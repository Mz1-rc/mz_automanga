/**
 * Project-level image stages: character reference sheets, sequential panels and
 * single-panel regeneration.
 *
 * The module deliberately receives a small `ImageGenWorkspace` port instead of
 * `ProjectStore`, so it can be used from tests or another host without pulling
 * in state.ts, previews.ts or png-grayscale.ts.
 */
import type { CastMember, MangaPage, Panel } from "../types.ts";
import { ImageGenError } from "./errors.ts";
import { buildReferences, panelCacheKey, panelRelPath, parsePanelKey } from "./references.ts";
import { enforceStyleNegative, enforceStylePrompt } from "./style.ts";
import type { ImageGenWorkspace, ImageGenerateResult, ImageStageOptions } from "./types.ts";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function characterPrompt(workspace: ImageGenWorkspace, member: CastMember): string {
	if (member.refPrompt?.trim()) return member.refPrompt.trim();
	return workspace.readText(`characters/${member.id}/ref.prompt.txt`)?.trim() ?? "";
}

export async function generateCharacterImages(
	options: ImageStageOptions,
): Promise<{ done: number; skipped: number; failed: number }> {
	const { workspace, config, provider, signal } = options;
	const bible = workspace.readBible();
	if (!bible) throw new Error("bible.json 缺失，无法生成角色立绘");
	const style = workspace.style;
	let done = 0;
	let skipped = 0;
	let failed = 0;
	const cast = options.onlyId ? bible.cast.filter((member) => member.id === options.onlyId) : bible.cast;
	if (options.onlyId && cast.length === 0) throw new Error(`找不到角色: ${options.onlyId}`);
	const total = cast.length;

	for (const [index, member] of cast.entries()) {
		if (signal?.aborted) throw new Error("已取消");
		const rel = `characters/${member.id}/ref.png`;
		const label = member.name || member.id;
		options.onProgress?.({ kind: "char-start", label, index: index + 1, total });

		if (!options.force && workspace.imageExists(rel)) {
			skipped++;
			options.onProgress?.({ kind: "char-skip", label, index: index + 1, total });
			continue;
		}
		const prompt = characterPrompt(workspace, member);
		if (!prompt) {
			failed++;
			options.onProgress?.({ kind: "char-fail", label, index: index + 1, total, error: "缺少 refPrompt" });
			continue;
		}
		try {
			const abs = workspace.prepareImage(rel, config.keepVersions);
			const result = await provider.generate({
				prompt: enforceStylePrompt(prompt, style),
				negative: enforceStyleNegative(undefined, style),
				size: config.draftSize,
				ratio: style.ratio,
				outPath: abs,
				signal,
			});
			workspace.afterImageWritten(rel);
			workspace.writeSourceUrl(rel, result.sourceUrl);
			done++;
			options.onProgress?.({ kind: "char-done", label, index: index + 1, total });
		} catch (error) {
			if (error instanceof ImageGenError && (error.code === "auth" || error.code === "aborted")) throw error;
			failed++;
			options.onProgress?.({
				kind: "char-fail",
				label,
				index: index + 1,
				total,
				error: messageOf(error),
			});
		}
	}
	workspace.refreshStats();
	return { done, skipped, failed };
}

function previousPanelRel(workspace: ImageGenWorkspace, pageIndex: number, panelIndex: number): string | undefined {
	if (panelIndex > 1) return panelRelPath(pageIndex, panelIndex - 1);
	if (pageIndex > 1) {
		const previousPage = workspace.readPage(pageIndex - 1);
		const count = previousPage?.panels.length ?? 0;
		return count > 0 ? panelRelPath(pageIndex - 1, count) : undefined;
	}
	return undefined;
}

export async function generatePanelImages(
	options: ImageStageOptions,
): Promise<{ done: number; skipped: number; failed: number; failures: string[] }> {
	const { workspace, config, provider, signal } = options;
	const bible = workspace.readBible();
	if (!bible) throw new Error("bible.json 缺失，无法生成画面");
	const pages = workspace.listPageKeys();
	const allPanels: Array<{ page: MangaPage; panel: Panel; panelIndex: number }> = [];
	for (const key of pages) {
		const page = workspace.readPageByKey(key);
		if (!page) continue;
		page.panels.forEach((panel, panelIndex) => allPanels.push({ page, panel, panelIndex }));
	}
	const total = allPanels.length;
	let done = 0;
	let skipped = 0;
	let failed = 0;
	const failures: string[] = [];
	const size = options.final ? config.finalSize : config.draftSize;

	for (const [index, item] of allPanels.entries()) {
		if (signal?.aborted) throw new Error("已取消");
		const { page, panel, panelIndex } = item;
		const pageIndex = page.index;
		const key = `${page.id}/${panel.id}`;
		const rel = panelRelPath(pageIndex, panelIndex + 1);
		const label = key;
		options.onProgress?.({ kind: "panel-start", label, index: index + 1, total });

		const rawPrompt = (panel.promptOverride?.trim() || panel.prompt?.trim() || "").trim();
		const prompt = enforceStylePrompt(rawPrompt, workspace.style);
		const negative = enforceStyleNegative(panel.negative, workspace.style);
		if (!rawPrompt) {
			panel.image = { ...(panel.image ?? { status: "pending" }), status: "failed", error: "缺少 prompt" };
			failed++;
			failures.push(key);
			workspace.writePage(page);
			workspace.touch();
			options.onProgress?.({ kind: "panel-fail", label, index: index + 1, total, error: "缺少 prompt" });
			continue;
		}

		const refRels: string[] = [];
		for (const member of panel.characters) {
			const cast = bible.cast.find((c) => c.id === member.id);
			const refRel = cast?.refSheet || `characters/${member.id}/ref.png`;
			if (!refRels.includes(refRel) && workspace.imageExists(refRel)) refRels.push(refRel);
		}
		if (config.usePreviousPanel && panel.continuityFrom !== null) {
			const continuity = panel.continuityFrom || previousPanelRel(workspace, pageIndex, panelIndex + 1);
			if (continuity) {
				const relFrom = continuity.includes("/")
					? panelRelPath(
							Number(continuity.split("/")[0].replace("page-", "")),
							Number(continuity.split("/")[1].replace("panel-", "")),
						)
					: undefined;
				if (relFrom && workspace.imageExists(relFrom) && !refRels.includes(relFrom)) refRels.push(relFrom);
			}
		}
		const refs = buildReferences(workspace, refRels, config.maxRefs);
		const cacheKey = panelCacheKey({
			prompt,
			negative,
			size,
			ratio: workspace.style.ratio,
			model: config.model,
			refs,
		});
		const existing = panel.image;
		if (!options.force && existing?.status === "done" && existing.cacheKey === cacheKey && workspace.imageExists(rel)) {
			skipped++;
			options.onProgress?.({ kind: "panel-skip", label, index: index + 1, total });
			continue;
		}

		try {
			const abs = workspace.prepareImage(rel, config.keepVersions);
			const result: ImageGenerateResult = await provider.generate({
				prompt,
				negative,
				size,
				ratio: workspace.style.ratio,
				refs,
				outPath: abs,
				signal,
			});
			workspace.afterImageWritten(rel);
			workspace.writeSourceUrl(rel, result.sourceUrl);
			panel.image = {
				status: "done",
				file: rel,
				sourceUrl: result.sourceUrl ?? null,
				cacheKey,
				size,
				ratio: workspace.style.ratio,
				width: result.width,
				height: result.height,
				attempts: result.attempts,
				generatedAt: new Date().toISOString(),
			};
			done++;
			options.onProgress?.({ kind: "panel-done", label, index: index + 1, total });
		} catch (error) {
			if (error instanceof ImageGenError && (error.code === "auth" || error.code === "aborted")) throw error;
			panel.image = {
				...(panel.image ?? { status: "pending" }),
				status: "failed",
				attempts: (panel.image?.attempts ?? 0) + 1,
				error: messageOf(error),
			};
			failed++;
			failures.push(key);
			options.onProgress?.({
				kind: "panel-fail",
				label,
				index: index + 1,
				total,
				error: messageOf(error),
			});
		}
		workspace.writePage(page);
		workspace.touch();
	}
	workspace.refreshStats();
	return { done, skipped, failed, failures };
}

export { parsePanelKey };

/** Generate exactly one panel (used by /manga regen). */
export async function regeneratePanel(
	options: ImageStageOptions & { key: string; note?: string; promptOverride?: string },
): Promise<ImageGenerateResult> {
	const { workspace, config, provider, signal } = options;
	const parsed = parsePanelKey(options.key);
	if (!parsed) throw new Error(`无效的格子: ${options.key}（应为 page-001/panel-01）`);
	const page = workspace.readPage(parsed.pageIndex);
	if (!page) throw new Error(`找不到页: ${options.key}`);
	const panel = page.panels[parsed.panelIndex - 1];
	if (!panel) throw new Error(`找不到格: ${options.key}`);
	if (options.promptOverride) panel.prompt = options.promptOverride;
	if (options.note?.trim()) panel.prompt = `${panel.prompt ?? ""}\n\nAdditional direction: ${options.note.trim()}`;
	const rawPrompt = (panel.prompt ?? "").trim();
	if (!rawPrompt) throw new Error(`格子 ${options.key} 缺少 prompt`);
	const prompt = enforceStylePrompt(rawPrompt, workspace.style);
	const negative = enforceStyleNegative(panel.negative, workspace.style);
	const bible = workspace.readBible();
	if (!bible) throw new Error("bible.json 缺失");
	const refRels: string[] = [];
	for (const member of panel.characters) {
		const cast = bible.cast.find((c) => c.id === member.id);
		const refRel = cast?.refSheet || `characters/${member.id}/ref.png`;
		if (!refRels.includes(refRel)) refRels.push(refRel);
	}
	const refs = buildReferences(workspace, refRels, config.maxRefs);
	const rel = panelRelPath(parsed.pageIndex, parsed.panelIndex);
	const abs = workspace.prepareImage(rel, config.keepVersions);
	const size = options.final ? config.finalSize : config.draftSize;
	const result = await provider.generate({
		prompt,
		negative,
		size,
		ratio: workspace.style.ratio,
		refs,
		outPath: abs,
		signal,
	});
	workspace.afterImageWritten(rel);
	workspace.writeSourceUrl(rel, result.sourceUrl);
	panel.image = {
		status: "done",
		file: rel,
		sourceUrl: result.sourceUrl ?? null,
		cacheKey: panelCacheKey({
			prompt,
			negative,
			size,
			ratio: workspace.style.ratio,
			model: config.model,
			refs,
		}),
		size,
		ratio: workspace.style.ratio,
		width: result.width,
		height: result.height,
		attempts: result.attempts,
		generatedAt: new Date().toISOString(),
	};
	workspace.writePage(page);
	workspace.refreshStats();
	return result;
}
