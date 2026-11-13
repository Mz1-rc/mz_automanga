import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureDir, truncateMiddle } from "../../paths.ts";
import { readImageSize, isJpeg, isPng } from "../../util/png.ts";
import { downloadToFile, readHead, writeBase64ToFile } from "../../util/stream.ts";
import { ImageGenError } from "../errors.ts";
import { joinPrompt, refsToImages } from "./shared.ts";
import type {
	ImageGenerateRequest,
	ImageGenerateResult,
	ImageProvider,
	ImageProviderConfig,
	ImageProviderTestResult,
	ImageRatio,
	ImageReference,
	ImageSizeTier,
} from "../types.ts";

// Backwards-compatible aliases for callers that used the old `src/agnes.ts`.
export type { ImageRatio, ImageSizeTier };
export type AgnesReference = ImageReference;
export type AgnesGenerateOptions = ImageGenerateRequest;
export type AgnesGenerateResult = ImageGenerateResult;

export interface AgnesClientOptions {
	baseUrl: string;
	apiKey: string;
	model: string;
	timeoutMs: number;
	retries: number;
	maxDownloadBytes: number;
	streamChunkBytes: number;
	fetchImpl?: typeof fetch;
}

export class AgnesError extends ImageGenError {
	constructor(code: string, message: string, options: { status?: number; detail?: string } = {}) {
		super(code, message, options);
		this.name = "AgnesError";
	}
}

interface AgnesPayload {
	model: string;
	prompt: string;
	size: string;
	ratio?: string;
	extra_body: {
		response_format: "url" | "b64_json";
		image?: string[];
	};
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		if (signal?.aborted) {
			reject(new AgnesError("aborted", "已取消"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new AgnesError("aborted", "已取消"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
	const onAbort = () => controller.abort(parent?.reason);
	if (parent) {
		if (parent.aborted) controller.abort(parent.reason);
		else parent.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}

export class AgnesClient implements ImageProvider {
	readonly id = "agnes";
	private readonly opts: AgnesClientOptions;
	private readonly fetchImpl: typeof fetch;

	constructor(options: AgnesClientOptions) {
		this.opts = options;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	get model(): string {
		return this.opts.model;
	}

	private endpoint(): string {
		const base = this.opts.baseUrl.replace(/\/+$/, "");
		return base.endsWith("/images/generations") ? base : `${base}/images/generations`;
	}

	buildPayload(options: {
		prompt: string;
		negative?: string;
		size: ImageSizeTier;
		ratio?: ImageRatio;
		refs?: AgnesReference[];
		b64?: boolean;
	}): AgnesPayload {
		const payload: AgnesPayload = {
			model: this.opts.model,
			prompt: joinPrompt(options.prompt, options.negative),
			size: options.size,
			extra_body: { response_format: options.b64 ? "b64_json" : "url" },
		};
		if (options.ratio) payload.ratio = options.ratio;
		const images = refsToImages(options.refs);
		if (images) payload.extra_body.image = images;
		return payload;
	}

	async generate(options: AgnesGenerateOptions): Promise<AgnesGenerateResult> {
		const totalAttempts = Math.max(1, this.opts.retries + 1);
		let lastError: unknown;
		for (let attempt = 1; attempt <= totalAttempts; attempt++) {
			if (options.signal?.aborted) throw new AgnesError("aborted", "已取消");
			try {
				return await this.generateOnce(options, attempt);
			} catch (error) {
				lastError = error;
				if (error instanceof AgnesError && (error.code === "aborted" || error.code === "auth" || error.code === "invalid")) {
					throw error;
				}
				if (attempt >= totalAttempts) break;
				const backoff = attempt === 1 ? 2000 : attempt === 2 ? 8000 : 25000;
				await sleep(backoff + Math.floor(Math.random() * 500), options.signal);
			}
		}
		if (lastError instanceof AgnesError) throw lastError;
		throw new AgnesError("network", `图像生成失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
	}

	private async generateOnce(options: AgnesGenerateOptions, attempt: number): Promise<AgnesGenerateResult> {
		const response = await this.post(
			this.buildPayload({
				prompt: options.prompt,
				negative: options.negative,
				size: options.size,
				ratio: options.ratio,
				refs: options.refs,
			}),
			options.signal,
		);
		const data = await this.readResponse(response);
		const entry = Array.isArray(data?.data) ? data.data[0] : undefined;
		const url = typeof entry?.url === "string" ? entry.url : undefined;
		const b64 = typeof entry?.b64_json === "string" ? entry.b64_json : undefined;

		ensureDir(dirname(options.outPath));
		if (url) {
			try {
				await this.download(url, options.outPath, options.signal);
				const size = await readImageSize(options.outPath);
				return {
					file: options.outPath,
					sourceUrl: url,
					width: size.width,
					height: size.height,
					bytes: 0,
					attempts: attempt,
					size: options.size,
					ratio: options.ratio,
					format: size.format,
				};
			} catch (error) {
				if (options.signal?.aborted) throw new AgnesError("aborted", "已取消");
				// URL download failed: retry once as base64.
				const fallback = await this.retryAsBase64(options);
				return { ...fallback, attempts: attempt, sourceUrl: url };
			}
		}
		if (b64) {
			await writeBase64ToFile(b64, options.outPath);
			const size = await readImageSize(options.outPath);
			return {
				file: options.outPath,
				width: size.width,
				height: size.height,
				bytes: 0,
				attempts: attempt,
				size: options.size,
				ratio: options.ratio,
				format: size.format,
			};
		}
		throw new AgnesError("empty", "Agnes 返回成功但没有 url 或 b64_json");
	}

	private async retryAsBase64(options: AgnesGenerateOptions): Promise<AgnesGenerateResult> {
		const response = await this.post(
			this.buildPayload({
				prompt: options.prompt,
				negative: options.negative,
				size: options.size,
				ratio: options.ratio,
				refs: options.refs,
				b64: true,
			}),
			options.signal,
		);
		const data = await this.readResponse(response);
		const entry = Array.isArray(data?.data) ? data.data[0] : undefined;
		if (typeof entry?.b64_json !== "string") throw new AgnesError("empty", "Agnes base64 回退失败");
		await writeBase64ToFile(entry.b64_json, options.outPath);
		const size = await readImageSize(options.outPath);
		return {
			file: options.outPath,
			width: size.width,
			height: size.height,
			bytes: 0,
			attempts: 1,
			size: options.size,
			ratio: options.ratio,
			format: size.format,
		};
	}

	private async post(payload: AgnesPayload, parentSignal?: AbortSignal): Promise<Response> {
		const { signal, dispose } = withTimeout(parentSignal, this.opts.timeoutMs);
		try {
			const response = await this.fetchImpl(this.endpoint(), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.opts.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
				signal,
			});
			if (response.ok) return response;
			const detail = truncateMiddle(await safeText(response), 600);
			const status = response.status;
			if (status === 401 || status === 403) {
				throw new AgnesError("auth", `Agnes 鉴权失败（${status}）。请用 /manga key 重新设置 API Key。`, { status, detail });
			}
			if (status === 400 || status === 404 || status === 422) {
				throw new AgnesError("invalid", `Agnes 拒绝请求（${status}）。${detail}`, { status, detail });
			}
			if (RETRYABLE.has(status)) {
				throw new AgnesError("retryable", `Agnes 暂时不可用（${status}）`, { status, detail });
			}
			throw new AgnesError("http", `Agnes 请求失败（${status}）`, { status, detail });
		} catch (error) {
			if (signal.aborted) {
				const reason = parentSignal?.aborted ? "已取消" : `请求超时（${this.opts.timeoutMs}ms）`;
				throw new AgnesError(parentSignal?.aborted ? "aborted" : "timeout", reason);
			}
			if (error instanceof AgnesError) throw error;
			throw new AgnesError("network", `无法连接 Agnes：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			dispose();
		}
	}

	private async readResponse(response: Response): Promise<{ data?: Array<{ url?: string | null; b64_json?: string | null }> }> {
		const text = await response.text();
		try {
			return JSON.parse(text) as { data?: Array<{ url?: string | null; b64_json?: string | null }> };
		} catch {
			throw new AgnesError("parse", "Agnes 返回的不是合法 JSON", { detail: truncateMiddle(text, 400) });
		}
	}

	private async download(url: string, outPath: string, parentSignal?: AbortSignal): Promise<void> {
		const { signal, dispose } = withTimeout(parentSignal, this.opts.timeoutMs);
		try {
			const response = await this.fetchImpl(url, { signal });
			if (!response.ok || !response.body) {
				throw new AgnesError("download", `下载图片失败（${response.status}）`);
			}
			await downloadToFile(response.body, outPath, {
				maxBytes: this.opts.maxDownloadBytes,
				chunkBytes: this.opts.streamChunkBytes,
				signal,
			});
			const head = await readHead(outPath, 16);
			if (!isPng(head) && !isJpeg(head)) {
				throw new AgnesError("decode", "下载的内容不是 PNG/JPEG");
			}
		} finally {
			dispose();
		}
	}

	/** Generate a tiny 1K image to validate the key. Returns the size. */
	async testKey(signal?: AbortSignal): Promise<ImageProviderTestResult> {
		const dir = mkdtempSync(join(tmpdir(), "mz-automanga-key-"));
		const file = join(dir, "test.png");
		try {
			const result = await this.generate({
				prompt: "a single black square on a white background",
				size: "1K",
				ratio: "1:1",
				outPath: file,
				signal,
			});
			return { width: result.width, height: result.height, format: result.format, file };
		} finally {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	}
}

async function safeText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

const AGNES_DEFAULTS = {
	baseUrl: "https://apihub.agnes-ai.com/v1",
	model: "agnes-image-2.5-flash",
	timeoutMs: 240000,
	retries: 3,
	maxDownloadBytes: 32 * 1024 * 1024,
	streamChunkBytes: 64 * 1024,
};

/** Factory used by the provider registry. */
export function createAgnesProvider(config: ImageProviderConfig): ImageProvider {
	return new AgnesClient({
		baseUrl: config.baseUrl ?? AGNES_DEFAULTS.baseUrl,
		apiKey: config.apiKey,
		model: config.model || AGNES_DEFAULTS.model,
		timeoutMs: config.timeoutMs ?? AGNES_DEFAULTS.timeoutMs,
		retries: config.retries ?? AGNES_DEFAULTS.retries,
		maxDownloadBytes: config.maxDownloadBytes ?? AGNES_DEFAULTS.maxDownloadBytes,
		streamChunkBytes: config.streamChunkBytes ?? AGNES_DEFAULTS.streamChunkBytes,
		fetchImpl: config.fetchImpl,
	});
}
