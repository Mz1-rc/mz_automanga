import { createHash } from "node:crypto";
import type { ImageGenWorkspace, ImageReference } from "./types.ts";

/** `pages/page-001/panel-02.png` */
export function panelRelPath(pageIndex: number, panelIndex: number): string {
	const page = `page-${String(pageIndex).padStart(3, "0")}`;
	const panel = `panel-${String(panelIndex).padStart(2, "0")}`;
	return `pages/${page}/${panel}.png`;
}

/** Resolve the page index/panel index from a "page-001/panel-02" key. */
export function parsePanelKey(key: string): { pageIndex: number; panelIndex: number } | undefined {
	const match = /^page-(\d{3})\/panel-(\d{2})$/.exec(key);
	if (!match) return undefined;
	return { pageIndex: Number(match[1]), panelIndex: Number(match[2]) };
}

/** Build references, preferring previous provider URLs over local base64. */
export function buildReferences(
	workspace: ImageGenWorkspace,
	rels: string[],
	maxRefs: number,
): ImageReference[] {
	const refs: ImageReference[] = [];
	for (const rel of rels) {
		if (refs.length >= maxRefs) break;
		if (!workspace.imageExists(rel)) continue;
		const url = workspace.readSourceUrl(rel);
		refs.push(url ? { url } : { path: workspace.imageAbsPath(rel) });
	}
	return refs;
}

export function panelCacheKey(options: {
	prompt: string;
	negative?: string;
	size: string;
	ratio: string;
	model: string;
	refs: ImageReference[];
}): string {
	const identity = options.refs.map((ref) => ref.url ?? ref.path ?? "");
	return createHash("sha256")
		.update(
			JSON.stringify({
				prompt: options.prompt,
				negative: options.negative ?? "",
				size: options.size,
				ratio: options.ratio,
				model: options.model,
				refs: identity,
			}),
		)
		.digest("hex");
}
