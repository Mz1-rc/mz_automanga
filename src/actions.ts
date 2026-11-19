import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { composeStylePrompt, makeStyle, STYLE_PRESETS, type MangaConfig } from "./config.ts";
import { createProviderFromConfig } from "./imagegen-adapter.ts";
import { resolveProviderKey, maskKey, saveProviderKey } from "./keys.ts";
import { imageProviders } from "./imagegen/index.ts";
import { ensureDir, listDirs, resolveWithin, writeAtomic, writeJsonAtomic } from "./paths.ts";
import { MangaPipeline, gateIdForPhase, isRole, roleForPhase, roleLabel, pipelineSummary, type PipelineUi } from "./pipeline.ts";
import type { ImageArchiveFormat } from "./export.ts";
import { ensureProjectWebPreviews } from "./previews.ts";
import { listProjects, ProjectStore } from "./state.ts";
import { characterRefSettings, collectCharacterRefSources, importCharacterRefs } from "./character-refs.ts";
import { readScriptInput } from "./script-input.ts";
import { ADAPTATION_INFO, ADAPTATION_LEVELS, ROLE_IDS, type AdaptationLevel, type CharacterRefMode, type RoleId, type StylePreset, type StyleSelection } from "./types.ts";
import { updateStatus, notify, phaseLabel, formatDuration, formatTokens } from "./ui.ts";
import { startWebServer, type WebServerHandle } from "./web/server.ts";

export interface ActionCtx {
	cwd: string;
	hasUI: boolean;
	mode?: string;
	model?: unknown;
	modelRegistry?: { find(provider: string, id: string): unknown; getAvailable(): Array<{ id: string; provider: string }> };
	ui: {
		select(title: string, options: string[], options?: unknown): Promise<string | undefined>;
		confirm(title: string, message: string, options?: unknown): Promise<boolean>;
		input(title: string, placeholder?: string, options?: unknown): Promise<string | undefined>;
		editor(title: string, prefill?: string, options?: unknown): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
		setWidget(key: string, lines: string[] | undefined): void;
	};
}

interface AppLike {
	agentDir: string;
	active?: ProjectStore;
	baseConfig(): MangaConfig;
	configFor(cwd: string, store: ProjectStore): MangaConfig;
	ensure(cwd: string, slug?: string): { store: ProjectStore; config: MangaConfig };
	create(cwd: string, input: { title?: string; style: StyleSelection; script: string }): {
		store: ProjectStore;
		config: MangaConfig;
	};
	list(cwd: string): ReturnType<typeof listProjects>;
	isBusy(): boolean;
	busyMessage(): string;
	startJob(label: string, runner: (controller: AbortController) => Promise<void>): unknown;
	abortCurrent(): boolean;
}

let webHandle: WebServerHandle | undefined;

export async function stopWebServer(): Promise<void> {
	if (!webHandle) return;
	const handle = webHandle;
	webHandle = undefined;
	await handle.close().catch(() => undefined);
}

function uiFor(ctx: ActionCtx, app: AppLike): PipelineUi {
	return {
		hasUI: ctx.hasUI,
		select: (title, options) => ctx.ui.select(title, options),
		confirm: (title, message) => ctx.ui.confirm(title, message),
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
		editor: (title, prefill) => ctx.ui.editor(title, prefill ?? ""),
		notify: (message, type) => ctx.ui.notify(message, type),
		updateStatus: (store, status, usage) => {
			if (status) app.updateJobStatus({ ...status, usage: usage ? { ...usage } : undefined });
			updateStatus(ctx as never, store, { ...app.statusSnapshot(), webUrl: webHandle?.url }, usage);
		},
	};
}

function refreshStatus(ctx: ActionCtx, app: AppLike, store: ProjectStore): void {
	updateStatus(ctx as never, store, { ...app.statusSnapshot(), webUrl: webHandle?.url });
}

export function resolveModelFor(ctx: ActionCtx, id?: string): unknown {
	if (!id) return ctx.model;
	const [provider, modelId] = id.includes("/") ? id.split("/", 2) : [undefined, id];
	try {
		if (provider && ctx.modelRegistry) return ctx.modelRegistry.find(provider, modelId) ?? ctx.model;
		const available = ctx.modelRegistry?.getAvailable() ?? [];
		return available.find((model) => model.id === modelId) ?? ctx.model;
	} catch {
		return ctx.model;
	}
}

function makePipeline(ctx: ActionCtx, app: AppLike, store: ProjectStore, config: MangaConfig, signal?: AbortSignal): MangaPipeline {
	return new MangaPipeline({
		store,
		config,
		ui: uiFor(ctx, app),
		agentDir: app.agentDir,
		signal,
		resolveModel: (id) => resolveModelFor(ctx, id),
	});
}

function startBackground(
	ctx: ActionCtx,
	app: AppLike,
	label: string,
	fn: (pipeline: MangaPipeline, store: ProjectStore) => Promise<void>,
): string {
	if (app.isBusy()) throw new Error(app.busyMessage());
	app.ensure(ctx.cwd);
	app.startJob(label, async (controller) => {
		const { store, config } = app.ensure(ctx.cwd);
		const pipeline = makePipeline(ctx, app, store, config, controller.signal);
		try {
			await fn(pipeline, store);
		} catch (error) {
			if (!controller.signal.aborted) {
				notify(ctx as never, error instanceof Error ? error.message : String(error), "error");
			}
		} finally {
			pipeline.finishStatus();
			refreshStatus(ctx, app, store);
		}
	});
	return `⏳ 已启动后台任务：${label}。使用 /manga status 查看进度。`;
}

// ---------------------------------------------------------------------------
// init / status
// ---------------------------------------------------------------------------

const STYLE_LABELS: Array<{ label: string; preset: StylePreset }> = [
	{ label: "黑白漫画", preset: "manga-bw" },
	{ label: "全彩国漫", preset: "manhua-color" },
	{ label: "竖屏条漫", preset: "webtoon" },
	{ label: "自定义", preset: "custom" },
];

function presetFromLabel(label: string): StylePreset {
	return STYLE_LABELS.find((item) => item.label === label)?.preset ?? "manga-bw";
}

function adaptationFromValue(value?: string): AdaptationLevel | undefined {
	const text = value?.trim();
	if (!text) return undefined;
	const lower = text.toLowerCase();
	if ((ADAPTATION_LEVELS as readonly string[]).includes(lower)) return lower as AdaptationLevel;
	return ADAPTATION_LEVELS.find((level) => ADAPTATION_INFO[level].label === text);
}

function adaptationLabel(level: AdaptationLevel | undefined): string {
	return level ? ADAPTATION_INFO[level].label : "未选择（首次剧本分析前询问）";
}

function refModeFromValue(value?: string): CharacterRefMode | undefined {
	const text = value?.trim().toLowerCase();
	if (!text) return undefined;
	if (["direct", "直接用", "直接使用", "原图"].includes(text)) return "direct";
	if (["restyle", "style", "跟随画风", "跟随画风改造", "改造", "重绘"].includes(text)) return "restyle";
	return undefined;
}

export interface InitInput {
	title?: string;
	/** A single script file or a directory of text files. */
	scriptPath?: string;
	/** Optional user note saved as a reference for script analysis. */
	note?: string;
	/** Optional character reference image file or directory. */
	refs?: string;
	/** How imported character references are used: direct or restyle. */
	refMode?: string;
	style?: string;
	customPrompt?: string;
	ratio?: StyleSelection["ratio"];
	adaptation?: string;
}

export async function actionInit(ctx: ActionCtx, app: AppLike, input: InitInput): Promise<ProjectStore> {
	let scriptPath = input.scriptPath?.trim() ?? "";
	if (!scriptPath && ctx.hasUI) {
		scriptPath =
			(await ctx.ui.input("剧本文件或目录路径", "./script.md 或 ./chapters/"))?.trim() ?? "";
		if (!scriptPath) throw new Error("已取消创建");
	}
	if (!scriptPath) throw new Error("请提供剧本文件或目录：/manga init --script <文件|目录>");

	// 剧本路径来自用户，允许绝对路径；相对路径按会话工作目录解析。
	const absPath = isAbsolute(scriptPath) ? scriptPath : resolve(ctx.cwd, scriptPath);
	const scriptInput = readScriptInput(absPath);
	const script = scriptInput.text;

	let title = input.title?.trim();
	let titleSource: "user" | "auto" | "directory" | undefined = title ? "user" : undefined;
	if (!title && scriptInput.fromDirectory) {
		title = basename(absPath);
		titleSource = "directory";
	}
	if (!title && ctx.hasUI) {
		title = (await ctx.ui.input("书名（可留空，自动根据剧本内容取名）", ""))?.trim();
		titleSource = title ? "user" : "auto";
	}

	let note = input.note?.trim();
	if (note === undefined && ctx.hasUI) {
		note = (await ctx.ui.input("初始备注（可留空，会作为剧本分析参考）", ""))?.trim();
	}

	let refsPath = input.refs?.trim();
	let hasRefs = refsPath !== undefined ? Boolean(refsPath) : false;
	if (input.refs === undefined && ctx.hasUI) {
		hasRefs = await ctx.ui.confirm("角色参考图", "是否有角色参考图？");
	}
	if (hasRefs && !refsPath && ctx.hasUI) {
		refsPath = (await ctx.ui.input("角色参考图路径（单张图片或目录）", "./refs/ 或 ./character.png"))?.trim();
	}
	if (hasRefs && !refsPath) throw new Error("已选择角色参考图，但没有提供路径");
	if (refsPath) refsPath = isAbsolute(refsPath) ? refsPath : resolve(ctx.cwd, refsPath);
	const refSources = hasRefs ? collectCharacterRefSources(refsPath!) : [];
	let refMode = refModeFromValue(input.refMode);
	if (input.refMode && !refMode) throw new Error(`未知参考图改造程度：${input.refMode}`);
	if (hasRefs) {
		if (!refMode && ctx.hasUI) {
			const choice = await ctx.ui.select("参考图改造程度", [
				"直接使用（不重画）",
				"跟随画风改造（重绘为设定图）",
			]);
			if (!choice) throw new Error("已取消参考图设置");
			refMode = choice.startsWith("直接") ? "direct" : "restyle";
		}
		refMode ??= "restyle";
	}

	const config = app.baseConfig();
	let style: StyleSelection | undefined;
	if (input.style) {
		const preset = (Object.keys(STYLE_PRESETS) as StylePreset[]).includes(input.style as StylePreset)
			? (input.style as StylePreset)
			: presetFromLabel(input.style);
		style = makeStyle(preset, input.customPrompt, input.ratio);
	} else if (ctx.hasUI) {
		const choice = await ctx.ui.select(
			"选择画风",
			STYLE_LABELS.map((item) => item.label),
		);
		if (!choice) throw new Error("已取消创建");
		const preset = presetFromLabel(choice);
		let customPrompt: string | undefined;
		let ratio: StyleSelection["ratio"] | undefined;
		if (preset === "custom") {
			customPrompt = (await ctx.ui.editor("画风描述（英文或中文均可）", ""))?.trim();
			if (!customPrompt) throw new Error("自定义画风需要提供描述");
		}
		const ratioChoice = await ctx.ui.select("画面比例", ["3:4（竖版漫画）", "2:3（偏长）", "9:16（条漫）", "1:1（方形）", "16:9（横版）"]);
		if (ratioChoice?.startsWith("2:3")) ratio = "2:3";
		else if (ratioChoice?.startsWith("9:16")) ratio = "9:16";
		else if (ratioChoice?.startsWith("1:1")) ratio = "1:1";
		else if (ratioChoice?.startsWith("16:9")) ratio = "16:9";
		else ratio = "3:4";
		style = makeStyle(preset, customPrompt, ratio);
	} else {
		style = makeStyle(config.style);
	}

	let adaptation = adaptationFromValue(input.adaptation);
	if (!adaptation && input.adaptation) throw new Error(`未知改编等级：${input.adaptation}`);
	if (!adaptation && ctx.hasUI) {
		const choice = await ctx.ui.select(
			"剧本整理与分镜改编程度",
			ADAPTATION_LEVELS.map((level) => ADAPTATION_INFO[level].label),
		);
		if (!choice) throw new Error("已取消创建");
		adaptation = adaptationFromValue(choice);
	}

	const { store } = app.create(ctx.cwd, { title, titleSource, style, adaptation, script });
	if (note) {
		writeAtomic(join(store.root, "source", "user-note.md"), `# 用户初始备注\n\n${note}\n`);
	}
	const manifest = refSources.length && refMode ? importCharacterRefs(store.root, refSources, refMode, refsPath!) : undefined;
	if (manifest && refMode) {
		store.project.characterRefs = characterRefSettings(refMode, refsPath!);
		store.saveProject();
	}
	writeJsonAtomic(join(store.root, "source", "inputs.json"), {
		inputPath: absPath,
		fromDirectory: scriptInput.fromDirectory,
		files: scriptInput.files,
		...(note ? { note } : {}),
		...(manifest && refMode
			? {
					characterRefs: {
						mode: refMode,
						inputPath: refsPath,
						files: manifest.files,
					},
				}
			: {}),
	});
	const refSummary = manifest
		? `，角色参考图 ${manifest.files.length} 张（${refMode === "direct" ? "直接使用" : "跟随画风改造"}）`
		: "";
	notify(
		ctx as never,
		`已创建《${store.project.title}》（${store.project.style.label}，${store.project.style.ratio}，改编：${adaptationLabel(store.project.adaptation)}，${scriptInput.files.length} 个输入文件${refSummary}）。运行 /manga next 开始剧本分析。`,
		"info",
	);
	refreshStatus(ctx, app, store);
	return store;
}

export function actionStatus(ctx: ActionCtx, app: AppLike): string {
	try {
		const { store } = app.ensure(ctx.cwd);
		refreshStatus(ctx, app, store);
		const job = app.statusSnapshot();
		const lines = [
			pipelineSummary(store),
			`画风：${store.project.style.label} · ${store.project.style.ratio} · ${store.project.style.preset}`,
			`绘制模型：${describeDrawingModel(store.project.image)}`,
			`改编：${adaptationLabel(store.project.adaptation)}`,
			`目录：${store.root}`,
			webHandle ? `Web：${webHandle.url}（${webHandle.host}:${webHandle.port}）` : "Web：未启动（/manga web start --port <端口>）",
		];
		if (job) {
			const end = job.done ? (job.endedAt ?? Date.now()) : Date.now();
			const elapsed = job.startedAt ? formatDuration(end - job.startedAt) : "";
			const step = job.step && job.total ? ` · ${job.step}/${job.total}` : "";
			lines.push(
				`任务：${job.label}${job.done ? "（已结束）" : "（运行中）"}${elapsed ? ` · ${elapsed}` : ""}${job.stage ? ` · ${job.stage}` : ""}${job.role ? ` · ${job.role}` : ""}${step}`,
			);
			if (job.detail) lines.push(`当前：${job.detail}`);
			if (job.lastTool) lines.push(`最近工具：${job.lastTool}`);
			if (job.usage && (job.usage.input || job.usage.output)) {
				lines.push(`本角色 Token：入 ${formatTokens(job.usage.input)} / 出 ${formatTokens(job.usage.output)}`);
			}
			if (job.contextTokens !== undefined) {
				const percent = job.contextPercent !== undefined ? ` · ${Math.round(job.contextPercent)}%` : "";
				lines.push(`上下文：${formatTokens(job.contextTokens)}${percent}`);
			}
			if (job.error) lines.push(`任务错误：${job.error}`);
		}
		if (store.state.pendingQuestions?.length) {
			lines.push(`待确认问题：${store.state.pendingQuestions.length}（运行 /manga next）`);
		}
		if (store.state.lastError?.message) lines.push(`上次错误：${store.state.lastError.message}`);
		return lines.join("\n");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

// ---------------------------------------------------------------------------
// pipeline actions
// ---------------------------------------------------------------------------

export function actionNext(ctx: ActionCtx, app: AppLike): string {
	return startBackground(ctx, app, "推进下一阶段", (pipeline) => pipeline.next());
}

export function actionStep(ctx: ActionCtx, app: AppLike): string {
	return startBackground(ctx, app, "运行下一步", (pipeline) => pipeline.next());
}

export function actionRunAll(ctx: ActionCtx, app: AppLike): string {
	return startBackground(ctx, app, "全自动运行", (pipeline) => pipeline.runAll());
}

export function actionRunRole(ctx: ActionCtx, app: AppLike, roleArg: string): string {
	const role = roleArg.trim();
	if (!isRole(role)) throw new Error(`未知角色：${roleArg}。可用：${ROLE_IDS.join(", ")}`);
	const { store } = app.ensure(ctx.cwd);
	const expected = roleForPhase(store.state.phase);
	return startBackground(ctx, app, `运行 ${roleLabel(role)}`, async (pipeline) => {
		if (expected && expected !== role) {
			notify(ctx as never, `当前阶段应运行 ${roleLabel(expected)}，而不是 ${roleLabel(role)}；仍按请求执行。`, "warning");
		}
		await pipeline.runSpecificRole(role);
	});
}

export function actionApprove(ctx: ActionCtx, app: AppLike, feedback?: string): string {
	const { store } = app.ensure(ctx.cwd);
	if (!gateIdForPhase(store.state.phase)) throw new Error(`当前阶段「${phaseLabel(store.state.phase)}」不是闸门`);
	return startBackground(ctx, app, "通过闸门", (pipeline) => pipeline.approveCurrentGate(feedback));
}

export function actionRevise(ctx: ActionCtx, app: AppLike, feedback: string): string {
	if (!feedback.trim()) throw new Error("请提供修改意见：/manga revise <意见>");
	const { store } = app.ensure(ctx.cwd);
	if (!gateIdForPhase(store.state.phase)) throw new Error(`当前阶段「${phaseLabel(store.state.phase)}」不是闸门`);
	return startBackground(ctx, app, "按意见重做", (pipeline) => pipeline.reviseCurrentGate(feedback.trim()));
}

export function actionPause(ctx: ActionCtx, app: AppLike): string {
	const { store } = app.ensure(ctx.cwd);
	store.pause();
	refreshStatus(ctx, app, store);
	return "已暂停。使用 /manga resume 恢复。";
}

export function actionResume(ctx: ActionCtx, app: AppLike): string {
	const { store } = app.ensure(ctx.cwd);
	store.resume();
	refreshStatus(ctx, app, store);
	return `已恢复：${phaseLabel(store.state.phase)}。`;
}

export function actionAbort(ctx: ActionCtx, app: AppLike): string {
	const aborted = app.abortCurrent();
	return aborted ? "已请求中止当前任务。" : "当前没有运行中的任务。";
}

// ---------------------------------------------------------------------------
// web
// ---------------------------------------------------------------------------

export interface WebActionOptions {
	/** start | stop | status | restart */
	action?: "start" | "stop" | "status" | "restart";
	host?: string;
	port?: number;
	open?: boolean;
}

export function actionWebStatus(): string {
	if (!webHandle) return "Web 预览未启动。使用 /manga web start --port <1–65535> 启动。";
	return [
		`Web 预览运行中：${webHandle.url}`,
		`绑定：${webHandle.host}:${webHandle.port}`,
		"模式：只读（仅 GET/HEAD，无写接口、无鉴权；同一网络内可访问）",
	].join("\n");
}

export async function actionWeb(
	ctx: ActionCtx,
	app: AppLike,
	pi: { exec?: (command: string, args: string[], options?: unknown) => Promise<unknown> },
	options: WebActionOptions = {},
): Promise<string> {
	const action = options.action ?? "start";
	if (action === "status") return actionWebStatus();
	if (action === "stop") {
		if (!webHandle) return "Web 预览未启动。";
		const url = webHandle.url;
		await stopWebServer();
		try {
			const { store } = app.ensure(ctx.cwd, undefined);
			refreshStatus(ctx, app, store);
		} catch {
			// no project: nothing to repaint
		}
		return `已停止 Web 预览（原地址 ${url}）。`;
	}
	if (action === "restart" && webHandle) {
		await stopWebServer();
	}

	let config = app.baseConfig();
	let store: ProjectStore | undefined;
	try {
		({ store, config } = app.ensure(ctx.cwd));
	} catch {
		// no project yet: use global config
	}
	const host = options.host ?? config.web.host;
	const port = options.port ?? config.web.port;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("Web 端口必须手动指定：/manga web start --port <1–65535>。不会随机分配，也不会自动换端口。");
	}
	if (webHandle) {
		const current = `${webHandle.host}:${webHandle.port}`;
		if (webHandle.port !== port || webHandle.host !== host) {
			throw new Error(`Web 已在 ${current} 运行。请先 /manga web stop，或用 /manga web restart --port <端口>。`);
		}
		if (options.open) await openBrowser(pi, webHandle.url);
		return `Web 预览已在运行：${webHandle.url}`;
	}
	if (store) {
		// Compression happens here (not in an HTTP handler), keeping Web read-only.
		notify(ctx as never, "正在准备 <500 KB 的 Web 预览图…", "info");
		const previews = ensureProjectWebPreviews(store);
		if (previews.created || previews.failed) {
			notify(
				ctx as never,
				`Web 预览图：新生成 ${previews.created}，跳过 ${previews.skipped}${previews.failed ? `，失败 ${previews.failed}` : ""}。`,
				previews.failed ? "warning" : "info",
			);
		}
	}
	const handle = await startWebServer({ cwd: ctx.cwd, config, host, port });
	webHandle = handle;
	if (options.open ?? config.web.open) await openBrowser(pi, handle.url);
	if (store) refreshStatus(ctx, app, store);
	return `Web 预览：${handle.url}\n绑定：${handle.host}:${handle.port}\n模式：只读（仅 GET/HEAD，无写接口、无鉴权；同一网络内可访问）`;
}

async function openBrowser(
	pi: { exec?: (command: string, args: string[], options?: unknown) => Promise<unknown> },
	url: string,
): Promise<void> {
	if (!pi.exec) return;
	const candidates: Array<[string, string[]]> = [
		["xdg-open", [url]],
		["open", [url]],
	];
	for (const [command, args] of candidates) {
		try {
			await pi.exec(command, args, { timeout: 5000 });
			return;
		} catch {
			// try next
		}
	}
}

// ---------------------------------------------------------------------------
// panels / cast / prompts
// ---------------------------------------------------------------------------

export function normalizePanelKey(input: string): string {
	const trimmed = input.trim();
	const match = /^(?:page-)?(\d{1,3})[\/\s-]+(?:panel-)?(\d{1,2})$/.exec(trimmed) ?? /^(page-\d{3})\/(panel-\d{2})$/.exec(trimmed);
	if (!match) throw new Error(`无效的格子：${input}（示例：page-001/panel-02）`);
	const page = Number(match[1].replace(/\D/g, ""));
	const panel = Number(match[2].replace(/\D/g, ""));
	return `page-${String(page).padStart(3, "0")}/panel-${String(panel).padStart(2, "0")}`;
}

export function actionRegen(ctx: ActionCtx, app: AppLike, keyInput: string, note?: string, final = false): string {
	const key = normalizePanelKey(keyInput);
	return startBackground(ctx, app, `重画 ${key}`, (pipeline) => pipeline.regenerate(key, note, final));
}

export function actionCast(ctx: ActionCtx, app: AppLike, options: { regen?: boolean; id?: string } = {}): string {
	const { store } = app.ensure(ctx.cwd);
	const bible = store.readBible();
	if (!bible) throw new Error("bible.json 缺失");
	if (options.regen) {
		return startBackground(ctx, app, options.id ? `重生成角色 ${options.id} 的立绘` : "重生成角色立绘", async (pipeline) => {
			await pipeline.runCharacterImages(true, options.id);
		});
	}
	const lines = [
		`角色（${bible.cast.length}）：`,
		...bible.cast.map((member) => {
			const rel = member.refSheet || `characters/${member.id}/ref.png`;
			const hasRef = existsSync(join(store.root, rel));
			return `- ${member.id} · ${member.name} · ${member.role} · 立绘${hasRef ? "✔" : "✗"}${rel}`;
		}),
		`目录：${join(store.root, "characters")}`,
	];
	return lines.join("\n");
}

export function actionPrompt(ctx: ActionCtx, app: AppLike, keyInput: string): string {
	const key = normalizePanelKey(keyInput);
	const { store } = app.ensure(ctx.cwd);
	const [pageId, panelId] = key.split("/");
	const page = store.readPageByKey(pageId);
	const panel = page?.panels.find((item) => item.id === panelId);
	if (!panel) throw new Error(`找不到格子 ${key}`);
	return [
		`${key} · ${panel.shot} · ${panel.characters.map((character) => character.id).join(", ") || "无角色"}`,
		`refs: ${(panel.refs ?? []).join(", ") || "无"}`,
		"",
		panel.prompt ?? "（尚未生成 prompt）",
	].join("\n");
}

export function actionExport(ctx: ActionCtx, app: AppLike, format: ImageArchiveFormat = "zip"): string {
	return startBackground(ctx, app, `导出 ${format.toUpperCase()}`, (pipeline) => pipeline.exportNow(format));
}

export function actionCompress(ctx: ActionCtx, app: AppLike): string {
	return startBackground(ctx, app, "压缩 Web 预览图", (pipeline) => pipeline.compressWebImages());
}

export function actionQa(ctx: ActionCtx, app: AppLike): string {
	const { store } = app.ensure(ctx.cwd);
	if (!["image_gen", "qa", "repair", "build"].includes(store.state.phase)) {
		throw new Error(`当前阶段「${phaseLabel(store.state.phase)}」不能单独审校；请先 /manga next。`);
	}
	return startBackground(ctx, app, "结构审校", (pipeline) => pipeline.runQa());
}

export function actionAuto(ctx: ActionCtx, app: AppLike, on: boolean): string {
	const { store } = app.ensure(ctx.cwd);
	store.project.gates = on
		? { script: "off", cast: "off", storyboard: "off", final: "off" }
		: { script: "auto", cast: "always", storyboard: "always", final: "always" };
	store.saveProject();
	return on
		? "已开启全自动：闸门全部跳过（剧本 blocker 仍会按假设记录）。使用 /manga run-all 跑完。"
		: "已关闭全自动：恢复默认闸门。";
}

// ---------------------------------------------------------------------------
// style / config / models / key / doctor / open / rollback
// ---------------------------------------------------------------------------

export async function actionStyle(ctx: ActionCtx, app: AppLike, presetArg?: string): Promise<string> {
	const { store } = app.ensure(ctx.cwd);
	let style: StyleSelection | undefined;
	if (presetArg) {
		const preset = (Object.keys(STYLE_PRESETS) as StylePreset[]).includes(presetArg as StylePreset)
			? (presetArg as StylePreset)
			: presetFromLabel(presetArg);
		style = makeStyle(preset, undefined, store.project.style.ratio);
	} else if (ctx.hasUI) {
		const choice = await ctx.ui.select(`当前画风：${store.project.style.label}（${store.project.style.ratio}）`, [
			"黑白漫画",
			"全彩国漫",
			"竖屏条漫",
			"自定义",
			"保持当前",
		]);
		if (!choice || choice === "保持当前") return "未修改画风。";
		const preset = presetFromLabel(choice);
		let customPrompt: string | undefined;
		if (preset === "custom") {
			customPrompt = (await ctx.ui.editor("新的画风描述", store.project.style.customPrompt ?? ""))?.trim();
			if (!customPrompt) throw new Error("自定义画风需要提供描述");
		}
		style = makeStyle(preset, customPrompt, store.project.style.ratio);
	} else {
		throw new Error("非交互模式需要指定画风：/manga style manga-bw|manhua-color|webtoon|custom");
	}
	const ok = !ctx.hasUI || (await ctx.ui.confirm("切换画风", "会重做角色立绘、全部提示词与画面。是否继续？"));
	if (!ok) return "未修改画风。";
	store.project.style = style;
	store.saveProject();
	store.resetGatesFrom("cast");
	store.state.phase = "design";
	store.state.previousPhase = null;
	store.state.pendingFeedback = null;
	store.saveState();
	refreshStatus(ctx, app, store);
	return `画风已切换为 ${style.label}（${style.ratio}）。需要重新运行 /manga next 从企划开始。`;
}

export function actionConfig(ctx: ActionCtx, app: AppLike): string {
	const { store, config } = app.ensure(ctx.cwd);
	const safe = structuredClone(config);
	if (safe.agnes.apiKey) safe.agnes.apiKey = maskKey(safe.agnes.apiKey);
	for (const settings of Object.values(safe.providers ?? {})) {
		if (settings.apiKey) settings.apiKey = maskKey(settings.apiKey);
	}
	const stylePrompt = composeStylePrompt(store.project.style);
	return [
		`项目：${store.project.slug}`,
		`阶段：${phaseLabel(store.state.phase)}`,
		`画风锁定串：${stylePrompt}`,
		`改编等级：${adaptationLabel(store.project.adaptation)}`,
		"",
		JSON.stringify(safe, null, 2),
	].join("\n");
}

export async function actionModels(ctx: ActionCtx, app: AppLike, roleArg?: string, modelArg?: string): Promise<string> {
	const { store } = app.ensure(ctx.cwd);
	let role = roleArg;
	let model = modelArg;
	if (!role && ctx.hasUI) {
		const choice = await ctx.ui.select("为哪个角色设置模型？", [...ROLE_IDS, "全部恢复默认"]);
		if (!choice) return "未修改。";
		if (choice === "全部恢复默认") {
			store.project.agents.overrides = {};
			store.saveProject();
			return "已恢复全部角色为默认模型。";
		}
		role = choice;
	}
	if (!role || !isRole(role)) throw new Error("需要有效的角色 id");
	if (!model && ctx.hasUI) {
		model = (await ctx.ui.input(`模型（provider/id，留空表示跟随宿主）`, ""))?.trim();
	}
	if (!model) {
		delete store.project.agents.overrides[role as RoleId];
	} else {
		store.project.agents.overrides[role as RoleId] = { model };
	}
	store.saveProject();
	return `${roleLabel(role as RoleId)}：${model || "跟随宿主"}。`;
}

export async function actionKey(
	ctx: ActionCtx,
	app: AppLike,
	options: { key?: string; test?: boolean; provider?: string } = {},
): Promise<string> {
	let config = app.baseConfig();
	const providerId = (options.provider || config.image.provider || "agnes").trim().toLowerCase();
	if (!imageProviders.has(providerId)) {
		throw new Error(`未知图像提供方：${providerId}（可用：${imageProviders.list().join(", ")}）`);
	}
	const envName =
		config.providers?.[providerId]?.apiKeyEnv ||
		(providerId === "agnes" ? config.agnes.apiKeyEnv : `${providerId.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_API_KEY`);
	let resolved: ReturnType<typeof resolveProviderKey>;
	try {
		resolved = resolveProviderKey(config, app.agentDir, providerId);
	} catch (error) {
		resolved = undefined;
		notify(ctx as never, error instanceof Error ? error.message : String(error), "warning");
	}
	let key = options.key?.trim();
	if (!key && !resolved && ctx.hasUI) {
		notify(ctx as never, `注意：输入内容会回显。更安全的做法是设置环境变量 ${envName}。`, "warning");
		key = (await ctx.ui.input(`${providerId} API Key`, ""))?.trim();
	}
	if (key) {
		saveProviderKey(app.agentDir, providerId, key);
		config = app.baseConfig();
		resolved = resolveProviderKey(config, app.agentDir, providerId);
	}
	if (!resolved) throw new Error(`尚未设置 ${providerId} API Key。设置 ${envName}，或运行 /manga key --provider ${providerId} 输入。`);
	if (!options.test) {
		return `已保存 ${providerId} API Key（${maskKey(resolved.key)}，来自 ${resolved.source === "env" ? "环境变量" : "配置文件"}）。`;
	}
	const client = createProviderFromConfig(config, resolved.key, { retries: 0 }, { provider: providerId });
	if (!client.test) throw new Error(`图像提供方 ${providerId} 不支持 Key 测试。`);
	const result = await client.test();
	return `${providerId} API Key 可用。测试图：${result.width}x${result.height}（${result.format}）。`;
}

export async function actionProvider(ctx: ActionCtx, app: AppLike, providerArg?: string, modelArg?: string): Promise<string> {
	const { store, config } = app.ensure(ctx.cwd);
	const available = imageProviders.list();
	const current = store.project.image.provider || "agnes";
	let id = providerArg?.trim().toLowerCase();
	if (!id) {
		if (!ctx.hasUI) {
			return [
				`当前绘制模型：${describeDrawingModel(store.project.image)}`,
				`可用提供方：${available.join("、")}`,
				"切换：/manga provider <id> [--model <model>]",
			].join("\n");
		}
		const keepLabel = "保持当前";
		const labels = providerChoiceLabels(available, current);
		labels.push(keepLabel);
		const choice = await ctx.ui.select(`选择图像提供方（当前：${describeDrawingModel(store.project.image)}）`, labels);
		if (!choice || choice === keepLabel) return `未修改绘制模型。当前：${describeDrawingModel(store.project.image)}；可用提供方：${available.join("、")}`;
		id = available[labels.indexOf(choice)];
	}
	if (!id || !imageProviders.has(id)) throw new Error(`未知图像提供方：${id || ""}（可用：${available.join(", ")}）`);
	const defaultModel = config.providers?.[id]?.model || imageProviders.defaultModel(id) || imageProviders.models(id)[0]?.id;
	let model = modelArg?.trim();
	if (!model) {
		const options = imageProviders.models(id);
		if (ctx.hasUI && options.length > 1) {
			const customLabel = "自定义模型 id…";
			const labels = modelChoiceLabels(options, store.project.image.model, defaultModel);
			labels.push(customLabel);
			const choice = await ctx.ui.select(`选择 ${id} 绘制模型`, labels);
			if (!choice) return "未修改图像提供方。";
			if (choice === customLabel) {
				const custom = (await ctx.ui.input(`${id} 模型 id`, defaultModel ?? ""))?.trim();
				if (!custom) return "未修改图像提供方。";
				model = custom;
			} else {
				model = options[labels.indexOf(choice)]?.id;
			}
		} else {
			model = defaultModel;
		}
	}
	if (!model) throw new Error(`提供方 ${id} 没有默认模型，请用 --model 指定`);
	if (store.project.image.provider === id && store.project.image.model === model) {
		return `绘制模型未变化：${describeDrawingModel(store.project.image)}。`;
	}
	store.project.image = { ...store.project.image, provider: id, model };
	store.saveProject();
	refreshStatus(ctx, app, store);
	return `图像提供方已切换为 ${id}（绘制模型 ${model}）。新出图生效；已有图片需 /manga regen 或重新运行出图阶段。`;
}

function providerChoiceLabels(ids: string[], current: string): string[] {
	const details: Record<string, { label: string; fee: string }> = {
		agnes: { label: "Agnes Image 2.5 Flash", fee: "免费" },
		ark: { label: "火山方舟 Seedream", fee: "付费" },
	};
	return ids.map((id) => {
		const detail = details[id];
		const meta = detail ? `${detail.label}，${detail.fee}` : "";
		return `${id}${meta ? ` · ${meta}` : ""}${id === current ? "（当前）" : ""}`;
	});
}

function modelChoiceLabels(
	options: Array<{ id: string; label?: string; note?: string }>,
	currentModel: string,
	defaultModel?: string,
): string[] {
	return options.map((option) => {
		const meta = [option.label, option.note].filter(Boolean).join(" · ");
		const tags = [option.id === currentModel ? "当前" : "", option.id === defaultModel ? "默认" : ""].filter(Boolean);
		return `${option.id}${meta ? ` · ${meta}` : ""}${tags.length ? `（${tags.join("，")}）` : ""}`;
	});
}

/** Compact provider/model description used by status output. */
export function describeDrawingModel(image: { provider?: string; model?: string }): string {
	const provider = image.provider?.trim() || "agnes";
	const model = image.model?.trim() || imageProviders.defaultModel(provider) || "未设置";
	const info = imageProviders.models(provider).find((option) => option.id === model);
	return `${provider}/${model}${info?.label ? ` · ${info.label}` : ""}`;
}

export function actionDoctor(ctx: ActionCtx, app: AppLike): string {
	const config = app.baseConfig();
	const lines: string[] = [];
	try {
		const { store } = app.ensure(ctx.cwd);
		lines.push(`项目：${store.project.slug}`);
		lines.push(`状态文件：${existsSync(join(store.root, "state.json")) ? "✔" : "✗"}`);
		lines.push(`锁：${store.isLockLive() ? "⚠ 有活动锁（可能有其他会话在运行）" : "✔ 无活动锁"}`);
		lines.push(`剧本：${store.readScript().trim() ? "✔" : "✗"}`);
		lines.push(`分析：${store.readAnalysis() ? "✔" : "✗"}`);
		lines.push(`bible：${store.readBible() ? "✔" : "✗"}`);
		lines.push(`页数：${store.listPageKeys().length}`);
		const stats = store.refreshStats();
		lines.push(`格数：${stats.panels} · 图片：${stats.images} · 失败：${stats.failedImages}`);
		const runs = store.state.runs;
		lines.push(`运行记录：${runs.length}（最近：${runs.at(-1)?.role ?? "无"} ${runs.at(-1)?.status ?? ""}）`);
	} catch (error) {
		lines.push(error instanceof Error ? error.message : String(error));
	}
	try {
		const providerId = config.image.provider || "agnes";
		const key = resolveProviderKey(config, app.agentDir, providerId);
		lines.push(`${providerId} Key：${key ? `✔ ${maskKey(key.key)}（${key.source}）` : "✗ 未设置"}`);
	} catch (error) {
		lines.push(`Agnes Key：✗ ${error instanceof Error ? error.message : String(error)}`);
	}
	lines.push(`工作区：${join(ctx.cwd, config.workspace)}`);
	return lines.join("\n");
}

export function actionOpen(ctx: ActionCtx, app: AppLike, slug?: string): string {
	if (!slug) {
		const projects = app.list(ctx.cwd);
		if (projects.length === 0) return "还没有漫画项目。";
		return projects
			.map((project) => `${project.slug === app.active?.project.slug ? "▶" : " "} ${project.slug} · ${project.title} · ${project.phase} · ${project.images}/${project.panels}`)
			.join("\n");
	}
	const { store } = app.ensure(ctx.cwd, slug);
	refreshStatus(ctx, app, store);
	return `已切换到《${store.project.title}》（${store.project.slug}）。`;
}

const ROLLBACK_PREFIXES = ["source/", "pages/", "characters/", "qa/"];

export function actionRollback(ctx: ActionCtx, app: AppLike, runId?: string): string {
	const { store } = app.ensure(ctx.cwd);
	const runsDir = join(store.root, ".runs");
	const ids = runId ? [runId] : listDirs(runsDir).slice(-1);
	if (ids.length === 0) throw new Error("没有可用的运行快照");
	const id = ids[0];
	let dir: string;
	try {
		dir = resolveWithin(runsDir, id);
	} catch {
		throw new Error(`非法的运行快照 id：${id}`);
	}
	if (!existsSync(dir)) throw new Error(`找不到运行快照：${id}`);
	let copied = 0;
	const walk = (base: string) => {
		for (const entry of readdirSync(base, { withFileTypes: true })) {
			const abs = join(base, entry.name);
			if (entry.isDirectory()) {
				walk(abs);
				continue;
			}
			const rel = relative(dir, abs).replaceAll("\\", "/");
			if (rel === "prompt.md" || rel === "meta.json") continue;
			if (rel !== "bible.json" && !ROLLBACK_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
			const target = join(store.root, rel);
			ensureDir(dirname(target));
			copyFileSync(abs, target);
			copied++;
		}
	};
	walk(dir);
	store.refreshStats();
	return `已从快照 ${id} 回滚 ${copied} 个文件。`;
}

export function actionListProjects(ctx: ActionCtx, app: AppLike): string {
	const projects = app.list(ctx.cwd);
	if (projects.length === 0) return "还没有漫画项目。运行 /manga init 创建。";
	return projects
		.map((project) => {
			const active = project.slug === app.active?.project.slug ? "▶" : " ";
			return `${active} ${project.slug} · ${project.title} · ${project.phase} · 图 ${project.images}/${project.panels}`;
		})
		.join("\n");
}

export function getWebHandle(): WebServerHandle | undefined {
	return webHandle;
}
