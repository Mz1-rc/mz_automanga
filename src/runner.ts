import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ArtifactManager } from "./artifacts.ts";
import { createSaveArtifactTool } from "./artifact-tool.ts";
import { ensureDir } from "./paths.ts";
import type { ProgressUpdate, RoleRunOptions, RoleRunResult, RunUsage } from "./types.ts";

let active = false;

function emptyUsage(): RunUsage {
	return { input: 0, output: 0, total: 0, cost: 0 };
}

function addUsage(total: RunUsage, usage: any): void {
	if (!usage) return;
	const input = Number(usage.input) || 0;
	const output = Number(usage.output) || 0;
	const cacheRead = Number(usage.cacheRead) || 0;
	const cacheWrite = Number(usage.cacheWrite) || 0;
	total.input += input;
	total.output += output;
	total.total = (total.total ?? 0) + (Number(usage.totalTokens) || input + output + cacheRead + cacheWrite);
	total.cost = (total.cost ?? 0) + (Number(usage.cost?.total) || 0);
}

function describeTool(toolName: string, args: any): string {
	const a = args && typeof args === "object" ? args : {};
	switch (toolName) {
		case "read":
			return `读取 ${a.path ?? a.file_path ?? "文件"}`;
		case "grep":
			return `搜索「${a.pattern ?? ""}」`;
		case "find":
			return `查找 ${a.pattern ?? ""}`;
		case "ls":
			return `列出 ${a.path ?? "."}`;
		case "save_artifact":
			return `保存 ${a.target ?? "工件"}`;
		default:
			return toolName;
	}
}

/**
 * Run exactly one role in an isolated, in-memory AgentSession.
 *
 * Strictly single-flight: the pipeline awaits each call before starting the
 * next role, and this module refuses concurrent calls even if a caller tries.
 * The session has no bash/write/edit tools and cannot spawn another Pi process.
 */
export async function runRole(options: RoleRunOptions): Promise<RoleRunResult> {
	if (active) throw new Error("已有角色会话在运行；本项目严格线性，不允许并行。");
	active = true;
	ensureDir(options.runDir);

	const settings = SettingsManager.inMemory({
		compaction: options.compact
			? { enabled: true, reserveTokens: 16384, keepRecentTokens: 30000 }
			: { enabled: false },
		retry: { enabled: true, maxRetries: 2 },
	} as never);

	const agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd: options.projectRoot,
		agentDir,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: options.systemPrompt,
		appendSystemPrompt: [],
	} as never);
	await loader.reload();

	const artifacts = new ArtifactManager(options.projectRoot, options.runDir, options.targets);
	const usage = emptyUsage();
	let preview = "";
	let timedOut = false;
	let abortRequested = false;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const emit = (update: ProgressUpdate) => {
		try {
			options.onProgress?.(update);
		} catch {
			// progress observers must never break a run
		}
	};

	const artifactTool = createSaveArtifactTool(artifacts, (target, chars) => {
		options.onWrite?.(target, chars);
		emit({ kind: "tool", toolName: "save_artifact", detail: `已保存 ${target}（${chars} 字）` });
	});

	try {
		const created = await createAgentSession({
			cwd: options.projectRoot,
			agentDir,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(options.projectRoot),
			settingsManager: settings,
			model: options.model as never,
			thinkingLevel: options.thinkingLevel as never,
			tools: ["read", "grep", "find", "ls", "save_artifact"],
			customTools: [artifactTool],
		} as never);
		session = created.session;

		let lastContextAt = 0;
		let cachedContext: ReturnType<typeof session.getContextUsage> | undefined;
		const emitProgress = (update: ProgressUpdate) => {
			const now = Date.now();
			if (update.kind !== "text" || now - lastContextAt >= 500) {
				try {
					cachedContext = session?.getContextUsage();
				} catch {
					cachedContext = undefined;
				}
				lastContextAt = now;
			}
			emit({
				...update,
				usage: { ...usage },
				contextTokens: cachedContext?.tokens ?? undefined,
				contextPercent: cachedContext?.percent ?? undefined,
			});
		};

		const unsubscribe = session.subscribe((event: any) => {
			try {
				if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
					const delta = String(event.assistantMessageEvent.delta ?? "");
					preview = `${preview}${delta}`.slice(-160);
					emitProgress({ kind: "text", text: preview, detail: `生成中 ${preview.length} 字` });
				} else if (event.type === "tool_execution_start") {
					emitProgress({ kind: "tool", toolName: event.toolName, detail: describeTool(event.toolName, event.args) });
				} else if (event.type === "tool_execution_end") {
					emitProgress({
						kind: "tool",
						toolName: event.toolName,
						detail: `${event.toolName} ${event.isError ? "失败" : "完成"}`,
					});
				} else if (event.type === "message_end" && event.message?.role === "assistant") {
					addUsage(usage, event.message.usage);
					emitProgress({ kind: "usage", detail: "用量更新" });
				} else if (event.type === "agent_settled") {
					emitProgress({ kind: "status", detail: "角色运行完成" });
				}
			} catch {
				// ignore observer errors
			}
		});

		const onAbort = () => {
			abortRequested = true;
			void session?.abort().catch(() => undefined);
		};
		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
		timer = setTimeout(() => {
			timedOut = true;
			void session?.abort().catch(() => undefined);
		}, timeoutMs);

		try {
			await session.prompt(options.taskPrompt);
		} catch (error) {
			if (timedOut) throw new Error(`角色运行超时（${timeoutMs}ms）`);
			if (abortRequested) throw new Error("角色运行已取消");
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
			if (options.signal) options.signal.removeEventListener("abort", onAbort);
			unsubscribe();
		}

		if (timedOut) throw new Error(`角色运行超时（${timeoutMs}ms）`);
		if (abortRequested) throw new Error("角色运行已取消");

		const model = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
		return {
			finalText: session.getLastAssistantText() ?? "",
			usage,
			outputs: [...artifacts.written.keys()],
			model,
			thinkingLevel: String(session.thinkingLevel ?? options.thinkingLevel ?? ""),
		};
	} finally {
		if (timer) clearTimeout(timer);
		try {
			session?.dispose();
		} catch {
			// ignore
		}
		active = false;
	}
}
