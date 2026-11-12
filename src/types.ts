/**
 * Shared types for mz_automanga.
 *
 * This module must stay free of Pi imports so that state / artifacts / prompts
 * can be unit-tested with plain Node.js.
 */

export const ROLE_IDS = [
	"script_analyst",
	"director",
	"character_designer",
	"storyboard",
	"prompt_artist",
	"editor",
	"repairer",
] as const;

export type RoleId = (typeof ROLE_IDS)[number];

export const GATE_IDS = ["script", "cast", "storyboard", "final"] as const;
export type GateId = (typeof GATE_IDS)[number];

export const PHASES = [
	"idle",
	"intake",
	"script_analysis",
	"script_gate",
	"design",
	"cast",
	"character_images",
	"cast_gate",
	"storyboard",
	"storyboard_gate",
	"prompts",
	"image_gen",
	"qa",
	"repair",
	"build",
	"final_gate",
	"export",
	"done",
	"paused",
	"error",
] as const;

export type Phase = (typeof PHASES)[number];

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const STYLE_PRESETS = ["manga-bw", "manhua-color", "webtoon", "custom"] as const;
export type StylePreset = (typeof STYLE_PRESETS)[number];

export type GatePolicy = "auto" | "always" | "off";

export interface StyleSelection {
	preset: StylePreset;
	label: string;
	customPrompt?: string | null;
	ratio: "1:1" | "3:4" | "2:3" | "4:3" | "16:9" | "9:16";
	lockedTokens: string[];
}

export interface ImageConfig {
	model: string;
	draftSize: "1K" | "2K" | "3K" | "4K";
	finalSize: "1K" | "2K" | "3K" | "4K";
	maxRefs: number;
	usePreviousPanel: boolean;
	keepVersions: number;
	timeoutMs: number;
	retries: number;
	maxDownloadBytes: number;
	streamChunkBytes: number;
}

export interface AgentOverrides {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface AgentConfig {
	thinkingLevel: ThinkingLevel;
	timeoutMs: number;
	maxAttempts: number;
	overrides: Partial<Record<RoleId, AgentOverrides>>;
}

export interface WebConfig {
	host: string;
	port: number;
	open: boolean;
}

export interface QaConfig {
	vision: boolean;
	repairRounds: number;
}

export interface MemoryConfig {
	logRotateBytes: number;
	webCacheBytes: number;
	previewChars: number;
	zipChunkBytes: number;
}

export interface MangaConfig {
	schemaVersion: 1;
	workspace: string;
	style: StylePreset;
	agnes: {
		baseUrl: string;
		model: string;
		apiKey?: string;
		apiKeyEnv: string;
		timeoutMs: number;
		retries: number;
	};
	image: ImageConfig;
	agents: AgentConfig;
	gates: Record<GateId, GatePolicy>;
	web: WebConfig;
	qa: QaConfig;
	memory: MemoryConfig;
}

export interface MangaProject {
	schemaVersion: 1;
	slug: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	language: string;
	style: StyleSelection;
	image: ImageConfig;
	gates: Record<GateId, GatePolicy>;
	agents: AgentConfig;
	web: WebConfig;
	qa: QaConfig;
	memory: MemoryConfig;
	config?: Partial<MangaConfig>;
	source: { file: string; sha256: string };
}

export interface GateRecord {
	status: "pending" | "approved" | "rejected";
	decidedAt?: string;
	feedback?: string;
	runId?: string;
}

export interface RunUsage {
	input: number;
	output: number;
	total?: number;
	cost?: number;
}

export interface RunRecord {
	id: string;
	role: RoleId | "code";
	phase: Phase;
	status: "running" | "success" | "error" | "aborted" | "interrupted";
	startedAt: string;
	endedAt?: string;
	model?: string;
	thinkingLevel?: string;
	inputFiles: string[];
	outputFiles: string[];
	usage?: RunUsage;
	validation?: { ok: boolean; issues: string[] };
	error?: string;
	note?: string;
}

export interface ProjectStats {
	pages: number;
	panels: number;
	images: number;
	failedImages: number;
	totalUsage: RunUsage;
}

export interface ProjectState {
	schemaVersion: 1;
	phase: Phase;
	previousPhase?: Phase | null;
	revision: number;
	gates: Record<GateId, GateRecord>;
	runs: RunRecord[];
	stats: ProjectStats;
	lastError?: { runId?: string; message: string; at: string } | null;
	pendingQuestions?: ScriptIssue[];
	/** Feedback captured at a gate, consumed by the next producing stage. */
	pendingFeedback?: string | null;
}

/** ---- script analysis ---- */

export type ScriptFormat = "novel" | "screenplay" | "outline" | "idea";

export interface ScriptIssue {
	id: string;
	severity: "blocker" | "major" | "minor";
	question: string;
	options: string[];
	assumption: string;
}

export interface SceneDialogue {
	speaker?: string;
	text: string;
}

export interface Scene {
	id: string;
	title: string;
	summary: string;
	location?: string;
	time?: string;
	characters: string[];
	beats: string[];
	dialogue?: SceneDialogue[];
}

export interface ScriptAnalysis {
	schemaVersion: 1;
	format: ScriptFormat;
	language: string;
	titleSuggestion: string;
	logline: string;
	pageEstimate: number;
	readingDirection?: "rtl" | "ltr";
	scenes: Scene[];
	status: "clear" | "needs_clarification";
	issues: ScriptIssue[];
	assumptions: string[];
}

/** ---- bible ---- */

export interface CharacterOutfitMap {
	default: string;
	[key: string]: string;
}

export interface CastMember {
	id: string;
	name: string;
	role: string;
	age?: string;
	canonical: string;
	outfits: CharacterOutfitMap;
	personality?: string;
	speechStyle?: string;
	distinctive?: string[];
	colors?: Record<string, string>;
	refSheet?: string;
	refPrompt?: string;
}

export interface BibleArt {
	preset: StylePreset;
	stylePrompt: string;
	letteringStyle: string;
	palette: string[];
	lineWeight?: string;
	backgroundDetail?: string;
	characterStyle?: string;
}

export interface BibleWorld {
	era?: string;
	locations: Array<{ id: string; name: string; description: string }>;
}

export interface Bible {
	schemaVersion: 1;
	title: string;
	logline: string;
	genre: string[];
	tone: string;
	audience: string;
	art: BibleArt;
	world: BibleWorld;
	cast: CastMember[];
	assumptions?: string[];
}

/** ---- pages ---- */

export type BubblePosition = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
export type BubbleShape = "rounded" | "spiky" | "cloud" | "box";

export interface PanelDialogue {
	type: "speech" | "thought" | "narration" | "sfx";
	speaker?: string;
	text: string;
	emotion?: string;
	bubble: { position: BubblePosition; shape: BubbleShape; tail?: string; size?: "small" | "medium" | "large" };
}

export interface PanelCharacter {
	id: string;
	outfit?: string;
	pose?: string;
	expression?: string;
	focus?: "primary" | "secondary";
}

export interface PanelImageState {
	status: "pending" | "running" | "done" | "failed";
	file?: string;
	sourceUrl?: string | null;
	cacheKey?: string;
	size?: string;
	ratio?: string;
	width?: number;
	height?: number;
	attempts?: number;
	generatedAt?: string;
	error?: string;
}

export interface Panel {
	id: string;
	shot: string;
	camera?: { angle?: string; lens?: string; tilt?: string };
	location?: string;
	time?: string;
	characters: PanelCharacter[];
	action: string;
	background?: string;
	lighting?: string;
	mood?: string;
	composition?: string;
	dialogue: PanelDialogue[];
	sfx?: string[];
	promptCore?: string;
	lettering?: { instructions: string };
	prompt?: string;
	negative?: string;
	refs?: string[];
	continuityFrom?: string | null;
	promptOverride?: string | null;
	image?: PanelImageState;
	notes?: string;
}

export interface MangaPage {
	schemaVersion: 1;
	id: string;
	index: number;
	summary: string;
	layout?: string;
	panels: Panel[];
}

/** ---- qa ---- */

export interface QaIssue {
	panel: string;
	severity: "minor" | "major" | "blocker";
	type: string;
	message: string;
	suggestedFix?: string;
}

export interface QaReport {
	schemaVersion: 1;
	generatedAt: string;
	structural: { errors: string[]; warnings: string[] };
	lettering: { checked: number; missingText: string[]; overlong: string[]; tooManyBubbles: string[] };
	vision: { enabled: boolean; issues: QaIssue[] };
	verdict: "pass" | "needs-repair";
	repairTargets: string[];
}

/** ---- runtime ---- */

export interface ProgressUpdate {
	kind: "text" | "tool" | "usage" | "status" | "stage";
	detail?: string;
	toolName?: string;
	text?: string;
	usage?: RunUsage;
	contextTokens?: number;
	contextPercent?: number;
	stage?: string;
}

export interface RoleRunOptions {
	role: RoleId;
	projectRoot: string;
	runDir: string;
	targets: string[];
	systemPrompt: string;
	taskPrompt: string;
	model?: unknown;
	thinkingLevel?: ThinkingLevel;
	compact?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (update: ProgressUpdate) => void;
	onWrite?: (target: string, chars: number) => void;
}

export interface RoleRunResult {
	finalText: string;
	usage: RunUsage;
	outputs: string[];
	model?: string;
	thinkingLevel?: string;
}

export interface RunStatus {
	/** Background job label, e.g. "推进下一阶段". */
	label?: string;
	/** Job start time (epoch ms) for elapsed display. */
	startedAt?: number;
	/** Job end time (epoch ms); freezes elapsed after completion. */
	endedAt?: number;
	/** Current phase label, e.g. "生成画面". */
	stage?: string;
	/** Current role or action, e.g. "提示词美术". */
	role?: string;
	/** Last progress detail, e.g. "page-002/panel-03 · 读取 pages/page-002.json". */
	detail?: string;
	/** Current step within a loop. */
	step?: number;
	total?: number;
	/** Last tool call observed in a nested session. */
	lastTool?: string;
	/** Live token usage of the currently running role (not the project total). */
	usage?: RunUsage;
	/** Nested-session context usage, when available. */
	contextTokens?: number;
	contextPercent?: number;
	/** Read-only preview URL, when the web server is running. */
	webUrl?: string;
	/** True when the job has finished (successfully or not). */
	done?: boolean;
	/** Job error message, if any. */
	error?: string;
}

export interface StageRecord {
	status: "pending" | "running" | "done" | "failed" | "skipped";
	attempts: number;
	depsHash?: string;
	startedAt?: string;
	endedAt?: string;
	durationMs?: number;
	error?: string;
}
