import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ImageReference } from "../types.ts";

export function mimeFor(path: string): string {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	return "image/png";
}

/** Build a data URI for a local reference. Reads exactly one file at a time. */
export function localRefToDataUri(path: string): string {
	const data = readFileSync(path);
	return `data:${mimeFor(path)};base64,${data.toString("base64")}`;
}

/** Providers without a dedicated negative field get it appended to the prompt. */
export function joinPrompt(prompt: string, negative?: string): string {
	const core = prompt.trim();
	const neg = (negative ?? "").trim();
	if (!neg) return core;
	return `${core}\n\nAvoid: ${neg}`;
}

/** Convert generic references to the URL/data-URI strings expected by image APIs. */
export function refsToImages(refs?: ImageReference[]): string[] | undefined {
	if (!refs || refs.length === 0) return undefined;
	const images: string[] = [];
	for (const ref of refs) {
		if (ref.url) images.push(ref.url);
		else if (ref.path) images.push(localRefToDataUri(ref.path));
	}
	return images.length > 0 ? images : undefined;
}
