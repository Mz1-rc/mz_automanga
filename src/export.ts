import { createWriteStream, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ensureDir, fileExists } from "./paths.ts";
import type { ProjectStore } from "./state.ts";
import { copyFileToStream, crc32File } from "./util/stream.ts";

interface ZipEntry {
	name: string;
	crc: number;
	size: number;
	offset: number;
	dosTime: number;
	dosDate: number;
}

function dosDateTime(date: Date): { time: number; date: number } {
	const year = Math.max(1980, date.getFullYear());
	const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
	const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
	return { time: dosTime, date: dosDate };
}

function write(stream: NodeJS.WritableStream, buffer: Buffer): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const ok = stream.write(buffer, (error) => {
			if (error) reject(error);
		});
		if (ok) resolvePromise();
		else stream.once("drain", () => resolvePromise());
	});
}

function localHeader(entry: ZipEntry): Buffer {
	const header = Buffer.alloc(30);
	header.writeUInt32LE(0x04034b50, 0);
	header.writeUInt16LE(20, 4);
	header.writeUInt16LE(0, 6);
	header.writeUInt16LE(0, 8); // store
	header.writeUInt16LE(entry.dosTime, 10);
	header.writeUInt16LE(entry.dosDate, 12);
	header.writeUInt32LE(entry.crc, 14);
	header.writeUInt32LE(entry.size, 18);
	header.writeUInt32LE(entry.size, 22);
	header.writeUInt16LE(Buffer.byteLength(entry.name), 26);
	header.writeUInt16LE(0, 28);
	return Buffer.concat([header, Buffer.from(entry.name, "utf8")]);
}

function centralHeader(entry: ZipEntry): Buffer {
	const name = Buffer.from(entry.name, "utf8");
	const header = Buffer.alloc(46);
	header.writeUInt32LE(0x02014b50, 0);
	header.writeUInt16LE(20, 4);
	header.writeUInt16LE(20, 6);
	header.writeUInt16LE(0, 8);
	header.writeUInt16LE(0, 10); // store
	header.writeUInt16LE(entry.dosTime, 12);
	header.writeUInt16LE(entry.dosDate, 14);
	header.writeUInt32LE(entry.crc, 16);
	header.writeUInt32LE(entry.size, 20);
	header.writeUInt32LE(entry.size, 24);
	header.writeUInt16LE(name.length, 28);
	header.writeUInt16LE(0, 30);
	header.writeUInt16LE(0, 32);
	header.writeUInt16LE(0, 34);
	header.writeUInt16LE(0, 36);
	header.writeUInt32LE(0, 38);
	header.writeUInt32LE(entry.offset, 42);
	return Buffer.concat([header, name]);
}

export interface CbzResult {
	file: string;
	entries: number;
	bytes: number;
}

/**
 * Build a store-only CBZ by streaming files one at a time. No archive buffer
 * and no image buffer ever exists; each file is read twice (CRC + copy).
 */
export async function exportCbz(options: {
	store: ProjectStore;
	outPath?: string;
	chunkBytes?: number;
}): Promise<CbzResult> {
	const { store } = options;
	const outPath = options.outPath ?? join(store.root, "exports", `${store.project.slug}.cbz`);
	const chunkBytes = options.chunkBytes ?? 1024 * 1024;
	ensureDir(join(store.root, "exports"));

	const files: Array<{ abs: string; name: string }> = [];
	for (const key of store.listPageKeys()) {
		for (let panel = 1; panel <= 6; panel++) {
			const abs = join(store.root, "pages", key, `panel-${String(panel).padStart(2, "0")}.png`);
			if (fileExists(abs)) files.push({ abs, name: `${key}/panel-${String(panel).padStart(2, "0")}.png` });
		}
	}
	if (files.length === 0) throw new Error("没有可导出的画面（pages/*/panel-*.png）");
	if (files.length > 65535) throw new Error("文件数量超过 ZIP32 上限");

	const stream = createWriteStream(outPath, { highWaterMark: chunkBytes });
	const entries: ZipEntry[] = [];
	let offset = 0;
	try {
		for (const file of files) {
			const stat = statSync(file.abs);
			if (stat.size > 0xffffffff) throw new Error(`文件过大: ${file.name}`);
			const crc = await crc32File(file.abs, chunkBytes);
			const { time, date } = dosDateTime(stat.mtime);
			const entry: ZipEntry = { name: file.name, crc, size: stat.size, offset, dosTime: time, dosDate: date };
			const header = localHeader(entry);
			await write(stream, header);
			offset += header.length;
			const copied = await copyFileToStream(file.abs, stream, chunkBytes);
			if (copied !== stat.size) throw new Error(`读取文件时长度变化: ${file.name}`);
			offset += copied;
			entries.push(entry);
		}
		const centralStart = offset;
		for (const entry of entries) {
			const header = centralHeader(entry);
			await write(stream, header);
			offset += header.length;
		}
		const centralSize = offset - centralStart;
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(0, 4);
		end.writeUInt16LE(0, 6);
		end.writeUInt16LE(entries.length, 8);
		end.writeUInt16LE(entries.length, 10);
		end.writeUInt32LE(centralSize, 12);
		end.writeUInt32LE(centralStart, 16);
		end.writeUInt16LE(0, 20);
		await write(stream, end);
		offset += end.length;
		if (offset > 0xffffffff) throw new Error("导出文件超过 ZIP32 上限");
	} finally {
		await new Promise<void>((resolvePromise, reject) => {
			stream.end((error?: Error | null) => (error ? reject(error) : resolvePromise()));
		});
	}
	if (!existsSync(outPath)) throw new Error("导出失败：文件未生成");
	return { file: outPath, entries: entries.length, bytes: offset };
}

export function cbzFileName(slug: string): string {
	return `${basename(slug)}.cbz`;
}
