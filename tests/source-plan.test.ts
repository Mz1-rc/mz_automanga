import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MangaApp } from "../src/app.ts";
import { makeStyle } from "../src/config.ts";
import { createProject } from "../src/state.ts";
import { actionInit, actionNextUnit, actionSplitSource, actionUnits } from "../src/actions.ts";
import { validateAnalysis } from "../src/artifacts.ts";
import { readScriptInput, splitFileIntoUnits } from "../src/script-input.ts";
import { planScriptInput } from "../src/source-plan.ts";
import type { ScriptAnalysis } from "../src/types.ts";
import { tempDir } from "./helpers.ts";

function fakeCtx(cwd: string) {
	return {
		cwd,
		hasUI: false,
		ui: {
			async select() {
				return undefined;
			},
			async confirm() {
				return true;
			},
			async input() {
				return undefined;
			},
			async editor() {
				return undefined;
			},
			notify() {},
			setStatus() {},
			setWidget() {},
		},
	};
}

test("splitFileIntoUnits detects chapters and chunks oversized sections", () => {
	const text = "# 第一回 开端\n\n" + "甲".repeat(500) + "\n\n# 第二回 结尾\n\n" + "乙".repeat(500);
	const units = splitFileIntoUnits(text, "book.md", { maxUnitChars: 300 });
	assert.ok(units.length >= 4);
	assert.match(units[0].title, /第一回/);
	assert.match(units.at(-1)!.title, /第二回/);
	assert.ok(units.every((unit) => unit.chars <= 300));
	assert.ok(units.some((unit) => unit.kind === "chunk"));
});

test("planScriptInput keeps short scripts single and splits long ones", () => {
	const short = readScriptInput(join(writeSingle("短篇.md", "# 标题\n\n" + "短".repeat(200)), "短篇.md"));
	const shortPlan = planScriptInput(short, { maxUnitChars: 300, splitThresholdChars: 500 });
	assert.equal(shortPlan.plan.strategy, "single");
	assert.equal(shortPlan.plan.totalUnits, 1);

	const long = readScriptInput(join(writeSingle("长篇.md", "# 第一章\n\n" + "长".repeat(400) + "\n\n# 第二章\n\n" + "文".repeat(400)), "长篇.md"));
	const longPlan = planScriptInput(long, { maxUnitChars: 500, splitThresholdChars: 500 });
	assert.equal(longPlan.plan.strategy, "chaptered");
	assert.equal(longPlan.plan.totalUnits, 2);
	assert.match(longPlan.units[1].title, /第二章/);
});

test("actionInit auto-splits a large directory, creates a series and scopes the project", async () => {
	const cwd = tempDir();
	const agentDir = tempDir();
	const scripts = join(cwd, "chapters");
	mkdirSync(scripts, { recursive: true });
	for (let i = 1; i <= 3; i++) {
		writeFileSync(
			join(scripts, `第00${i}回.md`),
			`# 第${i}回 测试章节\n\n${`这是第${i}回的正文。`.repeat(6000)}\n`,
		);
	}
	const app = new MangaApp(agentDir);
	const store = await actionInit(fakeCtx(cwd) as never, app, {
		scriptPath: scripts,
		style: "manga-bw",
		adaptation: "strict",
	});
	const plan = JSON.parse(readFileSync(join(store.root, "source", "plan.json"), "utf8"));
	assert.equal(plan.strategy, "chaptered");
	assert.equal(plan.totalUnits, 3);
	assert.equal(store.project.source.unitId, "unit-001");
	assert.equal(store.project.source.totalUnits, 3);
	assert.ok(store.project.series);
	assert.ok(store.readScript().length < plan.totalChars);
	assert.match(actionUnits(fakeCtx(cwd) as never, app), /3 个单元/);

	const next = actionNextUnit(fakeCtx(cwd) as never, app);
	assert.match(next, /第2回/);
	assert.equal(app.active?.project.source.unitId, "unit-002");
	assert.equal(app.active?.project.series?.totalUnits, 3);
});

test("actionSplitSource migrates a legacy project that stored the whole book", async () => {
	const cwd = tempDir();
	const agentDir = tempDir();
	const scripts = join(cwd, "chapters");
	mkdirSync(scripts, { recursive: true });
	for (let i = 1; i <= 3; i++) {
		writeFileSync(join(scripts, `第00${i}回.md`), `# 第${i}回 测试章节\n\n${`这是第${i}回的正文。`.repeat(6000)}\n`);
	}
	const app = new MangaApp(agentDir);
	const input = readScriptInput(scripts, { maxUnitChars: app.baseConfig().source.maxUnitChars });
	const store = createProject(cwd, {
		title: "旧项目",
		style: makeStyle("manga-bw"),
		script: input.text,
		config: app.baseConfig(),
	});
	app.active = store;
	const message = actionSplitSource(fakeCtx(cwd) as never, app);
	assert.match(message, /切分为/);
	assert.ok(app.active?.project.source.plan);
	assert.ok(app.active?.project.series);
	assert.ok(existsSync(join(app.active!.root, "source", "script.full.md")));
	assert.ok(app.active!.readScript().length < input.text.length);
});

test("analysis scope rejects a partial read and accepts first/last quotes", () => {
	const source = "# 章\n\n开头的文字。\n\n中间段落。\n\n结尾的文字。";
	const base: ScriptAnalysis = {
		schemaVersion: 1,
		format: "novel",
		language: "zh",
		titleSuggestion: "测试",
		logline: "测试",
		pageEstimate: 2,
		scenes: [{ id: "s1", title: "一", summary: "一", characters: [], beats: ["节拍"] }],
		status: "clear",
		issues: [],
		assumptions: [],
	};
	const partial = { ...base, scope: { unitId: "unit-001", unitTitle: "章", charCount: 10, firstQuote: "开头的文字。", lastQuote: "中间段落。" } };
	assert.equal(validateAnalysis(partial, { unitId: "unit-001", sourceText: source }).ok, false);

	const full = { ...base, scope: { unitId: "unit-001", unitTitle: "章", charCount: 10, firstQuote: "开头的文字。", lastQuote: "结尾的文字。" } };
	assert.equal(validateAnalysis(full, { unitId: "unit-001", sourceText: source }).ok, true);

	const missing = validateAnalysis(base, { unitId: "unit-001", sourceText: source });
	assert.equal(missing.ok, false);
	assert.match(missing.issues.join("\n"), /scope/);
});

function writeSingle(name: string, content: string): string {
	const dir = tempDir();
	const path = join(dir, name);
	writeFileSync(path, content);
	return dir;
}
