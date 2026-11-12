import { readFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { writeAtomic } from "../paths.ts";
import { crc32Update } from "./stream.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Guard against pathological images: 2K (≈4M px) is fine, 4K is skipped. */
const MAX_PIXELS = 16_000_000;

interface PngChunk {
	type: string;
	data: Buffer;
}

function readChunks(buffer: Buffer): PngChunk[] {
	if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return [];
	const chunks: PngChunk[] = [];
	let offset = 8;
	while (offset + 12 <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const start = offset + 8;
		const end = start + length;
		if (end + 4 > buffer.length) return [];
		chunks.push({ type, data: buffer.subarray(start, end) });
		offset = end + 4;
	}
	return chunks;
}

function chunk(type: string, data: Buffer): Buffer {
	const typeBuf = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32Update(crc32Update(0, typeBuf), data), 0);
	return Buffer.concat([length, typeBuf, data, crc]);
}

function paeth(left: number, up: number, upLeft: number): number {
	const p = left + up - upLeft;
	const pa = Math.abs(p - left);
	const pb = Math.abs(p - up);
	const pc = Math.abs(p - upLeft);
	if (pa <= pb && pa <= pc) return left;
	if (pb <= pc) return up;
	return upLeft;
}

/**
 * Deterministically convert an 8-bit RGB/RGBA PNG to grayscale in place.
 *
 * This is the last line of defense for `manga-bw`: even when an image model
 * ignores the prompt and returns a colored picture, the stored artifact and
 * therefore the Web preview / CBZ export stay black-and-white. Alpha and
 * dimensions are preserved; metadata chunks are dropped.
 *
 * Returns false for non-PNG, palette, 16-bit, interlaced or oversized images.
 */
export function toMonochromePng(path: string): boolean {
	let buffer: Buffer;
	try {
		buffer = readFileSync(path);
	} catch {
		return false;
	}
	const chunks = readChunks(buffer);
	if (chunks.length === 0) return false;
	const ihdr = chunks.find((item) => item.type === "IHDR")?.data;
	if (!ihdr || ihdr.length < 13) return false;
	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	const bitDepth = ihdr[8];
	const colorType = ihdr[9];
	const interlace = ihdr[12];
	if (bitDepth !== 8 || interlace !== 0) return false;
	if (width < 1 || height < 1 || width * height > MAX_PIXELS) return false;
	if (colorType === 0 || colorType === 4) return false; // already grayscale
	if (colorType === 3) return false; // palette PNG: not produced by Agnes
	const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
	if (!channels) return false;

	const idat = Buffer.concat(chunks.filter((item) => item.type === "IDAT").map((item) => item.data));
	if (idat.length === 0) return false;
	let raw: Buffer;
	try {
		raw = inflateSync(idat);
	} catch {
		return false;
	}
	const rowBytes = width * channels;
	const stride = rowBytes + 1;
	if (raw.length < stride * height) return false;

	const out = Buffer.alloc(stride * height);
	let previous = Buffer.alloc(rowBytes);
	const bpp = channels;
	for (let y = 0; y < height; y++) {
		const filter = raw[y * stride];
		const source = raw.subarray(y * stride + 1, y * stride + stride);
		const row = Buffer.alloc(rowBytes);
		for (let x = 0; x < rowBytes; x++) {
			const left = x >= bpp ? row[x - bpp] : 0;
			const up = previous[x];
			const upLeft = x >= bpp ? previous[x - bpp] : 0;
			let value = source[x];
			switch (filter) {
				case 0:
					break;
				case 1:
					value = source[x] + left;
					break;
				case 2:
					value = source[x] + up;
					break;
				case 3:
					value = source[x] + Math.floor((left + up) / 2);
					break;
				case 4:
					value = source[x] + paeth(left, up, upLeft);
					break;
				default:
					return false;
			}
			row[x] = value & 0xff;
		}
		out[y * stride] = 0;
		for (let x = 0; x < width; x++) {
			const offset = x * channels;
			const target = y * stride + 1 + offset;
			const luma = Math.round(0.299 * row[offset] + 0.587 * row[offset + 1] + 0.114 * row[offset + 2]);
			out[target] = luma;
			out[target + 1] = luma;
			out[target + 2] = luma;
			// Keep alpha untouched; previous row must stay unfiltered color data
			// because Up/Paeth predict from the reconstructed source values.
			if (channels === 4) out[target + 3] = row[offset + 3];
		}
		previous = row;
	}

	const png = Buffer.concat([
		PNG_SIGNATURE,
		chunk("IHDR", Buffer.from(ihdr)),
		chunk("IDAT", deflateSync(out, { level: 6 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
	try {
		writeAtomic(path, png);
		return true;
	} catch {
		return false;
	}
}
