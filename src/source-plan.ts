import { countChars } from "./paths.ts";
import { splitFileIntoUnits, type ScriptInputResult, type ScriptUnit } from "./script-input.ts";
import type { SourcePlan, SourceStrategy, SourceUnitMeta } from "./types.ts";

export const DEFAULT_SPLIT_THRESHOLD_CHARS = 60_000;
export const DEFAULT_MAX_UNIT_CHARS = 60_000;

export interface PlanScriptOptions {
	maxUnitChars?: number;
	splitThresholdChars?: number;
}

export interface PlannedScript {
	plan: SourcePlan;
	/** Units with their text; not persisted into plan JSON. */
	units: ScriptUnit[];
	/** Text that should become source/script.md for a single-unit project. */
	singleText: string;
}

function unitMeta(unit: ScriptUnit): SourceUnitMeta {
	return {
		id: unit.id,
		index: unit.index,
		title: unit.title,
		rel: unit.rel,
		chars: unit.chars,
		kind: unit.kind,
	};
}

function reassign(units: ScriptUnit[]): ScriptUnit[] {
	return units.map((unit, index) => ({
		...unit,
		id: `unit-${String(index + 1).padStart(3, "0")}`,
		index: index + 1,
		chars: countChars(unit.text),
	}));
}

function ensureBounded(units: ScriptUnit[], maxUnitChars: number): ScriptUnit[] {
	const out: ScriptUnit[] = [];
	for (const unit of units) {
		if (unit.chars <= maxUnitChars) {
			out.push(unit);
			continue;
		}
		const pieces = splitFileIntoUnits(unit.text, unit.rel, { maxUnitChars });
		if (pieces.length <= 1) {
			out.push(unit);
			continue;
		}
		for (const [index, piece] of pieces.entries()) {
			out.push({
				...piece,
				title: pieces.length > 1 ? `${unit.title}（${index + 1}/${pieces.length}）` : unit.title,
				kind: "chunk",
			});
		}
	}
	return out;
}

/**
 * Decide the source strategy from actual size:
 * - `single`: small enough to feed the whole script to every role.
 * - `chaptered`: large input with natural headings/files; one project per unit.
 * - `chunked`: large input without usable headings; split at paragraph/size boundaries.
 */
export function planScriptInput(input: ScriptInputResult, options: PlanScriptOptions = {}): PlannedScript {
	const maxUnitChars = Math.max(100, options.maxUnitChars ?? DEFAULT_MAX_UNIT_CHARS);
	const splitThresholdChars = Math.max(100, options.splitThresholdChars ?? DEFAULT_SPLIT_THRESHOLD_CHARS);
	const totalChars = input.totalChars || countChars(input.text);

	if (totalChars <= splitThresholdChars) {
		const first = input.units[0];
		const single: ScriptUnit = {
			id: "unit-001",
			index: 1,
			title: first?.title || "全文",
			rel: first?.rel || "script.md",
			text: input.text,
			chars: totalChars,
			kind: "file",
		};
		return {
			plan: {
				schemaVersion: 1,
				strategy: "single",
				totalChars,
				maxUnitChars,
				splitThresholdChars,
				totalUnits: 1,
				fromDirectory: input.fromDirectory,
				units: [unitMeta(single)],
			},
			units: [single],
			singleText: input.text,
		};
	}

	let units = ensureBounded(input.units.length > 0 ? input.units : splitFileIntoUnits(input.text, "script.md", { maxUnitChars }), maxUnitChars);
	if (units.length <= 1) {
		units = ensureBounded(splitFileIntoUnits(input.text, "script.md", { maxUnitChars }), maxUnitChars);
	}
	units = reassign(units);
	const strategy: SourceStrategy = units.some((unit) => unit.kind === "chunk") ? "chunked" : "chaptered";
	return {
		plan: {
			schemaVersion: 1,
			strategy,
			totalChars,
			maxUnitChars,
			splitThresholdChars,
			totalUnits: units.length,
			fromDirectory: input.fromDirectory,
			units: units.map(unitMeta),
		},
		units,
		singleText: units[0]?.text ?? input.text,
	};
}

export function findUnit(units: ScriptUnit[], selector?: string): ScriptUnit | undefined {
	const value = selector?.trim();
	if (!value) return undefined;
	const lower = value.toLowerCase();
	return (
		units.find((unit) => unit.id.toLowerCase() === lower) ??
		units.find((unit) => String(unit.index) === value) ??
		units.find((unit) => unit.title.toLowerCase() === lower) ??
		units.find((unit) => unit.title.toLowerCase().includes(lower)) ??
		units.find((unit) => unit.rel.toLowerCase() === lower)
	);
}

export function unitChoices(units: ScriptUnit[]): string[] {
	return units.map((unit) => `${unit.index}. ${unit.title}（${unit.chars} 字）`);
}

export function strategyLabel(strategy: SourceStrategy): string {
	switch (strategy) {
		case "chaptered":
			return "章节分割";
		case "chunked":
			return "长文分块";
		default:
			return "单篇";
	}
}
