import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, readJson } from "./paths.ts";
import type {
	AgentConfig,
	GateId,
	GatePolicy,
	ImageConfig,
	MangaConfig,
	MangaProject,
	MemoryConfig,
	QaConfig,
	StylePreset,
	StyleSelection,
	WebConfig,
} from "./types.ts";
import { ROLE_IDS } from "./types.ts";

export const LOCKED_TOKENS = [
	"no watermark",
	"no signature",
	"no text other than the specified lettering",
];

export const STYLE_PRESETS: Record<Exclude<StylePreset, "custom">, { label: string; ratio: StyleSelection["ratio"]; prompt: string }> = {
	"manga-bw": {
		label: "黑白漫画",
		ratio: "3:4",
		prompt:
			"modern seinen manga, clean confident lineart, screentone shading, high contrast, cinematic composition",
	},
	"manhua-color": {
		label: "全彩国漫",
		ratio: "3:4",
		prompt:
			"Chinese manhua, full color, cel shading, crisp outlines, vibrant but controlled palette",
	},
	webtoon: {
		label: "竖屏条漫",
		ratio: "9:16",
		prompt:
			"Korean webtoon style, full color, soft gradients, vertical composition, generous negative space",
	},
};

export const LETTERING_STYLE =
	"clean black comic lettering, rounded white speech bubbles with thin black outlines";

export const DEFAULT_IMAGE: ImageConfig = {
	model: "agnes-image-2.5-flash",
	draftSize: "1K",
	finalSize: "2K",
	maxRefs: 4,
	usePreviousPanel: true,
	keepVersions: 2,
	timeoutMs: 240000,
	retries: 3,
	maxDownloadBytes: 32 * 1024 * 1024,
	streamChunkBytes: 64 * 1024,
};

export const DEFAULT_AGENTS: AgentConfig = {
	thinkingLevel: "medium",
	timeoutMs: 10 * 60 * 1000,
	maxAttempts: 2,
	overrides: {},
};

export const DEFAULT_GATES: Record<GateId, GatePolicy> = {
	script: "auto",
	cast: "always",
	storyboard: "always",
	final: "always",
};

export const DEFAULT_WEB: WebConfig = {
	host: "127.0.0.1",
	port: 45871,
	token: "auto",
	open: true,
};

export const DEFAULT_QA: QaConfig = { vision: false, repairRounds: 1 };

export const DEFAULT_MEMORY: MemoryConfig = {
	logRotateBytes: 2 * 1024 * 1024,
	webCacheBytes: 256 * 1024,
	previewChars: 160,
	zipChunkBytes: 1024 * 1024,
};

export const DEFAULT_CONFIG: MangaConfig = {
	schemaVersion: 1,
	workspace: ".automanga",
	style: "manga-bw",
	agnes: {
		baseUrl: "https://apihub.agnes-ai.com/v1",
		model: "agnes-image-2.5-flash",
		apiKeyEnv: "AGNES_API_KEY",
		timeoutMs: 240000,
		retries: 3,
	},
	image: DEFAULT_IMAGE,
	agents: DEFAULT_AGENTS,
	gates: DEFAULT_GATES,
	web: DEFAULT_WEB,
	qa: DEFAULT_QA,
	memory: DEFAULT_MEMORY,
};

export function deepMerge<T>(base: T, patch: unknown): T {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
	const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
		const current = result[key];
		if (value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)) {
			result[key] = deepMerge(current, value);
		} else if (value !== undefined) {
			result[key] = value;
		}
	}
	return result as T;
}

export function globalConfigPath(agentDir: string): string {
	return join(agentDir, "mz-automanga.json");
}

export function loadGlobalConfig(agentDir: string): MangaConfig {
	const raw = readJson<Partial<MangaConfig>>(globalConfigPath(agentDir));
	if (!raw) return structuredClone(DEFAULT_CONFIG);
	return normalizeConfig(deepMerge(structuredClone(DEFAULT_CONFIG), raw));
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizeConfig(config: MangaConfig): MangaConfig {
	config.image.maxRefs = clamp(config.image.maxRefs, 4, 0, 8);
	config.image.keepVersions = clamp(config.image.keepVersions, 2, 0, 10);
	config.image.timeoutMs = clamp(config.image.timeoutMs, 240000, 60000, 360000);
	config.image.retries = clamp(config.image.retries, 3, 0, 6);
	config.image.maxDownloadBytes = clamp(config.image.maxDownloadBytes, 32 * 1024 * 1024, 1024 * 1024, 128 * 1024 * 1024);
	config.image.streamChunkBytes = clamp(config.image.streamChunkBytes, 64 * 1024, 16 * 1024, 1024 * 1024);
	config.agents.timeoutMs = clamp(config.agents.timeoutMs, 600000, 60000, 30 * 60 * 1000);
	config.agents.maxAttempts = clamp(config.agents.maxAttempts, 2, 1, 4);
	config.memory.logRotateBytes = clamp(config.memory.logRotateBytes, 2 * 1024 * 1024, 256 * 1024, 32 * 1024 * 1024);
	config.memory.webCacheBytes = clamp(config.memory.webCacheBytes, 256 * 1024, 32 * 1024, 4 * 1024 * 1024);
	config.memory.previewChars = clamp(config.memory.previewChars, 160, 40, 800);
	config.memory.zipChunkBytes = clamp(config.memory.zipChunkBytes, 1024 * 1024, 64 * 1024, 8 * 1024 * 1024);
	config.web.port = clamp(config.web.port, 45871, 1024, 65535);
	if (!config.agents.overrides || typeof config.agents.overrides !== "object") config.agents.overrides = {};
	for (const role of ROLE_IDS) {
		const override = config.agents.overrides[role];
		if (override && typeof override !== "object") delete config.agents.overrides[role];
	}
	return config;
}

export function saveGlobalConfig(agentDir: string, config: MangaConfig): void {
	ensureDir(agentDir);
	const path = globalConfigPath(agentDir);
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// best effort on platforms without chmod
	}
}

export function configFileIsPrivate(agentDir: string): boolean {
	const path = globalConfigPath(agentDir);
	if (!existsSync(path)) return true;
	try {
		const mode = statSync(path).mode & 0o777;
		return (mode & 0o077) === 0;
	} catch {
		return false;
	}
}

export function readRawGlobalConfig(agentDir: string): string | undefined {
	try {
		return readFileSync(globalConfigPath(agentDir), "utf8");
	} catch {
		return undefined;
	}
}

export function makeStyle(preset: StylePreset, customPrompt?: string | null, ratio?: StyleSelection["ratio"]): StyleSelection {
	if (preset === "custom") {
		const prompt = (customPrompt ?? "").trim();
		if (!prompt) throw new Error("自定义画风需要提供风格描述");
		return {
			preset,
			label: "自定义",
			customPrompt: prompt,
			ratio: ratio ?? "3:4",
			lockedTokens: [...LOCKED_TOKENS],
		};
	}
	const def = STYLE_PRESETS[preset];
	return {
		preset,
		label: def.label,
		customPrompt: null,
		ratio: ratio ?? def.ratio,
		lockedTokens: [...LOCKED_TOKENS],
	};
}

export function styleBasePrompt(style: StyleSelection): string {
	const base = style.preset === "custom" ? (style.customPrompt ?? "").trim() : STYLE_PRESETS[style.preset].prompt;
	return base;
}

/**
 * The style block appended verbatim to every image prompt. Agents must copy it
 * without edits; validators check that the locked tokens are present.
 */
export function composeStylePrompt(style: StyleSelection): string {
	return [
		styleBasePrompt(style),
		LETTERING_STYLE,
		`${style.lockedTokens.join(", ")}`,
	]
		.filter(Boolean)
		.join(", ");
}

export function projectConfig(cwd: string, project: MangaProject, global: MangaConfig): MangaConfig {
	const merged = deepMerge(structuredClone(global), project.config ?? {});
	merged.style = project.style.preset;
	merged.image = { ...merged.image, ...project.image, model: project.image.model || merged.image.model };
	merged.gates = { ...merged.gates, ...project.gates };
	merged.agents = { ...merged.agents, ...project.agents, overrides: { ...merged.agents.overrides, ...project.agents.overrides } };
	merged.web = { ...merged.web, ...project.web };
	merged.qa = { ...merged.qa, ...project.qa };
	merged.memory = { ...merged.memory, ...project.memory };
	if (!merged.workspace) merged.workspace = ".automanga";
	return normalizeConfig(merged);
}

export function workspaceRoot(cwd: string, config: MangaConfig): string {
	return join(cwd, config.workspace || ".automanga");
}

export function projectsRoot(cwd: string, config: MangaConfig): string {
	return join(workspaceRoot(cwd, config), "projects");
}
