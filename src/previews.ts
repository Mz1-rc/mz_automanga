import { renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, extname } from "node:path";
import { ensureDir, resolveWithin } from "./paths.ts";
import type { ProjectStore } from "./state.ts";
import { compressPngToSize } from "./util/image-compress.ts";

/** Web previews live in a hidden cache; originals and ZIP exports stay untouched. */
export const WEB_PREVIEW_DIR = ".web";
export const WEB_PREVIEW_MAX_BYTES = 500_000;

export type PreviewStatus = "created" | "skipped" | "missing" | "failed";

export interface PreviewResult {
	status: PreviewStatus;
	rel: string;
	bytes?: number;
	sourceBytes?: number;
	width?: number;
	height?: number;
	reason?: string;
}

export function webPreviewRel(rel: string): string {
	const normalized = rel.replaceAll("\\", "/").replace(/^\/+/, "");
	return `${WEB_PREVIEW_DIR}/${normalized}`;
}

export function webPreviewPath(projectRoot: string, rel: string): string {
	return resolveWithin(projectRoot, webPreviewRel(rel));
}

/** A preview is usable only when it is <=500 KB and not older than the source. */
export function webPreviewIsFresh(projectRoot: string, rel: string): boolean {
	try {
		const source = resolveWithin(projectRoot, rel);
		const preview = webPreviewPath(projectRoot, rel);
		const sourceStat = statSync(source);
		const previewStat = statSync(preview);
		return previewStat.size <= WEB_PREVIEW_MAX_BYTES && previewStat.mtimeMs >= sourceStat.mtimeMs;
	} catch {
		return false;
	}
}

/**
 * Create (or refresh) one <500 KB preview for a project-relative image.
 * This is called by the pipeline and by `/manga web start`, never by an HTTP
 * handler, so the Web server itself remains read-only.
 */
export function ensureWebPreview(projectRoot: string, rel: string): PreviewResult {
	let source: string;
	let sourceStat;
	try {
		source = resolveWithin(projectRoot, rel);
		sourceStat = statSync(source);
	} catch {
		return { status: "missing", rel, reason: "source-not-found" };
	}
	if (sourceStat.size <= WEB_PREVIEW_MAX_BYTES) {
		return { status: "skipped", rel, bytes: sourceStat.size, sourceBytes: sourceStat.size, reason: "source-small" };
	}
	// The compressor only decodes PNG. Direct-mode references may be JPEG/WebP;
	// those are served as-is instead of being reported as compression failures.
	if (extname(rel).toLowerCase() !== ".png") {
		return { status: "skipped", rel, bytes: sourceStat.size, sourceBytes: sourceStat.size, reason: "unsupported-format" };
	}
	if (webPreviewIsFresh(projectRoot, rel)) {
		let bytes = 0;
		try {
			bytes = statSync(webPreviewPath(projectRoot, rel)).size;
		} catch {
			bytes = 0;
		}
		return { status: "skipped", rel, bytes, sourceBytes: sourceStat.size, reason: "fresh" };
	}

	const preview = webPreviewPath(projectRoot, rel);
	const temp = `${preview}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		ensureDir(dirname(preview));
		const result = compressPngToSize(source, temp, { maxBytes: WEB_PREVIEW_MAX_BYTES });
		if (!result.ok || result.bytes <= 0 || result.bytes > WEB_PREVIEW_MAX_BYTES) {
			try {
				unlinkSync(temp);
			} catch {
				// ignore
			}
			return {
				status: "failed",
				rel,
				bytes: result.bytes,
				sourceBytes: sourceStat.size,
				reason: result.reason ?? "compress-failed",
			};
		}
		renameSync(temp, preview);
		return {
			status: "created",
			rel,
			bytes: result.bytes,
			sourceBytes: sourceStat.size,
			width: result.width,
			height: result.height,
		};
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// ignore
		}
		return {
			status: "failed",
			rel,
			sourceBytes: sourceStat.size,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Collect panel and character images that can be shown by the Web preview. */
export function previewRelPaths(store: ProjectStore): string[] {
	const rels = new Set<string>();
	for (const key of store.listPageKeys()) {
		const page = store.readPageByKey(key);
		if (!page) continue;
		for (const [index, panel] of page.panels.entries()) {
			const rel = panel.image?.file || `pages/${key}/panel-${String(index + 1).padStart(2, "0")}.png`;
			rels.add(rel.replaceAll("\\", "/"));
		}
	}
	const bible = store.readBible();
	for (const member of bible?.cast ?? []) {
		rels.add((member.refSheet || `characters/${member.id}/ref.png`).replaceAll("\\", "/"));
	}
	return [...rels];
}

export interface PreviewBatchResult {
	total: number;
	created: number;
	skipped: number;
	failed: number;
	missing: number;
	bytes: number;
}

export function ensureProjectWebPreviews(
	store: ProjectStore,
	onProgress?: (progress: { index: number; total: number; rel: string; result: PreviewResult }) => void,
): PreviewBatchResult {
	const rels = previewRelPaths(store);
	const result: PreviewBatchResult = { total: rels.length, created: 0, skipped: 0, failed: 0, missing: 0, bytes: 0 };
	for (const [index, rel] of rels.entries()) {
		const preview = ensureWebPreview(store.root, rel);
		if (preview.status === "created") result.created++;
		else if (preview.status === "skipped") result.skipped++;
		else if (preview.status === "missing") result.missing++;
		else result.failed++;
		result.bytes += preview.bytes ?? 0;
		try {
			onProgress?.({ index: index + 1, total: rels.length, rel, result: preview });
		} catch {
			// progress observers must never break compression
		}
	}
	return result;
}

/** Used by the Web server: prefer the compressed preview when it is fresh. */
export function selectWebMediaPath(projectRoot: string, rel: string, safeResolve: (projectRoot: string, rel: string) => string | undefined): string | undefined {
	const original = safeResolve(projectRoot, rel);
	if (!original) return undefined;
	try {
		const sourceStat = statSync(original);
		if (sourceStat.size <= WEB_PREVIEW_MAX_BYTES) return original;
		const preview = safeResolve(projectRoot, webPreviewRel(rel));
		if (!preview) return original;
		const previewStat = statSync(preview);
		if (previewStat.size <= WEB_PREVIEW_MAX_BYTES && previewStat.mtimeMs >= sourceStat.mtimeMs) return preview;
	} catch {
		// fall through to the original
	}
	return original;
}
