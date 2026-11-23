import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { seriesRoot, type MangaConfig } from "./config.ts";
import { ensureDir, nowIso, readJson, readText, slugify, writeAtomic, writeJsonAtomic } from "./paths.ts";
import type { ScriptUnit } from "./script-input.ts";
import type {
	AdaptationLevel,
	SeriesRecord,
	SeriesUnitRecord,
	SourcePlan,
	StyleSelection,
} from "./types.ts";

export interface CreateSeriesInput {
	title: string;
	inputPath: string;
	plan: SourcePlan;
	units: ScriptUnit[];
	style: StyleSelection;
	adaptation?: AdaptationLevel;
	config: MangaConfig;
}

export function seriesRecordPath(cwd: string, config: MangaConfig, id: string): string {
	return join(seriesRoot(cwd, config), `${id}.json`);
}

export function seriesDir(cwd: string, config: MangaConfig, id: string): string {
	return join(seriesRoot(cwd, config), id);
}

export function seriesUnitRel(id: string, unitId: string): string {
	return `series/${id}/units/${unitId}.md`;
}

/** Resolve the workspace from a project root (`<ws>/projects/<slug>`). */
export function workspaceFromProject(projectRoot: string): string {
	return dirname(dirname(projectRoot));
}

export function seriesRecordPathForProject(projectRoot: string, id: string): string {
	return join(workspaceFromProject(projectRoot), "series", `${id}.json`);
}

/** Create the series directory + manifest and write every unit to disk. */
export function createSeriesAt(
	cwd: string,
	config: MangaConfig,
	input: Omit<CreateSeriesInput, "config">,
): SeriesRecord {
	const root = ensureDir(seriesRoot(cwd, config));
	const base = slugify(input.title) || "series";
	let id = base;
	let n = 2;
	while (existsSync(join(root, `${id}.json`))) id = `${base}-${n++}`;
	const dir = ensureDir(join(root, id, "units"));
	const units: SeriesUnitRecord[] = input.units.map((unit) => {
		const file = `series/${id}/units/${unit.id}.md`;
		writeAtomic(join(dir, `${unit.id}.md`), unit.text.endsWith("\n") ? unit.text : `${unit.text}\n`);
		return {
			id: unit.id,
			index: unit.index,
			title: unit.title,
			rel: unit.rel,
			chars: unit.chars,
			kind: unit.kind,
			file,
		};
	});
	const now = nowIso();
	const record: SeriesRecord = {
		schemaVersion: 1,
		id,
		title: input.title,
		inputPath: input.inputPath,
		createdAt: now,
		updatedAt: now,
		strategy: input.plan.strategy,
		totalChars: input.plan.totalChars,
		totalUnits: units.length,
		style: input.style,
		...(input.adaptation ? { adaptation: input.adaptation } : {}),
		units,
	};
	writeJsonAtomic(join(root, `${id}.json`), record);
	return record;
}

export function readSeries(cwd: string, config: MangaConfig, id: string): SeriesRecord | undefined {
	return readJson<SeriesRecord>(seriesRecordPath(cwd, config, id));
}

export function readSeriesForProject(projectRoot: string, id: string): SeriesRecord | undefined {
	return readJson<SeriesRecord>(seriesRecordPathForProject(projectRoot, id));
}

export function saveSeries(cwd: string, config: MangaConfig, series: SeriesRecord): void {
	series.updatedAt = nowIso();
	writeJsonAtomic(seriesRecordPath(cwd, config, series.id), series);
}

export function readSeriesUnitText(projectRoot: string, unit: SeriesUnitRecord): string {
	return readText(join(workspaceFromProject(projectRoot), unit.file)) ?? "";
}

export function markSeriesUnitProject(
	cwd: string,
	config: MangaConfig,
	series: SeriesRecord,
	unitId: string,
	projectSlug: string,
): SeriesRecord {
	const unit = series.units.find((item) => item.id === unitId);
	if (unit) {
		unit.projectSlug = projectSlug;
		unit.status = "active";
	}
	saveSeries(cwd, config, series);
	return series;
}

/** Mark the unit complete after its project reaches the done phase. */
export function markSeriesUnitDoneForProject(projectRoot: string, seriesId: string, unitId: string): void {
	const path = seriesRecordPathForProject(projectRoot, seriesId);
	const series = readJson<SeriesRecord>(path);
	if (!series) return;
	const unit = series.units.find((item) => item.id === unitId);
	if (!unit) return;
	unit.status = "done";
	series.updatedAt = nowIso();
	writeJsonAtomic(path, series);
}

/** Prefer the next unit after the current one; otherwise the first unassigned. */
export function nextSeriesUnit(series: SeriesRecord, currentUnitId?: string): SeriesUnitRecord | undefined {
	const currentIndex = series.units.findIndex((unit) => unit.id === currentUnitId);
	if (currentIndex >= 0) {
		const after = series.units.slice(currentIndex + 1).find((unit) => !unit.projectSlug);
		if (after) return after;
		const later = series.units.slice(currentIndex + 1)[0];
		if (later && !later.projectSlug) return later;
	}
	return series.units.find((unit) => !unit.projectSlug);
}
