import { join } from "node:path";
import { existsSync } from "node:fs";
import { ImageGenError, generateCharacterImages, generatePanelImages, regeneratePanel, type ImageProvider } from "./imagegen/index.ts";
import { createProjectImageWorkspace, createProviderFromConfig } from "./imagegen-adapter.ts";
import { validatePage, validateRefImages, validateRoleOutputs, roleTargets } from "./artifacts.ts";
import { composeStylePrompt, type MangaConfig } from "./config.ts";
import { buildStoryboardPlan } from "./page-plan.ts";
import { markSeriesUnitDoneForProject } from "./series.ts";
import { applyCharacterRefsToBible, readCharacterRefManifest } from "./character-refs.ts";
import { resolveProviderKey } from "./keys.ts";
import { readJson, readText, resolveWithin, writeAtomic, writeJsonAtomic, ensureDir, fileExists, nowIso } from "./paths.ts";
import { ensureProjectWebPreviews } from "./previews.ts";
import { buildSystemPrompt, buildTaskPrompt } from "./prompts.ts";
import type { ImageArchiveFormat } from "./export.ts";
import { phaseLabel } from "./ui.ts";
import { recordAssumptions, runReviewGate, runScriptGate as runScriptGateUi, questionsNeedingUser, gatePolicy } from "./gates.ts";
import type { GateUi } from "./gates.ts";
import { isAutoTitle, normalizeTitle, type ProjectStore } from "./state.ts";
import type {
	AdaptationLevel,
	Bible,
	GateId,
	MangaPage,
	MangaProject,
	Phase,
	ProgressUpdate,
	QaReport,
	ReviewIssue,
	ReviewReport,
	RoleId,
	RoleRunOptions,
	RoleRunResult,
	RunStatus,
	RunUsage,
	ScriptAnalysis,
} from "./types.ts";
import { ADAPTATION_INFO, ADAPTATION_LEVELS, ROLE_IDS } from "./types.ts";

export type RoleRunner = (options: RoleRunOptions) => Promise<RoleRunResult>;

/** Maximum number of automatic panel regenerations per panel during one review. */
export const MAX_REVIEW_REGENERATIONS = 3;

export interface PipelineUi extends GateUi {
	updateStatus(store: ProjectStore, status?: RunStatus, activeUsage?: RunUsage): void;
}

export interface PipelineOptions {
	store: ProjectStore;
	config: MangaConfig;
	ui: PipelineUi;
	agentDir: string;
	runner?: RoleRunner;
	client?: ImageProvider;
	signal?: AbortSignal;
	/** Resolve a configured model id, or return the host session model. */
	resolveModel?: (modelId?: string) => unknown;
}

async function defaultRunner(options: RoleRunOptions): Promise<RoleRunResult> {
	const { runRole } = await import("./runner.ts");
	return runRole(options);
}

function pageIdOf(index: number): string {
	return `page-${String(index).padStart(3, "0")}`;
}

function panelKey(pageId: string, panelId: string): string {
	return `${pageId}/${panelId}`;
}

function extractPanelKeys(issues: string[]): string[] {
	const keys = new Set<string>();
	for (const issue of issues) {
		const match = /(page-\d{3})\/(panel-\d{2})/.exec(issue);
		if (match) keys.add(`${match[1]}/${match[2]}`);
	}
	return [...keys];
}

function emptyUsage(): RunUsage {
	return { input: 0, output: 0, total: 0, cost: 0 };
}

/** Direct reference mode copies local files and never calls provider.generate(). */
const directReferenceProvider: ImageProvider = {
	id: "direct-reference",
	async generate() {
		throw new Error("direct character reference mode does not call image generation");
	},
};

export class MangaPipeline {
	readonly store: ProjectStore;
	readonly config: MangaConfig;
	readonly ui: PipelineUi;
	readonly agentDir: string;
	readonly signal?: AbortSignal;
	private readonly runner: RoleRunner;
	private readonly modelResolver?: (modelId?: string) => unknown;
	private client?: ImageProvider;
	private lastReport = 0;
	private activeUsage = emptyUsage();
	private runStage?: string;
	private runRole?: string;
	private runStep?: number;
	private runTotal?: number;
	private runDetail?: string;
	private lastTool?: string;
	private runContextTokens?: number;
	private runContextPercent?: number;

	constructor(options: PipelineOptions) {
		this.store = options.store;
		this.config = options.config;
		this.ui = options.ui;
		this.agentDir = options.agentDir;
		this.signal = options.signal;
		this.runner = options.runner ?? defaultRunner;
		this.client = options.client;
		this.modelResolver = options.resolveModel;
	}

	get project(): MangaProject {
		return this.store.project;
	}

	get phase(): Phase {
		return this.store.phase;
	}

	// ---------------------------------------------------------------------
	// Entry points
	// ---------------------------------------------------------------------

	async next(): Promise<void> {
		try {
			await this.dispatch();
		} catch (error) {
			if (this.signal?.aborted) {
				this.ui.notify("已取消当前任务。", "warning");
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			this.store.markError(message);
			this.runStage = "出错";
			this.runRole = undefined;
			this.runDetail = message;
			this.runStep = undefined;
			this.runTotal = undefined;
			this.runContextTokens = undefined;
			this.runContextPercent = undefined;
			this.ui.updateStatus(this.store, this.status(), this.activeUsage);
			throw error;
		} finally {
			this.finishStatus();
		}
	}

	/** Public so command-initiated stages can repaint a clean final status. */
	finishStatus(): void {
		this.runStage = phaseLabel(this.store.phase);
		this.runRole = undefined;
		this.runDetail = undefined;
		this.runStep = undefined;
		this.runTotal = undefined;
		this.lastTool = undefined;
		this.runContextTokens = undefined;
		this.runContextPercent = undefined;
		this.activeUsage = emptyUsage();
		this.ui.updateStatus(this.store, this.status(), this.activeUsage);
	}

	private async dispatch(): Promise<void> {
		switch (this.store.phase) {
			case "script_analysis":
				return this.runScriptAnalysis();
			case "script_gate":
				return this.runScriptGate();
			case "design":
				return this.runDirector();
			case "cast":
				// Compatibility: old projects that stopped at the old cast phase now
				// run the merged director (bible + reference prompts).
				return this.runDirector();
			case "character_images":
				return this.runCharacterImages();
			case "cast_gate":
				return this.runCastGate();
			case "storyboard":
				return this.runStoryboard();
			case "storyboard_gate":
				return this.runStoryboardGate();
			case "prompts":
				// Compatibility: the prompt artist is merged into storyboard. Re-run
				// those pages with the merged role instead of leaving the project stuck.
				this.store.transition("storyboard");
				return this.runStoryboard(undefined, true);
			case "image_gen":
				return this.runImageGen();
			case "qa":
				return this.runQa();
			case "repair":
				return this.runRepair();
			case "build":
				return this.runBuild();
			case "final_gate":
				return this.runFinalGate();
			case "done":
				this.ui.notify(`《${this.project.title}》已完成。`, "info");
				return;
			case "paused":
				this.ui.notify("项目已暂停。使用 /manga resume 恢复。", "info");
				return;
			case "error": {
				const previous = this.store.state.previousPhase;
				if (!previous) {
					this.ui.notify(`上次出错：${this.store.state.lastError?.message ?? "未知错误"}。使用 /manga doctor 检查或 /manga next 重试。`, "error");
					return;
				}
				this.ui.notify(`正在重试上次失败的阶段（${previous}）…`, "warning");
				this.store.state.phase = previous;
				this.store.state.previousPhase = null;
				this.store.clearError();
				await this.next();
				return;
			}
			default:
				this.ui.notify(`当前阶段「${this.store.phase}」没有可执行的步骤。`, "info");
				return;
		}
	}

	async runAll(maxSteps = 40): Promise<void> {
		for (let step = 0; step < maxSteps; step++) {
			const before = this.store.phase;
			await this.next();
			const after = this.store.phase;
			if (after === "done" || after === "paused" || after === "error") return;
			if (after === before) return;
			if (["script_gate", "cast_gate", "storyboard_gate", "final_gate"].includes(after) && gatePolicy(this.project, gateIdForPhase(after)!) !== "off") return;
		}
	}

	// ---------------------------------------------------------------------
	// Gates
	// ---------------------------------------------------------------------

	async approveCurrentGate(feedback?: string): Promise<void> {
		const phase = this.store.phase;
		const gate = gateIdForPhase(phase);
		if (!gate) throw new Error(`当前阶段「${phase}」不是闸门`);
		this.store.recordGate(gate, "approved", { feedback });
		switch (gate) {
			case "script":
				this.store.transition("design");
				break;
			case "cast":
				this.store.transition("storyboard");
				break;
			case "storyboard":
				this.store.transition("image_gen");
				break;
			case "final":
				this.store.transition("done");
				break;
		}
		this.ui.updateStatus(this.store);
		await this.next();
	}

	async reviseCurrentGate(feedback: string): Promise<void> {
		const gate = gateIdForPhase(this.store.phase);
		if (!gate) throw new Error(`当前阶段「${this.store.phase}」不是闸门`);
		this.store.recordGate(gate, "rejected", { feedback });
		this.store.state.pendingFeedback = feedback;
		this.store.saveState();
		switch (gate) {
			case "script": {
				const path = join(this.store.root, "source", "clarifications.md");
				const previous = readText(path) ?? "# 用户确认记录\n\n";
				writeAtomic(path, `${previous}${previous.endsWith("\n") ? "" : "\n"}## 修改意见（${nowIso()}）\n${feedback}\n\n`);
				this.store.transition("script_analysis");
				await this.runScriptAnalysis(feedback);
				return;
			}
			case "cast":
				this.store.transition("design");
				return this.runDirector(feedback);
			case "storyboard":
				this.store.transition("storyboard");
				return this.runStoryboard(feedback);
			case "final":
				this.ui.notify("成品确认阶段的修改请用 /manga regen <page> <panel> 重画具体格子，再 /manga approve。", "info");
				return;
		}
	}

	// ---------------------------------------------------------------------
	// Script
	// ---------------------------------------------------------------------

	async runScriptAnalysis(feedback?: string): Promise<void> {
		await this.ensureAdaptationLevel();
		this.beginStage("剧本分析", "剧本分析师");
		await this.locked("script_analyst", async () => {
			const result = await this.runRoleWithRetry("script_analyst", {
				targets: roleTargets("script_analyst"),
				feedback: feedback ?? this.takeFeedback(),
			});
			if (!result.ok) return;
			const analysis = this.store.readAnalysis();
			if (!analysis) throw new Error("analysis.json 读取失败");
			this.adoptAnalysisTitle(analysis);
			this.store.state.pendingQuestions = analysis.issues ?? [];
			this.store.saveState();
			const policy = gatePolicy(this.project, "script");
			const blocking = questionsNeedingUser(analysis, policy);
			if (policy === "off" && analysis.issues.length > 0) {
				recordAssumptions(this.store, analysis, "script gate 已关闭，全部问题按建议假设处理。");
			}
			if (blocking.length > 0) {
				this.ui.notify(`剧本有 ${blocking.length} 个问题需要确认。`, "warning");
				this.store.transition("script_gate");
			} else {
				// Analysis is complete and needs no user input, so the script gate is
				// passed immediately instead of staying pending in the Web/TUI panel.
				if (this.store.gate("script").status !== "approved") {
					this.store.recordGate("script", "approved", { feedback: "剧本分析完成，无需澄清" });
				}
				this.ui.notify(`剧本分析完成：${analysis.scenes.length} 个场景，预计 ${analysis.pageEstimate} 页。`, "info");
				this.store.transition("design");
			}
			this.ui.updateStatus(this.store);
		});
	}

	/** Replace the bounded fallback title with the analyst's content-based suggestion. */
	private adoptAnalysisTitle(analysis: ScriptAnalysis): void {
		if (!isAutoTitle(this.project, this.store.readScript())) return;
		const suggestion = normalizeTitle(analysis.titleSuggestion ?? "");
		if (!suggestion || suggestion === this.project.title) return;
		const previous = this.project.title;
		this.project.title = suggestion;
		this.project.titleSource = "auto";
		this.store.saveProject();
		this.ui.notify(`已根据剧本内容生成书名《${suggestion}》（原临时标题《${previous}》）。`, "info");
	}

	private async runScriptGate(): Promise<void> {
		this.beginStage("剧本确认");
		const analysis = this.store.readAnalysis();
		if (!analysis) throw new Error("找不到 analysis.json，请先运行 /manga next 重试剧本分析");
		const decision = await runScriptGateUi({
			policy: gatePolicy(this.project, "script"),
			store: this.store,
			ui: this.ui,
			analysis,
		});
		if (decision.kind === "pause") {
			this.store.pause();
			return;
		}
		if (decision.kind === "answered") {
			const rounds = this.store.state.runs.filter((run) => run.role === "script_analyst").length;
			if (rounds >= 3) {
				recordAssumptions(this.store, analysis, "已达澄清轮次上限，剩余问题按假设处理。");
				this.store.recordGate("script", "approved");
				this.store.transition("design");
				return;
			}
			this.store.transition("script_analysis");
			await this.runScriptAnalysis();
			return;
		}
		this.store.recordGate("script", "approved");
		this.store.transition("design");
		this.ui.updateStatus(this.store);
	}

	// ---------------------------------------------------------------------
	// Design + characters
	// ---------------------------------------------------------------------

	async runDirector(feedback?: string): Promise<void> {
		this.beginStage("企划 / 角色设定", "导演");
		await this.locked("director", async () => {
			const result = await this.runRoleWithRetry("director", {
				targets: ["bible.json"],
				feedback: feedback ?? this.takeFeedback(),
			});
			if (!result.ok) return;
			this.syncRefPromptFiles();
			this.applyCharacterRefs();
			this.store.transition("character_images");
			this.ui.updateStatus(this.store);
		});
	}

	/** Mirror inline refPrompt values to the per-character text files. */
	private syncRefPromptFiles(): void {
		const bible = this.store.readBible();
		for (const member of bible?.cast ?? []) {
			const prompt = member.refPrompt?.trim();
			if (!prompt) continue;
			writeAtomic(join(this.store.root, "characters", member.id, "ref.prompt.txt"), `${prompt}\n`);
		}
	}

	/** Attach imported user reference images to cast members by name/id. */
	private applyCharacterRefs(): void {
		const manifest = readCharacterRefManifest(this.store.root);
		if (!manifest) return;
		const bible = this.store.readBible();
		if (!bible) return;
		if (applyCharacterRefsToBible(bible, manifest)) {
			writeJsonAtomic(join(this.store.root, "bible.json"), bible);
		}
	}

	async runCharacterImages(force = false, onlyId?: string): Promise<void> {
		this.beginStage("生成角色立绘");
		await this.locked("code", async () => {
			const run = this.store.beginRun("code", "character_images", { note: "角色立绘" });
			try {
				const manifest = readCharacterRefManifest(this.store.root);
				const bible = this.store.readBible();
				const cast = onlyId ? (bible?.cast ?? []).filter((member) => member.id === onlyId) : (bible?.cast ?? []);
				const allDirect =
					manifest?.mode === "direct" && cast.length > 0 && cast.every((member) => (member.userRefs?.length ?? 0) > 0);
				const client = allDirect ? directReferenceProvider : this.getClient();
				const result = await generateCharacterImages({
					workspace: createProjectImageWorkspace(this.store),
					config: this.config.image,
					provider: client,
					signal: this.signal,
					force,
					onlyId,
					onProgress: (progress) => {
						this.report(`${progress.label} ${progress.index}/${progress.total}`);
					},
				});
				this.store.finishRun(run.id, { status: "success" });
				this.ui.notify(`角色立绘：成功 ${result.done}，跳过 ${result.skipped}，失败 ${result.failed}。`, result.failed ? "warning" : "info");
				// The stage normally runs at character_images. Manual regen (`/manga cast --regen`)
				// can happen later; do not force an illegal transition there.
				if (["design", "cast", "character_images"].includes(this.store.phase)) {
					this.store.transition("cast_gate");
				} else {
					this.ui.notify("立绘已更新。含这些角色的已有画面需要 /manga regen 或重跑出图阶段。", "warning");
				}
				this.ui.updateStatus(this.store);
			} catch (error) {
				this.store.finishRun(run.id, { status: this.signal?.aborted ? "aborted" : "error", error: messageOf(error) });
				throw error;
			}
		});
	}

	private async runCastGate(): Promise<void> {
		this.beginStage("角色确认");
		const bible = this.store.readBible();
		const summary = [
			`角色：${(bible?.cast ?? []).map((member) => `${member.name}(${member.id})`).join("、")}`,
			`画风：${this.project.style.label} · ${this.project.style.ratio}`,
			`立绘目录：${join(this.store.root, "characters")}`,
		].join("\n");
		const decision = await runReviewGate({
			gate: "cast",
			title: "角色设定确认",
			summary,
			ui: this.ui,
			store: this.store,
		});
		if (decision.kind === "pause") {
			this.store.pause();
			return;
		}
		if (decision.kind === "revise") {
			this.store.transition("design");
			await this.runDirector(decision.feedback);
			return;
		}
		this.store.transition("storyboard");
		this.ui.updateStatus(this.store);
	}

	// ---------------------------------------------------------------------
	// Storyboard + prompts
	// ---------------------------------------------------------------------

	async runStoryboard(feedback?: string, force = false): Promise<void> {
		await this.ensureAdaptationLevel();
		this.beginStage("分镜 / 提示词", "分镜师");
		await this.locked("storyboard", async () => {
			const analysis = this.store.readAnalysis();
			if (!analysis) throw new Error("找不到 analysis.json，无法分镜");
			const plan = buildStoryboardPlan(analysis, this.store.readScript(), {
				maxPages: this.config.source.maxStoryboardPagesPerUnit,
			});
			const total = plan.totalPages;
			if (total < plan.requestedPages) {
				this.ui.notify(
					`分镜页数按场景/节拍/原文篇幅收紧为 ${total} 页（分析建议 ${plan.requestedPages} 页），避免为凑页数重复剧情。`,
					"info",
				);
			}
			const fb = feedback ?? this.takeFeedback();
			let completed = 0;
			for (let index = 1; index <= total; index++) {
				if (this.signal?.aborted) throw new Error("已取消");
				const pageId = pageIdOf(index);
				const existing = this.store.readPage(index);
				const ready = Boolean(existing?.panels?.length) && existing!.panels.every((panel) => Boolean(panel.prompt?.trim()));
				if (!force && !fb && ready) {
					this.report(`分镜 ${pageId} 已存在且提示词完整，跳过`);
					completed++;
					continue;
				}
				this.report(`分镜 ${pageId}（${index}/${total}）`, { step: index, total });
				const result = await this.runRoleWithRetry("storyboard", {
					pageIndex: index,
					pageId,
					targets: [`pages/${pageId}.json`],
					feedback: fb,
					storyboardPlan: plan,
				});
				if (!result.ok) return;
				completed++;
			}
			this.ui.notify(`分镜完成：${completed}/${total} 页。`, "info");
			this.store.transition("storyboard_gate");
			this.ui.updateStatus(this.store);
		});
	}

	private async runStoryboardGate(): Promise<void> {
		this.beginStage("分镜确认");
		const pages = this.store.listPageKeys();
		const summary = [
			`共 ${pages.length} 页，${this.store.state.stats.panels} 格。`,
			`目录：${join(this.store.root, "pages")}`,
			"分镜、提示词与 lettering 已就绪；请在 Web 预览中查看文字（图片尚未生成）。",
		].join("\n");
		const decision = await runReviewGate({
			gate: "storyboard",
			title: "分镜确认（出图前）",
			summary,
			ui: this.ui,
			store: this.store,
		});
		if (decision.kind === "pause") {
			this.store.pause();
			return;
		}
		if (decision.kind === "revise") {
			this.store.transition("storyboard");
			await this.runStoryboard(decision.feedback, true);
			return;
		}
		this.store.transition("image_gen");
		this.ui.updateStatus(this.store);
	}

	// ---------------------------------------------------------------------
	// Images
	// ---------------------------------------------------------------------

	async runImageGen(force = false): Promise<void> {
		this.beginStage("生成画面");
		await this.locked("code", async () => {
			const run = this.store.beginRun("code", "image_gen", { note: "分镜出图" });
			try {
				const result = await generatePanelImages({
					workspace: createProjectImageWorkspace(this.store),
					config: this.config.image,
					provider: this.getClient(),
					signal: this.signal,
					force,
					onProgress: (progress) => {
						const suffix = progress.error ? ` · ${progress.error}` : "";
						this.report(`${progress.label}${suffix}`, { step: progress.index, total: progress.total });
					},
				});
				this.store.finishRun(run.id, { status: "success" });
				this.ui.notify(
					`出图：成功 ${result.done}，跳过 ${result.skipped}，失败 ${result.failed}${result.failures.length ? `（${result.failures.slice(0, 3).join(", ")}）` : ""}。`,
					result.failed ? "warning" : "info",
				);
				this.store.transition("qa");
				this.ui.updateStatus(this.store);
			} catch (error) {
				this.store.finishRun(run.id, { status: this.signal?.aborted ? "aborted" : "error", error: messageOf(error) });
				throw error;
			}
		});
	}

	// ---------------------------------------------------------------------
	// QA / repair
	// ---------------------------------------------------------------------

	/** Send missing character sheets back to character_images once, then stop. */
	private recoverMissingRefs(prefix: string, issues: string[]): void {
		const message = `${prefix}：${issues.slice(0, 3).join("；")}`;
		const attempts = this.store.state.runs.filter((item) => item.phase === "character_images").length;
		if (attempts >= 2) {
			this.ui.notify(`${message}（已自动重跑过立绘，停止并等待手动修复）`, "error");
			this.store.markError(message);
		} else {
			this.ui.notify(`${message}，退回立绘阶段`, "error");
			this.store.transition("character_images");
		}
		this.ui.updateStatus(this.store);
	}

	async runQa(): Promise<void> {
		this.beginStage("审校");
		await this.locked("code", async () => {
			const run = this.store.beginRun("code", "qa", { note: "结构审校" });
			try {
				const report = this.buildQaReport();
				writeJsonAtomic(join(this.store.root, "qa", "report.json"), report);
				writeAtomic(join(this.store.root, "qa", "report.md"), renderQaMarkdown(report));
				ensureDir(join(this.store.root, "qa"));
				this.store.finishRun(run.id, { status: "success" });
				const refCheck = validateRefImages(this.store.readBible(), this.store.root);
				if (refCheck.issues.length > 0) {
					this.recoverMissingRefs("审校发现角色立绘缺失", refCheck.issues);
					return;
				}
				const repairRuns = this.store.state.runs.filter((item) => item.role === "repairer").length;
				if (report.repairTargets.length > 0 && repairRuns < this.config.qa.repairRounds) {
					this.ui.notify(`审校发现 ${report.repairTargets.length} 个问题，进入修复。`, "warning");
					this.store.transition("repair");
				} else {
					if (report.repairTargets.length > 0) {
						this.ui.notify(`审校仍有 ${report.repairTargets.length} 个问题，已达修复轮次上限。`, "warning");
					}
					this.store.transition("build");
				}
				this.ui.updateStatus(this.store);
			} catch (error) {
				this.store.finishRun(run.id, { status: "error", error: messageOf(error) });
				throw error;
			}
		});
	}

	private buildQaReport(): QaReport {
		const bible = this.store.readBible();
		const errors: string[] = [];
		const warnings: string[] = [];
		const missingText: string[] = [];
		const overlong: string[] = [];
		const tooManyBubbles: string[] = [];
		let checked = 0;
		for (const key of this.store.listPageKeys()) {
			const page = this.store.readPageByKey(key);
			if (!page) {
				errors.push(`缺少页面文件: ${key}.json`);
				continue;
			}
			const validation = validatePage(page, {
				bible,
				stylePrompt: composeStylePrompt(this.project.style),
				stage: "prompts",
				projectRoot: this.store.root,
			});
			for (const issue of validation.issues) {
				if (/超过 \d+ 字/.test(issue)) overlong.push(issue);
				else if (/对白超过 2 条/.test(issue)) tooManyBubbles.push(issue);
				else if (/未包含 dialogue/.test(issue)) missingText.push(issue);
				else errors.push(issue);
			}
			if (!page.panels.some((panel) => (panel.dialogue?.length ?? 0) > 0)) {
				warnings.push(`${page.id} 整页无文字，建议补旁白/心理活动`);
			}
			let previousEmpty = false;
			for (const panel of page.panels) {
				checked += 1;
				const key = panelKey(page.id, panel.id);
				const empty = (panel.characters?.length ?? 0) === 0 && (panel.dialogue?.length ?? 0) === 0;
				if (empty) {
					warnings.push(`${key} 是纯空镜（无角色/无文字），建议补旁白或心理活动`);
					if (previousEmpty) warnings.push(`${key} 与上一格连续空镜，建议插入反应/说明文字`);
				}
				previousEmpty = empty;
				const rel = panel.image?.file;
				if (!rel || !fileExists(resolveWithin(this.store.root, rel))) {
					errors.push(`${key} 缺少图片`);
				}
				for (const ref of panel.refs ?? []) {
					if (!fileExists(resolveWithin(this.store.root, ref))) {
						errors.push(`${key} 的参考图不存在: ${ref}`);
					}
				}
				if (panel.image?.status === "failed") {
					errors.push(`${key} 出图失败：${panel.image.error ?? "未知"}`);
				}
			}
		}
		if (bible) {
			const refCheck = validateRefImages(bible, this.store.root);
			errors.push(...refCheck.issues);
		}
		const repairTargets = [...new Set([...extractPanelKeys(errors), ...extractPanelKeys(missingText), ...extractPanelKeys(overlong), ...extractPanelKeys(tooManyBubbles)])].sort();
		return {
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			structural: { errors, warnings },
			lettering: { checked, missingText, overlong, tooManyBubbles },
			vision: { enabled: this.config.qa.vision, issues: [] },
			verdict: errors.length === 0 && missingText.length === 0 && overlong.length === 0 && tooManyBubbles.length === 0 ? "pass" : "needs-repair",
			repairTargets,
		};
	}

	async runRepair(): Promise<void> {
		this.beginStage("修复", "修复师");
		await this.locked("repairer", async () => {
			const report = readJson<QaReport>(join(this.store.root, "qa", "report.json"));
			if (!report || report.repairTargets.length === 0) {
				this.store.transition("build");
				return;
			}
			const byPage = new Map<string, string[]>();
			for (const key of report.repairTargets) {
				const [pageId] = key.split("/");
				byPage.set(pageId, [...(byPage.get(pageId) ?? []), key]);
			}
			for (const [pageId, keys] of byPage) {
				const page = this.store.readPageByKey(pageId);
				if (!page) continue;
				this.report(`修复 ${pageId}`);
				const result = await this.runRoleWithRetry("repairer", {
					pageIndex: page.index,
					pageId,
					targets: [`pages/${pageId}.json`],
					repairTargets: keys,
					feedback: `只修复这些格子：${keys.join(", ")}`,
				});
				if (!result.ok) return;
			}
			for (const key of report.repairTargets) {
				this.report(`重画 ${key}`);
				try {
					await regeneratePanel({
						workspace: createProjectImageWorkspace(this.store),
						config: this.config.image,
						provider: this.getClient(),
						key,
						signal: this.signal,
					});
				} catch (error) {
					if (error instanceof ImageGenError && error.code === "auth") throw error;
					this.ui.notify(`重画 ${key} 失败：${messageOf(error)}`, "warning");
				}
			}
			this.store.transition("qa");
			this.ui.updateStatus(this.store);
		});
	}

	async regenerate(key: string, note?: string, final = false): Promise<void> {
		this.beginStage("重画单格");
		this.report(key);
		await this.locked("code", async () => {
			const result = await regeneratePanel({
				workspace: createProjectImageWorkspace(this.store),
				config: this.config.image,
				provider: this.getClient(),
				key,
				note,
				final,
				signal: this.signal,
			});
			this.ui.notify(`已重画 ${key}（${result.width}x${result.height}）`, "info");
			this.ui.updateStatus(this.store);
		});
	}

	/**
	 * Visual review of generated panels by the reviewer role.
	 *
	 * Reviews page by page so each nested session only carries a few images.
	 * Panels with a blocker/major issue are regenerated; each panel is
	 * regenerated at most MAX_REVIEW_REGENERATIONS times. The concise human
	 * report is written to qa/review-report.md and is not printed in chat.
	 */
	async reviewImages(): Promise<void> {
		this.beginStage("AI 视觉审阅", "视觉审阅");
		await this.locked("reviewer", async () => {
			const pages = this.store
				.listPageKeys()
				.map((key) => ({ key, page: this.store.readPageByKey(key) }))
				.filter((entry): entry is { key: string; page: MangaPage } =>
					Boolean(
						entry.page?.panels.some(
							(panel) => panel.image?.file && fileExists(resolveWithin(this.store.root, panel.image.file)),
						),
					),
				);
			if (pages.length === 0) {
				this.ui.notify("还没有可审阅的画面。请先完成出图，再运行 /manga review。", "warning");
				this.ui.updateStatus(this.store);
				return;
			}

			const issues = new Map<string, ReviewIssue>();
			const attempts = new Map<string, number>();
			const reviewed = new Set<string>();
			const regenerated = new Set<string>();
			let rounds = 0;
			let affected = new Set(pages.map((entry) => entry.key));

			for (let round = 1; round <= MAX_REVIEW_REGENERATIONS + 1; round++) {
				if (this.signal?.aborted) throw new Error("已取消");
				const active = pages.filter((entry) => affected.has(entry.key));
				if (active.length === 0) break;
				rounds = round;
				for (const [index, entry] of active.entries()) {
					if (this.signal?.aborted) throw new Error("已取消");
					const pageId = entry.key;
					const target = `qa/review/${pageId}.json`;
					this.report(`第 ${round} 轮审阅 ${pageId}（${index + 1}/${active.length}）`, {
						step: index + 1,
						total: active.length,
					});
					const result = await this.runRoleWithRetry("reviewer", {
						pageIndex: entry.page.index,
						pageId,
						targets: [target],
					});
					if (!result.ok) throw new Error(`视觉审阅输出未通过校验：${result.issues.join("；")}`);
					const report = readJson<ReviewReport>(resolveWithin(this.store.root, target));
					for (const key of [...issues.keys()]) {
						if (key.startsWith(`${pageId}/`)) issues.delete(key);
					}
					for (const issue of report?.issues ?? []) {
						const key = normalizeReviewPanel(issue.panel, pageId);
						if (key) issues.set(key, { ...issue, panel: key });
					}
					for (const panel of entry.page.panels) {
						if (panel.image?.file && fileExists(resolveWithin(this.store.root, panel.image.file))) {
							reviewed.add(`${pageId}/${panel.id}`);
						}
					}
				}

				if (round > MAX_REVIEW_REGENERATIONS) break;
				const actionable = [...issues.entries()]
					.filter(([key, issue]) => issue.severity !== "minor" && (attempts.get(key) ?? 0) < MAX_REVIEW_REGENERATIONS)
					.filter(([key]) => this.panelHasImage(key));
				if (actionable.length === 0) break;

				affected = new Set();
				for (const [key, issue] of actionable) {
					if (this.signal?.aborted) throw new Error("已取消");
					const attempt = (attempts.get(key) ?? 0) + 1;
					attempts.set(key, attempt);
					this.report(`重画 ${key}（第 ${attempt}/${MAX_REVIEW_REGENERATIONS} 次）`);
					try {
						await regeneratePanel({
							workspace: createProjectImageWorkspace(this.store),
							config: this.config.image,
							provider: this.getClient(),
							key,
							note: reviewFixNote(issue),
							signal: this.signal,
						});
						regenerated.add(key);
						affected.add(key.split("/")[0]);
					} catch (error) {
						if (error instanceof ImageGenError && (error.code === "auth" || error.code === "aborted")) throw error;
						this.ui.notify(`重画 ${key} 失败：${messageOf(error)}`, "warning");
					}
				}
			}

			const sortedIssues = [...issues.values()].sort((a, b) => a.panel.localeCompare(b.panel));
			const summary: ReviewSummary = {
				schemaVersion: 1,
				generatedAt: nowIso(),
				rounds,
				reviewed: [...reviewed].sort(),
				regenerated: [...regenerated].sort(),
				issues: sortedIssues,
				verdict: sortedIssues.length > 0 ? "needs-attention" : "pass",
			};
			ensureDir(join(this.store.root, "qa"));
			writeJsonAtomic(join(this.store.root, "qa", "review.json"), summary);
			writeAtomic(join(this.store.root, "qa", "review-report.md"), renderReviewMarkdown(summary));
			this.ui.notify(
				`AI 视觉审阅完成：${rounds} 轮，重画 ${regenerated.size} 格，剩余 ${sortedIssues.length} 个问题。报告已写入 qa/review-report.md。`,
				sortedIssues.length ? "warning" : "info",
			);
			this.ui.updateStatus(this.store);
		});
	}

	private panelHasImage(key: string): boolean {
		const [pageId, panelId] = key.split("/");
		const panel = this.store.readPageByKey(pageId)?.panels.find((item) => item.id === panelId);
		return Boolean(panel?.image?.file && fileExists(resolveWithin(this.store.root, panel.image.file)));
	}

	async exportNow(format: ImageArchiveFormat = "zip"): Promise<void> {
		this.beginStage(`导出 ${format.toUpperCase()}`);
		await this.locked("code", async () => {
			const { exportImages } = await import("./export.ts");
			const result = await exportImages({
				store: this.store,
				format,
				chunkBytes: this.config.memory.zipChunkBytes,
			});
			this.ui.notify(`已导出 ${result.entries} 张画面到 ${result.file}`, "info");
		});
	}

	/** Build <500 KB Web previews without changing the original images. */
	async compressWebImages(): Promise<void> {
		this.beginStage("压缩 Web 预览图");
		await this.locked("code", async () => {
			const result = ensureProjectWebPreviews(this.store, (progress) => {
				this.report(`压缩 ${progress.rel}（${progress.index}/${progress.total}）`, {
					step: progress.index,
					total: progress.total,
				});
			});
			const failed = result.failed ? `，失败 ${result.failed}` : "";
			this.ui.notify(
				`Web 预览图：新生成 ${result.created}，跳过 ${result.skipped}${failed}（上限 500 KB）。`,
				result.failed ? "warning" : "info",
			);
		});
	}

	// ---------------------------------------------------------------------
	// Build / final
	// ---------------------------------------------------------------------

	async runBuild(): Promise<void> {
		this.beginStage("构建 / 导出");
		await this.locked("code", async () => {
			const run = this.store.beginRun("code", "build", { note: "构建与导出" });
			try {
				const refCheck = validateRefImages(this.store.readBible(), this.store.root);
				if (refCheck.issues.length > 0) {
					this.store.finishRun(run.id, { status: "success", note: "角色立绘缺失，退回立绘阶段" });
					this.recoverMissingRefs("构建前检查发现角色立绘缺失", refCheck.issues);
					return;
				}
				this.store.refreshStats();
				if (this.store.state.stats.images === 0) {
					this.store.finishRun(run.id, { status: "success", note: "没有成功画面，跳过导出" });
					this.ui.notify("没有任何成功画面，跳过图片导出。请检查失败原因后 /manga next 重试。", "warning");
					this.store.transition("final_gate");
					this.ui.updateStatus(this.store);
					return;
				}
				const { exportImages } = await import("./export.ts");
				const result = await exportImages({
					store: this.store,
					format: "zip",
					chunkBytes: this.config.memory.zipChunkBytes,
				});
				this.store.finishRun(run.id, { status: "success", outputFiles: [result.file] });
				this.ui.notify(`已导出 ${result.entries} 张画面到 ${result.file}`, "info");
				this.store.transition("final_gate");
				this.ui.updateStatus(this.store);
			} catch (error) {
				this.store.finishRun(run.id, { status: "error", error: messageOf(error) });
				throw error;
			}
		});
	}

	private async runFinalGate(): Promise<void> {
		this.beginStage("成品确认");
		const stats = this.store.state.stats;
		const summary = [
			`页数：${stats.pages} · 格数：${stats.panels} · 已出图：${stats.images} · 失败：${stats.failedImages}`,
			`导出：${join(this.store.root, "exports", `${this.project.slug}.zip`)}`,
			"确认后项目标记为完成；如需改某格，请先 /manga regen。",
		].join("\n");
		const decision = await runReviewGate({
			gate: "final",
			title: "成品确认",
			summary,
			ui: this.ui,
			store: this.store,
		});
		if (decision.kind === "pause") {
			this.store.pause();
			return;
		}
		if (decision.kind === "revise") {
			this.ui.notify("请用 /manga regen <page> <panel> 重画具体格子，然后再次 /manga approve。", "info");
			return;
		}
		this.store.transition("done");
		if (this.project.series?.id && this.project.source.unitId) {
			try {
				markSeriesUnitDoneForProject(this.store.root, this.project.series.id, this.project.source.unitId);
			} catch {
				// Series metadata is best-effort; the project itself is still complete.
			}
		}
		this.ui.notify(`《${this.project.title}》已完成。`, "info");
		this.ui.updateStatus(this.store);
	}

	// ---------------------------------------------------------------------
	// Role execution
	// ---------------------------------------------------------------------

	async runSpecificRole(role: RoleId): Promise<void> {
		switch (role) {
			case "script_analyst":
				return this.runScriptAnalysis();
			case "director":
				return this.runDirector();
			case "storyboard":
				return this.runStoryboard(undefined, true);
			case "editor":
				return this.runQa();
			case "repairer":
				return this.runRepair();
			case "reviewer":
				return this.reviewImages();
		}
	}

	private async runRoleWithRetry(
		role: RoleId,
		options: {
			targets: string[];
			pageIndex?: number;
			pageId?: string;
			feedback?: string;
			repairTargets?: string[];
			storyboardPlan?: ReturnType<typeof buildStoryboardPlan>;
			compact?: boolean;
		},
	): Promise<{ ok: boolean; issues: string[] }> {
		const maxAttempts = this.config.agents.maxAttempts;
		let extraInstruction: string | undefined;
		let lastIssues: string[] = [];
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			if (this.signal?.aborted) throw new Error("已取消");
			this.runRole = roleLabel(role);
			this.runStage = this.runStage ?? phaseLabelForStage(this.store.phase);
			const run = this.store.beginRun(role, this.store.phase, {
				inputFiles: this.inputFilesFor(role, options.pageId),
				note: attempt > 1 ? `第 ${attempt} 次尝试` : undefined,
			});
			const runDir = ensureDir(join(this.store.root, ".runs", run.id));
			const systemPrompt = buildSystemPrompt(role);
			const taskPrompt = buildTaskPrompt({
				role,
				project: this.project,
				projectRoot: this.store.root,
				config: this.config,
				pageIndex: options.pageIndex,
				pageId: options.pageId,
				feedback: options.feedback,
				extraInstruction,
				repairTargets: options.repairTargets,
				storyboardPlan: options.storyboardPlan,
			});
			writeAtomic(join(runDir, "prompt.md"), `# SYSTEM\n\n${systemPrompt}\n\n# TASK\n\n${taskPrompt}\n`);
			writeJsonAtomic(join(runDir, "meta.json"), {
				runId: run.id,
				role,
				phase: this.store.phase,
				pageId: options.pageId,
				targets: options.targets,
				attempt,
			});
			try {
				const result = await this.runner({
					role,
					projectRoot: this.store.root,
					runDir,
					targets: options.targets,
					systemPrompt,
					taskPrompt,
					model: this.resolveModel(role),
					thinkingLevel: this.thinkingFor(role),
					compact: options.compact ?? (role === "storyboard" || role === "editor"),
					timeoutMs: this.config.agents.timeoutMs,
					signal: this.signal,
					onProgress: (update) => this.onRoleProgress(update),
				});
				const page = options.pageIndex ? this.store.readPage(options.pageIndex) : undefined;
				this.activeUsage = emptyUsage();
				const validation = validateRoleOutputs({
					role,
					projectRoot: this.store.root,
					targets: options.targets,
					project: this.project,
					page,
				});
				this.store.finishRun(run.id, {
					status: "success",
					usage: result.usage,
					outputFiles: result.outputs,
					model: result.model,
					thinkingLevel: result.thinkingLevel,
					validation,
				});
				if (validation.ok) return { ok: true, issues: [] };
				lastIssues = validation.issues;
				extraInstruction = validation.issues.map((issue) => `- ${issue}`).join("\n");
				if (attempt < maxAttempts) {
					this.ui.notify(`${roleLabel(role)} 输出未通过校验，正在让同一角色补全…`, "warning");
				}
			} catch (error) {
				this.store.finishRun(run.id, {
					status: this.signal?.aborted ? "aborted" : "error",
					error: messageOf(error),
				});
				throw error;
			}
		}
		throw new Error(`${roleLabel(role)} 输出未通过校验：\n${lastIssues.map((issue) => `- ${issue}`).join("\n")}`);
	}

	private inputFilesFor(role: RoleId, pageId?: string): string[] {
		switch (role) {
			case "script_analyst":
				return [
					"source/script.md",
					...(fileExists(join(this.store.root, "source", "user-note.md")) ? ["source/user-note.md"] : []),
					"source/clarifications.md",
				];
			case "director":
				return [
					"source/script.md",
					"source/analysis.json",
					"source/clarifications.md",
					...(fileExists(join(this.store.root, "source", "character-refs", "manifest.json"))
						? ["source/character-refs/manifest.json"]
						: []),
				];
			case "storyboard":
				return ["bible.json", ...(pageId ? [`pages/${pageId}.json`] : [])];
			case "repairer":
				return ["bible.json", ...(pageId ? [`pages/${pageId}.json`] : [])];
			case "editor":
				return ["bible.json", ...this.store.listPageKeys().map((key) => `pages/${key}.json`)];
			case "reviewer": {
				const page = pageId ? this.store.readPageByKey(pageId) : undefined;
				return [
					"bible.json",
					...(pageId ? [`pages/${pageId}.json`] : []),
					...(page?.panels.map((panel) => panel.image?.file).filter((file): file is string => Boolean(file)) ?? []),
				];
			}
		}
	}

	private async locked(role: RoleId | "code", fn: () => Promise<void>): Promise<void> {
		this.store.acquireLock(role);
		try {
			await fn();
		} finally {
			this.store.releaseLock();
		}
	}

	/** Ask once, before script analysis/storyboard, which fidelity level to use. */
	private async ensureAdaptationLevel(): Promise<void> {
		const current = this.project.adaptation;
		if (current && (ADAPTATION_LEVELS as readonly string[]).includes(current)) return;
		let level: AdaptationLevel = "balanced";
		if (this.ui.hasUI) {
			const choice = await this.ui.select(
				"剧本整理与分镜改编程度（越自由，越能补充旁白/心理活动并减少空镜）",
				ADAPTATION_LEVELS.map((item) => ADAPTATION_INFO[item].label),
			);
			if (!choice) throw new Error("已取消改编等级选择；请重新运行 /manga next。");
			level = ADAPTATION_LEVELS.find((item) => ADAPTATION_INFO[item].label === choice) ?? "balanced";
		} else {
			this.ui.notify("未选择改编等级，默认使用「适当调整改写」（balanced）。", "warning");
		}
		this.project.adaptation = level;
		this.store.saveProject();
		this.ui.notify(`改编等级：${ADAPTATION_INFO[level].label}。`, "info");
	}

	private takeFeedback(): string | undefined {
		const feedback = this.store.state.pendingFeedback ?? undefined;
		if (feedback) {
			this.store.state.pendingFeedback = null;
			this.store.saveState();
		}
		return feedback;
	}

	private status(extra: RunStatus = {}): RunStatus {
		return {
			stage: this.runStage,
			role: this.runRole,
			step: this.runStep,
			total: this.runTotal,
			detail: this.runDetail,
			lastTool: this.lastTool,
			contextTokens: this.runContextTokens,
			contextPercent: this.runContextPercent,
			...extra,
		};
	}

	private beginStage(stage: string, role?: string): void {
		this.runStage = stage;
		this.runRole = role;
		this.runStep = undefined;
		this.runTotal = undefined;
		this.runDetail = undefined;
		this.lastTool = undefined;
		this.runContextTokens = undefined;
		this.runContextPercent = undefined;
		this.activeUsage = emptyUsage();
		this.ui.updateStatus(this.store, this.status(), this.activeUsage);
	}

	private report(detail: string, extra: RunStatus = {}): void {
		this.runDetail = detail;
		if (extra.step !== undefined) this.runStep = extra.step;
		if (extra.total !== undefined) this.runTotal = extra.total;
		const now = Date.now();
		if (now - this.lastReport < 350) return;
		this.lastReport = now;
		this.ui.updateStatus(this.store, this.status(extra), this.activeUsage);
	}

	private onRoleProgress(update: ProgressUpdate): void {
		// The runner attaches cumulative usage and context usage to every
		// progress event, so the footer can show live numbers while a role runs.
		if (update.usage) this.activeUsage = { ...update.usage };
		if (update.contextTokens !== undefined) this.runContextTokens = update.contextTokens;
		if (update.contextPercent !== undefined) this.runContextPercent = update.contextPercent;
		if (update.kind === "text") {
			this.report(update.detail ?? "生成中");
		} else if (update.kind === "tool") {
			this.lastTool = update.toolName;
			this.report(update.detail ?? update.toolName ?? "工具调用", { lastTool: update.toolName });
		} else if (update.kind === "usage" || update.kind === "status") {
			this.ui.updateStatus(this.store, this.status(), this.activeUsage);
		}
	}

	private resolveModel(role: RoleId): unknown {
		if (!this.modelResolver) return undefined;
		return this.modelResolver(this.config.agents.overrides[role]?.model);
	}

	private thinkingFor(role: RoleId) {
		return this.config.agents.overrides[role]?.thinkingLevel ?? this.config.agents.thinkingLevel;
	}

	private getClient(): ImageProvider {
		if (this.client) return this.client;
		const providerId = (this.config.image.provider || "agnes").trim().toLowerCase();
		const resolved = resolveProviderKey(this.config, this.agentDir, providerId);
		if (!resolved) {
			const envName =
				this.config.providers?.[providerId]?.apiKeyEnv ||
				(providerId === "agnes" ? this.config.agnes.apiKeyEnv : `${providerId.toUpperCase()}_API_KEY`);
			throw new Error(
				`未找到 ${providerId} API Key。请设置环境变量 ${envName}，或运行 /manga key --provider ${providerId} 保存。`,
			);
		}
		this.client = createProviderFromConfig(this.config, resolved.key, {}, { provider: providerId });
		return this.client;
	}
}

export function gateIdForPhase(phase: Phase): GateId | undefined {
	switch (phase) {
		case "script_gate":
			return "script";
		case "cast_gate":
			return "cast";
		case "storyboard_gate":
			return "storyboard";
		case "final_gate":
			return "final";
		default:
			return undefined;
	}
}

export function roleForPhase(phase: Phase): RoleId | undefined {
	switch (phase) {
		case "script_analysis":
			return "script_analyst";
		case "design":
			return "director";
		case "cast":
			return "director";
		case "storyboard":
			return "storyboard";
		case "prompts":
			return "storyboard";
		case "qa":
			return "editor";
		case "repair":
			return "repairer";
		default:
			return undefined;
	}
}

export function roleLabel(role: RoleId): string {
	switch (role) {
		case "script_analyst":
			return "剧本分析师";
		case "director":
			return "导演 / 角色设计师";
		case "storyboard":
			return "分镜师 / 提示词美术";
		case "editor":
			return "审校";
		case "repairer":
			return "修复师";
		case "reviewer":
			return "视觉审阅";
	}
}

export function isRole(value: string): value is RoleId {
	return (ROLE_IDS as readonly string[]).includes(value);
}

function phaseLabelForStage(phase: Phase): string {
	switch (phase) {
		case "script_analysis":
			return "剧本分析";
		case "design":
			return "企划 / 角色设定";
		case "cast":
			return "企划 / 角色设定";
		case "storyboard":
			return "分镜 / 提示词";
		case "prompts":
			return "分镜 / 提示词";
		case "qa":
			return "审校";
		case "repair":
			return "修复";
		default:
			return String(phase);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function renderQaMarkdown(report: QaReport): string {
	const lines = [
		"# QA 报告",
		"",
		`- 时间：${report.generatedAt}`,
		`- 结论：${report.verdict}`,
		`- 检查格数：${report.lettering.checked}`,
		"",
		"## 结构问题",
		...(report.structural.errors.length ? report.structural.errors.map((item) => `- ${item}`) : ["- 无"]),
		"",
		"## 结构警告",
		...(report.structural.warnings.length ? report.structural.warnings.map((item) => `- ${item}`) : ["- 无"]),
		"",
		"## 文字 / 气泡",
		`- 缺少对白原文：${report.lettering.missingText.length}`,
		`- 文字超长：${report.lettering.overlong.length}`,
		`- 气泡过多：${report.lettering.tooManyBubbles.length}`,
		"",
		"## 需要修复",
		...(report.repairTargets.length ? report.repairTargets.map((item) => `- ${item}`) : ["- 无"]),
		"",
	];
	return lines.join("\n");
}

export interface ReviewSummary {
	schemaVersion: 1;
	generatedAt: string;
	rounds: number;
	reviewed: string[];
	regenerated: string[];
	issues: ReviewIssue[];
	verdict: "pass" | "needs-attention";
}

function normalizeReviewPanel(value: unknown, pageId: string): string | undefined {
	const text = String(value ?? "").trim().replaceAll("\\", "/");
	if (/^page-\d{3}\/panel-\d{2}$/.test(text)) return text;
	const match = /^panel-(\d{2})$/.exec(text);
	return match ? `${pageId}/panel-${match[1]}` : undefined;
}

function reviewFixNote(issue: ReviewIssue): string {
	const fix = issue.fix?.trim() || `Fix the visual issue: ${issue.message}`;
	return `${fix}. Keep all specified lettering text unchanged, clearly readable, and inside its bubble.`;
}

function renderReviewMarkdown(summary: ReviewSummary): string {
	const lines = [
		"# AI 审阅报告",
		"",
		`- 结论：${summary.issues.length ? `仍有 ${summary.issues.length} 个问题` : "通过"}`,
		`- 审阅：${summary.rounds} 次 · 格子：${summary.reviewed.length} · 重画：${summary.regenerated.length} 格（每格上限 3 次）`,
		"- 问题：",
	];
	if (summary.issues.length === 0) lines.push("- 无");
	else {
		for (const issue of summary.issues) {
			lines.push(`- ${issue.panel} [${issue.severity}] ${issue.type}：${issue.message}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** Exposed for tests / status output. */
export function pipelineSummary(store: ProjectStore): string {
	const { state, project } = store;
	return [
		`《${project.title}》`,
		`阶段：${state.phase}`,
		`源文本：${project.source.strategy ?? "single"}${project.source.unitId ? ` · ${project.source.unitIndex}/${project.source.totalUnits} ${project.source.unitTitle ?? project.source.unitId}` : ""}`,
		`统计：${state.stats.pages} 页 / ${state.stats.panels} 格 / ${state.stats.images} 图 / 失败 ${state.stats.failedImages}`,
		`闸门：${(Object.entries(state.gates) as Array<[string, { status: string }]>).map(([gate, record]) => `${gate}:${record.status}`).join(" · ")}`,
	].join("\n");
}

export type { Bible, MangaPage, ScriptAnalysis };
