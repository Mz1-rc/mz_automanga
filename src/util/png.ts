import { readHead } from "./stream.ts";

export interface ImageSize {
	width: number;
	height: number;
	format: "png" | "jpeg" | "unknown";
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function parsePngSize(head: Buffer): ImageSize | undefined {
	if (head.length < 24) return undefined;
	if (!head.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
	// IHDR width/height are big-endian at offsets 16..24
	return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), format: "png" };
}

/** Scan JPEG markers in a head buffer for a SOF marker. */
export function parseJpegSize(head: Buffer): ImageSize | undefined {
	if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return undefined;
	let offset = 2;
	while (offset + 9 < head.length) {
		if (head[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = head[offset + 1];
		// standalone markers
		if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		const length = head.readUInt16BE(offset + 2);
		if (length < 2) return undefined;
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return {
				height: head.readUInt16BE(offset + 5),
				width: head.readUInt16BE(offset + 7),
				format: "jpeg",
			};
		}
		offset += 2 + length;
	}
	return undefined;
}

export function parseImageSize(head: Buffer): ImageSize {
	return parsePngSize(head) ?? parseJpegSize(head) ?? { width: 0, height: 0, format: "unknown" };
}

export async function readImageSize(path: string): Promise<ImageSize> {
	return parseImageSize(await readHead(path, 64 * 1024));
}

export function isPng(head: Buffer): boolean {
	return head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE);
}

export function isJpeg(head: Buffer): boolean {
	return head.length >= 2 && head[0] === 0xff && head[1] === 0xd8;
}
