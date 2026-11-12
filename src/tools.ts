import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	actionAbort,
	actionApprove,
	actionAuto,
	actionCast,
	actionCompress,
	actionDoctor,
	actionExport,
	actionInit,
	actionListProjects,
	actionModels,
	actionNext,
	actionOpen,
	actionPause,
	actionPrompt,
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
	actionWebStatus,
} from "./actions.ts";
import type { MangaApp } from "./app.ts";

const ACTIONS = [
	"init",
	"status",
	"next",
	"step",
	"run_all",
	"run_role",
	"approve",
	"revise",
	"web",
	"web_stop",
	"web_status",
	"regen_panel",
	"prompt_panel",
	"cast",
	"qa",
	"style",
	"configure",
	"set_auto",
	"pause",
	"resume",
	"abort",
	"doctor",
	"open",
	"rollback",
	"export",
	"compress_images",
	"list",
	"help",
] as const;

const HELP = `manga_team 动作：
init / status / next / step / run_all / run_role / approve / revise
web / web_stop / web_status / regen_panel / prompt_panel / cast / qa
style / configure / set_auto / pause / resume / abort / doctor / open
rollback / export / compress_images / list

export 默认导出图片 ZIP；export_format="cbz" 可导出 CBZ。
web 需要显式端口（--port），不会随机分配。`;

function text(value: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: value }], details };
}

export function registerMangaTool(pi: ExtensionAPI, app: MangaApp): void {
	pi.registerTool({
		name: "manga_team",
		label: "漫画工作室",
		description:
			"驱动多 Agent 漫画流水线：创建项目、推进阶段、运行角色、确认闸门、预览、重画单格、导出。耗时 action 会在后台启动并立即返回；一次只允许一个后台任务。",
		promptSnippet: "驱动多 Agent 漫画流水线按阶段创作、确认和导出",
		promptGuidelines: [
			"Use manga_team when the user asks to turn a script into a manga, continue a manga project, review a gate, preview images, or export.",
			"Call manga_team with one action at a time; never run multiple manga_team calls in parallel.",
			"Long-running manga_team actions return immediately after starting a background job; use status to inspect progress.",
			"After starting a background job, do not start another manga_team action in the same turn; report the job and wait.",
			"When manga_team reports a gate (script/cast/storyboard/final), ask the user to confirm before advancing.",
			"Use set_auto and run_all only when the user explicitly asks for fully automatic operation.",
			"When the user wants different art, use style before generating images; switching style invalidates cast, prompts and panels.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS),
			title: Type.Optional(Type.String({ description: "init 时的书名" })),
			script_path: Type.Optional(Type.String({ description: "init 时的剧本文件或目录路径（目录会递归合并 .md/.txt）" })),
			style: Type.Optional(
				StringEnum(["manga-bw", "manhua-color", "webtoon", "custom"], { description: "画风预设" }),
			),
			adaptation: Type.Optional(
				StringEnum(["strict", "balanced", "free"], {
					description: "剧本整理与分镜改编程度：strict=完全尊重剧本，balanced=适当调整改写，free=agent 自由调整",
				}),
			),
			role: Type.Optional(Type.String({ description: "run_role / configure 的角色 id" })),
			page: Type.Optional(Type.String({ description: "regen_panel / prompt_panel 的页，如 page-001" })),
			panel: Type.Optional(Type.String({ description: "regen_panel / prompt_panel 的格，如 panel-02" })),
			note: Type.Optional(Type.String({ description: "regen_panel 的额外方向" })),
			final: Type.Optional(Type.Boolean({ description: "regen_panel 是否用最终尺寸" })),
			feedback: Type.Optional(Type.String({ description: "approve / revise 的意见" })),
			host: Type.Optional(Type.String({ description: "web 绑定地址；默认 0.0.0.0（只读、无鉴权）" })),
			port: Type.Optional(Type.Number({ description: "web 端口（1–65535），必须显式指定，不会随机分配" })),
			web_action: Type.Optional(
				StringEnum(["start", "stop", "status", "restart"], { description: "web 子动作，默认 start" }),
			),
			model: Type.Optional(Type.String({ description: "configure 的模型 provider/id" })),
			export_format: Type.Optional(
				StringEnum(["zip", "cbz"], { description: "export 的打包格式；默认 zip（仅图片的普通 zip）" }),
			),
			auto: Type.Optional(Type.Boolean({ description: "set_auto 开启/关闭全自动" })),
			run_id: Type.Optional(Type.String({ description: "rollback 的运行快照 id" })),
			slug: Type.Optional(Type.String({ description: "open 的项目 slug" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action;
			const actionCtx = ctx as never;
			switch (action) {
				case "help":
					return text(HELP);
				case "init": {
					if (!params.script_path && !ctx.hasUI) {
						throw new Error("init 需要 script_path（文件或目录）");
					}
					const store = await actionInit(actionCtx, app, {
						title: params.title,
						scriptPath: params.script_path,
						style: params.style,
						adaptation: params.adaptation,
					});
					return text(`已创建《${store.project.title}》（${store.project.slug}）。下一步：next。`, {
						slug: store.project.slug,
						style: store.project.style,
						adaptation: store.project.adaptation,
					});
				}
				case "status":
					return text(actionStatus(actionCtx, app));
				case "list":
					return text(actionListProjects(actionCtx, app));
				case "next":
					return text(actionNext(actionCtx, app));
				case "step":
					return text(actionStep(actionCtx, app));
				case "run_all":
					return text(actionRunAll(actionCtx, app));
				case "run_role": {
					if (!params.role) throw new Error("run_role 需要 role");
					return text(actionRunRole(actionCtx, app, params.role));
				}
				case "approve":
					return text(actionApprove(actionCtx, app, params.feedback));
				case "revise": {
					if (!params.feedback) throw new Error("revise 需要 feedback");
					return text(actionRevise(actionCtx, app, params.feedback));
				}
				case "web":
					return text(
						await actionWeb(actionCtx, app, pi, {
							action: params.web_action ?? "start",
							host: params.host,
							port: params.port,
						}),
					);
				case "web_stop":
					return text(await actionWeb(actionCtx, app, pi, { action: "stop" }));
				case "web_status":
					return text(actionWebStatus());
				case "regen_panel": {
					if (!params.page || !params.panel) throw new Error("regen_panel 需要 page 和 panel");
					return text(actionRegen(actionCtx, app, `${params.page}/${params.panel}`, params.note, params.final));
				}
				case "prompt_panel": {
					if (!params.page || !params.panel) throw new Error("prompt_panel 需要 page 和 panel");
					return text(actionPrompt(actionCtx, app, `${params.page}/${params.panel}`));
				}
				case "cast":
					return text(actionCast(actionCtx, app, {}));
				case "qa":
					return text(actionQa(actionCtx, app));
				case "style":
					return text(await actionStyle(actionCtx, app, params.style));
				case "configure":
					return text(await actionModels(actionCtx, app, params.role, params.model));
				case "set_auto":
					return text(actionAuto(actionCtx, app, Boolean(params.auto)));
				case "pause":
					return text(actionPause(actionCtx, app));
				case "resume":
					return text(actionResume(actionCtx, app));
				case "abort":
					return text(actionAbort(actionCtx, app));
				case "doctor":
					return text(actionDoctor(actionCtx, app));
				case "open":
					return text(actionOpen(actionCtx, app, params.slug));
				case "rollback":
					return text(actionRollback(actionCtx, app, params.run_id));
				case "export":
					return text(actionExport(actionCtx, app, params.export_format === "cbz" ? "cbz" : "zip"));
				case "compress_images":
					return text(actionCompress(actionCtx, app));
				default:
					return text(`未知 action: ${action}`);
			}
		},
	});
}
