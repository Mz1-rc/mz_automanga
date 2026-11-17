import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { projectsRoot, workspaceRoot, type MangaConfig } from "./config.ts";
import {
	ensureDir,
	fileExists,
	fileStat,
	isStale,
	listDirs,
	nowIso,
	readJson,
	readText,
	sha256,
	slugify,
	timestampForId,
	writeJsonAtomic,
	writeAtomic,
} from "./paths.ts";
import type {
	AdaptationLevel,
	GateId,
	GateRecord,
	MangaPage,
	MangaProject,
	Phase,
	ProjectState,
	ProjectStats,
	RoleId,
	RunRecord,
	StyleSelection,
} from "./types.ts";

const ALLOWED: Record<Phase, Phase[]> = {
	idle: ["intake", "script_analysis"],
	intake: ["script_analysis"],
	script_analysis: ["script_gate", "design", "paused", "error"],
	script_gate: ["design", "script_analysis", "paused", "error"],
	design: ["cast", "paused", "error"],
	cast: ["character_images", "cast", "paused", "error"],
	character_images: ["cast_gate", "cast", "paused", "error"],
	cast_gate: ["storyboard", "cast", "paused", "error"],
	storyboard: ["storyboard_gate", "storyboard", "paused", "error"],
	storyboard_gate: ["prompts", "storyboard", "paused", "error"],
	prompts: ["image_gen", "prompts", "paused", "error"],
	image_gen: ["image_gen", "qa", "paused", "error"],
	qa: ["repair", "build", "paused", "error"],
	repair: ["qa", "image_gen", "build", "paused", "error"],
	build: ["final_gate", "done", "paused", "error"],
	final_gate: ["done", "build", "image_gen", "paused", "error"],
	export: ["done"],
	done: [],
	paused: [],
	error: [],
};

export function emptyStats(): ProjectStats {
	return { pages: 0, panels: 0, images: 0, failedImages: 0, totalUsage: { input: 0, output: 0, total: 0, cost: 0 } };
}

export function emptyGate(): GateRecord {
	return { status: "pending" };
}

export function initialState(): ProjectState {
	return {
		schemaVersion: 1,
		phase: "script_analysis",
		previousPhase: null,
		revision: 1,
		gates: { script: emptyGate(), cast: emptyGate(), storyboard: emptyGate(), final: emptyGate() },
		runs: [],
		stats: emptyStats(),
		lastError: null,
		pendingQuestions: [],
		pendingFeedback: null,
	};
}

export function statePath(root: string): string {
	return join(root, "state.json");
}

export function projectFilePath(root: string): string {
	return join(root, "project.json");
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class ProjectStore {
	readonly root: string;
	project: MangaProject;
	state: ProjectState;
	private lockHeld = false;

	constructor(root: string, project: MangaProject, state: ProjectState) {
		this.root = root;
		this.project = project;
		this.state = state;
	}

	static load(cwd: string, config: MangaConfig, slug?: string): ProjectStore {
		const root = projectsRoot(cwd, config);
		const names = listDirs(root);
		if (names.length === 0) throw new Error("当前没有漫画项目，请先运行 /manga init");
		const chosen = slug ?? names.find((name) => fileExists(join(root, name, "project.json"))) ?? names[0];
		const dir = join(root, chosen);
		if (!fileExists(join(dir, "project.json"))) throw new Error(`找不到漫画项目: ${chosen}`);
		return ProjectStore.loadByPath(dir);
	}

	static loadByPath(root: string): ProjectStore {
		const project = readJson<MangaProject>(projectFilePath(root));
		const state = readJson<ProjectState>(statePath(root));
		if (!project || project.schemaVersion !== 1) throw new Error(`项目状态文件损坏: ${projectFilePath(root)}`);
		if (!state || state.schemaVersion !== 1) throw new Error(`流水线状态文件损坏: ${statePath(root)}`);
		const store = new ProjectStore(root, project, state);
		store.markInterruptedRuns();
		return store;
	}

	get phase(): Phase {
		return this.state.phase;
	}

	saveState(): void {
		this.state.revision += 1;
		writeJsonAtomic(statePath(this.root), this.state);
	}

	saveProject(): void {
		this.project.updatedAt = nowIso();
		writeJsonAtomic(projectFilePath(this.root), this.project);
	}

	/** Mark a change and persist state so web/SSE clients can refresh. */
	touch(): void {
		this.saveState();
	}

	transition(next: Phase): void {
		const current = this.state.phase;
		if (next === current) return;
		if (next === "paused") {
			if (current === "paused") return;
			this.state.previousPhase = current;
			this.state.phase = "paused";
			this.saveState();
			return;
		}
		if (current === "paused" && this.state.previousPhase) {
			this.state.phase = this.state.previousPhase;
			this.state.previousPhase = null;
			if (this.state.phase === next) {
				this.saveState();
				return;
			}
		}
		if (next === "error") {
			if (current === "error") return;
			this.state.previousPhase = current;
			this.state.phase = "error";
			this.saveState();
			return;
		}
		if (current === "error" && this.state.previousPhase) {
			this.state.phase = this.state.previousPhase;
			this.state.previousPhase = null;
			if (this.state.phase === next) {
				this.saveState();
				return;
			}
		}
		const allowed = ALLOWED[this.state.phase] ?? [];
		if (!allowed.includes(next)) {
			throw new Error(`非法阶段迁移: ${this.state.phase} -> ${next}`);
		}
		this.state.phase = next;
		this.saveState();
	}

	canTransition(next: Phase): boolean {
		if (next === this.state.phase) return true;
		if (next === "paused" || next === "error") return true;
		return (ALLOWED[this.state.phase] ?? []).includes(next);
	}

	pause(): void {
		this.transition("paused");
	}

	resume(): void {
		if (this.state.phase !== "paused" || !this.state.previousPhase) throw new Error("当前不处于暂停状态");
		this.state.phase = this.state.previousPhase;
		this.state.previousPhase = null;
		this.saveState();
	}

	markError(message: string, runId?: string): void {
		this.state.lastError = { runId, message, at: nowIso() };
		this.transition("error");
		this.saveState();
	}

	clearError(): void {
		this.state.lastError = null;
		this.saveState();
	}

	markInterruptedRuns(): void {
		if (this.isLockLive()) return;
		let changed = false;
		for (const run of this.state.runs) {
			if (run.status === "running") {
				run.status = "interrupted";
				run.endedAt = nowIso();
				run.error = "进程在运行结束前退出";
				changed = true;
			}
		}
		if (changed) {
			this.state.phase = this.state.phase === "error" ? "error" : this.state.phase;
			this.saveState();
		}
	}

	beginRun(role: RoleId | "code", phase: Phase, options: { inputFiles?: string[]; note?: string } = {}): RunRecord {
		if (this.state.phase !== phase && this.canTransition(phase)) this.transition(phase);
		const run: RunRecord = {
			id: `${timestampForId()}-${role}-${Math.random().toString(36).slice(2, 6)}`,
			role,
			phase,
			status: "running",
			startedAt: nowIso(),
			inputFiles: options.inputFiles ?? [],
			outputFiles: [],
			note: options.note,
		};
		this.state.runs.push(run);
		this.saveState();
		return run;
	}

	finishRun(
		id: string,
		patch: Partial<Pick<RunRecord, "status" | "outputFiles" | "usage" | "error" | "model" | "thinkingLevel" | "validation">>,
	): void {
		const run = this.state.runs.find((item) => item.id === id);
		if (!run) return;
		Object.assign(run, patch);
		run.endedAt = nowIso();
		if (run.usage) {
			const usage = this.state.stats.totalUsage;
			usage.input += run.usage.input;
			usage.output += run.usage.output;
			usage.total = (usage.total ?? 0) + (run.usage.total ?? run.usage.input + run.usage.output);
			usage.cost = (usage.cost ?? 0) + (run.usage.cost ?? 0);
		}
		this.saveState();
	}

	getRun(id: string): RunRecord | undefined {
		return this.state.runs.find((run) => run.id === id);
	}

	lastRunFor(role: RoleId): RunRecord | undefined {
		for (let i = this.state.runs.length - 1; i >= 0; i--) {
			if (this.state.runs[i].role === role) return this.state.runs[i];
		}
		return undefined;
	}

	gate(gate: GateId): GateRecord {
		this.state.gates[gate] ??= emptyGate();
		return this.state.gates[gate];
	}

	recordGate(gate: GateId, status: GateRecord["status"], options: { feedback?: string; runId?: string } = {}): void {
		const record = this.gate(gate);
		record.status = status;
		record.decidedAt = nowIso();
		record.feedback = options.feedback;
		record.runId = options.runId;
		this.saveState();
	}

	resetGatesFrom(gate: GateId): void {
		const order: GateId[] = ["script", "cast", "storyboard", "final"];
		const index = order.indexOf(gate);
		for (let i = index; i < order.length; i++) this.state.gates[order[i]] = emptyGate();
		this.saveState();
	}

	acquireLock(role: RoleId | "code"): void {
		if (this.lockHeld) return;
		const path = join(this.root, ".lock");
		if (existsSync(path)) {
			const info = readJson<{ pid?: number; role?: string; startedAt?: string }>(path);
			const stat = fileStat(path);
			const alive = info?.pid ? isProcessAlive(info.pid) : false;
			const stale = stat ? isStale(stat.mtimeMs, 30 * 60 * 1000) : true;
			if (alive && !stale) {
				throw new Error(
					`另一个会话正在运行（pid ${info?.pid}，环节 ${info?.role ?? "未知"}）。请等待其完成，或确认无进程使用后删除 ${path}。`,
				);
			}
			try {
				unlinkSync(path);
			} catch {
				// ignore
			}
		}
		writeFileSync(path, JSON.stringify({ pid: process.pid, role, startedAt: nowIso() }, null, 2), {
			encoding: "utf8",
			flag: "wx",
		});
		this.lockHeld = true;
	}

	releaseLock(): void {
		if (!this.lockHeld) return;
		try {
			unlinkSync(join(this.root, ".lock"));
		} catch {
			// ignore
		}
		this.lockHeld = false;
	}

	hasLock(): boolean {
		return existsSync(join(this.root, ".lock"));
	}

	isLockLive(): boolean {
		const path = join(this.root, ".lock");
		if (!existsSync(path)) return false;
		const info = readJson<{ pid?: number }>(path);
		const stat = fileStat(path);
		if (!info?.pid || !stat) return false;
		return isProcessAlive(info.pid) && !isStale(stat.mtimeMs, 30 * 60 * 1000);
	}

	readPage(index: number): MangaPage | undefined {
		return readJson<MangaPage>(join(this.root, "pages", `page-${String(index).padStart(3, "0")}.json`));
	}

	readPageByKey(key: string): MangaPage | undefined {
		return readJson<MangaPage>(join(this.root, "pages", `${key}.json`));
	}

	listPageKeys(): string[] {
		try {
			return readdirSync(join(this.root, "pages"))
				.filter((name) => /^page-\d{3}\.json$/.test(name))
				.map((name) => basename(name, ".json"))
				.sort();
		} catch {
			return [];
		}
	}

	writePage(page: MangaPage): void {
		writeJsonAtomic(join(this.root, "pages", `${page.id}.json`), page);
	}

	refreshStats(): ProjectStats {
		const stats = emptyStats();
		stats.totalUsage = { ...this.state.stats.totalUsage };
		for (const key of this.listPageKeys()) {
			const page = this.readPageByKey(key);
			if (!page) continue;
			stats.pages += 1;
			for (const panel of page.panels) {
				stats.panels += 1;
				const status = panel.image?.status;
				if (status === "done") stats.images += 1;
				if (status === "failed") stats.failedImages += 1;
			}
		}
		this.state.stats = stats;
		this.saveState();
		return stats;
	}

	writeScript(text: string): string {
		const rel = "source/script.md";
		ensureDir(join(this.root, "source"));
		writeAtomic(join(this.root, rel), text.endsWith("\n") ? text : `${text}\n`);
		this.project.source = { file: rel, sha256: sha256(text) };
		this.saveProject();
		return rel;
	}

	readScript(): string {
		return readText(join(this.root, this.project.source.file)) ?? "";
	}

	readAnalysis() {
		return readJson<import("./types.ts").ScriptAnalysis>(join(this.root, "source", "analysis.json"));
	}

	readBible() {
		return readJson<import("./types.ts").Bible>(join(this.root, "bible.json"));
	}

	readClarifications(): string {
		return readText(join(this.root, "source", "clarifications.md")) ?? "";
	}
}

export interface ProjectSummary {
	slug: string;
	title: string;
	path: string;
	phase: Phase;
	updatedAt: string;
	pages: number;
	images: number;
	panels: number;
}

export function listProjects(cwd: string, config: MangaConfig): ProjectSummary[] {
	const root = projectsRoot(cwd, config);
	return listDirs(root)
		.map((slug) => {
			const dir = join(root, slug);
			const project = readJson<MangaProject>(projectFilePath(dir));
			const state = readJson<ProjectState>(statePath(dir));
			if (!project || !state) return undefined;
			return {
				slug,
				title: project.title,
				path: dir,
				phase: state.phase,
				updatedAt: project.updatedAt,
				pages: state.stats?.pages ?? 0,
				panels: state.stats?.panels ?? 0,
				images: state.stats?.images ?? 0,
			} satisfies ProjectSummary;
		})
		.filter((item): item is ProjectSummary => Boolean(item))
		.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export interface CreateProjectInput {
	title?: string;
	style: StyleSelection;
	adaptation?: AdaptationLevel;
	script: string;
	config: MangaConfig;
}

export function createProject(cwd: string, input: CreateProjectInput): ProjectStore {
	const script = input.script.trim();
	if (!script) throw new Error("剧本为空，无法创建项目");
	const title = (input.title ?? "").trim() || deriveTitle(script);
	const root = projectsRoot(cwd, input.config);
	ensureDir(root);
	let slug = slugify(title);
	let n = 2;
	while (existsSync(join(root, slug))) {
		slug = `${slugify(title)}-${n++}`;
	}
	const dir = join(root, slug);
	ensureDir(dir);
	for (const sub of ["source", "pages", "characters", "state", "logs", "qa", "exports", ".runs"]) {
		ensureDir(join(dir, sub));
	}
	const now = nowIso();
	const project: MangaProject = {
		schemaVersion: 1,
		slug,
		title,
		createdAt: now,
		updatedAt: now,
		language: "zh",
		style: input.style,
		...(input.adaptation ? { adaptation: input.adaptation } : {}),
		image: { ...input.config.image },
		gates: { ...input.config.gates },
		agents: { ...input.config.agents, overrides: { ...input.config.agents.overrides } },
		web: { ...input.config.web },
		qa: { ...input.config.qa },
		memory: { ...input.config.memory },
		config: {},
		source: { file: "source/script.md", sha256: sha256(script) },
	};
	const state = initialState();
	writeJsonAtomic(projectFilePath(dir), project);
	writeJsonAtomic(statePath(dir), state);
	const store = new ProjectStore(dir, project, state);
	store.writeScript(script);
	store.refreshStats();
	return store;
}

function deriveTitle(script: string): string {
	const firstLine = script
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return `漫画-${Date.now().toString(36)}`;
	return firstLine.replace(/^#+\s*/, "").slice(0, 32);
}

export function workspaceLabel(cwd: string, config: MangaConfig): string {
	return workspaceRoot(cwd, config);
}
