import type { MangaProject, Phase, RunUsage, ProjectState } from "./types.ts";

export const STATUS_KEY = "mz-automanga";
export const WIDGET_KEY = "mz-automanga";

export interface UiContext {
	ui: {
		setStatus(key: string, text: string | undefined): void;
		setWidget(key: string, lines: string[] | undefined): void;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

export function notify(ctx: UiContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.ui.notify(message, type);
	} catch {
		// ignore UI failures (print/json mode)
	}
}

export function phaseLabel(phase: Phase): string {
	switch (phase) {
		case "idle":
			return "未开始";
		case "intake":
			return "创建项目";
		case "script_analysis":
			return "剧本分析";
		case "script_gate":
			return "剧本确认";
		case "design":
			return "企划 / 角色设定";
		case "cast":
			return "角色设计";
		case "character_images":
			return "生成角色立绘";
		case "cast_gate":
			return "角色确认";
		case "storyboard":
			return "分镜";
		case "storyboard_gate":
			return "分镜确认";
		case "prompts":
			return "提示词 / 文字排版";
		case "image_gen":
			return "生成画面";
		case "qa":
			return "审校";
		case "repair":
			return "修复";
		case "build":
			return "构建 / 导出";
		case "final_gate":
			return "成品确认";
		case "export":
			return "导出";
		case "done":
			return "完成";
		case "paused":
			return "已暂停";
		case "error":
			return "出错";
	}
}

export function formatTokens(count: number | undefined): string {
	const n = count ?? 0;
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

function formatCost(cost: number | undefined): string {
	if (!cost) return "";
	return `$${cost.toFixed(2)}`;
}

function progressBar(done: number, total: number, width = 16): string {
	if (total <= 0) return "";
	const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function gateMark(state: ProjectState, gate: keyof ProjectState["gates"]): string {
	return state.gates[gate]?.status === "approved" ? "✔" : "○";
}

export function updateStatus(
	ctx: UiContext,
	store: { project: MangaProject; state: ProjectState },
	progress?: string,
	activeUsage?: RunUsage,
): void {
	const { project, state } = store;
	const total = {
		input: state.stats.totalUsage.input + (activeUsage?.input ?? 0),
		output: state.stats.totalUsage.output + (activeUsage?.output ?? 0),
		cost: (state.stats.totalUsage.cost ?? 0) + (activeUsage?.cost ?? 0),
	};
	const images = state.stats.images;
	const panels = Math.max(state.stats.panels, images);
	const extra = progress ? ` · ${progress}` : "";
	ctx.ui.setStatus(
		STATUS_KEY,
		`🎬 ${project.title} · ${phaseLabel(state.phase)} · 图 ${images}/${panels || "?"} · Σ${formatTokens(total.input + total.output)} tok${extra}`,
	);

	const lines: string[] = [];
	lines.push(
		`${gateMark(state, "script")} 剧本   ${gateMark(state, "cast")} 角色   ${gateMark(state, "storyboard")} 分镜   ${gateMark(state, "final")} 成品`,
	);
	lines.push(
		`${progressBar(images, panels)}  ${images}/${panels || "?"} · ${phaseLabel(state.phase)}`,
	);
	const cost = formatCost(total.cost);
	lines.push(
		`Token：入 ${formatTokens(total.input)} / 出 ${formatTokens(total.output)}${cost ? ` · ${cost}` : ""}${activeUsage ? ` · 当前 ${formatTokens((activeUsage.input ?? 0) + (activeUsage.output ?? 0))}` : ""}`,
	);
	if (progress) lines.push(progress);
	if (state.lastError?.message) lines.push(`⚠ ${state.lastError.message}`);
	ctx.ui.setWidget(WIDGET_KEY, lines);
}

export function clearStatus(ctx: UiContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export function summarizeGates(state: ProjectState): string {
	return (["script", "cast", "storyboard", "final"] as const)
		.map((gate) => {
			const record = state.gates[gate];
			const label = gate === "script" ? "剧本" : gate === "cast" ? "角色" : gate === "storyboard" ? "分镜" : "成品";
			return `${label}:${record?.status ?? "pending"}`;
		})
		.join(" · ");
}
