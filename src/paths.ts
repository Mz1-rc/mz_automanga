import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function nowIso(): string {
	return new Date().toISOString();
}

/** Compact timestamp usable in run IDs: 20260101T101530 */
export function timestampForId(date = new Date()): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function slugify(input: string): string {
	const ascii = input
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return ascii || `manga-${Date.now().toString(36)}`;
}

/** Count visible characters (CJK counts as 1, whitespace ignored). */
export function countChars(text: string): number {
	return Array.from(text.replace(/\s+/g, "")).length;
}

export function ensureDir(path: string): string {
	mkdirSync(path, { recursive: true });
	return path;
}

export function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function readJson<T>(path: string): T | undefined {
	const text = readText(path);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export function writeAtomic(path: string, content: string | Uint8Array): void {
	ensureDir(dirname(path));
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		writeFileSync(tmp, content);
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore
		}
		throw error;
	}
}

export function writeJsonAtomic(path: string, value: unknown): void {
	writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function fileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export function fileStat(path: string): { size: number; mtimeMs: number } | undefined {
	try {
		const stat = statSync(path);
		return { size: stat.size, mtimeMs: stat.mtimeMs };
	} catch {
		return undefined;
	}
}

/**
 * Resolve a project-relative path and refuse anything that escapes the root.
 * Lexical check first; callers that need symlink safety should also realpath.
 */
export function resolveWithin(root: string, relPath: string): string {
	const normalized = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
	if (!normalized || normalized.split("/").includes("..") || isAbsolute(relPath)) {
		throw new Error(`非法路径: ${relPath}`);
	}
	const rootAbs = resolve(root);
	const abs = resolve(rootAbs, normalized);
	if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
		throw new Error(`路径越界: ${relPath}`);
	}
	return abs;
}

export function relativeInside(root: string, abs: string): string {
	const rel = relative(resolve(root), resolve(abs));
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`路径越界: ${abs}`);
	return rel.replaceAll("\\", "/");
}

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolvePromise, reject) => {
		const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolvePromise());
	});
	return hash.digest("hex");
}

export function isStale(mtimeMs: number, maxAgeMs = 6 * 60 * 60 * 1000): boolean {
	return Date.now() - mtimeMs > maxAgeMs;
}

export function listDirs(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

export function truncateMiddle(text: string, max = 400): string {
	if (text.length <= max) return text;
	const half = Math.floor((max - 3) / 2);
	return `${text.slice(0, half)}...${text.slice(-half)}`;
}

export function projectDirName(index: number): string {
	return `page-${String(index).padStart(3, "0")}`;
}

export function panelFileName(index: number): string {
	return `panel-${String(index).padStart(2, "0")}.png`;
}

export function pageRelPath(index: number): string {
	return join("pages", `${projectDirName(index)}.json`).replaceAll("\\", "/");
}

export function panelRelPath(pageIndex: number, panelIndex: number): string {
	return join("pages", projectDirName(pageIndex), panelFileName(panelIndex)).replaceAll("\\", "/");
}
