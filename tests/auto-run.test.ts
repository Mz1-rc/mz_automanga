import { test } from "node:test";
import assert from "node:assert/strict";
import { MangaApp } from "../src/app.ts";
import { actionAutoRun } from "../src/actions.ts";
import { makeTestProject, tempDir } from "./helpers.ts";

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

test("actionAutoRun enables every gate and starts a run-all job", async () => {
	const { cwd, store } = makeTestProject();
	// A finished project lets runAll() exit immediately without invoking an agent.
	store.state.phase = "done";
	store.saveState();
	const app = new MangaApp(tempDir());

	const output = actionAutoRun(fakeCtx(cwd) as never, app);

	assert.match(output, /已开启全自动/);
	assert.match(output, /全自动运行/);
	assert.deepEqual(app.active?.project.gates, {
		script: "off",
		cast: "off",
		storyboard: "off",
		final: "off",
	});
	assert.equal(app.lastJob?.label, "全自动运行");
	for (let i = 0; i < 20 && app.isBusy(); i++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
	assert.equal(app.isBusy(), false);
});
