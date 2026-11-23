import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { countChars } from "./paths.ts";
import type { SourceUnitKind } from "./types.ts";

export interface ScriptInputFile {
	/** Path relative to the input root (or the file name for a single file). */
	rel: string;
	bytes: number;
}

/** A chapter / section / size-bounded chunk of the original input. */
export interface ScriptUnit {
	id: string;
	index: number;
	title: string;
	rel: string;
	text: string;
	chars: number;
	kind: SourceUnitKind;
}

export interface ScriptInputResult {
	/** Full merged text, kept for backwards compatibility with small projects. */
	text: string;
	files: ScriptInputFile[];
	/** true when the input was a directory. */
	fromDirectory: boolean;
	/** Natural units before size-based splitting. */
	units: ScriptUnit[];
	totalChars: number;
}

export interface ReadScriptInputOptions {
	/** Total byte cap across all files. Default 8 MiB. */
	maxBytes?: number;
	/** Recognized text extensions (case-insensitive). */
	extensions?: string[];
	/** Directory names skipped during traversal. */
	skipDirs?: string[];
	/** Maximum visible characters in one unit. Default 60k. */
	maxUnitChars?: number;
}

const DEFAULT_EXTENSIONS = [".md", ".markdown", ".txt", ".text"];
const DEFAULT_SKIP_DIRS = new Set([".git", ".automanga", "node_modules", ".runs", ".pi", ".idea", ".vscode"]);
export const DEFAULT_MAX_UNIT_CHARS = 60_000;

export function isScriptTextFile(name: string, extensions: string[] = DEFAULT_EXTENSIONS): boolean {
	const lower = name.toLowerCase();
	if (lower.startsWith(".")) return false;
	const ext = lower.slice(lower.lastIndexOf("."));
	if (lower.lastIndexOf(".") <= 0) return false;
	return extensions.includes(ext);
}

const NATURAL_COLLATOR = new Intl.Collator("zh-Hans", { numeric: true, sensitivity: "base" });

function naturalCompare(a: string, b: string): number {
	return NATURAL_COLLATOR.compare(a, b);
}

function walkDirectory(root: string, extensions: string[], skipDirs: Set<string>): string[] {
	const files: string[] = [];
	const stack: string[] = [""];
	while (stack.length > 0) {
		const relDir = stack.pop() as string;
		const absDir = relDir ? join(root, relDir) : root;
		let entries;
		try {
			entries = readdirSync(absDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (skipDirs.has(entry.name) || entry.name.startsWith(".")) continue;
				stack.push(rel);
			} else if (entry.isFile() && isScriptTextFile(entry.name, extensions)) {
				files.push(rel);
			}
		}
	}
	return files.sort(naturalCompare);
}

/** Strip markdown heading markers and collapse whitespace for a unit title. */
function cleanTitle(value: string): string {
	return value
		.replace(/^#+\s*/, "")
		.replace(/\s+/g, " ")
		.replace(/^[\s"'“”‘’《》]+|[\s"'“”‘’《》]+$/g, "")
		.trim()
		.slice(0, 80);
}

function firstMeaningfulLine(text: string): string {
	for (const line of text.split(/\r?\n/)) {
		const value = line.trim();
		if (!value) continue;
		if (value.startsWith("#")) return cleanTitle(value);
		if (countChars(value) >= 2) return cleanTitle(value);
	}
	return "";
}

interface HeadingMatch {
	start: number;
	title: string;
}

/** Find chapter/section headings without splitting ordinary prose. */
function findHeadings(text: string): HeadingMatch[] {
	const matches: HeadingMatch[] = [];
	const re = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const title = cleanTitle(match[2]);
		if (!title) continue;
		matches.push({ start: match.index, title });
	}
	return matches;
}

/** Split one long section by paragraph boundaries, never exceeding maxChars. */
function chunkSection(text: string, title: string, rel: string, maxChars: number): ScriptUnit[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	if (countChars(trimmed) <= maxChars) {
		return [{ id: "", index: 0, title, rel, text: trimmed, chars: countChars(trimmed), kind: "section" }];
	}

	const paragraphs = trimmed.split(/\n{2,}/).filter((part) => part.trim());
	const chunks: string[] = [];
	let current = "";
	const pushCurrent = () => {
		if (current.trim()) chunks.push(current.trim());
		current = "";
	};
	for (const paragraph of paragraphs) {
		const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
		if (countChars(candidate) <= maxChars) {
			current = candidate;
			continue;
		}
		pushCurrent();
		if (countChars(paragraph) <= maxChars) {
			current = paragraph;
			continue;
		}
		// A single huge paragraph: split at sentence-ish boundaries, then hard cap.
		const sentences = paragraph.split(/(?<=[。！？!?；;])/);
		let sentenceBuffer = "";
		const flushSentence = () => {
			if (sentenceBuffer.trim()) chunks.push(sentenceBuffer.trim());
			sentenceBuffer = "";
		};
		for (const sentence of sentences) {
			const next = sentenceBuffer + sentence;
			if (countChars(next) <= maxChars) {
				sentenceBuffer = next;
			} else {
				flushSentence();
				if (countChars(sentence) <= maxChars) {
					sentenceBuffer = sentence;
				} else {
					let rest = sentence;
					while (countChars(rest) > maxChars) {
						let cut = rest.length;
						while (cut > 0 && countChars(rest.slice(0, cut)) > maxChars) cut = Math.floor(cut / 2);
						// The loop above is deliberately conservative; walk forward to
						// the exact boundary so a chunk is never empty.
						let exact = cut;
						while (exact < rest.length && countChars(rest.slice(0, exact + 1)) <= maxChars) exact++;
						chunks.push(rest.slice(0, Math.max(1, exact)).trim());
						rest = rest.slice(Math.max(1, exact));
					}
					sentenceBuffer = rest;
				}
			}
		}
		flushSentence();
	}
	pushCurrent();

	return chunks
		.filter((chunk) => chunk.trim())
		.map((chunk, index) => ({
			id: "",
			index: 0,
			title: chunks.length > 1 ? `${title}（${index + 1}/${chunks.length}）` : title,
			rel,
			text: chunk,
			chars: countChars(chunk),
			kind: "chunk" as const,
		}));
}

/** Split a file into chapters, sections, or size-bounded chunks. */
export function splitFileIntoUnits(
	content: string,
	rel: string,
	options: { maxUnitChars?: number; preferFileUnit?: boolean } = {},
): ScriptUnit[] {
	const text = content.trim();
	if (!text) return [];
	const maxChars = Math.max(100, options.maxUnitChars ?? DEFAULT_MAX_UNIT_CHARS);
	const headings = findHeadings(text);
	const fallbackTitle = cleanTitle(basename(rel)) || "未命名章节";
	// A directory of chapter files should stay one unit per file unless the file
	// itself is oversized. This avoids splitting on scene-level subheadings.
	if (options.preferFileUnit && countChars(text) <= maxChars) {
		return [{
			id: "",
			index: 0,
			title: headings[0]?.title || fallbackTitle,
			rel,
			text,
			chars: countChars(text),
			kind: "file",
		}];
	}
	const units: ScriptUnit[] = [];

	const emit = (unit: ScriptUnit) => units.push(unit);
	const emitSection = (body: string, title: string) => {
		for (const unit of chunkSection(body, title || fallbackTitle, rel, maxChars)) emit(unit);
	};

	if (headings.length === 0) {
		// No headings: one unit, or size-bounded chunks for a very long file.
		const chunks = chunkSection(text, fallbackTitle, rel, maxChars);
		for (const unit of chunks) {
			// A file that is split purely by size is a "chunk"; a short file is
			// still a file-level unit.
			unit.kind = chunks.length > 1 ? "chunk" : "file";
			emit(unit);
		}
		return units;
	}

	const preface = text.slice(0, headings[0].start).trim();
	if (preface) emitSection(preface, fallbackTitle);
	for (const [index, heading] of headings.entries()) {
		const end = index + 1 < headings.length ? headings[index + 1].start : text.length;
		const body = text.slice(heading.start, end).trim();
		emitSection(body, heading.title);
	}
	return units;
}

/** Split a merged file that already contains `# ===== file =====` markers. */
function splitMergedSections(content: string, maxUnitChars: number): ScriptUnit[] | undefined {
	const re = /^# =====[ \t]*(.+?)[ \t]*=====[ \t]*$/gm;
	const matches: Array<{ start: number; end: number; title: string }> = [];
	let match: RegExpExecArray | null;
	while ((match = re.exec(content)) !== null) {
		matches.push({ start: match.index, end: re.lastIndex, title: cleanTitle(match[1]) });
	}
	if (matches.length === 0) return undefined;

	const units: ScriptUnit[] = [];
	const preface = content.slice(0, matches[0].start).trim();
	if (preface) units.push(...splitFileIntoUnits(preface, "preface", { maxUnitChars }));
	for (const [index, marker] of matches.entries()) {
		const end = index + 1 < matches.length ? matches[index + 1].start : content.length;
		const body = content.slice(marker.end, end).trim();
		if (!body) continue;
		const nested = splitFileIntoUnits(body, marker.title, { maxUnitChars });
		for (const unit of nested) {
			if (!unit.title || unit.title === marker.title) unit.title = marker.title || unit.title;
			units.push(unit);
		}
	}
	return units;
}

function assignIds(units: ScriptUnit[]): ScriptUnit[] {
	return units.map((unit, index) => ({
		...unit,
		id: `unit-${String(index + 1).padStart(3, "0")}`,
		index: index + 1,
	}));
}

/**
 * Read a script from a single text file or a directory of text files.
 *
 * Directory files are traversed recursively (sorted naturally). The returned
 * `text` remains the merged full script for backwards compatibility; `units`
 * is the machine-usable chapter/section/chunk breakdown used by long-script
 * projects.
 */
export function readScriptInput(inputPath: string, options: ReadScriptInputOptions = {}): ScriptInputResult {
	const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
	const maxUnitChars = options.maxUnitChars ?? DEFAULT_MAX_UNIT_CHARS;
	const extensions = (options.extensions ?? DEFAULT_EXTENSIONS).map((ext) => ext.toLowerCase());
	const skipDirs = new Set(options.skipDirs ?? [...DEFAULT_SKIP_DIRS]);
	if (!existsSync(inputPath)) throw new Error(`找不到剧本路径: ${inputPath}`);
	const stat = statSync(inputPath);

	if (stat.isFile()) {
		const bytes = stat.size;
		if (bytes > maxBytes) throw new Error(`剧本文件过大（${bytes} 字节，上限 ${maxBytes}）: ${inputPath}`);
		const text = readFileSync(inputPath, "utf8");
		const rel = basename(inputPath);
		const units = splitMergedSections(text, maxUnitChars) ?? splitFileIntoUnits(text, rel, { maxUnitChars });
		return {
			text,
			files: [{ rel, bytes }],
			fromDirectory: false,
			units: assignIds(units),
			totalChars: countChars(text),
		};
	}

	if (!stat.isDirectory()) throw new Error(`剧本路径既不是文件也不是目录: ${inputPath}`);

	const rels = walkDirectory(inputPath, extensions, skipDirs);
	if (rels.length === 0) {
		throw new Error(`目录中没有可读取的文本文件（支持 ${extensions.join("/")}）: ${inputPath}`);
	}
	const parts: string[] = [];
	const files: ScriptInputFile[] = [];
	const units: ScriptUnit[] = [];
	let total = 0;
	for (const rel of rels) {
		const abs = join(inputPath, rel);
		const bytes = statSync(abs).size;
		total += bytes;
		if (total > maxBytes) throw new Error(`剧本目录内容过大（超过 ${maxBytes} 字节）: ${inputPath}`);
		const content = readFileSync(abs, "utf8").trim();
		if (!content) continue;
		parts.push(`# ===== ${rel} =====\n\n${content}`);
		files.push({ rel: relative(inputPath, abs).replaceAll("\\", "/"), bytes });
		for (const unit of splitFileIntoUnits(content, rel, { maxUnitChars, preferFileUnit: true })) units.push(unit);
	}
	if (parts.length === 0) throw new Error(`目录中的文本文件都为空: ${inputPath}`);
	const text = `${parts.join("\n\n")}\n`;
	return {
		text,
		files,
		fromDirectory: true,
		units: assignIds(units),
		totalChars: countChars(text),
	};
}
