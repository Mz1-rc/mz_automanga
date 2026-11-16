import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureDir, truncateMiddle } from "../../paths.ts";
import { isJpeg, isPng, readImageSize } from "../../util/png.ts";
import { downloadToFile, readHead, writeBase64ToFile } from "../../util/stream.ts";
import { ImageGenError } from "../errors.ts";
import type {
	ImageGenerateRequest,
	ImageGenerateResult,
	ImageModelOption,
	ImageProvider,
	ImageProviderConfig,
	ImageProviderTestResult,
	ImageRatio,
	ImageSizeTier,
} from "../types.ts";
import { joinPrompt, refsToImages } from "./shared.ts";

export const DEFAULT_ARK_MODEL = "doubao-seedream-5-5-261028";

/** Seedream models exposed by `/manga provider ark` for interactive selection. */
export const ARK_MODELS: ImageModelOption[] = [
	{ id: DEFAULT_ARK_MODEL, label: "Seedream 5.5", note: "推荐 · 1K/2K" },
	{ id: "doubao-seedream-5-0-pro-260628", label: "Seedream 5.0 Pro", note: "1K/2K" },
	{ id: "doubao-seedream-5-0-lite-260128", label: "Seedream 5.0 Lite", note: "最低 2K" },
	{ id: "doubao-seedream-4-0-250828", label: "Seedream 4.0", note: "1K/2K/4K" },
];

const ARK_DEFAULTS = {
	baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
	timeoutMs: 240000,
	retries: 3,
	maxDownloadBytes: 32 * 1024 * 1024,
	streamChunkBytes: 64 * 1024,
};

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Pixel dimensions from the Ark docs. Using explicit WxH (instead of a tier
 * string) keeps the project's 3:4 / 9:16 ratio stable across models.
 */
const DIMENSIONS: Record<"1K" | "2K" | "4K", Record<ImageRatio, string>> = {
	"1K": {
		"1:1": "1024x1024",
		"3:4": "864x1152",
		"2:3": "832x1248",
		"4:3": "1152x864",
		"16:9": "1280x720",
		"9:16": "720x1280",
	},
	"2K": {
		"1:1": "2048x2048",
		"3:4": "1728x2304",
		"2:3": "1664x2496",
		"4:3": "2304x1728",
		"16:9": "2848x1600",
		"9:16": "1600x2848",
	},
	"4K": {
		"1:1": "4096x4096",
		"3:4": "3520x4704",
		"2:3": "3328x4992",
		"4:3": "4704x3520",
		"16:9": "5504x3040",
		"9:16": "3040x5504",
	},
};

/** Clamp our size tiers to what the selected Seedream model supports. */
function tierForModel(model: string, tier: ImageSizeTier): "1K" | "2K" | "4K" {
	const name = model.toLowerCase();
	// Seedream 5.5 / 5.0 pro / 5.0 flash: 1K, 1.5K, 2K only.
	if (/seedream-5-5|seedream-5-0-(pro|flash)/.test(name)) {
		return tier === "3K" || tier === "4K" ? "2K" : tier === "2K" ? "2K" : "1K";
	}
	// Seedream 5.0 lite / 4.5: minimum 2K.
	if (/seedream-(4-5|5-0-lite|5-0-2)/.test(name)) {
		return tier === "1K" ? "2K" : tier === "3K" ? "4K" : tier;
	}
	// Seedream 4.0 and unknown models: 1K / 2K / 4K.
	return tier === "3K" ? "4K" : tier;
}

function arkSize(model: string, tier: ImageSizeTier, ratio?: ImageRatio): string {
	const mapped = tierForModel(model, tier);
	return DIMENSIONS[mapped][ratio ?? "3:4"] ?? DIMENSIONS[mapped]["3:4"];
}

export interface ArkClientOptions {
	baseUrl: string;
	apiKey: string;
	model: string;
	timeoutMs: number;
	retries: number;
	maxDownloadBytes: number;
	streamChunkBytes: number;
	fetchImpl?: typeof fetch;
}

interface ArkErrorBody {
	code?: string;
	message?: string;
}

interface ArkEntry {
	url?: string | null;
	b64_json?: string | null;
	size?: string;
	error?: ArkErrorBody;
}

interface ArkResponse {
	data?: ArkEntry[];
	error?: ArkErrorBody;
}

interface ArkPayload {
	model: string;
	prompt: string;
	size: string;
	response_format: "url" | "b64_json";
	watermark: boolean;
	output_format: "png";
	/** Only models that support group mode expose this flag. */
	sequential_image_generation?: "disabled";
	image?: string[];
}

function supportsSequentialFlag(model: string): boolean {
	// 5.5 / 5.0 pro / 5.0 flash reject this parameter; 4.0 / 4.5 / 5.0 lite support it.
	return !/seedream-5-5|seedream-5-0-(pro|flash)/.test(model.toLowerCase());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		if (signal?.aborted) {
			reject(new ImageGenError("aborted", "已取消"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new ImageGenError("aborted", "已取消"));
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

function errorFromBody(error: ArkErrorBody, status?: number): ImageGenError {
	const code = String(error.code ?? "api");
	const message = `${code}: ${error.message ?? "Ark 图像生成失败"}`;
	if (/auth|unauthor|forbidden|apikey|access.?denied/i.test(code)) {
		return new ImageGenError("auth", `${message}。请用 /manga key --provider ark 设置 ARK_API_KEY。`, { status });
	}
	if (/rate|limit|throttl|quota/i.test(code)) return new ImageGenError("retryable", message, { status });
	if (/internal|server|timeout|unavailable|service/i.test(code)) return new ImageGenError("retryable", message, { status });
	return new ImageGenError("invalid", message, { status });
}

export class ArkClient implements ImageProvider {
	readonly id = "ark";
	private readonly opts: ArkClientOptions;
	private readonly fetchImpl: typeof fetch;

	constructor(options: ArkClientOptions) {
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
		refs?: ImageGenerateRequest["refs"];
		b64?: boolean;
	}): ArkPayload {
		const payload: ArkPayload = {
			model: this.opts.model,
			prompt: joinPrompt(options.prompt, options.negative),
			size: arkSize(this.opts.model, options.size, options.ratio),
			response_format: options.b64 ? "b64_json" : "url",
			watermark: false,
			output_format: "png",
		};
		if (supportsSequentialFlag(this.opts.model)) payload.sequential_image_generation = "disabled";
		const images = refsToImages(options.refs);
		if (images) payload.image = images;
		return payload;
	}

	async generate(options: ImageGenerateRequest): Promise<ImageGenerateResult> {
		const totalAttempts = Math.max(1, this.opts.retries + 1);
		let lastError: unknown;
		for (let attempt = 1; attempt <= totalAttempts; attempt++) {
			if (options.signal?.aborted) throw new ImageGenError("aborted", "已取消");
			try {
				return await this.generateOnce(options, attempt);
			} catch (error) {
				lastError = error;
				if (error instanceof ImageGenError && (error.code === "aborted" || error.code === "auth" || error.code === "invalid")) {
					throw error;
				}
				if (attempt >= totalAttempts) break;
				const backoff = attempt === 1 ? 2000 : attempt === 2 ? 8000 : 25000;
				await sleep(backoff + Math.floor(Math.random() * 500), options.signal);
			}
		}
		if (lastError instanceof ImageGenError) throw lastError;
		throw new ImageGenError("network", `Ark 图像生成失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
	}

	private async generateOnce(options: ImageGenerateRequest, attempt: number): Promise<ImageGenerateResult> {
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
		const entry = data.data?.[0];
		if (!entry) throw new ImageGenError("empty", "Ark 返回成功但没有图片数据");
		if (entry.error) throw errorFromBody(entry.error, response.status);

		ensureDir(dirname(options.outPath));
		if (entry.url) {
			try {
				await this.download(entry.url, options.outPath, options.signal);
				const size = await readImageSize(options.outPath);
				return {
					file: options.outPath,
					sourceUrl: entry.url,
					width: size.width,
					height: size.height,
					bytes: 0,
					attempts: attempt,
					size: options.size,
					ratio: options.ratio,
					format: size.format,
				};
			} catch (error) {
				if (options.signal?.aborted) throw new ImageGenError("aborted", "已取消");
				// URL download can fail if the signed link expires; retry once as b64.
				const fallback = await this.retryAsBase64(options);
				return { ...fallback, attempts: attempt, sourceUrl: entry.url };
			}
		}
		if (entry.b64_json) {
			await writeBase64ToFile(entry.b64_json, options.outPath);
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
		throw new ImageGenError("empty", "Ark 返回成功但没有 url 或 b64_json");
	}

	private async retryAsBase64(options: ImageGenerateRequest): Promise<ImageGenerateResult> {
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
		const entry = data.data?.[0];
		if (entry?.error) throw errorFromBody(entry.error, response.status);
		if (!entry?.b64_json) throw new ImageGenError("empty", "Ark base64 回退失败");
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

	private async post(payload: ArkPayload, parentSignal?: AbortSignal): Promise<Response> {
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
				throw new ImageGenError("auth", `Ark 鉴权失败（${status}）。请用 /manga key --provider ark 重新设置 API Key。`, {
					status,
					detail,
				});
			}
			if (status === 400 || status === 404 || status === 422) {
				throw new ImageGenError("invalid", `Ark 拒绝请求（${status}）。${detail}`, { status, detail });
			}
			if (RETRYABLE.has(status)) {
				throw new ImageGenError("retryable", `Ark 暂时不可用（${status}）`, { status, detail });
			}
			throw new ImageGenError("http", `Ark 请求失败（${status}）`, { status, detail });
		} catch (error) {
			if (signal.aborted) {
				const reason = parentSignal?.aborted ? "已取消" : `请求超时（${this.opts.timeoutMs}ms）`;
				throw new ImageGenError(parentSignal?.aborted ? "aborted" : "timeout", reason);
			}
			if (error instanceof ImageGenError) throw error;
			throw new ImageGenError("network", `无法连接 Ark：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			dispose();
		}
	}

	private async readResponse(response: Response): Promise<ArkResponse> {
		const text = await response.text();
		let data: ArkResponse;
		try {
			data = JSON.parse(text) as ArkResponse;
		} catch {
			throw new ImageGenError("parse", "Ark 返回的不是合法 JSON", { detail: truncateMiddle(text, 400) });
		}
		if (data.error) throw errorFromBody(data.error, response.status);
		return data;
	}

	private async download(url: string, outPath: string, parentSignal?: AbortSignal): Promise<void> {
		const { signal, dispose } = withTimeout(parentSignal, this.opts.timeoutMs);
		try {
			const response = await this.fetchImpl(url, { signal });
			if (!response.ok || !response.body) {
				throw new ImageGenError("download", `下载图片失败（${response.status}）`);
			}
			await downloadToFile(response.body, outPath, {
				maxBytes: this.opts.maxDownloadBytes,
				chunkBytes: this.opts.streamChunkBytes,
				signal,
			});
			const head = await readHead(outPath, 16);
			if (!isPng(head) && !isJpeg(head)) {
				throw new ImageGenError("decode", "下载的内容不是 PNG/JPEG");
			}
		} finally {
			dispose();
		}
	}

	/** Generate one tiny image to validate the key. */
	async testKey(signal?: AbortSignal): Promise<ImageProviderTestResult> {
		const dir = mkdtempSync(join(tmpdir(), "mz-automanga-ark-key-"));
		const file = join(dir, "test.png");
		try {
			const result = await this.generate({
				prompt: "a single black square on a white background, simple, no text",
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

export function createArkProvider(config: ImageProviderConfig): ImageProvider {
	return new ArkClient({
		baseUrl: config.baseUrl ?? ARK_DEFAULTS.baseUrl,
		apiKey: config.apiKey,
		model: config.model || DEFAULT_ARK_MODEL,
		timeoutMs: config.timeoutMs ?? ARK_DEFAULTS.timeoutMs,
		retries: config.retries ?? ARK_DEFAULTS.retries,
		maxDownloadBytes: config.maxDownloadBytes ?? ARK_DEFAULTS.maxDownloadBytes,
		streamChunkBytes: config.streamChunkBytes ?? ARK_DEFAULTS.streamChunkBytes,
		fetchImpl: config.fetchImpl,
	});
}
