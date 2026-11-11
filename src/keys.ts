import { configFileIsPrivate, loadGlobalConfig, saveGlobalConfig, type MangaConfig } from "./config.ts";

export interface ResolvedKey {
	key: string;
	source: "env" | "config";
}

export function resolveAgnesKey(config: MangaConfig, agentDir: string, env: NodeJS.ProcessEnv = process.env): ResolvedKey | undefined {
	const envName = config.agnes.apiKeyEnv || "AGNES_API_KEY";
	const fromEnv = env[envName];
	if (fromEnv && fromEnv.trim()) return { key: fromEnv.trim(), source: "env" };
	const fileKey = config.agnes.apiKey?.trim();
	if (!fileKey) return undefined;
	if (!configFileIsPrivate(agentDir)) {
		throw new Error(
			`${agentDir}/mz-automanga.json 权限过于开放（应为 0600），拒绝读取其中的 API Key。请运行 chmod 600 后重试，或改用环境变量 ${envName}。`,
		);
	}
	return { key: fileKey, source: "config" };
}

export function saveAgnesKey(agentDir: string, key: string): void {
	const config = loadGlobalConfig(agentDir);
	config.agnes.apiKey = key.trim();
	saveGlobalConfig(agentDir, config);
}

export function clearAgnesKey(agentDir: string): void {
	const config = loadGlobalConfig(agentDir);
	config.agnes.apiKey = "";
	saveGlobalConfig(agentDir, config);
}

export function maskKey(key: string): string {
	if (key.length <= 8) return "*".repeat(key.length);
	return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
