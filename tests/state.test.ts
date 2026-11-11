import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeTestProject, reloadStore, testConfig, writeTinyPng } from "./helpers.ts";
import { listProjects, ProjectStore } from "../src/state.ts";
import { fileExists } from "../src/paths.ts";

test("createProject writes project/state/script and starts at script_analysis", () => {
	const { store, cwd, config } = makeTestProject();
	assert.equal(store.state.phase, "script_analysis");
	assert.ok(existsSync(join(store.root, "project.json")));
	assert.ok(existsSync(join(store.root, "state.json")));
	assert.ok(existsSync(join(store.root, "source", "script.md")));
	assert.equal(store.project.source.file, "source/script.md");
	assert.equal(store.project.style.preset, "manga-bw");
	const projects = listProjects(cwd, config);
	assert.equal(projects.length, 1);
	assert.equal(projects[0].slug, store.project.slug);
});

test("phase transitions follow the allowed graph", () => {
	const { store } = makeTestProject();
	store.transition("design");
	assert.equal(store.state.phase, "design");
	assert.throws(() => store.transition("final_gate"), /非法阶段迁移/);
	store.transition("cast");
	store.transition("paused");
	assert.equal(store.state.phase, "paused");
	store.resume();
	assert.equal(store.state.phase, "cast");
});

test("gates record status and can be reset from a point", () => {
	const { store } = makeTestProject();
	store.recordGate("script", "approved");
	assert.equal(store.gate("script").status, "approved");
	store.resetGatesFrom("cast");
	assert.equal(store.gate("script").status, "approved");
	assert.equal(store.gate("cast").status, "pending");
	assert.equal(store.gate("storyboard").status, "pending");
});

test("lock prevents a second store from running concurrently", () => {
	const { store, cwd } = makeTestProject({ config: testConfig() });
	store.acquireLock("script_analyst");
	const second = ProjectStore.loadByPath(store.root);
	assert.throws(() => second.acquireLock("director"), /另一个会话正在运行/);
	store.releaseLock();
	const third = ProjectStore.loadByPath(store.root);
	third.acquireLock("director");
	third.releaseLock();
	assert.ok(existsSync(join(cwd, ".automanga")));
});

test("refreshStats counts pages, panels and images", () => {
	const { store } = makeTestProject();
	for (let index = 1; index <= 2; index++) {
		const pageId = `page-${String(index).padStart(3, "0")}`;
		store.writePage({
			schemaVersion: 1,
			id: pageId,
			index,
			summary: "s",
			panels: [1, 2, 3].map((n) => ({
				id: `panel-${String(n).padStart(2, "0")}`,
				shot: "wide",
				characters: [],
				action: "a",
				dialogue: [],
				image: n === 1 ? { status: "done" as const, file: `pages/${pageId}/panel-01.png` } : { status: "pending" as const },
			})),
		});
	}
	const stats = store.refreshStats();
	assert.equal(stats.pages, 2);
	assert.equal(stats.panels, 6);
	assert.equal(stats.images, 2);
	assert.equal(store.state.stats.panels, 6);
});

test("interrupted runs are marked when no live lock exists", () => {
	const { store } = makeTestProject();
	store.state.runs.push({
		id: "r1",
		role: "director",
		phase: "design",
		status: "running",
		startedAt: new Date().toISOString(),
		inputFiles: [],
		outputFiles: [],
	});
	store.saveState();
	const reloaded = reloadStore(store);
	assert.equal(reloaded.state.runs[0].status, "interrupted");
});

test("writeStaticImage helper creates a readable png", () => {
	const { store } = makeTestProject();
	const path = join(store.root, "pages", "page-001", "panel-01.png");
	writeTinyPng(path);
	assert.ok(fileExists(path));
});
