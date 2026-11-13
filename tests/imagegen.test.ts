import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_IMAGE,
	ImageGenError,
	createImageProvider,
	generatePanelImages,
	imageProviders,
	registerImageProvider,
	type ImageGenConfig,
	type ImageGenWorkspace,
	type ImageGenerateRequest,
	type ImageGenerateResult,
	type ImageProvider,
} from "../src/imagegen/index.ts";
import type { Bible, MangaPage } from "../src/types.ts";
import { tinyPng } from "./helpers.ts";

function makeBible(): Bible {
	return {
		schemaVersion: 1,
		title: "t",
		logline: "l",
		genre: [],
		tone: "",
		audience: "",
		art: { preset: "manga-bw", stylePrompt: "", letteringStyle: "", palette: [] },
		world: { locations: [] },
		cast: [{ id: "lin", name: "Lin", role: "lead", canonical: "", outfits: { default: "" } }],
	};
}

function makePage(): MangaPage {
	return {
		schemaVersion: 1,
		id: "page-001",
		index: 1,
		summary: "",
		panels: [
			{
				id: "panel-01",
				shot: "wide",
				characters: [],
				action: "waits",
				dialogue: [],
				prompt: "wide shot, a rooftop at dusk",
			},
		],
	};
}

/** Minimal workspace: no ProjectStore, no previews, no pipeline. */
function makeWorkspace(root: string): { workspace: ImageGenWorkspace; calls: string[] } {
	const pages = new Map<number, MangaPage>([[1, makePage()]]);
	const sourceUrls = new Map<string, string>();
	const calls: string[] = [];
	const workspace: ImageGenWorkspace = {
		root,
		style: {
			preset: "manga-bw",
			label: "黑白漫画",
			ratio: "3:4",
			lockedTokens: ["no watermark", "no signature", "no text other than the specified lettering"],
		},
		readBible: () => makeBible(),
		listPageKeys: () => ["page-001"],
		readPage: (index) => pages.get(index),
		readPageByKey: (key) => [...pages.values()].find((page) => page.id === key),
		writePage: (page) => {
			pages.set(page.index, page);
		},
		touch: () => {},
		refreshStats: () => {},
		readText: () => undefined,
		imageExists: (rel) => existsSync(join(root, rel)),
		imageAbsPath: (rel) => join(root, rel),
		prepareImage: (rel) => {
			const abs = join(root, rel);
			mkdirSync(dirname(abs), { recursive: true });
			return abs;
		},
		afterImageWritten: (rel) => {
			calls.push(`after:${rel}`);
		},
		readSourceUrl: (rel) => sourceUrls.get(rel),
		writeSourceUrl: (rel, url) => {
			if (url) sourceUrls.set(rel, url);
		},
	};
	return { workspace, calls };
}

class FakeProvider implements ImageProvider {
	readonly id = "fake";
	readonly model = "fake-model";
	requests: ImageGenerateRequest[] = [];

	async generate(request: ImageGenerateRequest): Promise<ImageGenerateResult> {
		this.requests.push(request);
		writeFileSync(request.outPath, tinyPng(4, 4));
		return {
			file: request.outPath,
			sourceUrl: "https://example.com/fake.png",
			width: 4,
			height: 4,
			bytes: 0,
			attempts: 1,
			size: request.size,
			ratio: request.ratio,
			format: "png",
		};
	}
}

test("image stages run against a provider + workspace port without app internals", async () => {
	const root = mkdtempSync(join(tmpdir(), "mz-imagegen-"));
	const { workspace, calls } = makeWorkspace(root);
	const provider = new FakeProvider();
	const config: ImageGenConfig = { ...DEFAULT_IMAGE, maxRefs: 0 };
	const result = await generatePanelImages({ workspace, config, provider });
	assert.deepEqual(result, { done: 1, skipped: 0, failed: 0, failures: [] });
	assert.equal(provider.requests.length, 1);
	assert.match(provider.requests[0].prompt, /BLACK AND WHITE|COLOR LOCK/i, "style enforcement is provider-independent");
	assert.ok(calls.includes("after:pages/page-001/panel-01.png"));
	assert.ok(readFileSync(join(root, "pages/page-001/panel-01.png")).length > 0);
	const page = workspace.readPage(1);
	assert.equal(page?.panels[0].image?.status, "done");
	assert.equal(page?.panels[0].image?.sourceUrl, "https://example.com/fake.png");
});

test("provider registry exposes built-ins and accepts custom factories", () => {
	assert.ok(imageProviders.has("agnes"));
	assert.equal(createImageProvider("agnes", { model: "m", apiKey: "k" }).id, "agnes");
	assert.throws(
		() => createImageProvider("missing", { model: "m", apiKey: "k" }),
		(error: unknown) => error instanceof ImageGenError && error.code === "provider",
	);
	registerImageProvider("fake-test", (config) => {
		const provider = new FakeProvider();
		assert.equal(config.id, "fake-test");
		return provider;
	});
	assert.equal(createImageProvider("fake-test", { model: "m", apiKey: "k" }).id, "fake");
});
