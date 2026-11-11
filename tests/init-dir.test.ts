import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { MangaApp } from "../src/app.ts";
import { actionInit } from "../src/actions.ts";
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
	const store = await actionInit(fakeCtx(cwd) as never, app, { scriptPath: scriptDir, style: "manga-bw" });
	assert.equal(store.project.title, basename(scriptDir));
	const script = store.readScript();
	assert.match(script, /雨落/);
	assert.match(script, /天晴/);
	assert.match(script, /# ===== 01\.md =====/);
	const manifest = JSON.parse(
		await import("node:fs").then((fs) => fs.readFileSync(join(store.root, "source", "inputs.json"), "utf8")),
	) as { fromDirectory: boolean; files: Array<{ rel: string }> };
	assert.equal(manifest.fromDirectory, true);
	assert.deepEqual(manifest.files.map((file) => file.rel), ["01.md", "act-1/02.txt"]);
});
