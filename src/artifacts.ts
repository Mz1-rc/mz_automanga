import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { countChars, ensureDir, fileExists, readJson, readText, resolveWithin, sha256, writeAtomic } from "./paths.ts";
import type { Bible, MangaPage, MangaProject, RoleId, ScriptAnalysis } from "./types.ts";

export const BLOCKED_TARGETS = new Set(["project.json", "state.json", ".lock"]);

export interface ArtifactWriteResult {
	target: string;
	path: string;
	chars: number;
	sha256: string;
}

export class ArtifactManager {
	readonly projectRoot: string;
	readonly runDir: string;
	readonly targets: string[];
	readonly written = new Map<string, ArtifactWriteResult>();

	constructor(projectRoot: string, runDir: string, targets: string[]) {
		this.projectRoot = projectRoot;
		this.runDir = runDir;
		this.targets = targets;
	}

	write(target: string, content: string, mode: "replace" | "append" = "replace"): ArtifactWriteResult {
		const normalized = target.replaceAll("\\", "/").replace(/^\.\//, "");
		if (BLOCKED_TARGETS.has(normalized)) throw new Error(`禁止写入 ${target}`);
		if (!this.targets.includes(normalized)) {
			throw new Error(`该角色不能写入 ${target}；允许：${this.targets.join(", ")}`);
		}
		if (!content || !content.trim()) throw new Error("内容为空，拒绝写入");
		if (normalized.endsWith(".json")) {
			if (mode === "append") throw new Error("JSON 工件不支持 append，请一次写入完整 JSON");
			try {
				JSON.parse(content);
			} catch (error) {
				throw new Error(`${target} 不是合法 JSON: ${(error as Error).message}`);
			}
		}
		const canonical = resolveWithin(this.projectRoot, normalized);
		const snapshot = resolveWithin(this.runDir, normalized);
		let finalContent = content;
		if (mode === "append") {
			const previous = existsSync(snapshot)
				? readText(snapshot) ?? ""
				: readText(canonical) ?? "";
			finalContent = `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${content}`;
		}
		ensureDir(dirname(canonical));
		ensureDir(dirname(snapshot));
		writeAtomic(snapshot, finalContent);
		writeAtomic(canonical, finalContent);
		const result: ArtifactWriteResult = {
			target: normalized,
			path: canonical,
			chars: countChars(finalContent),
			sha256: sha256(finalContent),
		};
		this.written.set(normalized, result);
		return result;
	}

	read(target: string): string | undefined {
		try {
			return readText(resolveWithin(this.projectRoot, target)) ?? undefined;
		} catch {
			return undefined;
		}
	}
}

export interface ValidationResult {
	ok: boolean;
	issues: string[];
}

function fail(issues: string[]): ValidationResult {
	return { ok: issues.length === 0, issues };
}

const FORMATS = new Set(["novel", "screenplay", "outline", "idea"]);
const SEVERITIES = new Set(["blocker", "major", "minor"]);
const POSITIONS = new Set(["top-left", "top-right", "bottom-left", "bottom-right", "center"]);
const SHAPES = new Set(["rounded", "spiky", "cloud", "box"]);
const DIALOGUE_TYPES = new Set(["speech", "thought", "narration", "sfx"]);

export function validateAnalysis(analysis: ScriptAnalysis | undefined): ValidationResult {
	const issues: string[] = [];
	if (!analysis || typeof analysis !== "object") return fail(["source/analysis.json 缺失或不是对象"]);
	if (!FORMATS.has(analysis.format)) issues.push(`format 必须是 ${[...FORMATS].join("/")}`);
	if (!analysis.titleSuggestion?.trim()) issues.push("titleSuggestion 为空");
	if (!analysis.logline?.trim()) issues.push("logline 为空");
	if (!Array.isArray(analysis.scenes) || analysis.scenes.length === 0) issues.push("scenes 必须是非空数组");
	if (!Array.isArray(analysis.issues)) issues.push("issues 必须是数组");
	else {
		if (analysis.issues.length > 5) issues.push("issues 不能超过 5 条，请合并问题");
		const ids = new Set<string>();
		for (const issue of analysis.issues) {
			if (!issue || typeof issue !== "object") {
				issues.push("issues 中存在非对象项");
				continue;
			}
			if (!issue.id?.trim()) issues.push("issue 缺少 id");
			else if (ids.has(issue.id)) issues.push(`issue id 重复: ${issue.id}`);
			else ids.add(issue.id);
			if (!SEVERITIES.has(issue.severity)) issues.push(`issue ${issue.id ?? "?"} 的 severity 非法`);
			if (!issue.question?.trim()) issues.push(`issue ${issue.id ?? "?"} 缺少 question`);
			if (!Array.isArray(issue.options) || issue.options.length < 2) issues.push(`issue ${issue.id ?? "?"} 至少需要 2 个 options`);
			if (!issue.assumption?.trim()) issues.push(`issue ${issue.id ?? "?"} 缺少 assumption`);
		}
		const derived = analysis.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major")
			? "needs_clarification"
			: "clear";
		if (analysis.status !== derived) issues.push(`status 应为 ${derived}（由 issues 严重度推导）`);
	}
	for (const [index, scene] of (analysis.scenes ?? []).entries()) {
		if (!scene.id?.trim()) issues.push(`scene[${index}] 缺少 id`);
		if (!scene.title?.trim()) issues.push(`scene[${index}] 缺少 title`);
		if (!scene.summary?.trim()) issues.push(`scene[${index}] 缺少 summary`);
		if (!Array.isArray(scene.characters)) issues.push(`scene[${index}] characters 必须是数组`);
		if (!Array.isArray(scene.beats) || scene.beats.length === 0) issues.push(`scene[${index}] beats 不能为空`);
	}
	if (!Number.isInteger(analysis.pageEstimate) || analysis.pageEstimate < 1 || analysis.pageEstimate > 60) {
		issues.push("pageEstimate 必须是 1–60 的整数");
	}
	if (!Array.isArray(analysis.assumptions)) issues.push("assumptions 必须是数组");
	return fail(issues);
}

export function validateBible(bible: Bible | undefined, stylePromptTokens: string[], knownStylePrompt: string): ValidationResult {
	const issues: string[] = [];
	if (!bible || typeof bible !== "object") return fail(["bible.json 缺失或不是对象"]);
	if (!bible.title?.trim()) issues.push("title 为空");
	if (!Array.isArray(bible.cast) || bible.cast.length === 0) issues.push("cast 必须是非空数组");
	if (!bible.art || typeof bible.art !== "object") issues.push("art 缺失");
	else {
		const prompt = String(bible.art.stylePrompt ?? "");
		if (!prompt.trim()) issues.push("art.stylePrompt 为空");
		for (const token of stylePromptTokens) {
			if (!prompt.toLowerCase().includes(token.toLowerCase())) issues.push(`art.stylePrompt 缺少锁定词: ${token}`);
		}
		if (knownStylePrompt && !prompt.includes("no text other than the specified lettering")) {
			issues.push("art.stylePrompt 缺少 lettering 约束");
		}
		if (!bible.art.letteringStyle?.trim()) issues.push("art.letteringStyle 为空");
	}
	const ids = new Set<string>();
	for (const [index, member] of (bible.cast ?? []).entries()) {
		const label = member?.id || `cast[${index}]`;
		if (!member?.id?.trim()) issues.push(`${label} 缺少 id`);
		else if (ids.has(member.id)) issues.push(`角色 id 重复: ${member.id}`);
		else ids.add(member.id);
		if (!member?.name?.trim()) issues.push(`${label} 缺少 name`);
		if (!member?.canonical?.trim()) issues.push(`${label} 缺少 canonical`);
		else if (countChars(member.canonical) < 25) issues.push(`${label} 的 canonical 过短（应包含足够外观信息）`);
		if (!member?.outfits || typeof member.outfits !== "object" || !Object.keys(member.outfits).length) {
			issues.push(`${label} 缺少 outfits`);
		}
	}
	return fail(issues);
}

export function validatePage(
	page: MangaPage | undefined,
	options: { bible: Bible | undefined; stylePrompt: string; stage: "storyboard" | "prompts"; projectRoot: string },
): ValidationResult {
	const issues: string[] = [];
	if (!page || typeof page !== "object") return fail(["页面 JSON 缺失或不是对象"]);
	if (!/^page-\d{3}$/.test(String(page.id ?? ""))) issues.push("id 必须是 page-XXX");
	if (!Number.isInteger(page.index) || page.index < 1) issues.push("index 必须是正整数");
	const cast = new Map((options.bible?.cast ?? []).map((member) => [member.id, member]));
	if (!Array.isArray(page.panels) || page.panels.length < 3 || page.panels.length > 6) {
		issues.push("每页必须是 3–6 格");
	}
	const ids = new Set<string>();
	let emptyPanels = 0;
	let previousEmpty = false;
	for (const [index, panel] of (page.panels ?? []).entries()) {
		const label = `${page.id}/${panel?.id || `panel[${index}]`}`;
		if (!/^panel-\d{2}$/.test(String(panel?.id ?? ""))) issues.push(`${label} 的 id 必须是 panel-XX`);
		else if (ids.has(panel.id)) issues.push(`${label} 的 id 重复`);
		else ids.add(panel.id);
		if (!panel?.shot?.trim()) issues.push(`${label} 缺少 shot`);
		if (!panel?.action?.trim()) issues.push(`${label} 缺少 action`);
		if (!Array.isArray(panel?.characters)) issues.push(`${label} characters 必须是数组`);
		for (const character of panel?.characters ?? []) {
			const member = cast.get(character.id);
			if (!member) issues.push(`${label} 引用了未定义角色 ${character.id}`);
			else if (character.outfit && !member.outfits?.[character.outfit]) {
				issues.push(`${label} 的 outfit "${character.outfit}" 不在 ${character.id} 的 outfits 中`);
			}
		}
		const dialogue = Array.isArray(panel?.dialogue) ? panel.dialogue : [];
		const pureEmpty = (panel?.characters?.length ?? 0) === 0 && dialogue.length === 0;
		if (pureEmpty) {
			emptyPanels += 1;
			if (emptyPanels > 1) {
				issues.push(`${label} 是第 ${emptyPanels} 个纯空镜（每页最多 1 个），请补旁白/心理活动或合并`);
			}
			if (previousEmpty) issues.push(`${label} 与上一格连续纯空镜，请插入角色反应或说明文字`);
		}
		previousEmpty = pureEmpty;
		if (dialogue.length > 2) issues.push(`${label} 的对白超过 2 条（文字进图，必须拆格）`);
		for (const [di, line] of dialogue.entries()) {
			if (!DIALOGUE_TYPES.has(line.type)) issues.push(`${label} dialogue[${di}] 的 type 非法`);
			if (!line.text?.trim()) issues.push(`${label} dialogue[${di}] 的 text 为空`);
			if (!line.bubble || !POSITIONS.has(line.bubble.position)) issues.push(`${label} dialogue[${di}] 缺少合法的 bubble.position`);
			if (!line.bubble || !SHAPES.has(line.bubble.shape)) issues.push(`${label} dialogue[${di}] 缺少合法的 bubble.shape`);
		}
		if (options.stage === "storyboard") {
			// prompt fields are intentionally not required here
		} else {
			const prompt = String(panel?.prompt ?? "");
			if (!prompt.trim()) issues.push(`${label} 缺少 prompt`);
			if (!prompt.includes("no text other than the specified lettering")) {
				issues.push(`${label} 的 prompt 缺少 lettering 锁定词`);
			}
			for (const [di, line] of dialogue.entries()) {
				if (line.text && !prompt.includes(line.text)) {
					issues.push(`${label} 的 prompt 未包含 dialogue[${di}] 原文：${line.text}`);
				}
			}
			for (const ref of panel?.refs ?? []) {
				// Character sheets must exist before prompting. Continuity refs may
				// point at panels that will be generated later in the same stage.
				if (!ref.startsWith("characters/")) continue;
				if (!existsSync(resolveWithin(options.projectRoot, ref))) {
					issues.push(`${label} 的参考图不存在: ${ref}`);
				}
			}
		}
	}
	return fail(issues);
}

export function validateRefPrompts(bible: Bible | undefined, projectRoot: string): ValidationResult {
	const issues: string[] = [];
	if (!bible) return fail(["bible.json 缺失"]);
	for (const member of bible.cast ?? []) {
		const inline = String(member.refPrompt ?? "").trim();
		const fileRel = `characters/${member.id}/ref.prompt.txt`;
		const fileText = readText(resolveWithin(projectRoot, fileRel)) ?? "";
		if (!inline && !fileText.trim()) issues.push(`角色 ${member.id} 缺少 refPrompt（bible 或 ${fileRel}）`);
	}
	return fail(issues);
}

export function validateRefImages(bible: Bible | undefined, projectRoot: string): ValidationResult {
	const issues: string[] = [];
	if (!bible) return fail(["bible.json 缺失"]);
	for (const member of bible.cast ?? []) {
		const rel = member.refSheet || `characters/${member.id}/ref.png`;
		if (!fileExists(resolveWithin(projectRoot, rel))) issues.push(`角色 ${member.id} 缺少立绘: ${rel}`);
	}
	return fail(issues);
}

export interface RoleValidationContext {
	role: RoleId;
	projectRoot: string;
	targets: string[];
	project: MangaProject;
	page?: MangaPage;
}

export function validateRoleOutputs(ctx: RoleValidationContext): ValidationResult {
	const issues: string[] = [];
	const read = (target: string): string => readText(resolveWithin(ctx.projectRoot, target)) ?? "";
	const mustExist = (target: string): string => {
		const text = read(target);
		if (!text.trim()) issues.push(`缺少或为空: ${target}`);
		return text;
	};
	for (const target of ctx.targets) mustExist(target);

	switch (ctx.role) {
		case "script_analyst": {
			const analysis = readJson<ScriptAnalysis>(resolveWithin(ctx.projectRoot, "source/analysis.json"));
			issues.push(...validateAnalysis(analysis).issues);
			break;
		}
		case "director": {
			const bible = readJson<Bible>(resolveWithin(ctx.projectRoot, "bible.json"));
			issues.push(...validateBible(bible, ctx.project.style.lockedTokens, "").issues);
			// Director now owns the character reference prompts as well.
			for (const member of bible?.cast ?? []) {
				if (!member.refPrompt?.trim()) issues.push(`角色 ${member.id || "?"} 缺少 refPrompt（导演需一并产出）`);
			}
			break;
		}
		case "storyboard": {
			const page = ctx.page;
			const bible = readJson<Bible>(resolveWithin(ctx.projectRoot, "bible.json"));
			// Storyboard now writes the final image prompt and lettering too.
			issues.push(...validatePage(page, { bible, stylePrompt: "", stage: "prompts", projectRoot: ctx.projectRoot }).issues);
			break;
		}
		case "editor": {
			const report = readJson<Record<string, unknown>>(resolveWithin(ctx.projectRoot, "qa/report.json"));
			if (!report || typeof report !== "object") issues.push("qa/report.json 不是对象");
			else {
				if (!("verdict" in report)) issues.push("qa/report.json 缺少 verdict");
				if (!Array.isArray(report.repairTargets)) issues.push("qa/report.json 缺少 repairTargets");
			}
			break;
		}
		case "repairer": {
			const page = ctx.page;
			const bible = readJson<Bible>(resolveWithin(ctx.projectRoot, "bible.json"));
			issues.push(...validatePage(page, { bible, stylePrompt: "", stage: "prompts", projectRoot: ctx.projectRoot }).issues);
			break;
		}
	}
	return fail(issues);
}

export function roleTargets(role: RoleId, options: { bible?: Bible; pageId?: string; repairTargets?: string[] } = {}): string[] {
	switch (role) {
		case "script_analyst":
			return ["source/analysis.json", "source/scenes.json"];
		case "director":
			return ["bible.json"];
		case "storyboard":
			return options.pageId ? [`pages/${options.pageId}.json`] : [];
		case "editor":
			return ["qa/report.json", "qa/report.md"];
		case "repairer":
			return (options.repairTargets ?? []).map((target) => `pages/${target.split("/")[0]}.json`);
	}
}

export function panelKey(pageId: string, panelId: string): string {
	return `${pageId}/${panelId}`;
}

export function ensureProjectDirs(root: string): void {
	for (const sub of ["source", "pages", "characters", "state", "logs", "qa", "exports", ".runs"]) {
		ensureDir(join(root, sub));
	}
}
