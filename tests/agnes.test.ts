import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgnesClient, AgnesError } from "../src/agnes.ts";
import { readImageSize } from "../src/util/png.ts";
import { downloadToFile } from "../src/util/stream.ts";
import { tinyPng } from "./helpers.ts";

interface MockOptions {
	status?: number;
	body?: string;
	urlPath?: string;
	download?: Buffer;
}

async function startMock(options: MockOptions = {}) {
	const requests: Array<Record<string, unknown>> = [];
	let downloads = 0;
	let base = "";
	const png = options.download ?? tinyPng(8, 8);
	const server = createServer((req, res) => {
		if (req.method === "POST") {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				try {
					requests.push(JSON.parse(body));
				} catch {
					requests.push({ raw: body });
				}
				const payload = requests.at(-1);
				if (options.status && options.status !== 200) {
					res.writeHead(options.status, { "Content-Type": "application/json" });
					res.end(options.body ?? JSON.stringify({ error: "mock" }));
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				if (payload && (payload.extra_body as { response_format?: string })?.response_format === "b64_json") {
					res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
				} else {
					res.end(JSON.stringify({ data: [{ url: `${base}${options.urlPath ?? "/img.png"}` }] }));
				}
			});
			return;
		}
		if (req.url === (options.urlPath ?? "/img.png")) {
			downloads++;
			res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
			res.end(png);
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	base = `http://127.0.0.1:${address.port}`;
	return {
		url: base,
		requests,
		get downloads() {
			return downloads;
		},
		close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
	};
}

function client(baseUrl: string, overrides: Partial<ConstructorParameters<typeof AgnesClient>[0]> = {}) {
	return new AgnesClient({
		baseUrl,
		apiKey: "test-key",
		model: "agnes-image-2.5-flash",
		timeoutMs: 5000,
		retries: 0,
		maxDownloadBytes: 8 * 1024 * 1024,
		streamChunkBytes: 16 * 1024,
		...overrides,
	});
}

test("generate requests url format, streams the image and reports size", async () => {
	const mock = await startMock();
	const dir = mkdtempSync(join(tmpdir(), "agnes-"));
	const out = join(dir, "p.png");
	try {
		const result = await client(mock.url).generate({
			prompt: "a test panel",
			negative: "garbled characters",
			size: "1K",
			ratio: "3:4",
			outPath: out,
		});
		assert.equal(result.width, 8);
		assert.equal(result.height, 8);
		assert.ok(readFileSync(out).length > 0);
		assert.equal(mock.downloads, 1);
		const payload = mock.requests[0];
		assert.equal(payload.model, "agnes-image-2.5-flash");
		assert.equal(payload.size, "1K");
		assert.equal(payload.ratio, "3:4");
		assert.equal((payload.extra_body as Record<string, unknown>).response_format, "url");
		assert.equal("response_format" in payload, false);
		assert.match(String(payload.prompt), /Avoid: garbled characters/);
		assert.equal((payload.extra_body as Record<string, unknown>).image, undefined);
		const size = await readImageSize(out);
		assert.equal(size.format, "png");
	} finally {
		await mock.close();
	}
});

test("local references are sent as data URIs", async () => {
	const mock = await startMock();
	const dir = mkdtempSync(join(tmpdir(), "agnes-"));
	const ref = join(dir, "ref.png");
	writeFileSync(ref, tinyPng(4, 4));
	try {
		await client(mock.url).generate({
			prompt: "panel with lin",
			size: "1K",
			refs: [{ path: ref }],
			outPath: join(dir, "out.png"),
		});
		const images = (mock.requests[0].extra_body as { image: string[] }).image;
		assert.equal(images.length, 1);
		assert.match(images[0], /^data:image\/png;base64,/);
	} finally {
		await mock.close();
	}
});

test("401 is reported as auth and is not retried", async () => {
	const mock = await startMock({ status: 401, body: "bad key" });
	try {
		await assert.rejects(
			client(mock.url, { retries: 3 }).generate({ prompt: "x", size: "1K", outPath: join(tmpdir(), "x.png") }),
			(error: unknown) => error instanceof AgnesError && error.code === "auth" && error.status === 401,
		);
		assert.equal(mock.requests.length, 1);
	} finally {
		await mock.close();
	}
});

test("400 is reported as invalid and is not retried", async () => {
	const mock = await startMock({ status: 400, body: "bad payload" });
	try {
		await assert.rejects(
			client(mock.url, { retries: 3 }).generate({ prompt: "x", size: "1K", outPath: join(tmpdir(), "x.png") }),
			(error: unknown) => error instanceof AgnesError && error.code === "invalid",
		);
		assert.equal(mock.requests.length, 1);
	} finally {
		await mock.close();
	}
});

test("429 is retryable", async () => {
	const mock = await startMock({ status: 429, body: "slow down" });
	try {
		await assert.rejects(
			client(mock.url, { retries: 0 }).generate({ prompt: "x", size: "1K", outPath: join(tmpdir(), "x.png") }),
			(error: unknown) => error instanceof AgnesError && error.code === "retryable",
		);
	} finally {
		await mock.close();
	}
});

test("downloadToFile enforces the byte cap and removes the temp file", async () => {
	const { Readable } = await import("node:stream");
	const dir = mkdtempSync(join(tmpdir(), "agnes-"));
	const out = join(dir, "big.png");
	const chunks = [Buffer.alloc(40, 1), Buffer.alloc(40, 2), Buffer.alloc(40, 3)];
	await assert.rejects(
		downloadToFile(Readable.from(chunks), out, { maxBytes: 50, chunkBytes: 16 }),
		/下载超过上限/,
	);
	assert.throws(() => readFileSync(out), /ENOENT/);
});
