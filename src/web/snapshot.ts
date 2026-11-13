import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson, resolveWithin } from "../paths.ts";
import type { ProjectStore } from "../state.ts";
import type { Bible, MangaPage } from "../types.ts";

interface PanelSummary {
	id: string;
	file: string;
	status: string;
	version: number;
}

interface PageSummary {
	id: string;
	index: number;
	panels: PanelSummary[];
}

interface CharacterSummary {
	id: string;
	name: string;
	role: string;
	file: string;
	version: number;
}

export interface ProjectSnapshot {
	slug: string;
	title: string;
	phase: string;
	revision: number;
	stats: unknown;
	style: { preset: string; ratio: string };
	pages: PageSummary[];
	characters: CharacterSummary[];
}

function readdirSafe(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

function pageSummary(projectRoot: string): { pages: PageSummary[] } {
	const pages: PageSummary[] = [];
	const pagesDir = join(projectRoot, "pages");
	if (!existsSync(pagesDir)) return { pages };
	for (const name of readdirSafe(pagesDir)) {
		if (!/^page-\d{3}\.json$/.test(name)) continue;
		const id = name.replace(/\.json$/, "");
		const page = readJson<MangaPage>(join(pagesDir, name));
		if (!page) continue;
		pages.push({
			id,
			index: page.index,
			panels: page.panels.map((panel, index) => {
				// Media URLs are /media/<slug>/<project-relative path>; include the
				// pages/ prefix so the server can resolve the file from the project root.
				const file = `pages/${id}/panel-${String(index + 1).padStart(2, "0")}.png`;
				const abs = join(projectRoot, file);
				let version = 0;
				try {
					version = Math.floor(statSync(abs).mtimeMs);
				} catch {
					version = 0;
				}
				return { id: panel.id, file, status: panel.image?.status ?? (version ? "done" : "pending"), version };
			}),
		});
	}
	pages.sort((a, b) => a.index - b.index);
	return { pages };
}

function characterSummary(store: ProjectStore): CharacterSummary[] {
	const bible = readJson<Bible>(join(store.root, "bible.json"));
	if (!bible || !Array.isArray(bible.cast)) return [];
	return bible.cast.map((member) => {
		const fallback = `characters/${member.id}/ref.png`;
		let rel = (member.refSheet || fallback).replaceAll("\\", "/");
		let abs: string;
		try {
			abs = resolveWithin(store.root, rel);
		} catch {
			rel = fallback;
			abs = join(store.root, rel);
		}
		let version = 0;
		try {
			version = Math.floor(statSync(abs).mtimeMs);
		} catch {
			version = 0;
		}
		return {
			id: member.id,
			name: member.name || member.id,
			role: member.role || "",
			file: rel,
			version,
		};
	});
}

export function projectSnapshot(store: ProjectStore): ProjectSnapshot {
	const summary = pageSummary(store.root);
	return {
		slug: store.project.slug,
		title: store.project.title,
		phase: store.state.phase,
		revision: store.state.revision,
		stats: store.state.stats,
		style: { preset: store.project.style.preset, ratio: store.project.style.ratio },
		...summary,
		characters: characterSummary(store),
	};
}
