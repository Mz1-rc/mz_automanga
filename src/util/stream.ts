import { createWriteStream, renameSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DownloadResult {
	bytes: number;
	path: string;
}

function tmpName(dest: string): string {
	return `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Stream a web ReadableStream to disk without ever buffering the whole body.
 * Enforces a hard byte cap so a runaway response cannot exhaust memory/disk.
 */
export async function downloadToFile(
	body: ReadableStream<Uint8Array> | Readable,
	dest: string,
	options: { maxBytes: number; chunkBytes: number; signal?: AbortSignal },
): Promise<DownloadResult> {
	const tmp = tmpName(dest);
	let bytes = 0;
	const limiter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			bytes += chunk.length;
			if (bytes > options.maxBytes) {
				callback(new Error(`下载超过上限 ${options.maxBytes} 字节`));
				return;
			}
			callback(null, chunk);
		},
	});
	const source = body instanceof Readable ? body : Readable.fromWeb(body as never);
	try {
		await pipeline(source, limiter, createWriteStream(tmp, { highWaterMark: options.chunkBytes }), {
			signal: options.signal,
		} as never);
		renameSync(tmp, dest);
		return { bytes, path: dest };
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore
		}
		throw error;
	}
}

/** Decode base64 and write once; callers must drop the string immediately. */
export async function writeBase64ToFile(base64: string, dest: string): Promise<DownloadResult> {
	const buffer = Buffer.from(base64, "base64");
	const tmp = tmpName(dest);
	try {
		await new Promise<void>((resolvePromise, reject) => {
			const stream = createWriteStream(tmp, { highWaterMark: 64 * 1024 });
			stream.on("error", reject);
			stream.on("finish", () => resolvePromise());
			stream.end(buffer);
		});
		renameSync(tmp, dest);
		return { bytes: buffer.length, path: dest };
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore
		}
		throw error;
	} finally {
		buffer.fill(0);
	}
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32Update(crc: number, chunk: Uint8Array): number {
	let c = crc ^ 0xffffffff;
	for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** Compute CRC32 by streaming a file in fixed-size chunks. */
export async function crc32File(path: string, chunkBytes = 1024 * 1024): Promise<number> {
	const handle = await open(path, "r");
	const buffer = Buffer.allocUnsafe(chunkBytes);
	let crc = 0;
	try {
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null);
			if (bytesRead <= 0) break;
			crc = crc32Update(crc, buffer.subarray(0, bytesRead));
		}
	} finally {
		await handle.close();
	}
	return crc;
}

/** Copy a file to a writable stream in chunks, returning bytes copied. */
export async function copyFileToStream(path: string, writable: NodeJS.WritableStream, chunkBytes = 1024 * 1024): Promise<number> {
	const handle = await open(path, "r");
	const buffer = Buffer.allocUnsafe(chunkBytes);
	let total = 0;
	try {
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null);
			if (bytesRead <= 0) break;
			total += bytesRead;
			if (!writable.write(buffer.subarray(0, bytesRead))) {
				await new Promise<void>((resolvePromise) => writable.once("drain", () => resolvePromise()));
			}
		}
	} finally {
		await handle.close();
	}
	return total;
}

/**
 * Read at most `limit` bytes from the head of a file. Used for image headers,
 * never for image bodies.
 */
export async function readHead(path: string, limit = 64 * 1024): Promise<Buffer> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(limit);
		const { bytesRead } = await handle.read(buffer, 0, limit, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}
