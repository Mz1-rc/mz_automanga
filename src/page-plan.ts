import { countChars } from "./paths.ts";
import type { Scene, ScriptAnalysis } from "./types.ts";

export const STORYBOARD_MAX_PAGES = 40;
/** Rough source-text density used to stop a short script from becoming a recap. */
export const PAGE_SCRIPT_CHARS = 140;
/** A page has 3–6 panels, so more than this many beats per page gets crowded. */
export const PAGE_BEATS = 5;

export interface StoryboardPagePlan {
	index: number;
	id: string;
	total: number;
	sceneIds: string[];
	sceneTitles: string[];
	beatStart: number;
	beatEnd: number;
	totalBeats: number;
	beats: string[];
}

export interface StoryboardPlan {
	/** Number of pages the storyboard stage will actually produce. */
	totalPages: number;
	/** Page count requested by analysis.pageEstimate. */
	requestedPages: number;
	/** Maximum pages supported by scenes, beats and source length. */
	budgetPages: number;
	sourceChars: number;
	totalBeats: number;
	pages: StoryboardPagePlan[];
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function pageId(index: number): string {
	return `page-${String(index).padStart(3, "0")}`;
}

function sceneInventory(scenes: Scene[]): Array<{ scene: Scene; beat: string; sceneIndex: number }> {
	const flat: Array<{ scene: Scene; beat: string; sceneIndex: number }> = [];
	for (const [sceneIndex, scene] of scenes.entries()) {
		for (const beat of scene.beats ?? []) {
			const text = String(beat ?? "").trim();
			if (text) flat.push({ scene, beat: text, sceneIndex });
		}
	}
	return flat;
}

/**
 * Build a deterministic page plan before the storyboard role runs.
 *
 * Analysis often over-estimates pageEstimate for short scripts; without a
 * per-page allocation the storyboard agent runs out of story and fills the
 * remaining pages with recaps/replays. This plan caps the page count by the
 * actual scene/beat/source budget and gives every page its own slice of beats.
 */
export function buildStoryboardPlan(analysis: ScriptAnalysis, script: string): StoryboardPlan {
	const scenes = (analysis.scenes ?? []).filter(Boolean);
	const flat = sceneInventory(scenes);
	const totalBeats = flat.length;
	const requestedPages = clamp(Math.round(Number(analysis.pageEstimate) || 1), 1, STORYBOARD_MAX_PAGES);
	const sceneFloor = Math.max(1, scenes.length);
	const contentPages = Math.max(1, Math.ceil(countChars(script) / PAGE_SCRIPT_CHARS));
	const beatPages = Math.max(1, Math.ceil(totalBeats / PAGE_BEATS));
	// Keep at least one page per scene, but only allow extra pages when both the
	// source text and the number of beats can support them.
	const budgetPages = clamp(Math.max(sceneFloor, Math.min(contentPages, beatPages)), 1, STORYBOARD_MAX_PAGES);
	const totalPages = clamp(Math.min(requestedPages, budgetPages), 1, STORYBOARD_MAX_PAGES);

	const pages: StoryboardPagePlan[] = [];
	if (totalBeats === 0) {
		for (let index = 1; index <= totalPages; index++) {
			const scene = scenes[index - 1];
			pages.push({
				index,
				id: pageId(index),
				total: totalPages,
				sceneIds: scene ? [scene.id] : [],
				sceneTitles: scene ? [scene.title] : [],
				beatStart: 0,
				beatEnd: 0,
				totalBeats: 0,
				beats: scene ? [scene.summary].filter(Boolean).map(String) : [],
			});
		}
		return { totalPages, requestedPages, budgetPages, sourceChars: countChars(script), totalBeats, pages };
	}

	for (let index = 1; index <= totalPages; index++) {
		// Split the global beat sequence evenly. When there are fewer pages than
		// beats every page gets at least one beat; the final page absorbs the rest.
		const start = Math.floor(((index - 1) * totalBeats) / totalPages);
		const rawEnd = Math.floor((index * totalBeats) / totalPages);
		const end = index === totalPages ? totalBeats : Math.max(start + 1, rawEnd);
		const slice = flat.slice(start, end);
		const sceneIds: string[] = [];
		const sceneTitles: string[] = [];
		for (const item of slice) {
			if (!sceneIds.includes(item.scene.id)) {
				sceneIds.push(item.scene.id);
				sceneTitles.push(item.scene.title);
			}
		}
		pages.push({
			index,
			id: pageId(index),
			total: totalPages,
			sceneIds,
			sceneTitles,
			beatStart: start + 1,
			beatEnd: end,
			totalBeats,
			beats: slice.map((item) => item.beat),
		});
	}

	return { totalPages, requestedPages, budgetPages, sourceChars: countChars(script), totalBeats, pages };
}

export function pagePlanFor(plan: StoryboardPlan, index: number): StoryboardPagePlan | undefined {
	return plan.pages.find((page) => page.index === index);
}
