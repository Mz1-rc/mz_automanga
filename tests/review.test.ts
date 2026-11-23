import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MangaPipeline, type RoleRunner } from "../src/pipeline.ts";
import type { ImageProvider } from "../src/imagegen/index.ts";
import type { Bible, MangaPage, RoleRunOptions, RoleRunResult } from "../src/types.ts";
import { readJson, resolveWithin, writeJsonAtomic } from "../src/paths.ts";
import { fakeUi, makeTestProject, tinyPng, writeTinyPng } from "./helpers.ts";

function pageWithImages(): MangaPage {
	return {
		schemaVersion: 1,
		id: "page-001",
		index: 1,
		summary: "等待",
		layout: "3x1",
		panels: [1, 2, 3].map((n) => ({
			id: `panel-${String(n).padStart(2, "0")}`,
			shot: "medium",
			characters: [],
			action: "站在天台",
			dialogue: [
				{
					type: "speech",
					text: n === 1 ? "没来。" : `台词 ${n}`,
					bubble: { position: "top-left", shape: "rounded" },
				},
			],
			prompt: `medium shot on the roof, lettering "${n === 1 ? "没来。" : `台词 ${n}`}", no text other than the specified lettering`,
			image: {
				status: "done",
				file: `pages/page-001/panel-0${n}.png`,
				width: 10,
				height: 10,
			},
		})),
	};
}

function prepare(): {
	root: string;
	store: ReturnType<typeof makeTestProject>["store"];
	config: ReturnType<typeof makeTestProject>["config"];
} {
	const { store, config } = makeTestProject();
	const bible: Bible = {
		schemaVersion: 1,
		title: store.project.title,
		logline: "测试",
		genre: ["测试"],
		tone: "测试",
		audience: "测试",
		art: {
			preset: "manga-bw",
			stylePrompt: store.project.style.lockedTokens.join(", "),
			letteringStyle: "clean comic lettering",
			palette: ["#000000", "#ffffff"],
		},
		world: { locations: [] },
		cast: [],
	};
	writeJsonAtomic(join(store.root, "bible.json"), bible);
	const page = pageWithImages();
	store.writePage(page);
	for (const panel of page.panels) {
		writeTinyPng(resolveWithin(store.root, panel.image!.file!), 10, 10);
	}
	store.state.phase = "qa";
	store.saveState();
	return { root: store.root, store, config };
}

function fakeProvider(counter: { calls: number }): ImageProvider {
	return {
		id: "fake",
		async generate(request) {
			counter.calls += 1;
			writeFileSync(request.outPath, tinyPng(12, 12));
			return {
				file: request.outPath,
				width: 12,
				height: 12,
				bytes: tinyPng(12, 12).length,
				attempts: 1,
				size: request.size,
				ratio: request.ratio,
				format: "png",
			};
		},
	};
}

function reviewerRunner(options: {
	alwaysFail: boolean;
	reviewCalls: { value: number };
	onPrompt?: (prompt: string) => void;
}): RoleRunner {
	return async (run: RoleRunOptions): Promise<RoleRunResult> => {
		if (run.role !== "reviewer") throw new Error(`unexpected role ${run.role}`);
		options.reviewCalls.value += 1;
		options.onPrompt?.(run.taskPrompt);
		const target = run.targets[0];
		const pageId = run.pageId ?? "page-001";
		const failing = options.alwaysFail || options.reviewCalls.value === 1;
		writeJsonAtomic(resolveWithin(run.projectRoot, target), {
			schemaVersion: 1,
			reviewedAt: new Date().toISOString(),
			reviewed: [`${pageId}/panel-01`],
			issues: failing
				? [
						{
							panel: `${pageId}/panel-01`,
							severity: "major",
							type: "text",
							message: "气泡内「没来。」糊成一团，无法辨认",
							fix: "redraw the speech bubble with larger, clear Chinese lettering",
						},
					]
				: [],
			verdict: failing ? "needs-regen" : "pass",
		});
		return {
			finalText: "ok",
			usage: { input: 10, output: 5, total: 15, cost: 0 },
			outputs: run.targets,
			model: "test/model",
			thinkingLevel: "medium",
		};
	};
}

test("review reads generated images, redraws a failing panel, and writes a short report", async () => {
	const { root, store, config } = prepare();
	const ui = fakeUi();
	const reviewCalls = { value: 0 };
	const gens = { calls: 0 };
	let taskPrompt = "";
	const pipeline = new MangaPipeline({
		store,
		config,
		ui,
		agentDir: root,
		runner: reviewerRunner({ alwaysFail: false, reviewCalls, onPrompt: (prompt) => (taskPrompt = prompt) }),
		client: fakeProvider(gens),
	});

	await pipeline.reviewImages();

	assert.equal(reviewCalls.value, 2, "one review before and one after regeneration");
	assert.equal(gens.calls, 1, "the failing panel is regenerated once");
	assert.match(taskPrompt, /pages\/page-001\/panel-01\.png/, "review task lists the image to inspect");
	assert.match(taskPrompt, /应出现文字：没来。/, "review task gives the expected lettering");
	const summary = readJson<{ verdict: string; issues: unknown[]; reviewed: string[] }>(
		join(root, "qa", "review.json"),
	);
	assert.equal(summary?.verdict, "pass");
	assert.deepEqual(summary?.issues, []);
	assert.equal(summary?.reviewed.length, 3);
	const report = readFileSync(join(root, "qa", "review-report.md"), "utf8");
	assert.match(report, /结论：通过/);
	assert.ok(!ui.state.notes.some((note) => note.includes("糊成一团")), "problem details stay in the file, not chat");
	assert.match(ui.state.notes.join("\n"), /报告已写入 qa\/review-report\.md/);
});

test("review regenerates one panel at most three times, then reports the remaining issue", async () => {
	const { root, store, config } = prepare();
	const ui = fakeUi();
	const reviewCalls = { value: 0 };
	const gens = { calls: 0 };
	const pipeline = new MangaPipeline({
		store,
		config,
		ui,
		agentDir: root,
		runner: reviewerRunner({ alwaysFail: true, reviewCalls }),
		client: fakeProvider(gens),
	});

	await pipeline.reviewImages();

	assert.equal(gens.calls, 3, "no more than three regenerations per panel");
	assert.equal(reviewCalls.value, 4, "a final verification pass follows the third regeneration");
	const summary = readJson<{ verdict: string; issues: Array<{ panel: string }>; regenerated: string[] }>(
		join(root, "qa", "review.json"),
	);
	assert.equal(summary?.verdict, "needs-attention");
	assert.deepEqual(summary?.issues.map((issue) => issue.panel), ["page-001/panel-01"]);
	assert.deepEqual(summary?.regenerated, ["page-001/panel-01"]);
	const report = readFileSync(join(root, "qa", "review-report.md"), "utf8");
	assert.match(report, /仍有 1 个问题/);
	assert.match(report, /page-001\/panel-01 \[major\] text/);
	assert.ok(existsSync(join(root, "qa", "review.json")));
	assert.ok(!ui.state.notes.some((note) => note.includes("糊成一团")), "problem details stay in the file, not chat");
});
