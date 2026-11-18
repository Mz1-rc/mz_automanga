import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ArtifactManager,
	validateAnalysis,
	validateBible,
	validatePage,
	validateRefPrompts,
} from "../src/artifacts.ts";
import { composeStylePrompt, makeStyle } from "../src/config.ts";
import { makeTestProject, tinyPng } from "./helpers.ts";
import type { Bible, MangaPage, ScriptAnalysis } from "../src/types.ts";

function analysis(): ScriptAnalysis {
	return {
		schemaVersion: 1,
		format: "novel",
		language: "zh",
		titleSuggestion: "雨落屋檐",
		logline: "她在天台等一个人。",
		pageEstimate: 1,
		scenes: [{ id: "s1", title: "天台", summary: "等待", characters: ["林澈"], beats: ["等待", "雨停"] }],
		status: "clear",
		issues: [],
		assumptions: [],
	};
}

function bible(): Bible {
	const style = makeStyle("manga-bw");
	return {
		schemaVersion: 1,
		title: "雨落屋檐",
		logline: "l",
		genre: ["青春"],
		tone: "克制",
		audience: "青少年",
		art: {
			preset: "manga-bw",
			stylePrompt: composeStylePrompt(style),
			letteringStyle: "clean black comic lettering, rounded white speech bubbles with thin black outlines",
			palette: ["#000000"],
		},
		world: { locations: [{ id: "roof", name: "天台", description: "湿" }] },
		cast: [
			{
				id: "lin",
				name: "林澈",
				role: "protagonist",
				canonical: "seventeen-year-old Chinese girl, shoulder-length black hair, dark eyes, navy school blazer",
				outfits: { default: "navy blazer" },
				refPrompt: "character reference sheet, three views",
				refSheet: "characters/lin/ref.png",
			},
		],
		assumptions: [],
	};
}

function page(promptMode: boolean): MangaPage {
	return {
		schemaVersion: 1,
		id: "page-001",
		index: 1,
		summary: "等待",
		panels: [1, 2, 3].map((n) => ({
			id: `panel-${String(n).padStart(2, "0")}`,
			shot: "wide",
			characters: [{ id: "lin" }],
			action: "站在天台",
			dialogue: [
				{
					type: "speech" as const,
					speaker: "lin",
					text: "没来。",
					bubble: { position: "top-left" as const, shape: "rounded" as const, tail: "bottom-right" },
				},
			],
			...(promptMode
				? {
						prompt: `wide shot, LIN, Lettering: "没来。", ${composeStylePrompt(makeStyle("manga-bw"))}`,
						negative: "garbled characters",
						refs: ["characters/lin/ref.png"],
					}
				: {}),
			image: { status: "pending" as const },
		})),
	};
}

test("ArtifactManager enforces the target whitelist and JSON validity", () => {
	const { store } = makeTestProject();
	const manager = new ArtifactManager(store.root, join(store.root, ".runs", "r1"), ["pages/page-001.json"]);
	assert.throws(() => manager.write("bible.json", "{}"), /不能写入/);
	assert.throws(() => manager.write("pages/page-001.json", "{oops"), /不是合法 JSON/);
	assert.throws(() => manager.write("pages/page-001.json", "   "), /内容为空/);
	const result = manager.write("pages/page-001.json", JSON.stringify(page(false)));
	assert.ok(result.sha256.length === 64);
	assert.ok(existsSync(join(store.root, "pages", "page-001.json")));
	assert.ok(existsSync(join(store.root, ".runs", "r1", "pages", "page-001.json")));
	assert.throws(() => manager.write("project.json", "{}"), /禁止写入/);
});

test("validateAnalysis accepts a clear analysis and rejects inconsistent status", () => {
	assert.equal(validateAnalysis(analysis()).ok, true);
	const bad = analysis();
	bad.issues = [{ id: "Q1", severity: "blocker", question: "谁的结局？", options: ["A", "B"], assumption: "A" }];
	assert.equal(validateAnalysis(bad).ok, false);
	bad.status = "needs_clarification";
	assert.equal(validateAnalysis(bad).ok, true);
	bad.issues.push({ id: "Q2", severity: "major", question: "?", options: ["only"], assumption: "" });
	const result = validateAnalysis(bad);
	assert.equal(result.ok, false);
	assert.ok(result.issues.some((issue) => issue.includes("至少需要 2 个 options")));
});

test("validateBible requires locked tokens and character fields", () => {
	const style = makeStyle("manga-bw");
	assert.equal(validateBible(bible(), style.lockedTokens, "").ok, true);
	const bad = bible();
	bad.art.stylePrompt = "some style";
	bad.cast[0].canonical = "girl";
	const result = validateBible(bad, style.lockedTokens, "");
	assert.equal(result.ok, false);
	assert.ok(result.issues.some((issue) => issue.includes("no watermark")));
	assert.ok(result.issues.some((issue) => issue.includes("canonical 过短")));
});

test("validatePage enforces bubble and lettering text without a character limit", () => {
	const { store } = makeTestProject();
	mkdirSync(join(store.root, "characters", "lin"), { recursive: true });
	writeFileSync(join(store.root, "characters", "lin", "ref.png"), tinyPng());
	assert.equal(
		validatePage(page(false), { bible: bible(), stylePrompt: "", stage: "storyboard", projectRoot: store.root }).ok,
		true,
	);
	const missingBubble = page(false);
	delete (missingBubble.panels[0].dialogue[0] as { bubble?: unknown }).bubble;
	const badBubble = validatePage(missingBubble, { bible: bible(), stylePrompt: "", stage: "storyboard", projectRoot: store.root });
	assert.equal(badBubble.ok, false);
	assert.ok(badBubble.issues.some((issue) => issue.includes("bubble.position")));

	const long = page(false);
	long.panels[0].dialogue[0].text = "这是一句明显超过十四个汉字的对白内容，但旁白和对话不再限制字数。";
	assert.equal(
		validatePage(long, { bible: bible(), stylePrompt: "", stage: "storyboard", projectRoot: store.root }).ok,
		true,
	);

	const good = page(true);
	assert.equal(
		validatePage(good, { bible: bible(), stylePrompt: "", stage: "prompts", projectRoot: store.root }).ok,
		true,
	);
	const missingText = page(true);
	missingText.panels[0].prompt = `wide shot, no text other than the specified lettering`;
	const badPrompt = validatePage(missingText, {
		bible: bible(),
		stylePrompt: "",
		stage: "prompts",
		projectRoot: store.root,
	});
	assert.equal(badPrompt.ok, false);
	assert.ok(badPrompt.issues.some((issue) => issue.includes("未包含 dialogue")));
});

test("validateRefPrompts accepts inline or file prompts", () => {
	const { store } = makeTestProject();
	assert.equal(validateRefPrompts(bible(), store.root).ok, true);
	const without = bible();
	without.cast[0].refPrompt = "";
	assert.equal(validateRefPrompts(without, store.root).ok, false);
	mkdirSync(join(store.root, "characters", "lin"), { recursive: true });
	writeFileSync(join(store.root, "characters", "lin", "ref.prompt.txt"), "sheet prompt");
	assert.equal(validateRefPrompts(without, store.root).ok, true);
});

test("validatePage limits pure empty panels and consecutive empties", () => {
	const { store } = makeTestProject();
	const empty = page(false);
	for (const panel of empty.panels) {
		panel.characters = [];
		panel.dialogue = [];
	}
	const result = validatePage(empty, {
		bible: bible(),
		stylePrompt: "",
		stage: "storyboard",
		projectRoot: store.root,
	});
	assert.equal(result.ok, false);
	assert.ok(result.issues.some((issue) => issue.includes("纯空镜")));
});
