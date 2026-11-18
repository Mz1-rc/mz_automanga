import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { MangaApp } from "../src/app.ts";
import { actionInit } from "../src/actions.ts";
import { buildTaskPrompt } from "../src/prompts.ts";
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

test("actionInit reads a directory of script files and records the input manifest", async () => {
	const cwd = tempDir();
	const agentDir = tempDir();
	const scriptDir = join(cwd, "chapters");
	mkdirSync(join(scriptDir, "act-1"), { recursive: true });
	writeFileSync(join(scriptDir, "01.md"), "# 一\n\n雨落。\n");
	writeFileSync(join(scriptDir, "act-1", "02.txt"), "# 二\n\n天晴。\n");
	const app = new MangaApp(agentDir);
	const store = await actionInit(fakeCtx(cwd) as never, app, {
		scriptPath: scriptDir,
		note: "请把重点放在姐妹关系上。",
		style: "manga-bw",
		adaptation: "strict",
	});
	assert.equal(store.project.title, basename(scriptDir));
	assert.equal(store.project.adaptation, "strict");
	assert.match(readFileSync(join(store.root, "source", "user-note.md"), "utf8"), /姐妹关系/);
	const analysisPrompt = buildTaskPrompt({
		role: "script_analyst",
		project: store.project,
		projectRoot: store.root,
		config: app.baseConfig(),
	});
	assert.match(analysisPrompt, /source\/user-note\.md/);
	const script = store.readScript();
	assert.match(script, /雨落/);
	assert.match(script, /天晴/);
	assert.match(script, /# ===== 01\.md =====/);
	const manifest = JSON.parse(
		await import("node:fs").then((fs) => fs.readFileSync(join(store.root, "source", "inputs.json"), "utf8")),
	) as { fromDirectory: boolean; note?: string; files: Array<{ rel: string }> };
	assert.equal(manifest.fromDirectory, true);
	assert.equal(manifest.note, "请把重点放在姐妹关系上。");
	assert.deepEqual(manifest.files.map((file) => file.rel), ["01.md", "act-1/02.txt"]);
});
