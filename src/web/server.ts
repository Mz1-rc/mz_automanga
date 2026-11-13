import { existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { MangaConfig } from "../config.ts";
import { resolveWithin } from "../paths.ts";
import { selectWebMediaPath } from "../previews.ts";
import { listProjects, ProjectStore } from "../state.ts";
import { sendJson, sendText, serveFile } from "./http.ts";
import { projectSnapshot } from "./snapshot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const ASSET_DIR = join(PUBLIC_DIR, "assets");
const STATIC_ASSET_EXTENSIONS = new Set([".html", ".js", ".css", ".svg", ".png", ".webp", ".ico", ".woff2"]);

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

/** Resolve a media path, then verify realpath stays inside the project. */
function safeMediaPath(projectRoot: string, rel: string): string | undefined {
	try {
		const abs = resolveWithin(projectRoot, rel);
		if (!existsSync(abs)) return undefined;
		const real = realpathSync(abs);
		const realRoot = realpathSync(projectRoot);
		if (!real.startsWith(`${realRoot}${sep}`)) return undefined;
		if (!statSync(real).isFile()) return undefined;
		return real;
	} catch {
		return undefined;
	}
}

/** Static files live under public/; reject traversal, symlinks and unknown types. */
function safePublicPath(rel: string): string | undefined {
	if (!rel || rel.includes("\0")) return undefined;
	let decoded: string;
	try {
		decoded = decodeURIComponent(rel);
	} catch {
		return undefined;
	}
	let abs: string;
	try {
		abs = resolveWithin(ASSET_DIR, decoded);
	} catch {
		return undefined;
	}
	if (!STATIC_ASSET_EXTENSIONS.has(extname(abs).toLowerCase())) return undefined;
	try {
		const real = realpathSync(abs);
		const realRoot = realpathSync(ASSET_DIR);
		if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) return undefined;
		return statSync(real).isFile() ? real : undefined;
	} catch {
		return undefined;
	}
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
				if (url.pathname.startsWith("/assets/")) {
					const abs = safePublicPath(url.pathname.slice("/assets/".length));
					if (!abs) {
						sendText(res, 404, "404 Not Found");
						return;
					}
					serveFile(req, res, abs);
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
