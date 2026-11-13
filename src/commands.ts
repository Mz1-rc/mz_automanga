import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	actionAbort,
	actionApprove,
	actionAuto,
	actionCast,
	actionCompress,
	actionConfig,
	actionDoctor,
	actionExport,
	actionInit,
	actionKey,
	actionListProjects,
	actionModels,
	actionNext,
	actionOpen,
	actionPause,
	actionPrompt,
	actionProvider,
	actionQa,
	actionRegen,
	actionResume,
	actionRevise,
	actionRollback,
	actionRunAll,
	actionRunRole,
	actionStatus,
	actionStep,
	actionStyle,
	actionWeb,
	type ActionCtx,
} from "./actions.ts";
import type { MangaApp } from "./app.ts";
import { ROLE_IDS } from "./types.ts";

interface Parsed {
	positionals: string[];
	flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(["force", "final", "open", "regen", "test", "vision", "no-export", "cbz"]);
const VALUE_FLAGS = new Set(["script", "dir", "title", "style", "custom", "ratio", "adaptation", "host", "port", "note", "key", "auto", "provider", "model"]);

export function parseArgs(input: string): Parsed {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(input)) !== null) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const body = token.slice(2);
		const eq = body.indexOf("=");
		if (eq >= 0) {
			flags[body.slice(0, eq)] = body.slice(eq + 1);
			continue;
		}
		if (BOOLEAN_FLAGS.has(body)) {
			flags[body] = true;
			continue;
		}
		if (VALUE_FLAGS.has(body) && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
			flags[body] = tokens[++i];
			continue;
		}
		flags[body] = true;
	}
	return { positionals, flags };
}

function str(flags: Record<string, string | boolean>, name: string): string | undefined {
	const value = flags[name];
	return typeof value === "string" ? value : undefined;
}

function bool(flags: Record<string, string | boolean>, name: string): boolean {
	return flags[name] === true || flags[name] === "true";
}

const HELP = `mz_automanga · 多 Agent 漫画流水线

  /manga init [--script <文件|目录>] [--title <书名>] [--style <preset>]
              [--adaptation strict|balanced|free]
  /manga status
  /manga next              推进下一阶段（后台）
  /manga step              只执行下一步（后台）
  /manga run-all           全自动跑完（跳过闸门，仍做校验）
  /manga run <role>        运行指定角色
  /manga approve [意见]    通过当前闸门
  /manga revise <意见>     按意见重做当前闸门产物
  /manga web [start|stop|status|restart] --port <端口> [--host H] [--open]
  /manga regen <page-001/panel-01> [--note "更暗"] [--final]
  /manga cast [--regen]    查看/重生成角色立绘
  /manga prompt <page-001/panel-01>
  /manga qa                重新结构审校
  /manga style [preset]    查看/切换画风（会提示影响范围）
  /manga models [role] [provider/id]
  /manga provider [id] [--model <model>]  查看/切换图像模型（agnes 免费默认，ark 付费）
  /manga config            查看有效配置
  /manga auto on|off       全自动模式（跳过闸门）
  /manga pause|resume|abort
  /manga key [--provider <id>] [--test] [--key <key>]
  /manga doctor
  /manga open [slug]
  /manga rollback [runId]
  /manga export [--cbz]   导出图片 ZIP（默认）或 CBZ
  /manga compress         生成 <500 KB 的 Web 预览图
  /manga help

角色：${ROLE_IDS.join(" | ")}
画风：manga-bw | manhua-color | webtoon | custom`;

export async function handleMangaCommand(
	input: string,
	ctx: ActionCtx,
	app: MangaApp,
	pi: ExtensionAPI,
): Promise<void> {
	const { positionals, flags } = parseArgs(input);
	const sub = (positionals.shift() ?? "status").toLowerCase();
	const rest = positionals.join(" ").trim();
	try {
		switch (sub) {
			case "help":
			case "-h":
			case "--help":
				ctx.ui.notify(HELP, "info");
				return;
			case "init":
			case "new": {
				await actionInit(ctx, app, {
					title: str(flags, "title") ?? (rest || undefined),
					scriptPath: str(flags, "script") ?? str(flags, "dir"),
					style: str(flags, "style"),
					customPrompt: str(flags, "custom"),
					ratio: str(flags, "ratio") as never,
					adaptation: str(flags, "adaptation"),
				});
				return;
			}
			case "status":
				ctx.ui.notify(actionStatus(ctx, app), "info");
				return;
			case "next":
				ctx.ui.notify(actionNext(ctx, app), "info");
				return;
			case "step":
				ctx.ui.notify(actionStep(ctx, app), "info");
				return;
			case "run-all":
				ctx.ui.notify(actionRunAll(ctx, app), "info");
				return;
			case "run":
				if (!rest) throw new Error("用法：/manga run <role>");
				ctx.ui.notify(actionRunRole(ctx, app, rest), "info");
				return;
			case "approve":
				ctx.ui.notify(actionApprove(ctx, app, rest || undefined), "info");
				return;
			case "revise":
				ctx.ui.notify(actionRevise(ctx, app, rest), "info");
				return;
			case "pause":
				ctx.ui.notify(actionPause(ctx, app), "info");
				return;
			case "resume":
				ctx.ui.notify(actionResume(ctx, app), "info");
				return;
			case "abort":
			case "cancel":
				ctx.ui.notify(actionAbort(ctx, app), "info");
				return;
			case "web":
			case "preview": {
				const webAction = (rest || "start").toLowerCase();
				if (!["start", "stop", "status", "restart"].includes(webAction)) {
					throw new Error("用法：/manga web [start|stop|status|restart] --port <端口> [--host H] [--open]");
				}
				ctx.ui.notify(
					await actionWeb(ctx, app, pi, {
						action: webAction as "start" | "stop" | "status" | "restart",
						host: str(flags, "host"),
						port: str(flags, "port") ? Number(str(flags, "port")) : undefined,
						open: bool(flags, "open") ? true : undefined,
					}),
					"info",
				);
				return;
			}
			case "regen":
				if (!rest) throw new Error("用法：/manga regen <page-001/panel-01> [--note ...]");
				ctx.ui.notify(actionRegen(ctx, app, rest.split(/\s+/)[0], str(flags, "note"), bool(flags, "final")), "info");
				return;
			case "cast":
				ctx.ui.notify(actionCast(ctx, app, { regen: bool(flags, "regen"), id: rest || undefined }), "info");
				return;
			case "prompt":
				if (!rest) throw new Error("用法：/manga prompt <page-001/panel-01>");
				ctx.ui.notify(actionPrompt(ctx, app, rest.split(/\s+/)[0]), "info");
				return;
			case "qa":
				ctx.ui.notify(actionQa(ctx, app), "info");
				return;
			case "style":
				ctx.ui.notify(await actionStyle(ctx, app, rest || undefined), "info");
				return;
			case "models":
				ctx.ui.notify(await actionModels(ctx, app, positionals[0], positionals[1]), "info");
				return;
			case "provider":
				ctx.ui.notify(actionProvider(ctx, app, positionals[0], str(flags, "model") || positionals[1]), "info");
				return;
			case "config":
				ctx.ui.notify(actionConfig(ctx, app), "info");
				return;
			case "auto": {
				const arg = (rest || str(flags, "auto") || "").toLowerCase();
				if (arg !== "on" && arg !== "off") throw new Error("用法：/manga auto on|off");
				ctx.ui.notify(actionAuto(ctx, app, arg === "on"), "info");
				return;
			}
			case "key":
				ctx.ui.notify(await actionKey(ctx, app, { key: str(flags, "key"), test: bool(flags, "test"), provider: str(flags, "provider") }), "info");
				return;
			case "doctor":
				ctx.ui.notify(actionDoctor(ctx, app), "info");
				return;
			case "open":
				ctx.ui.notify(rest ? actionOpen(ctx, app, rest) : actionListProjects(ctx, app), "info");
				return;
			case "rollback":
				ctx.ui.notify(actionRollback(ctx, app, rest || undefined), "warning");
				return;
			case "export":
				ctx.ui.notify(actionExport(ctx, app, bool(flags, "cbz") ? "cbz" : "zip"), "info");
				return;
			case "compress":
				ctx.ui.notify(actionCompress(ctx, app), "info");
				return;
			default:
				throw new Error(`未知子命令：${sub}。使用 /manga help 查看用法。`);
		}
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export function registerMangaCommand(pi: ExtensionAPI, app: MangaApp): void {
	pi.registerCommand("manga", {
		description: "多 Agent 漫画流水线：剧本分析、角色、分镜、出图、Web 预览",
		getArgumentCompletions: (prefix: string) => {
			const commands = [
				"init",
				"status",
				"next",
				"step",
				"run-all",
				"run",
				"approve",
				"revise",
				"web",
				"regen",
				"cast",
				"prompt",
				"qa",
				"style",
				"models",
				"provider",
				"config",
				"auto",
				"pause",
				"resume",
				"abort",
				"key",
				"doctor",
				"open",
				"rollback",
				"export",
				"compress",
				"help",
			];
			const items = commands
				.filter((command) => command.startsWith(prefix))
				.map((command) => ({ value: command, label: command }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			await handleMangaCommand(args ?? "", ctx as never, app, pi);
		},
	});
}
