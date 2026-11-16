import { test } from "node:test";
import assert from "node:assert/strict";
import { MangaApp } from "../src/app.ts";
import { actionProvider, actionStatus } from "../src/actions.ts";
import { DEFAULT_ARK_MODEL, imageProviders } from "../src/imagegen/index.ts";
import { makeTestProject, tempDir } from "./helpers.ts";

interface FakeCtxOptions {
	hasUI?: boolean;
	select?: (title: string, options: string[]) => string | undefined;
	input?: (title: string, placeholder?: string) => string | undefined;
}

function fakeCtx(cwd: string, options: FakeCtxOptions = {}) {
	return {
		cwd,
		hasUI: options.hasUI ?? false,
		ui: {
			async select(title: string, choices: string[]) {
				return options.select ? options.select(title, choices) : choices[0];
			},
			async confirm() {
				return true;
			},
			async input(title: string, placeholder?: string) {
				return options.input ? options.input(title, placeholder) : undefined;
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

test("ark exposes selectable Seedream models", () => {
	const models = imageProviders.models("ark");
	assert.equal(models[0]?.id, DEFAULT_ARK_MODEL);
	assert.ok(models.length >= 4);
	assert.ok(models.some((model) => model.id === "doubao-seedream-5-0-lite-260128"));
	assert.ok(models.every((model) => model.id.startsWith("doubao-seedream-")));
});

test("provider ark uses the default model without UI and reports it in status", async () => {
	const { cwd } = makeTestProject();
	const app = new MangaApp(tempDir());
	const output = await actionProvider(fakeCtx(cwd) as never, app, "ark");
	assert.match(output, /doubao-seedream-5-5-261028/);
	assert.equal(app.active?.project.image.provider, "ark");
	assert.equal(app.active?.project.image.model, DEFAULT_ARK_MODEL);

	const status = actionStatus(fakeCtx(cwd) as never, app);
	assert.match(status, /绘制模型：ark\/doubao-seedream-5-5-261028/);
});

test("provider ark lets the user pick another model interactively", async () => {
	const { cwd } = makeTestProject();
	const app = new MangaApp(tempDir());
	let offered: string[] = [];
	const ctx = fakeCtx(cwd, {
		hasUI: true,
		select(_title, options) {
			offered = options;
			return options.find((option) => option.startsWith("doubao-seedream-5-0-lite-260128"));
		},
	});
	await actionProvider(ctx as never, app, "ark");
	assert.ok(offered.some((option) => option.includes("Seedream 5.0 Lite")));
	assert.ok(offered.some((option) => option.includes("自定义模型 id")));
	assert.equal(app.active?.project.image.provider, "ark");
	assert.equal(app.active?.project.image.model, "doubao-seedream-5-0-lite-260128");
});

test("provider ark accepts a custom model id interactively", async () => {
	const { cwd } = makeTestProject();
	const app = new MangaApp(tempDir());
	const ctx = fakeCtx(cwd, {
		hasUI: true,
		select(_title, options) {
			return options.find((option) => option.includes("自定义模型 id"));
		},
		input: () => "doubao-seedream-custom-000000",
	});
	await actionProvider(ctx as never, app, "ark");
	assert.equal(app.active?.project.image.model, "doubao-seedream-custom-000000");
});
