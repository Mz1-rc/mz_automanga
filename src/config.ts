import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_IMAGE, normalizeImageConfig } from "./imagegen/config.ts";
import { LOCKED_TOKENS, STYLE_PRESETS } from "./imagegen/style.ts";
import { ensureDir, readJson } from "./paths.ts";
import type {
	AgentConfig,
	GateId,
	GatePolicy,
	MangaConfig,
	MangaProject,
	MemoryConfig,
	QaConfig,
	SourceConfig,
	StylePreset,
	StyleSelection,
	WebConfig,
} from "./types.ts";
import { ROLE_IDS } from "./types.ts";

// Style constants and enforcement live in the image module; re-exported here
// so existing imports (`composeStylePrompt`, `makeStyle`, …) keep working.
export {
	LETTERING_STYLE,
	LOCKED_TOKENS,
	MONOCHROME_LOCK,
	STYLE_PRESETS,
	composeStylePrompt,
	enforceStyleNegative,
	enforceStylePrompt,
	isMonochromeStyle,
	styleBasePrompt,
} from "./imagegen/style.ts";
export { DEFAULT_IMAGE } from "./imagegen/config.ts";

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
	// Read-only preview is reachable from the LAN by default. There is no
	// authentication: the framework only exposes GET/HEAD routes.
	host: "0.0.0.0",
	// 0 means "not configured": the web server requires an explicit port.
	port: 0,
	open: true,
};

export const DEFAULT_QA: QaConfig = { vision: false, repairRounds: 1 };

export const DEFAULT_MEMORY: MemoryConfig = {
	logRotateBytes: 2 * 1024 * 1024,
	webCacheBytes: 256 * 1024,
	previewChars: 160,
	zipChunkBytes: 1024 * 1024,
};

/**
 * Long-script policy. A unit must stay small enough that analyst / director /
 * storyboard can read it in full; above the threshold the input is split into
 * chapters (when headings exist) or size-bounded chunks.
 */
export const DEFAULT_SOURCE: SourceConfig = {
	maxUnitChars: 60_000,
	splitThresholdChars: 60_000,
	maxStoryboardPagesPerUnit: 40,
	maxInputBytes: 64 * 1024 * 1024,
};

export const DEFAULT_PROVIDERS: NonNullable<MangaConfig["providers"]> = {
	agnes: {
		baseUrl: "https://apihub.agnes-ai.com/v1",
		model: "agnes-image-2.5-flash",
		apiKeyEnv: "AGNES_API_KEY",
	},
	ark: {
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		model: "doubao-seedream-5-5-261028",
		apiKeyEnv: "ARK_API_KEY",
	},
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
	providers: structuredClone(DEFAULT_PROVIDERS),
	image: DEFAULT_IMAGE,
	agents: DEFAULT_AGENTS,
	gates: DEFAULT_GATES,
	web: DEFAULT_WEB,
	qa: DEFAULT_QA,
	memory: DEFAULT_MEMORY,
	source: DEFAULT_SOURCE,
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
	normalizeImageConfig(config.image);
	if (!config.providers || typeof config.providers !== "object" || Array.isArray(config.providers)) {
		config.providers = {};
	}
	for (const [id, defaults] of Object.entries(DEFAULT_PROVIDERS)) {
		const current = config.providers[id];
		config.providers[id] = {
			...defaults,
			...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
		};
	}
	config.agents.timeoutMs = clamp(config.agents.timeoutMs, 600000, 60000, 30 * 60 * 1000);
	config.agents.maxAttempts = clamp(config.agents.maxAttempts, 2, 1, 4);
	config.memory.logRotateBytes = clamp(config.memory.logRotateBytes, 2 * 1024 * 1024, 256 * 1024, 32 * 1024 * 1024);
	config.memory.webCacheBytes = clamp(config.memory.webCacheBytes, 256 * 1024, 32 * 1024, 4 * 1024 * 1024);
	config.memory.previewChars = clamp(config.memory.previewChars, 160, 40, 800);
	config.memory.zipChunkBytes = clamp(config.memory.zipChunkBytes, 1024 * 1024, 64 * 1024, 8 * 1024 * 1024);
	if (!config.source || typeof config.source !== "object" || Array.isArray(config.source)) {
		config.source = { ...DEFAULT_SOURCE };
	}
	config.source.maxUnitChars = clamp(config.source.maxUnitChars, DEFAULT_SOURCE.maxUnitChars, 4_000, 200_000);
	config.source.splitThresholdChars = clamp(
		config.source.splitThresholdChars,
		DEFAULT_SOURCE.splitThresholdChars,
		1_000,
		2_000_000,
	);
	config.source.maxStoryboardPagesPerUnit = clamp(
		config.source.maxStoryboardPagesPerUnit,
		DEFAULT_SOURCE.maxStoryboardPagesPerUnit,
		1,
		200,
	);
	config.source.maxInputBytes = clamp(
		config.source.maxInputBytes,
		DEFAULT_SOURCE.maxInputBytes,
		1024 * 1024,
		512 * 1024 * 1024,
	);
	const port = Number(config.web.port);
	config.web.port = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0;
	if (!config.agents.overrides || typeof config.agents.overrides !== "object") config.agents.overrides = {};
	for (const role of ROLE_IDS) {
		const override = config.agents.overrides[role];
		if (override && typeof override !== "object") delete config.agents.overrides[role];
	}
	// Drop the legacy token field from old config/project files; the read-only
	// preview no longer has an authentication layer. A file that still carries
	// `token` predates v0.5, so its old loopback default is migrated to the new
	// 0.0.0.0 default as well.
	const legacyWeb = config.web as WebConfig & { token?: unknown };
	if ("token" in legacyWeb) {
		delete legacyWeb.token;
		if (legacyWeb.host === "127.0.0.1" || legacyWeb.host === "localhost" || legacyWeb.host === "::1") {
			legacyWeb.host = "0.0.0.0";
		}
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

export function seriesRoot(cwd: string, config: MangaConfig): string {
	return join(workspaceRoot(cwd, config), "series");
}
