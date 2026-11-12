import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { MangaConfig } from "../config.ts";
import { readJson, resolveWithin } from "../paths.ts";
import { selectWebMediaPath } from "../previews.ts";
import { listProjects, ProjectStore } from "../state.ts";
import type { Bible, MangaPage } from "../types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");

/** Hard read-only boundary: no request may mutate project state or files. */
const READ_ONLY_METHODS = new Set(["GET", "HEAD"]);

export interface WebServerOptions {
	cwd: string;
	config: MangaConfig;
	host?: string;
	port?: number;
	signal?: AbortSignal;
}

export interface WebServerHandle {
	server: Server;
	url: string;
	host: string;
	port: number;
	close(): Promise<void>;
}

function contentType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		default:
			return "application/octet-stream";
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(text),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string, type = "text/plain; charset=utf-8"): void {
	res.writeHead(status, {
		"Content-Type": type,
		"Content-Length": Buffer.byteLength(text),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
	});
	res.end(text);
}

/** Resolve a media path, then verify realpath stays inside the project. */
function safeMediaPath(projectRoot: string, rel: string): string | undefined {
	try {
		const abs = resolveWithin(projectRoot, normalize(rel));
		if (!existsSync(abs)) return undefined;
		const real = realpathSync(abs);
		const realRoot = realpathSync(projectRoot);
		if (!real.startsWith(`${realRoot}/`)) return undefined;
		if (!statSync(real).isFile()) return undefined;
		return real;
	} catch {
		return undefined;
	}
}

function serveFile(req: IncomingMessage, res: ServerResponse, path: string): void {
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

function pageSummary(projectRoot: string): { pages: Array<{ id: string; index: number; panels: Array<{ id: string; file: string; status: string; version: number }> }> } {
	const pages: Array<{ id: string; index: number; panels: Array<{ id: string; file: string; status: string; version: number }> }> = [];
	const pagesDir = join(projectRoot, "pages");
	if (!existsSync(pagesDir)) return { pages };
	for (const name of readdirSafe(pagesDir)) {
		if (!/^page-\d{3}\.json$/.test(name)) continue;
		const id = name.replace(/\.json$/, "");
		const page = readJson<MangaPage>(join(pagesDir, name));
		if (!page) continue;
		pages.push({
			id,
			index: page.index,
			panels: page.panels.map((panel, index) => {
				// Media URLs are /media/<slug>/<project-relative path>; include the
				// pages/ prefix so the server can resolve the file from the project root.
				const file = `pages/${id}/panel-${String(index + 1).padStart(2, "0")}.png`;
				const abs = join(projectRoot, file);
				let version = 0;
				try {
					version = Math.floor(statSync(abs).mtimeMs);
				} catch {
					version = 0;
				}
				return { id: panel.id, file, status: panel.image?.status ?? (version ? "done" : "pending"), version };
			}),
		});
	}
	pages.sort((a, b) => a.index - b.index);
	return { pages };
}

function readdirSafe(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

function characterSummary(store: ProjectStore): Array<{
	id: string;
	name: string;
	role: string;
	file: string;
	version: number;
}> {
	const bible = readJson<Bible>(join(store.root, "bible.json"));
	if (!bible || !Array.isArray(bible.cast)) return [];
	return bible.cast.map((member) => {
		const fallback = `characters/${member.id}/ref.png`;
		let rel = (member.refSheet || fallback).replaceAll("\\", "/");
		let abs: string;
		try {
			abs = resolveWithin(store.root, rel);
		} catch {
			rel = fallback;
			abs = join(store.root, rel);
		}
		let version = 0;
		try {
			version = Math.floor(statSync(abs).mtimeMs);
		} catch {
			version = 0;
		}
		return {
			id: member.id,
			name: member.name || member.id,
			role: member.role || "",
			file: rel,
			version,
		};
	});
}

function projectSnapshot(store: ProjectStore): unknown {
	const summary = pageSummary(store.root);
	return {
		slug: store.project.slug,
		title: store.project.title,
		phase: store.state.phase,
		revision: store.state.revision,
		stats: store.state.stats,
		style: { preset: store.project.style.preset, ratio: store.project.style.ratio },
		...summary,
		characters: characterSummary(store),
	};
}

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
	const host = options.host ?? options.config.web.host ?? "0.0.0.0";
	const basePort = options.port ?? options.config.web.port;
	if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65535) {
		throw new Error("Web 端口必须在 1–65535 之间且不能为 0；请用 --port 手动指定。");
	}

	let activeSlug: string | undefined;

	const handler = (req: IncomingMessage, res: ServerResponse): void => {
		void (async () => {
			try {
				const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
				// Central framework-level guard. Every route below is read-only, and
				// mutation verbs are rejected before touching the filesystem.
				if (!READ_ONLY_METHODS.has(req.method ?? "")) {
					res.setHeader("Allow", "GET, HEAD");
					sendJson(res, 405, { error: "read only" });
					return;
				}

				if (url.pathname === "/" || url.pathname === "/index.html") {
					serveFile(req, res, join(PUBLIC_DIR, "index.html"));
					return;
				}
				if (url.pathname === "/app.js" || url.pathname === "/style.css") {
					serveFile(req, res, join(PUBLIC_DIR, url.pathname.slice(1)));
					return;
				}
				if (url.pathname === "/api/projects") {
					sendJson(res, 200, { projects: listProjects(options.cwd, options.config) });
					return;
				}
				if (url.pathname === "/api/project") {
					activeSlug = url.searchParams.get("p") ?? activeSlug;
					const store = ProjectStore.load(options.cwd, options.config, activeSlug);
					activeSlug = store.project.slug;
					sendJson(res, 200, projectSnapshot(store));
					return;
				}
				if (url.pathname === "/api/events") {
					const slug = url.searchParams.get("p") ?? activeSlug;
					const store = ProjectStore.load(options.cwd, options.config, slug);
					activeSlug = store.project.slug;
					res.writeHead(200, {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
						"X-Accel-Buffering": "no",
					});
					res.write("retry: 3000\n\n");
					let lastRevision = -1;
					const sendSnapshot = () => {
						try {
							const loaded = ProjectStore.loadByPath(store.root);
							if (loaded.state.revision === lastRevision) return;
							lastRevision = loaded.state.revision;
							res.write(`event: snapshot\ndata: ${JSON.stringify(projectSnapshot(loaded))}\n\n`);
						} catch {
							// project may be temporarily mid-write; retry next tick
						}
					};
					sendSnapshot();
					const poll = setInterval(sendSnapshot, 1000);
					const ping = setInterval(() => res.write(": ping\n\n"), 20000);
					req.on("close", () => {
						clearInterval(poll);
						clearInterval(ping);
					});
					return;
				}
				const media = /^\/media\/([^/]+)\/(.+)$/.exec(url.pathname);
				if (media) {
					const slug = decodeURIComponent(media[1]);
					const rel = decodeURIComponent(media[2]);
					const store = ProjectStore.load(options.cwd, options.config, slug);
					// Prefer the compressed .web copy when it is fresh; HTTP handlers
					// never create previews themselves.
					const abs = selectWebMediaPath(store.root, rel, safeMediaPath);
					if (!abs) {
						sendText(res, 404, "404 Not Found");
						return;
					}
					serveFile(req, res, abs);
					return;
				}
				sendText(res, 404, "404 Not Found");
			} catch (error) {
				sendText(res, 500, `500 ${error instanceof Error ? error.message : "error"}`);
			}
		})();
	};

	const server = createServer(handler);
	const port = await listenOnce(server, basePort, host);
	server.unref();
	const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
	const url = `http://${displayHost}:${port}`;
	const close = async () => {
		await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	};
	return { server, url, host, port, close };
}

function listenOnce(server: Server, port: number, host: string): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		const onError = (error: NodeJS.ErrnoException) => {
			if (error.code === "EADDRINUSE") {
				reject(new Error(`端口 ${port} 已被占用。请先停止占用进程，或用 /manga web start --port <其他端口>。`));
				return;
			}
			reject(error);
		};
		server.once("error", onError);
		server.listen(port, host, () => {
			server.removeListener("error", onError);
			resolvePromise(port);
		});
	});
}
