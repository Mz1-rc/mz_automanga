import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AgnesClient, AgnesGenerateResult, AgnesReference } from "./agnes.ts";
import { AgnesError } from "./agnes.ts";
import type { MangaConfig } from "./config.ts";
import { panelRelPath, readText, resolveWithin, sha256, writeAtomic } from "./paths.ts";
import type { ProjectStore } from "./state.ts";
import type { CastMember, MangaPage, Panel } from "./types.ts";

export interface ImageProgress {
	kind: "panel-start" | "panel-done" | "panel-skip" | "panel-fail" | "char-start" | "char-done" | "char-skip" | "char-fail";
	label: string;
	index: number;
	total: number;
	error?: string;
}

export interface ImageStageOptions {
	store: ProjectStore;
	config: MangaConfig;
	client: AgnesClient;
	signal?: AbortSignal;
	final?: boolean;
	force?: boolean;
	/** Regenerate only this cast id (character images stage). */
	onlyId?: string;
	onProgress?: (progress: ImageProgress) => void;
}

function sourceUrlPath(imageRel: string): string {
	return imageRel.replace(/\.png$/i, ".source-url.txt");
}

export function readSourceUrl(projectRoot: string, imageRel: string): string | undefined {
	const text = readText(resolveWithin(projectRoot, sourceUrlPath(imageRel)))?.trim();
	return text && /^https?:\/\//i.test(text) ? text : undefined;
}

function writeSourceUrl(projectRoot: string, imageRel: string, url: string | undefined): void {
	const rel = sourceUrlPath(imageRel);
	if (!url) return;
	writeAtomic(resolveWithin(projectRoot, rel), `${url}\n`);
}

/** Build references, preferring previous Agnes URLs over local base64. */
export function buildReferences(projectRoot: string, rels: string[], maxRefs: number): AgnesReference[] {
	const refs: AgnesReference[] = [];
	for (const rel of rels) {
		if (refs.length >= maxRefs) break;
		const abs = resolveWithin(projectRoot, rel);
		if (!existsSync(abs)) continue;
		const url = readSourceUrl(projectRoot, rel);
		refs.push(url ? { url } : { path: abs });
	}
	return refs;
}

function bumpVersion(path: string, keepVersions: number): void {
	if (!existsSync(path) || keepVersions <= 0) return;
	for (let n = keepVersions; n >= 1; n--) {
		const target = path.replace(/\.png$/i, `.v${n}.png`);
		const source = n === 1 ? path : path.replace(/\.png$/i, `.v${n - 1}.png`);
		if (existsSync(source)) {
			try {
				renameSync(source, target);
			} catch {
				// ignore versioning failures
			}
		}
	}
}

function panelCacheKey(options: {
	prompt: string;
	negative?: string;
	size: string;
	ratio: string;
	model: string;
	refs: AgnesReference[];
}): string {
	const identity = options.refs.map((ref) => ref.url ?? ref.path ?? "");
	return sha256(
		JSON.stringify({
			prompt: options.prompt,
			negative: options.negative ?? "",
			size: options.size,
			ratio: options.ratio,
			model: options.model,
			refs: identity,
		}),
	);
}

function characterPrompt(projectRoot: string, member: CastMember): string {
	if (member.refPrompt?.trim()) return member.refPrompt.trim();
	return readText(resolveWithin(projectRoot, `characters/${member.id}/ref.prompt.txt`))?.trim() ?? "";
}

export async function generateCharacterImages(options: ImageStageOptions): Promise<{ done: number; skipped: number; failed: number }> {
	const { store, config, client, signal } = options;
	const bible = store.readBible();
	if (!bible) throw new Error("bible.json 缺失，无法生成角色立绘");
	const style = store.project.style;
	let done = 0;
	let skipped = 0;
	let failed = 0;
	const cast = options.onlyId ? bible.cast.filter((member) => member.id === options.onlyId) : bible.cast;
	if (options.onlyId && cast.length === 0) throw new Error(`找不到角色: ${options.onlyId}`);
	const total = cast.length;

	for (const [index, member] of cast.entries()) {
		if (signal?.aborted) throw new Error("已取消");
		const rel = `characters/${member.id}/ref.png`;
		const abs = resolveWithin(store.root, rel);
		const label = member.name || member.id;
		options.onProgress?.({ kind: "char-start", label, index: index + 1, total });

		if (!options.force && existsSync(abs)) {
			skipped++;
			options.onProgress?.({ kind: "char-skip", label, index: index + 1, total });
			continue;
		}
		const prompt = characterPrompt(store.root, member);
		if (!prompt) {
			failed++;
			options.onProgress?.({ kind: "char-fail", label, index: index + 1, total, error: "缺少 refPrompt" });
			continue;
		}
		try {
			bumpVersion(abs, config.image.keepVersions);
			const result = await client.generate({
				prompt,
				size: config.image.draftSize,
				ratio: style.ratio,
				outPath: abs,
				signal,
				projectRoot: store.root,
			});
			writeSourceUrl(store.root, rel, result.sourceUrl);
			done++;
			options.onProgress?.({ kind: "char-done", label, index: index + 1, total });
		} catch (error) {
			if (error instanceof AgnesError && (error.code === "auth" || error.code === "aborted")) throw error;
			failed++;
			options.onProgress?.({
				kind: "char-fail",
				label,
				index: index + 1,
				total,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	store.refreshStats();
	return { done, skipped, failed };
}

function previousPanelRel(store: ProjectStore, pageIndex: number, panelIndex: number): string | undefined {
	if (panelIndex > 1) return panelRelPath(pageIndex, panelIndex - 1);
	if (pageIndex > 1) {
		const previousPage = store.readPage(pageIndex - 1);
		const count = previousPage?.panels.length ?? 0;
		return count > 0 ? panelRelPath(pageIndex - 1, count) : undefined;
	}
	return undefined;
}

export async function generatePanelImages(options: ImageStageOptions): Promise<{ done: number; skipped: number; failed: number; failures: string[] }> {
	const { store, config, client, signal } = options;
	const bible = store.readBible();
	if (!bible) throw new Error("bible.json 缺失，无法生成画面");
	const pages = store.listPageKeys();
	const allPanels: Array<{ page: MangaPage; panel: Panel; panelIndex: number }> = [];
	for (const key of pages) {
		const page = store.readPageByKey(key);
		if (!page) continue;
		page.panels.forEach((panel, panelIndex) => allPanels.push({ page, panel, panelIndex }));
	}
	const total = allPanels.length;
	let done = 0;
	let skipped = 0;
	let failed = 0;
	const failures: string[] = [];
	const size = options.final ? config.image.finalSize : config.image.draftSize;

	for (const [index, item] of allPanels.entries()) {
		if (signal?.aborted) throw new Error("已取消");
		const { page, panel, panelIndex } = item;
		const pageIndex = page.index;
		const key = `${page.id}/${panel.id}`;
		const rel = panelRelPath(pageIndex, panelIndex + 1);
		const abs = resolveWithin(store.root, rel);
		const label = key;
		options.onProgress?.({ kind: "panel-start", label, index: index + 1, total });

		const prompt = (panel.promptOverride?.trim() || panel.prompt?.trim() || "").trim();
		if (!prompt) {
			panel.image = { ...(panel.image ?? { status: "pending" }), status: "failed", error: "缺少 prompt" };
			failed++;
			failures.push(key);
			store.writePage(page);
			store.touch();
			options.onProgress?.({ kind: "panel-fail", label, index: index + 1, total, error: "缺少 prompt" });
			continue;
		}

		const refRels: string[] = [];
		for (const member of panel.characters) {
			const cast = bible.cast.find((c) => c.id === member.id);
			const refRel = cast?.refSheet || `characters/${member.id}/ref.png`;
			if (!refRels.includes(refRel) && existsSync(resolveWithin(store.root, refRel))) refRels.push(refRel);
		}
		if (config.image.usePreviousPanel && panel.continuityFrom !== null) {
			const continuity = panel.continuityFrom || previousPanelRel(store, pageIndex, panelIndex + 1);
			if (continuity) {
				const relFrom = continuity.includes("/") ? panelRelPath(Number(continuity.split("/")[0].replace("page-", "")), Number(continuity.split("/")[1].replace("panel-", ""))) : undefined;
				if (relFrom && existsSync(resolveWithin(store.root, relFrom)) && !refRels.includes(relFrom)) refRels.push(relFrom);
			}
		}
		const refs = buildReferences(store.root, refRels, config.image.maxRefs);
		const cacheKey = panelCacheKey({ prompt, negative: panel.negative, size, ratio: store.project.style.ratio, model: config.image.model, refs });
		const existing = panel.image;
		if (!options.force && existing?.status === "done" && existing.cacheKey === cacheKey && existsSync(abs)) {
			skipped++;
			options.onProgress?.({ kind: "panel-skip", label, index: index + 1, total });
			continue;
		}

		try {
			bumpVersion(abs, config.image.keepVersions);
			const result: AgnesGenerateResult = await client.generate({
				prompt,
				negative: panel.negative,
				size,
				ratio: store.project.style.ratio,
				refs,
				outPath: abs,
				signal,
				projectRoot: store.root,
			});
			writeSourceUrl(store.root, rel, result.sourceUrl);
			panel.image = {
				status: "done",
				file: rel,
				sourceUrl: result.sourceUrl ?? null,
				cacheKey,
				size,
				ratio: store.project.style.ratio,
				width: result.width,
				height: result.height,
				attempts: result.attempts,
				generatedAt: new Date().toISOString(),
			};
			done++;
			options.onProgress?.({ kind: "panel-done", label, index: index + 1, total });
		} catch (error) {
			if (error instanceof AgnesError && (error.code === "auth" || error.code === "aborted")) throw error;
			panel.image = {
				...(panel.image ?? { status: "pending" }),
				status: "failed",
				attempts: (panel.image?.attempts ?? 0) + 1,
				error: error instanceof Error ? error.message : String(error),
			};
			failed++;
			failures.push(key);
			options.onProgress?.({
				kind: "panel-fail",
				label,
				index: index + 1,
				total,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		store.writePage(page);
		store.touch();
	}
	store.refreshStats();
	return { done, skipped, failed, failures };
}

/** Resolve the page index/panel index from a "page-001/panel-02" key. */
export function parsePanelKey(key: string): { pageIndex: number; panelIndex: number } | undefined {
	const match = /^page-(\d{3})\/panel-(\d{2})$/.exec(key);
	if (!match) return undefined;
	return { pageIndex: Number(match[1]), panelIndex: Number(match[2]) };
}

/** Generate exactly one panel (used by /manga regen). */
export async function regeneratePanel(options: ImageStageOptions & { key: string; note?: string; promptOverride?: string }): Promise<AgnesGenerateResult> {
	const { store, config, client, signal } = options;
	const parsed = parsePanelKey(options.key);
	if (!parsed) throw new Error(`无效的格子: ${options.key}（应为 page-001/panel-01）`);
	const page = store.readPage(parsed.pageIndex);
	if (!page) throw new Error(`找不到页: ${options.key}`);
	const panel = page.panels[parsed.panelIndex - 1];
	if (!panel) throw new Error(`找不到格: ${options.key}`);
	if (options.promptOverride) panel.prompt = options.promptOverride;
	if (options.note?.trim()) panel.prompt = `${panel.prompt ?? ""}\n\nAdditional direction: ${options.note.trim()}`;
	const prompt = (panel.prompt ?? "").trim();
	if (!prompt) throw new Error(`格子 ${options.key} 缺少 prompt`);
	const bible = store.readBible();
	if (!bible) throw new Error("bible.json 缺失");
	const refRels: string[] = [];
	for (const member of panel.characters) {
		const cast = bible.cast.find((c) => c.id === member.id);
		const refRel = cast?.refSheet || `characters/${member.id}/ref.png`;
		if (!refRels.includes(refRel)) refRels.push(refRel);
	}
	const refs = buildReferences(store.root, refRels, config.image.maxRefs);
	const rel = panelRelPath(parsed.pageIndex, parsed.panelIndex);
	const abs = resolveWithin(store.root, rel);
	bumpVersion(abs, config.image.keepVersions);
	const size = options.final ? config.image.finalSize : config.image.draftSize;
	const result = await client.generate({
		prompt,
		negative: panel.negative,
		size,
		ratio: store.project.style.ratio,
		refs,
		outPath: abs,
		signal,
		projectRoot: store.root,
	});
	writeSourceUrl(store.root, rel, result.sourceUrl);
	panel.image = {
		status: "done",
		file: rel,
		sourceUrl: result.sourceUrl ?? null,
		cacheKey: panelCacheKey({ prompt, negative: panel.negative, size, ratio: store.project.style.ratio, model: config.image.model, refs }),
		size,
		ratio: store.project.style.ratio,
		width: result.width,
		height: result.height,
		attempts: result.attempts,
		generatedAt: new Date().toISOString(),
	};
	store.writePage(page);
	store.refreshStats();
	return result;
}
