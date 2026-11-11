import { join } from "node:path";
import { readText, writeAtomic } from "./paths.ts";
import type { GateId, GatePolicy, MangaProject, ScriptAnalysis, ScriptIssue } from "./types.ts";
import type { ProjectStore } from "./state.ts";
import { notify } from "./ui.ts";

export interface GateUi {
	hasUI: boolean;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	notify?(message: string, type?: "info" | "warning" | "error"): void;
}

export type GateDecision =
	| { kind: "approve" }
	| { kind: "revise"; feedback: string }
	| { kind: "pause" }
	| { kind: "answered" };

export function gatePolicy(project: MangaProject, gate: GateId): GatePolicy {
	return project.gates[gate] ?? "auto";
}

export function questionsNeedingUser(analysis: ScriptAnalysis, policy: GatePolicy): ScriptIssue[] {
	if (policy === "off") return [];
	const blocking = analysis.issues.filter((issue) => issue.severity === "blocker" || issue.severity === "major");
	if (policy === "always") return analysis.issues;
	return blocking;
}

function appendClarification(store: ProjectStore, text: string): void {
	const path = join(store.root, "source", "clarifications.md");
	const previous = readText(path) ?? "# 用户确认记录\n\n";
	const next = `${previous}${previous.endsWith("\n") ? "" : "\n"}${text.trim()}\n\n`;
	writeAtomic(path, next);
}

export function recordAssumptions(store: ProjectStore, analysis: ScriptAnalysis, reason: string): void {
	const lines: string[] = [`## 按假设继续（${new Date().toISOString()}）`, reason, ""];
	for (const issue of analysis.issues) {
		lines.push(`- ${issue.id}（${issue.severity}）：${issue.question}`);
		lines.push(`  - 采用假设：${issue.assumption}`);
	}
	for (const assumption of analysis.assumptions ?? []) lines.push(`- ${assumption}`);
	appendClarification(store, lines.join("\n"));
}

export interface ScriptGateOptions {
	policy: GatePolicy;
	store: ProjectStore;
	ui: GateUi;
	analysis: ScriptAnalysis;
}

/**
 * Ask the user about script problems. Questions come from `analysis.issues`;
 * answers are appended to source/clarifications.md and the analyst is re-run.
 */
export async function runScriptGate(options: ScriptGateOptions): Promise<GateDecision> {
	const { policy, store, ui, analysis } = options;
	const questions = questionsNeedingUser(analysis, policy);
	if (questions.length === 0) {
		if (policy === "off" && analysis.issues.length > 0) {
			recordAssumptions(store, analysis, "script gate 已关闭，全部问题按建议假设处理。");
		}
		return { kind: "approve" };
	}
	if (!ui.hasUI) {
		store.pause();
		notify(
			{ ui: { setStatus() {}, setWidget() {}, notify: (m, t) => ui.notify?.(m, t) } },
			`剧本有 ${questions.length} 个问题需要确认。请在 TUI 中运行 /manga next。`,
			"warning",
		);
		return { kind: "pause" };
	}

	const choice = await ui.select(
		`《${store.project.title}》剧本需要确认（${questions.length} 个问题）\n\n${questions
			.map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.question}`)
			.join("\n")
			.slice(0, 1200)}`,
		["逐条回答", "按建议假设继续", "修改剧本后继续", "暂停"],
	);
	if (!choice) return { kind: "pause" };
	if (choice === "暂停") return { kind: "pause" };
	if (choice === "修改剧本后继续") {
		notify(
			{ ui: { setStatus() {}, setWidget() {}, notify: (m, t) => ui.notify?.(m, t) } },
			`请直接编辑 ${join(store.root, "source", "script.md")}，然后运行 /manga next。`,
			"info",
		);
		return { kind: "pause" };
	}
	if (choice === "按建议假设继续") {
		recordAssumptions(store, analysis, "用户在剧本确认闸门选择按建议假设继续。");
		return { kind: "approve" };
	}

	let answered = 0;
	for (const issue of questions) {
		const picked = await ui.select(
			`[${issue.severity}] ${issue.question}\n\n默认假设：${issue.assumption}`,
			[...issue.options, "自定义回答", "跳过（按建议假设）"],
		);
		if (picked === undefined) break;
		if (picked === "跳过（按建议假设）") {
			appendClarification(store, `## ${issue.id}（${issue.severity}）\n答：按建议假设 —— ${issue.assumption}`);
			answered++;
			continue;
		}
		let answer = picked;
		if (picked === "自定义回答") {
			const custom = await ui.editor(`${issue.id} 的回答`, "");
			if (!custom?.trim()) continue;
			answer = custom.trim();
		}
		appendClarification(store, `## ${issue.id}（${issue.severity}）\n问：${issue.question}\n答：${answer}`);
		answered++;
	}
	if (answered === 0) {
		recordAssumptions(store, analysis, "用户没有回答问题，全部按建议假设处理。");
		return { kind: "approve" };
	}
	return { kind: "answered" };
}

export interface ReviewGateOptions {
	gate: GateId;
	title: string;
	summary: string;
	ui: GateUi;
	store: ProjectStore;
	extraOptions?: string[];
	allowApprove?: boolean;
}

export async function runReviewGate(options: ReviewGateOptions): Promise<GateDecision> {
	const { ui, store, gate } = options;
	if (gatePolicy(store.project, gate) === "off") {
		store.recordGate(gate, "approved", { feedback: "闸门已关闭，自动通过" });
		return { kind: "approve" };
	}
	if (!ui.hasUI) {
		store.pause();
		notify(
			{ ui: { setStatus() {}, setWidget() {}, notify: (m, t) => ui.notify?.(m, t) } },
			`${options.title}需要人工确认。请在 TUI 中运行 /manga next。`,
			"info",
		);
		return { kind: "pause" };
	}
	const canApprove = options.allowApprove !== false;
	const menu = [
		...(canApprove ? ["通过"] : []),
		"提出修改",
		...(options.extraOptions ?? []),
		"暂停",
	];
	const choice = await ui.select(`${options.title}\n\n${options.summary.slice(0, 1400)}`, menu);
	if (!choice) return { kind: "pause" };
	if (choice === "通过") {
		store.recordGate(gate, "approved");
		return { kind: "approve" };
	}
	if (choice === "暂停") return { kind: "pause" };
	if (choice === "提出修改") {
		const feedback = await ui.editor("请输入具体修改意见（越具体越好）", "");
		if (!feedback?.trim()) return { kind: "pause" };
		store.recordGate(gate, "rejected", { feedback: feedback.trim() });
		return { kind: "revise", feedback: feedback.trim() };
	}
	return { kind: "pause" };
}
