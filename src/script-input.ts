import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

export interface ScriptInputFile {
	/** Path relative to the input root (or the file name for a single file). */
	rel: string;
	bytes: number;
}

export interface ScriptInputResult {
	text: string;
	files: ScriptInputFile[];
	/** true when the input was a directory. */
	fromDirectory: boolean;
}

export interface ReadScriptInputOptions {
	/** Total byte cap across all files. Default 8 MiB. */
	maxBytes?: number;
	/** Recognized text extensions (case-insensitive). */
	extensions?: string[];
	/** Directory names skipped during traversal. */
	skipDirs?: string[];
}

const DEFAULT_EXTENSIONS = [".md", ".markdown", ".txt", ".text"];
const DEFAULT_SKIP_DIRS = new Set([".git", ".automanga", "node_modules", ".runs", ".pi", ".idea", ".vscode"]);

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

/**
 * Read a script from a single text file or a directory of text files.
 * Directories are traversed recursively (sorted naturally) and merged with
 * file separators so the analyst can still see chapter boundaries.
 */
export function readScriptInput(inputPath: string, options: ReadScriptInputOptions = {}): ScriptInputResult {
	const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
	const extensions = (options.extensions ?? DEFAULT_EXTENSIONS).map((ext) => ext.toLowerCase());
	const skipDirs = new Set(options.skipDirs ?? [...DEFAULT_SKIP_DIRS]);
	if (!existsSync(inputPath)) throw new Error(`找不到剧本路径: ${inputPath}`);
	const stat = statSync(inputPath);

	if (stat.isFile()) {
		const bytes = stat.size;
		if (bytes > maxBytes) throw new Error(`剧本文件过大（${bytes} 字节，上限 ${maxBytes}）: ${inputPath}`);
		const text = readFileSync(inputPath, "utf8");
		return { text, files: [{ rel: basename(inputPath), bytes }], fromDirectory: false };
	}

	if (!stat.isDirectory()) throw new Error(`剧本路径既不是文件也不是目录: ${inputPath}`);

	const rels = walkDirectory(inputPath, extensions, skipDirs);
	if (rels.length === 0) {
		throw new Error(`目录中没有可读取的文本文件（支持 ${extensions.join("/")}）: ${inputPath}`);
	}
	const parts: string[] = [];
	const files: ScriptInputFile[] = [];
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
	}
	if (parts.length === 0) throw new Error(`目录中的文本文件都为空: ${inputPath}`);
	return { text: `${parts.join("\n\n")}\n`, files, fromDirectory: true };
}
