import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import {
	composeStylePrompt,
	enforceStyleNegative,
	enforceStylePrompt,
	makeStyle,
} from "../src/config.ts";
import { readImageSize } from "../src/util/png.ts";
import { toMonochromePng } from "../src/util/png-grayscale.ts";
import { tinyPng } from "./helpers.ts";

function pngPixels(path: string): Buffer {
	const buffer = readFileSync(path);
	let offset = 8;
	let width = 0;
	let height = 0;
	const idat: Buffer[] = [];
	while (offset + 12 <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
		}
		if (type === "IDAT") idat.push(data);
		offset += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * 3 + 1;
	const pixels = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		assert.equal(raw[y * stride], 0);
		raw.copy(pixels, y * width * 3, y * stride + 1, y * stride + stride);
	}
	return pixels;
}

test("manga-bw style carries an explicit black-and-white color lock", () => {
	const style = makeStyle("manga-bw");
	const prompt = composeStylePrompt(style);
	assert.match(prompt, /black and white/i);
	assert.match(prompt, /monochrome/i);
	assert.match(prompt, /no color/i);
	assert.match(prompt, /COLOR LOCK/);
	for (const token of style.lockedTokens) assert.ok(prompt.includes(token));

	const color = composeStylePrompt(makeStyle("manhua-color"));
	assert.doesNotMatch(color, /COLOR LOCK/);
	assert.match(color, /full color/i);
});

test("style enforcement appends the mono lock to stale agent prompts", () => {
	const style = makeStyle("manga-bw");
	const stale = "wide shot, LIN on a roof. modern seinen manga, clean confident lineart, screentone shading, high contrast";
	const enforced = enforceStylePrompt(stale, style);
	assert.match(enforced, /BLACK AND WHITE/i);
	assert.match(enforced, /no color/i);
	assert.match(enforced, /no text other than the specified lettering/);
	assert.equal(enforceStylePrompt(enforced, style), enforced.trim(), "already-enforced prompts must not grow");
	const negative = enforceStyleNegative("garbled characters", style);
	assert.match(negative ?? "", /garbled characters/);
	assert.match(negative ?? "", /full color/);
	assert.match(negative ?? "", /colored lighting/);
});

test("monochrome conversion keeps dimensions and removes chroma", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mz-mono-"));
	const file = join(dir, "color.png");
	writeFileSync(file, tinyPng(8, 8));
	assert.ok(toMonochromePng(file));
	const size = await readImageSize(file);
	assert.deepEqual(size, { width: 8, height: 8, format: "png" });
	const pixels = pngPixels(file);
	for (let i = 0; i < pixels.length; i += 3) {
		assert.equal(pixels[i], pixels[i + 1]);
		assert.equal(pixels[i + 1], pixels[i + 2]);
	}
});
