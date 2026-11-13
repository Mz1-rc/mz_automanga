import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArkClient, DEFAULT_ARK_MODEL, ImageGenError } from "../src/imagegen/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createProviderFromConfig } from "../src/imagegen-adapter.ts";
import { tinyPng } from "./helpers.ts";

interface MockOptions {
	status?: number;
	body?: string;
	dataError?: { code: string; message: string };
}

async function startMock(options: MockOptions = {}) {
	const requests: Array<Record<string, unknown>> = [];
	let base = "";
	const png = tinyPng(6, 8);
	const server = createServer((req, res) => {
		if (req.method === "POST") {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				const payload = JSON.parse(body) as Record<string, unknown>;
				requests.push(payload);
				if (options.status && options.status !== 200) {
					res.writeHead(options.status, { "Content-Type": "application/json" });
					res.end(options.body ?? JSON.stringify({ error: { code: "MockError", message: "mock" } }));
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				if (options.dataError) {
					res.end(JSON.stringify({ data: [{ error: options.dataError }] }));
					return;
				}
				if (payload.response_format === "b64_json") {
					res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64"), output_format: "png" }] }));
					return;
				}
				res.end(
					JSON.stringify({
						model: payload.model,
						data: [{ url: `${base}/img.png`, size: "864x1152", output_format: "png" }],
					}),
				);
			});
			return;
		}
		if (req.url === "/img.png") {
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
		close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
	};
}

function client(baseUrl: string, overrides: Partial<ConstructorParameters<typeof ArkClient>[0]> = {}) {
	return new ArkClient({
		baseUrl,
		apiKey: "test-key",
		model: DEFAULT_ARK_MODEL,
		timeoutMs: 5000,
		retries: 0,
		maxDownloadBytes: 8 * 1024 * 1024,
		streamChunkBytes: 16 * 1024,
		...overrides,
	});
}

test("ark generate requests explicit 3:4 pixels and streams the image", async () => {
	const mock = await startMock();
	const dir = mkdtempSync(join(tmpdir(), "ark-"));
	const out = join(dir, "p.png");
	try {
		const result = await client(mock.url).generate({
			prompt: "a test panel",
			negative: "garbled characters",
			size: "1K",
			ratio: "3:4",
			outPath: out,
		});
		assert.equal(result.width, 6);
		assert.equal(result.height, 8);
		assert.equal(result.sourceUrl, `${mock.url}/img.png`);
		assert.ok(readFileSync(out).length > 0);
		const payload = mock.requests[0];
		assert.equal(payload.model, DEFAULT_ARK_MODEL);
		assert.equal(payload.size, "864x1152");
		assert.equal(payload.response_format, "url");
		assert.equal(payload.watermark, false);
		assert.equal(payload.output_format, "png");
		// Seedream 5.5 rejects sequential_image_generation, so it must be omitted.
		assert.equal("sequential_image_generation" in payload, false);
		assert.match(String(payload.prompt), /Avoid: garbled characters/);
	} finally {
		await mock.close();
	}
});

test("ark size mapping respects model tiers and ratios", () => {
	const ark = client("http://127.0.0.1");
	assert.equal(ark.buildPayload({ prompt: "p", size: "2K", ratio: "9:16" }).size, "1600x2848");
	assert.equal(ark.buildPayload({ prompt: "p", size: "4K", ratio: "3:4" }).size, "1728x2304");
	const v40 = client("http://127.0.0.1", { model: "doubao-seedream-4-0-250828" });
	assert.equal(v40.buildPayload({ prompt: "p", size: "4K", ratio: "3:4" }).size, "3520x4704");
	const lite = client("http://127.0.0.1", { model: "doubao-seedream-5-0-lite-260128" });
	assert.equal(lite.buildPayload({ prompt: "p", size: "1K", ratio: "3:4" }).size, "1728x2304");
	const pro = client("http://127.0.0.1", { model: "doubao-seedream-5-0-pro-260628" });
	assert.equal(pro.buildPayload({ prompt: "p", size: "4K", ratio: "3:4" }).size, "1728x2304");
	const v55 = client("http://127.0.0.1", { model: "doubao-seedream-5-5-261028" });
	const payload = v55.buildPayload({ prompt: "p", size: "4K", ratio: "3:4" });
	assert.equal(payload.size, "1728x2304");
	assert.equal("sequential_image_generation" in payload, false);
	assert.equal(v40.buildPayload({ prompt: "p", size: "1K", ratio: "3:4" }).sequential_image_generation, "disabled");
});

test("ark passes URL references and reports API errors", async () => {
	const mock = await startMock();
	const dir = mkdtempSync(join(tmpdir(), "ark-"));
	try {
		await client(mock.url).generate({
			prompt: "p",
			size: "1K",
			ratio: "3:4",
			refs: [{ url: "https://example.com/ref.png" }],
			outPath: join(dir, "p.png"),
		});
		assert.deepEqual(mock.requests[0].image, ["https://example.com/ref.png"]);
	} finally {
		await mock.close();
	}

	const bad = await startMock({ dataError: { code: "InvalidParameter", message: "bad prompt" } });
	try {
		await assert.rejects(
			client(bad.url).generate({ prompt: "p", size: "1K", outPath: join(dir, "bad.png") }),
			(error: unknown) => error instanceof ImageGenError && error.code === "invalid",
		);
	} finally {
		await bad.close();
	}
});

test("ark maps 401 to auth and 429 to retryable", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ark-"));
	const auth = await startMock({ status: 401, body: JSON.stringify({ error: { code: "AuthenticationError", message: "bad key" } }) });
	try {
		await assert.rejects(
			client(auth.url).generate({ prompt: "p", size: "1K", outPath: join(dir, "a.png") }),
			(error: unknown) => error instanceof ImageGenError && error.code === "auth",
		);
	} finally {
		await auth.close();
	}
	const rate = await startMock({ status: 429, body: JSON.stringify({ error: { code: "RateLimitExceeded", message: "slow" } }) });
	try {
		await assert.rejects(
			client(rate.url).generate({ prompt: "p", size: "1K", outPath: join(dir, "r.png") }),
			(error: unknown) => error instanceof ImageGenError && error.code === "retryable",
		);
	} finally {
		await rate.close();
	}
});

test("ark provider falls back to its own model when image.model belongs to another provider", () => {
	const config = structuredClone(DEFAULT_CONFIG);
	config.image = { ...config.image, provider: "ark", model: "agnes-image-2.5-flash" };
	const provider = createProviderFromConfig(config, "test");
	assert.equal(provider.id, "ark");
	assert.equal(provider.model, DEFAULT_ARK_MODEL);
});
