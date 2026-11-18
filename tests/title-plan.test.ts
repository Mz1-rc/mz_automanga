import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeStyle } from "../src/config.ts";
import { buildStoryboardPlan } from "../src/page-plan.ts";
import { AUTO_TITLE_MAX_CHARS, AUTO_TITLE_PREVIEW_CHARS, createProject, deriveTitle, isAutoTitle } from "../src/state.ts";
import { makeTestProject, tempDir, testConfig } from "./helpers.ts";
import type { ScriptAnalysis } from "../src/types.ts";

test("automatic title uses a heading or label and stays within its bounded preview", () => {
	assert.equal(deriveTitle("# 雨落屋檐\n\n正文"), "雨落屋檐");
	assert.equal(deriveTitle("书名：雨落屋檐\n\n正文"), "雨落屋檐");
	const first = deriveTitle(`# ${"很长".repeat(30)}\n\n正文`);
	assert.ok(Array.from(first).length <= AUTO_TITLE_MAX_CHARS);

	const beyond = `${"填充".repeat(AUTO_TITLE_PREVIEW_CHARS)}\n\n# 预览之外`;
	const bounded = deriveTitle(beyond);
	assert.notEqual(bounded, "预览之外");
	assert.ok(Array.from(bounded).length <= AUTO_TITLE_MAX_CHARS);

	const cwd = tempDir();
	const config = testConfig();
	mkdirSync(cwd, { recursive: true });
	const store = createProject(cwd, {
		style: makeStyle("manga-bw"),
		script: "# 临时标题\n\n正文内容。",
		config,
	});
	assert.equal(store.project.title, "临时标题");
	assert.equal(store.project.titleSource, "auto");
	assert.equal(isAutoTitle(store.project, store.readScript()), true);
});

test("storyboard plan caps over-estimated pages and assigns every page a beat slice", () => {
	const { store } = makeTestProject();
	store.project.gates = { script: "off", cast: "off", storyboard: "off", final: "off" };
	const scenes = Array.from({ length: 12 }, (_, index) => ({
		id: `s${index + 1}`,
		title: `场景 ${index + 1}`,
		summary: "新信息",
		characters: [],
		beats: Array.from({ length: 6 }, (_, beat) => `节拍 ${index + 1}-${beat + 1}`),
	}));
	const analysis: ScriptAnalysis = {
		schemaVersion: 1,
		format: "novel",
		language: "zh",
		titleSuggestion: "山上的幸存者",
		logline: "幸存者",
		pageEstimate: 22,
		scenes,
		status: "clear",
		issues: [],
		assumptions: [],
	};
	// Keep the source short: the plan must not invent ten recap pages just because
	// analysis.pageEstimate is high.
	const plan = buildStoryboardPlan(analysis, "短剧本".repeat(100));
	assert.equal(plan.requestedPages, 22);
	assert.ok(plan.totalPages <= scenes.length, `totalPages=${plan.totalPages}`);
	assert.equal(plan.pages.length, plan.totalPages);
	let previousEnd = 0;
	for (const page of plan.pages) {
		assert.ok(page.beats.length > 0);
		assert.equal(page.beatStart, previousEnd + 1);
		previousEnd = page.beatEnd;
	}
	assert.equal(previousEnd, plan.totalBeats);
	assert.ok(plan.pages.every((page, index) => page.id === `page-${String(index + 1).padStart(3, "0")}`));
});
