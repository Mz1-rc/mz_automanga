import { readFileSync, statSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { writeAtomic } from "../paths.ts";
import { crc32Update } from "./stream.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_INPUT_PIXELS = 20_000_000;

interface PngChunk {
	type: string;
	data: Buffer;
}

interface DecodedPng {
	width: number;
	height: number;
	/** Always RGBA8, alpha composited over white. */
	rgba: Buffer;
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

function paeth(left: number, up: number, upLeft: number): number {
	const p = left + up - upLeft;
	const pa = Math.abs(p - left);
	const pb = Math.abs(p - up);
	const pc = Math.abs(p - upLeft);
	if (pa <= pb && pa <= pc) return left;
	if (pb <= pc) return up;
	return upLeft;
}

function unfilter(raw: Buffer, width: number, height: number, channels: number): Buffer | undefined {
	const stride = width * channels + 1;
	if (raw.length < stride * height) return undefined;
	const bpp = channels;
	const out = Buffer.alloc(width * height * channels);
	let previous = Buffer.alloc(width * channels);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * stride];
		const source = raw.subarray(y * stride + 1, y * stride + stride);
		const row = Buffer.alloc(width * channels);
		for (let x = 0; x < width * channels; x++) {
			const left = x >= bpp ? row[x - bpp] : 0;
			const up = previous[x];
			const upLeft = x >= bpp ? previous[x - bpp] : 0;
			let value = source[x];
			switch (filter) {
				case 0:
					break;
				case 1:
					value += left;
					break;
				case 2:
					value += up;
					break;
				case 3:
					value += Math.floor((left + up) / 2);
					break;
				case 4:
					value += paeth(left, up, upLeft);
					break;
				default:
					return undefined;
			}
			row[x] = value & 0xff;
		}
		row.copy(out, y * width * channels);
		previous = row;
	}
	return out;
}

/** Decode the 8-bit non-interlaced PNG subset produced by Agnes. */
export function decodePng(buffer: Buffer): DecodedPng | undefined {
	const chunks = readChunks(buffer);
	if (chunks.length === 0) return undefined;
	const ihdr = chunks.find((item) => item.type === "IHDR")?.data;
	if (!ihdr || ihdr.length < 13) return undefined;
	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	const bitDepth = ihdr[8];
	const colorType = ihdr[9];
	const interlace = ihdr[12];
	if (bitDepth !== 8 || interlace !== 0) return undefined;
	if (width < 1 || height < 1 || width * height > MAX_INPUT_PIXELS) return undefined;

	let channels: number;
	if (colorType === 0) channels = 1;
	else if (colorType === 2) channels = 3;
	else if (colorType === 4) channels = 2;
	else if (colorType === 6) channels = 4;
	else if (colorType === 3) channels = 1;
	else return undefined;

	const idat = Buffer.concat(chunks.filter((item) => item.type === "IDAT").map((item) => item.data));
	if (idat.length === 0) return undefined;
	let inflated: Buffer;
	try {
		inflated = inflateSync(idat);
	} catch {
		return undefined;
	}
	const pixels = unfilter(inflated, width, height, channels);
	if (!pixels) return undefined;

	let palette: Buffer | undefined;
	let transparency: Buffer | undefined;
	if (colorType === 3) {
		palette = chunks.find((item) => item.type === "PLTE")?.data;
		transparency = chunks.find((item) => item.type === "tRNS")?.data;
		if (!palette || palette.length < 3) return undefined;
	}

	const rgba = Buffer.alloc(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		const source = i * channels;
		const target = i * 4;
		let r: number;
		let g: number;
		let b: number;
		let a = 255;
		if (colorType === 3) {
			const index = pixels[source];
			r = palette?.[index * 3] ?? 0;
			g = palette?.[index * 3 + 1] ?? 0;
			b = palette?.[index * 3 + 2] ?? 0;
			if (transparency && index < transparency.length) a = transparency[index];
		} else if (channels === 1) {
			r = g = b = pixels[source];
		} else if (channels === 2) {
			r = g = b = pixels[source];
			a = pixels[source + 1];
		} else if (channels === 3) {
			r = pixels[source];
			g = pixels[source + 1];
			b = pixels[source + 2];
		} else {
			r = pixels[source];
			g = pixels[source + 1];
			b = pixels[source + 2];
			a = pixels[source + 3];
		}
		if (a < 255) {
			const alpha = a / 255;
			r = Math.round(r * alpha + 255 * (1 - alpha));
			g = Math.round(g * alpha + 255 * (1 - alpha));
			b = Math.round(b * alpha + 255 * (1 - alpha));
		}
		rgba[target] = r;
		rgba[target + 1] = g;
		rgba[target + 2] = b;
		rgba[target + 3] = 255;
	}
	return { width, height, rgba };
}

function chunk(type: string, data: Buffer): Buffer {
	const typeBuf = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32Update(crc32Update(0, typeBuf), data), 0);
	return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * Encode RGBA8 as either grayscale (color type 0) or truecolor (type 2).
 * Rows use the cheapest PNG filter, which is significantly smaller than
 * always writing filter 0 for lineart.
 */
export function encodePng(rgba: Buffer, width: number, height: number, monochrome: boolean, level = 6): Buffer {
	const channels = monochrome ? 1 : 3;
	const stride = width * channels + 1;
	const raw = Buffer.alloc(stride * height);
	let previous = Buffer.alloc(width * channels);
	for (let y = 0; y < height; y++) {
		const row = Buffer.alloc(width * channels);
		for (let x = 0; x < width; x++) {
			const source = (y * width + x) * 4;
			if (monochrome) {
				row[x] = Math.round(0.299 * rgba[source] + 0.587 * rgba[source + 1] + 0.114 * rgba[source + 2]);
			} else {
				row[x * 3] = rgba[source];
				row[x * 3 + 1] = rgba[source + 1];
				row[x * 3 + 2] = rgba[source + 2];
			}
		}
		let bestFilter = 0;
		let bestScore = Number.POSITIVE_INFINITY;
		let bestRow = row;
		for (let filter = 0; filter < 5; filter++) {
			const candidate = Buffer.alloc(width * channels);
			let score = 0;
			for (let i = 0; i < width * channels; i++) {
				const left = i >= channels ? row[i - channels] : 0;
				const up = previous[i];
				const upLeft = i >= channels ? previous[i - channels] : 0;
				let value = row[i];
				if (filter === 1) value -= left;
				else if (filter === 2) value -= up;
				else if (filter === 3) value -= Math.floor((left + up) / 2);
				else if (filter === 4) value -= paeth(left, up, upLeft);
				value &= 0xff;
				candidate[i] = value;
				score += value < 128 ? value : 256 - value;
			}
			if (score < bestScore) {
				bestScore = score;
				bestFilter = filter;
				bestRow = candidate;
			}
		}
		raw[y * stride] = bestFilter;
		bestRow.copy(raw, y * stride + 1);
		previous = row;
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = monochrome ? 0 : 2;
	return Buffer.concat([
		PNG_SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** Box-filter downscale; only called with dw <= sw and dh <= sh. */
export function resizeRgba(rgba: Buffer, width: number, height: number, targetWidth: number, targetHeight: number): Buffer {
	if (targetWidth === width && targetHeight === height) return rgba;
	const out = Buffer.alloc(targetWidth * targetHeight * 4);
	const xRatio = width / targetWidth;
	const yRatio = height / targetHeight;
	for (let y = 0; y < targetHeight; y++) {
		const sy0 = Math.floor(y * yRatio);
		const sy1 = Math.max(sy0 + 1, Math.min(height, Math.ceil((y + 1) * yRatio)));
		for (let x = 0; x < targetWidth; x++) {
			const sx0 = Math.floor(x * xRatio);
			const sx1 = Math.max(sx0 + 1, Math.min(width, Math.ceil((x + 1) * xRatio)));
			let r = 0;
			let g = 0;
			let b = 0;
			let count = 0;
			for (let sy = sy0; sy < sy1; sy++) {
				for (let sx = sx0; sx < sx1; sx++) {
					const index = (sy * width + sx) * 4;
					r += rgba[index];
					g += rgba[index + 1];
					b += rgba[index + 2];
					count++;
				}
			}
			const target = (y * targetWidth + x) * 4;
			out[target] = Math.round(r / count);
			out[target + 1] = Math.round(g / count);
			out[target + 2] = Math.round(b / count);
			out[target + 3] = 255;
		}
	}
	return out;
}

function isGrayscale(rgba: Buffer): boolean {
	for (let i = 0; i < rgba.length; i += 4) {
		if (rgba[i] !== rgba[i + 1] || rgba[i + 1] !== rgba[i + 2]) return false;
	}
	return true;
}

function widthCandidates(start: number, minimum: number): number[] {
	const widths = new Set<number>();
	let width = start;
	widths.add(width);
	while (width > minimum) {
		width = Math.max(minimum, Math.floor(width * 0.85));
		widths.add(width);
		if (width === minimum) break;
	}
	return [...widths].sort((a, b) => b - a);
}

export interface CompressOptions {
	maxBytes?: number;
	/** Defaults: grayscale 1280, color 640. */
	startWidth?: number;
	minWidth?: number;
	level?: number;
}

export interface CompressResult {
	ok: boolean;
	bytes: number;
	width: number;
	height: number;
	monochrome: boolean;
	attempts: number;
	reason?: string;
}

/**
 * Compress a PNG for Web delivery while keeping text readable.
 *
 * Strategy: decode once, detect grayscale lineart, box-downscale, and encode
 * with adaptive PNG filters. Widths shrink by 15% until the output is below
 * `maxBytes` (500 KB by default). The output is written atomically.
 */
export function compressPngToSize(inputPath: string, outputPath: string, options: CompressOptions = {}): CompressResult {
	const maxBytes = options.maxBytes ?? 500_000;
	const level = options.level ?? 6;
	let sourceBytes = 0;
	try {
		sourceBytes = statSync(inputPath).size;
	} catch {
		return { ok: false, bytes: 0, width: 0, height: 0, monochrome: false, attempts: 0, reason: "missing" };
	}
	let buffer: Buffer;
	try {
		buffer = readFileSync(inputPath);
	} catch {
		return { ok: false, bytes: sourceBytes, width: 0, height: 0, monochrome: false, attempts: 0, reason: "read" };
	}
	const decoded = decodePng(buffer);
	if (!decoded) {
		return { ok: false, bytes: sourceBytes, width: 0, height: 0, monochrome: false, attempts: 0, reason: "unsupported" };
	}
	const monochrome = isGrayscale(decoded.rgba);
	const startWidth = Math.min(decoded.width, options.startWidth ?? (monochrome ? 1280 : 640));
	const minWidth = Math.min(startWidth, options.minWidth ?? 160);
	const widths = widthCandidates(startWidth, minWidth);

	let best: Buffer | undefined;
	let bestWidth = 0;
	let bestHeight = 0;
	for (const [index, width] of widths.entries()) {
		const height = Math.max(1, Math.round((decoded.height * width) / decoded.width));
		const resized = width === decoded.width && height === decoded.height
			? decoded.rgba
			: resizeRgba(decoded.rgba, decoded.width, decoded.height, width, height);
		const png = encodePng(resized, width, height, monochrome, level);
		best = png;
		bestWidth = width;
		bestHeight = height;
		if (png.length <= maxBytes) {
			writeAtomic(outputPath, png);
			return {
				ok: true,
				bytes: png.length,
				width,
				height,
				monochrome,
				attempts: index + 1,
				reason: sourceBytes <= maxBytes ? "already-small" : undefined,
			};
		}
	}
	// Even the smallest attempt did not fit: keep the smallest output so the
	// caller can still decide whether to use it.
	if (best) writeAtomic(outputPath, best);
	return {
		ok: false,
		bytes: best?.length ?? sourceBytes,
		width: bestWidth,
		height: bestHeight,
		monochrome,
		attempts: widths.length,
		reason: "too-large",
	};
}
