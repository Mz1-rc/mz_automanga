import { configFileIsPrivate, loadGlobalConfig, saveGlobalConfig, type MangaConfig } from "./config.ts";

export interface ResolvedKey {
	key: string;
	source: "env" | "config";
}

function defaultEnvName(providerId: string, config: MangaConfig): string {
	const id = providerId.trim().toLowerCase();
	if (id === "agnes") return config.agnes.apiKeyEnv || "AGNES_API_KEY";
	const configured = config.providers?.[id]?.apiKeyEnv?.trim();
	if (configured) return configured;
	return `${id.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_API_KEY`;
}

/** Resolve the API key for any registered image provider. */
export function resolveProviderKey(
	config: MangaConfig,
	agentDir: string,
	providerId: string,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedKey | undefined {
	const id = providerId.trim().toLowerCase() || "agnes";
	const settings = config.providers?.[id];
	const envName = settings?.apiKeyEnv?.trim() || defaultEnvName(id, config);
	const fromEnv = env[envName];
	if (fromEnv && fromEnv.trim()) return { key: fromEnv.trim(), source: "env" };
	const fileKey = settings?.apiKey?.trim() || (id === "agnes" ? config.agnes.apiKey?.trim() : "");
	if (!fileKey) return undefined;
	if (!configFileIsPrivate(agentDir)) {
		throw new Error(
			`${agentDir}/mz-automanga.json 权限过于开放（应为 0600），拒绝读取其中的 API Key。请运行 chmod 600 后重试，或改用环境变量 ${envName}。`,
		);
	}
	return { key: fileKey, source: "config" };
}

export function resolveAgnesKey(config: MangaConfig, agentDir: string, env: NodeJS.ProcessEnv = process.env): ResolvedKey | undefined {
	return resolveProviderKey(config, agentDir, "agnes", env);
}

/** Save a provider key in the 0600 config file (Agnes also mirrors the legacy field). */
export function saveProviderKey(agentDir: string, providerId: string, key: string): void {
	const config = loadGlobalConfig(agentDir);
	const id = providerId.trim().toLowerCase() || "agnes";
	config.providers = config.providers ?? {};
	config.providers[id] = { ...(config.providers[id] ?? {}), apiKey: key.trim() };
	if (id === "agnes") config.agnes.apiKey = key.trim();
	saveGlobalConfig(agentDir, config);
}

export function saveAgnesKey(agentDir: string, key: string): void {
	saveProviderKey(agentDir, "agnes", key);
}

export function clearProviderKey(agentDir: string, providerId: string): void {
	const config = loadGlobalConfig(agentDir);
	const id = providerId.trim().toLowerCase() || "agnes";
	if (config.providers?.[id]) config.providers[id] = { ...config.providers[id], apiKey: "" };
	if (id === "agnes") config.agnes.apiKey = "";
	saveGlobalConfig(agentDir, config);
}

export function clearAgnesKey(agentDir: string): void {
	clearProviderKey(agentDir, "agnes");
}

export function maskKey(key: string): string {
	if (key.length <= 8) return "*".repeat(key.length);
	return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
