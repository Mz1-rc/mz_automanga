import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgnesClient } from "../src/agnes.ts";
import { generatePanelImages } from "../src/images.ts";
import { MangaPipeline, type RoleRunner } from "../src/pipeline.ts";
import { composeStylePrompt } from "../src/config.ts";
import { fakeUi, makeTestProject, testConfig, tinyPng } from "./helpers.ts";
import type { Bible, MangaPage, MangaProject, RoleRunOptions, RoleRunResult } from "../src/types.ts";
import { readJson, resolveWithin, writeAtomic } from "../src/paths.ts";

async function startMockAgnes() {
	let base = "";
	let requests = 0;
	const png = tinyPng(10, 10);
	const server = createServer((req, res) => {
		if (req.method === "POST") {
			requests++;
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: [{ url: `${base}/img.png` }] }));
			});
			return;
		}
		if (req.url === "/img.png") {
			res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
			res.end(png);
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	base = `http://127.0.0.1:${address.port}`;
	return {
		url: base,
		get requests() {
			return requests;
		},
		close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
	};
}

function write(root: string, target: string, value: unknown): void {
	writeAtomic(resolveWithin(root, target), typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function fakeRunner(): RoleRunner {
	return async (options: RoleRunOptions): Promise<RoleRunResult> => {
		const project = readJson<MangaProject>(join(options.projectRoot, "project.json"));
		if (!project) throw new Error("missing project");
		const style = project.style;
		const pageTarget = options.targets.find((target) => target.startsWith("pages/"));
		switch (options.role) {
			case "script_analyst":
				write(options.projectRoot, "source/analysis.json", {
					schemaVersion: 1,
					format: "novel",
					language: "zh",
					titleSuggestion: project.title,
					logline: "她在天台等一个人。",
					pageEstimate: 1,
					readingDirection: "rtl",
					scenes: [
						{
							id: "s1",
							title: "天台",
							summary: "等待，雨停，离开。",
							location: "天台",
							time: "黄昏",
							characters: ["lin"],
							beats: ["等待", "雨停", "离开"],
						},
					],
					status: "clear",
					issues: [],
					assumptions: [],
				});
				write(options.projectRoot, "source/scenes.json", [{ id: "s1", title: "天台", summary: "等待", characters: ["lin"], beats: ["等待"] }]);
				break;
			case "director": {
				const bible: Bible = {
					schemaVersion: 1,
					title: project.title,
					logline: "她在天台等一个人。",
					genre: ["青春"],
					tone: "克制",
					audience: "青少年",
					art: {
						preset: style.preset,
						stylePrompt: composeStylePrompt(style),
						letteringStyle: "clean black comic lettering, rounded white speech bubbles with thin black outlines",
						palette: ["#141418", "#f0d2c2", "#a33b3b"],
					},
					world: { era: "当代", locations: [{ id: "roof", name: "天台", description: "积水与霓虹" }] },
					cast: [
						{
							id: "lin",
							name: "林澈",
							role: "protagonist",
							canonical:
								"seventeen-year-old Chinese girl, shoulder-length black hair with blunt bangs, dark grey eyes, slim build, navy school blazer and red ribbon",
							outfits: { default: "navy blazer, white shirt, red ribbon" },
							personality: "沉默",
							refSheet: "characters/lin/ref.png",
						},
					],
					assumptions: [],
				};
				write(options.projectRoot, "bible.json", bible);
				break;
			}
			case "character_designer": {
				const bible = readJson<Bible>(join(options.projectRoot, "bible.json"))!;
				bible.cast[0].refPrompt =
					"character reference sheet, three views, seventeen-year-old Chinese girl, black hair, navy blazer, neutral background, no watermark";
				write(options.projectRoot, "bible.json", bible);
				write(options.projectRoot, "characters/lin/ref.prompt.txt", bible.cast[0].refPrompt);
				break;
			}
			case "storyboard": {
				const page: MangaPage = {
					schemaVersion: 1,
					id: "page-001",
					index: 1,
					summary: "等待",
					layout: "3x1",
					panels: [1, 2, 3].map((n) => ({
						id: `panel-${String(n).padStart(2, "0")}`,
						shot: n === 1 ? "wide" : "medium",
						camera: { angle: "eye-level", lens: "24mm", tilt: "none" },
						location: "roof",
						time: "黄昏",
						characters: [{ id: "lin", outfit: "default", pose: "站着", expression: "平静", focus: "primary" as const }],
						action: "站在天台",
						background: "湿漉漉的天台",
						lighting: "蓝调时刻",
						mood: "空",
						composition: "人物在下三分之一",
						dialogue: [
							{
								type: "speech" as const,
								speaker: "lin",
								text: "没来。",
								emotion: "平静",
								bubble: { position: "top-left" as const, shape: "rounded" as const, tail: "bottom-right", size: "medium" as const },
							},
						],
						image: { status: "pending" as const },
					})),
				};
				write(options.projectRoot, pageTarget ?? "pages/page-001.json", page);
				break;
			}
			case "prompt_artist": {
				const page = readJson<MangaPage>(join(options.projectRoot, pageTarget ?? "pages/page-001.json"))!;
				for (const panel of page.panels) {
					const text = panel.dialogue[0].text;
					panel.promptCore = `${panel.shot} shot of LIN on the roof`;
					panel.lettering = {
						instructions: `One rounded white speech bubble at top-left containing "${text}" in clean black comic lettering.`,
					};
					panel.prompt = `${panel.promptCore}. Lettering (must be drawn into the image): one rounded white speech bubble at top-left containing the Simplified Chinese text "${text}" in clean black comic lettering. ${composeStylePrompt(style)}`;
					panel.negative = "garbled characters, misspelled characters, extra text, watermark, signature, blurry text";
					panel.refs = ["characters/lin/ref.png"];
				}
				write(options.projectRoot, pageTarget ?? "pages/page-001.json", page);
				break;
			}
			default:
				break;
		}
		return {
			finalText: "ok",
			usage: { input: 10, output: 5, total: 15, cost: 0 },
			outputs: options.targets,
			model: "test/model",
			thinkingLevel: "medium",
		};
	};
}

test("pipeline runs end-to-end with a fake runner and mock Agnes, then skips cached panels", async () => {
	const mock = await startMockAgnes();
	const { cwd, store, config } = makeTestProject({ config: testConfig({ qa: { vision: false, repairRounds: 0 } }) });
	store.project.gates = { script: "off", cast: "off", storyboard: "off", final: "off" };
	store.saveProject();
	const client = new AgnesClient({
		baseUrl: mock.url,
		apiKey: "test",
		model: "agnes-image-2.5-flash",
		timeoutMs: 5000,
		retries: 0,
		maxDownloadBytes: 1024 * 1024,
		streamChunkBytes: 16 * 1024,
	});
	const ui = fakeUi();
	try {
		const pipeline = new MangaPipeline({ store, config, ui, agentDir: cwd, runner: fakeRunner(), client });
		await pipeline.runAll(40);
		const reloaded = store;
		assert.equal(reloaded.state.phase, "done", `phase=${reloaded.state.phase} notes=${ui.state.notes.join(" | ")}`);
		assert.equal(reloaded.state.stats.pages, 1);
		assert.equal(reloaded.state.stats.panels, 3);
		assert.equal(reloaded.state.stats.images, 3);
		const page = reloaded.readPage(1);
		assert.ok(page?.panels.every((panel) => panel.image?.status === "done"));
		assert.ok(page?.panels.every((panel) => panel.prompt?.includes("没来。")));
		for (let n = 1; n <= 3; n++) {
			assert.ok(existsSync(join(reloaded.root, "pages", "page-001", `panel-0${n}.png`)));
		}
		assert.ok(existsSync(join(reloaded.root, "exports", `${reloaded.project.slug}.cbz`)));
		assert.equal(mock.requests, 4);

		const second = await generatePanelImages({
			store: reloaded,
			config,
			client,
			force: false,
		});
		assert.equal(second.done, 0);
		assert.equal(second.skipped, 3);
	} finally {
		await mock.close();
	}
});

test("script gate records assumptions when the user chooses to continue", async () => {
	const { cwd, store, config } = makeTestProject({ config: testConfig({ qa: { vision: false, repairRounds: 0 } }) });
	write(store.root, "source/analysis.json", {
		schemaVersion: 1,
		format: "novel",
		language: "zh",
		titleSuggestion: store.project.title,
		logline: "l",
		pageEstimate: 1,
		scenes: [{ id: "s1", title: "天台", summary: "等待", characters: ["lin"], beats: ["等待"] }],
		status: "needs_clarification",
		issues: [
			{
				id: "Q1",
				severity: "blocker",
				question: "她等的是谁？",
				options: ["哥哥", "同学"],
				assumption: "按已故的哥哥处理。",
			},
		],
		assumptions: [],
	});
	store.state.phase = "script_gate";
	store.saveState();
	const ui = fakeUi({ selectHandler: (_title, options) => options.find((option) => option.includes("按建议假设")) ?? options[0] });
	ui.hasUI = true;
	const pipeline = new MangaPipeline({ store, config, ui, agentDir: cwd, runner: fakeRunner() });
	await pipeline.next();
	assert.equal(store.state.phase, "design");
	assert.ok(existsSync(join(store.root, "source", "clarifications.md")));
	assert.match(readFileSync(join(store.root, "source", "clarifications.md"), "utf8"), /按已故的哥哥处理/);
});
