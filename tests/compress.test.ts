import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProjectWebPreviews, webPreviewPath } from "../src/previews.ts";
import { readImageSize } from "../src/util/png.ts";
import { compressPngToSize } from "../src/util/image-compress.ts";
import { makeTestProject, writeNoisyPng } from "./helpers.ts";

test("compressPngToSize produces a PNG under 500 KB", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mz-compress-"));
	const source = join(dir, "source.png");
	const target = join(dir, "target.png");
	writeNoisyPng(source, 800, 1000);
	assert.ok(statSync(source).size > 500_000, "fixture must be larger than the limit");
	const result = compressPngToSize(source, target, { maxBytes: 500_000 });
	assert.equal(result.ok, true, result.reason);
	assert.ok(result.bytes <= 500_000, `bytes=${result.bytes}`);
	assert.ok(result.width <= 800);
	const size = await readImageSize(target);
	assert.equal(size.format, "png");
	assert.equal(size.width, result.width);
	assert.equal(size.height, result.height);
});

test("web previews are cached under .web and reused while fresh", () => {
	const { store } = makeTestProject();
	const rel = "pages/page-001/panel-01.png";
	store.writePage({
		schemaVersion: 1,
		id: "page-001",
		index: 1,
		summary: "s",
		panels: [
			{
				id: "panel-01",
				shot: "wide",
				characters: [],
				action: "a",
				dialogue: [],
				image: { status: "done", file: rel },
			},
		],
	});
	writeNoisyPng(join(store.root, rel), 800, 1000);
	const first = ensureProjectWebPreviews(store);
	assert.equal(first.total, 1);
	assert.equal(first.created, 1);
	const preview = webPreviewPath(store.root, rel);
	assert.ok(statSync(preview).size <= 500_000);
	const second = ensureProjectWebPreviews(store);
	assert.equal(second.created, 0);
	assert.equal(second.skipped, 1);
});
