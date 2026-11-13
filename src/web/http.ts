import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export function contentType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".ico":
			return "image/x-icon";
		case ".woff2":
			return "font/woff2";
		default:
			return "application/octet-stream";
	}
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(text),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(text);
}

export function sendText(res: ServerResponse, status: number, text: string, type = "text/plain; charset=utf-8"): void {
	res.writeHead(status, {
		"Content-Type": type,
		"Content-Length": Buffer.byteLength(text),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
	});
	res.end(text);
}

/** Stream a file with ETag, conditional request and byte-range support. */
export function serveFile(req: IncomingMessage, res: ServerResponse, path: string): void {
	const stat = statSync(path);
	const type = contentType(path);
	const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
	if (req.headers["if-none-match"] === etag) {
		res.writeHead(304, { ETag: etag });
		res.end();
		return;
	}
	const range = req.headers.range;
	let start = 0;
	let end = stat.size - 1;
	let status = 200;
	if (range) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(range);
		if (match) {
			start = match[1] ? Number(match[1]) : 0;
			end = match[2] ? Number(match[2]) : stat.size - 1;
			if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
				res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
				res.end();
				return;
			}
			end = Math.min(end, stat.size - 1);
			status = 206;
		}
	}
	const headers: Record<string, string | number> = {
		"Content-Type": type,
		"Content-Length": end - start + 1,
		"Accept-Ranges": "bytes",
		ETag: etag,
		"Cache-Control": "no-cache",
		"X-Content-Type-Options": "nosniff",
	};
	if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
	res.writeHead(status, headers);
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	const stream = createReadStream(path, { start, end, highWaterMark: 64 * 1024 });
	stream.on("error", () => res.destroy());
	stream.pipe(res);
}
