import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "./paths.ts";
import type { Bible, CastMember, CharacterRefMode, CharacterRefSettings } from "./types.ts";

export const CHARACTER_REF_DIR = "source/character-refs";
export const CHARACTER_REF_MANIFEST = `${CHARACTER_REF_DIR}/manifest.json`;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_REFERENCE_IMAGES = 100;

export interface CharacterRefSource {
	absPath: string;
	name: string;
	ext: string;
}

export interface CharacterRefFile {
	/** Project-relative copied file, e.g. source/character-refs/01-lin.png */
	file: string;
	originalPath: string;
	originalName: string;
}

export interface CharacterRefManifest {
	schemaVersion: 1;
	mode: CharacterRefMode;
	inputPath: string;
	files: CharacterRefFile[];
}

export function isCharacterRefImage(path: string): boolean {
	return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

function walk(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".")) continue;
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) walk(abs, out);
		else if (entry.isFile() && isCharacterRefImage(abs)) out.push(abs);
		if (out.length > MAX_REFERENCE_IMAGES) throw new Error(`角色参考图超过 ${MAX_REFERENCE_IMAGES} 张，请精简后再试`);
	}
}

export function collectCharacterRefSources(inputPath: string): CharacterRefSource[] {
	const path = inputPath.trim();
	if (!path) throw new Error("角色参考图路径为空");
	if (!existsSync(path)) throw new Error(`角色参考图路径不存在: ${path}`);
	const stat = statSync(path);
	const files: string[] = [];
	if (stat.isFile()) {
		if (isCharacterRefImage(path)) files.push(path);
	} else if (stat.isDirectory()) {
		walk(path, files);
	}
	if (files.length === 0) throw new Error(`角色参考图路径中没有 PNG/JPEG/WebP: ${path}`);
	return files.map((absPath) => ({
		absPath,
		name: basename(absPath),
		ext: extname(absPath).toLowerCase(),
	}));
}

function safeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "_");
}

export function importCharacterRefs(
	projectRoot: string,
	sources: CharacterRefSource[],
	mode: CharacterRefMode,
	inputPath: string,
): CharacterRefManifest {
	const dir = join(projectRoot, CHARACTER_REF_DIR);
	ensureDir(dir);
	const files: CharacterRefFile[] = [];
	for (const [index, source] of sources.entries()) {
		const destName = `${String(index + 1).padStart(2, "0")}-${safeFileName(source.name)}`;
		const destRel = `${CHARACTER_REF_DIR}/${destName}`;
		copyFileSync(source.absPath, join(projectRoot, destRel));
		files.push({
			file: destRel,
			originalPath: source.absPath,
			originalName: source.name,
		});
	}
	const manifest: CharacterRefManifest = {
		schemaVersion: 1,
		mode,
		inputPath,
		files,
	};
	writeJsonAtomic(join(projectRoot, CHARACTER_REF_MANIFEST), manifest);
	return manifest;
}

export function readCharacterRefManifest(projectRoot: string): CharacterRefManifest | undefined {
	const manifest = readJson<CharacterRefManifest>(join(projectRoot, CHARACTER_REF_MANIFEST));
	if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) return undefined;
	if (manifest.mode !== "direct" && manifest.mode !== "restyle") return undefined;
	return manifest;
}

export function characterRefSettings(mode: CharacterRefMode, inputPath: string): CharacterRefSettings {
	return { mode, inputPath, manifest: CHARACTER_REF_MANIFEST };
}

function normalize(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

function memberKeys(member: CastMember): string[] {
	return [member.id, member.name].map((value) => normalize(String(value ?? ""))).filter(Boolean);
}

function fileKey(file: CharacterRefFile): string {
	return normalize(file.originalName || basename(file.file));
}

/**
 * Attach imported user references to cast members.
 *
 * The director may assign `userRefs` explicitly by reading the manifest. Any
 * remaining entries are matched by filename (character name or id). When one
 * image and one character exist, they are paired even if the name differs.
 */
export function applyCharacterRefsToBible(bible: Bible, manifest: CharacterRefManifest): boolean {
	const available = new Set(manifest.files.map((file) => file.file));
	const used = new Set<string>();
	let changed = false;

	for (const member of bible.cast ?? []) {
		const explicit = (member.userRefs ?? []).filter((file) => available.has(file));
		let refs = explicit;
		if (refs.length === 0) {
			const keys = memberKeys(member);
			const match = manifest.files.find((file) => {
				if (used.has(file.file)) return false;
				const key = fileKey(file);
				if (!key) return false;
				return keys.some((memberKey) => memberKey === key || memberKey.includes(key) || key.includes(memberKey));
			});
			if (match) refs = [match.file];
		}
		if (refs.length === 0 && bible.cast.length === 1 && manifest.files.length === 1 && !used.has(manifest.files[0].file)) {
			refs = [manifest.files[0].file];
		}
		if (refs.length === 0) continue;

		used.add(refs[0]);
		if (!member.userRefs || member.userRefs.length !== refs.length || member.userRefs.some((file, index) => file !== refs[index])) {
			member.userRefs = refs;
			changed = true;
		}
		const target =
			manifest.mode === "direct"
				? `characters/${member.id}/ref${extname(refs[0]).toLowerCase() || ".png"}`
				: `characters/${member.id}/ref.png`;
		if (member.refSheet !== target) {
			member.refSheet = target;
			changed = true;
		}
	}

	// If the counts line up, pair remaining arbitrary filenames with remaining
	// characters in cast order. This keeps directories like 01.png / 02.png useful.
	const unmatched = (bible.cast ?? []).filter((member) => !(member.userRefs?.length ?? 0));
	const unused = manifest.files.filter((file) => !used.has(file.file));
	if (unmatched.length > 0 && unused.length === unmatched.length) {
		for (const [index, member] of unmatched.entries()) {
			const refs = [unused[index].file];
			used.add(refs[0]);
			member.userRefs = refs;
			const target =
				manifest.mode === "direct"
					? `characters/${member.id}/ref${extname(refs[0]).toLowerCase() || ".png"}`
					: `characters/${member.id}/ref.png`;
			member.refSheet = target;
			changed = true;
		}
	}

	return changed;
}
