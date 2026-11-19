import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	applyCharacterRefsToBible,
	characterRefSettings,
	collectCharacterRefSources,
	importCharacterRefs,
	readCharacterRefManifest,
} from "../src/character-refs.ts";
import { DEFAULT_IMAGE, generateCharacterImages, type ImageGenWorkspace, type ImageProvider } from "../src/imagegen/index.ts";
import type { Bible } from "../src/types.ts";
import { tinyPng, writeTinyPng } from "./helpers.ts";

function bibleWith(cast: Bible["cast"]): Bible {
	return {
		schemaVersion: 1,
		title: "t",
		logline: "l",
		genre: [],
		tone: "",
		audience: "",
		art: { preset: "manga-bw", stylePrompt: "", letteringStyle: "", palette: [] },
		world: { locations: [] },
		cast,
	};
}

test("imported character references are matched to cast and honor direct/restyle mode", () => {
	const root = mkdtempSync(join(tmpdir(), "mz-char-refs-"));
	const input = join(root, "input");
	mkdirSync(input, { recursive: true });
	writeTinyPng(join(input, "01-林澈.png"), 4, 4);
	writeTinyPng(join(input, "02-罗伯托.png"), 4, 4);

	const sources = collectCharacterRefSources(input);
	assert.equal(sources.length, 2);
	const direct = importCharacterRefs(root, sources, "direct", input);
	assert.equal(direct.files.length, 2);
	assert.ok(existsSync(join(root, direct.files[0].file)));
	assert.equal(readCharacterRefManifest(root)?.mode, "direct");

	const bible = bibleWith([
		{ id: "lin", name: "林澈", role: "protagonist", canonical: "", outfits: { default: "" }, refPrompt: "sheet" },
		{ id: "roberto", name: "罗伯托", role: "supporting", canonical: "", outfits: { default: "" }, refPrompt: "sheet" },
	]);
	assert.equal(applyCharacterRefsToBible(bible, direct), true);
	assert.equal(bible.cast[0].userRefs?.length, 1);
	assert.equal(bible.cast[1].userRefs?.length, 1);
	assert.match(String(bible.cast[0].refSheet), /characters\/lin\/ref\.png$/);

	const restyle = { ...direct, mode: "restyle" as const };
	const restyleBible = bibleWith([
		{ id: "lin", name: "林澈", role: "protagonist", canonical: "", outfits: { default: "" }, refPrompt: "sheet" },
	]);
	assert.equal(applyCharacterRefsToBible(restyleBible, restyle), true);
	assert.equal(restyleBible.cast[0].refSheet, "characters/lin/ref.png");
	assert.deepEqual(characterRefSettings("restyle", input).mode, "restyle");
});

test("direct mode copies the user reference without calling the image provider", async () => {
	const root = mkdtempSync(join(tmpdir(), "mz-char-direct-"));
	const userRef = "source/character-refs/01-lin.png";
	writeTinyPng(join(root, userRef), 4, 4);
	writeFileSync(
		join(root, "source/character-refs/manifest.json"),
		JSON.stringify({ schemaVersion: 1, mode: "direct", inputPath: "x", files: [{ file: userRef, originalPath: "x", originalName: "lin.png" }] }),
	);
	const bible = bibleWith([
		{
			id: "lin",
			name: "林澈",
			role: "protagonist",
			canonical: "",
			outfits: { default: "" },
			refPrompt: "sheet",
			userRefs: [userRef],
			refSheet: "characters/lin/ref.png",
		},
	]);
	let calls = 0;
	const provider: ImageProvider = {
		id: "fake",
		async generate() {
			calls += 1;
			return { file: "", width: 1, height: 1, bytes: 0, attempts: 1, size: "1K", format: "png" };
		},
	};
	const workspace: ImageGenWorkspace = {
		root,
		style: { preset: "manga-bw", ratio: "3:4", lockedTokens: [] },
		readBible: () => bible,
		listPageKeys: () => [],
		readPage: () => undefined,
		readPageByKey: () => undefined,
		writePage: () => undefined,
		touch: () => {},
		refreshStats: () => {},
		readText: (rel) => {
			try {
				return readFileSync(join(root, rel), "utf8");
			} catch {
				return undefined;
			}
		},
		imageExists: (rel) => existsSync(join(root, rel)),
		imageAbsPath: (rel) => join(root, rel),
		prepareImage: (rel) => {
			const abs = join(root, rel);
			mkdirSync(dirname(abs), { recursive: true });
			return abs;
		},
		afterImageWritten: () => {},
		readSourceUrl: () => undefined,
		writeSourceUrl: () => {},
	};
	const result = await generateCharacterImages({ workspace, config: { ...DEFAULT_IMAGE }, provider, force: true });
	assert.equal(result.done, 1);
	assert.equal(calls, 0);
	assert.ok(existsSync(join(root, "characters/lin/ref.png")));
});
