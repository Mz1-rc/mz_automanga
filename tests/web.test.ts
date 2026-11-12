import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, DEFAULT_WEB, normalizeConfig } from "../src/config.ts";
import { ensureProjectWebPreviews } from "../src/previews.ts";
import { freePort, makeTestProject, writeNoisyPng, writeTinyPng } from "./helpers.ts";
import { startWebServer } from "../src/web/server.ts";

function mediaPath(slug: string, file: string): string {
	const encodedFile = file.split("/").map((part) => encodeURIComponent(part)).join("/");
	return `/media/${encodeURIComponent(slug)}/${encodedFile}`;
}

function seed(store: ReturnType<typeof makeTestProject>["store"]) {
	store.writePage({
		schemaVersion: 1,
		id: "page-001",
		index: 1,
		summary: "s",
		panels: [
			{
				id: "panel-01",
				shot: "wide",
				characters: [],
				action: "a",
				dialogue: [],
				image: { status: "done", file: "pages/page-001/panel-01.png" },
			},
		],
	});
	writeTinyPng(join(store.root, "pages", "page-001", "panel-01.png"));
	writeFileSync(
		join(store.root, "bible.json"),
		JSON.stringify({
			schemaVersion: 1,
			title: store.project.title,
			logline: "l",
			genre: [],
			tone: "",
			audience: "",
			art: { preset: "manga-bw", stylePrompt: "", letteringStyle: "", palette: [] },
			world: { locations: [] },
			cast: [
				{
					id: "lin",
					name: "林澈",
					role: "protagonist",
					canonical: "seventeen-year-old Chinese girl with black hair",
					outfits: { default: "navy blazer" },
					refSheet: "characters/lin/ref.png",
				},
			],
		}),
	);
	writeTinyPng(join(store.root, "characters", "lin", "ref.png"));
	store.refreshStats();
}

test("web server serves projects, page summaries and images read-only", async () => {
	const { cwd, store, config } = makeTestProject();
	seed(store);
	const port = await freePort();
	const handle = await startWebServer({ cwd, config, host: "127.0.0.1", port });
	try {
		assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+/);
		const index = await fetch(`${handle.url}/`);
		assert.equal(index.status, 200);
		assert.match(await index.text(), /mz_automanga/);

		const projects = await (await fetch(`${handle.url}/api/projects`)).json() as { projects: Array<{ slug: string }> };
		assert.equal(projects.projects.length, 1);
		assert.equal(projects.projects[0].slug, store.project.slug);

		const snapshot = await (await fetch(`${handle.url}/api/project?p=${store.project.slug}`)).json() as {
			pages: Array<{ id: string; panels: Array<{ file: string; status: string; version: number }> }>;
			characters: Array<{ id: string; name: string; file: string; version: number }>;
		};
		assert.equal(snapshot.pages.length, 1);
		assert.equal(snapshot.pages[0].panels[0].status, "done");
		assert.equal(snapshot.pages[0].panels[0].file, "pages/page-001/panel-01.png");
		assert.ok(snapshot.pages[0].panels[0].version > 0);
		assert.equal(snapshot.characters.length, 1);
		assert.equal(snapshot.characters[0].id, "lin");
		assert.ok(snapshot.characters[0].version > 0);

		// Chinese project slugs must be URL-encoded exactly once in both places.
		const media = await fetch(`${handle.url}${mediaPath(store.project.slug, snapshot.pages[0].panels[0].file)}`);
		assert.equal(media.status, 200);
		assert.equal(media.headers.get("content-type"), "image/png");
		assert.equal(media.headers.get("accept-ranges"), "bytes");

		const characterMedia = await fetch(`${handle.url}${mediaPath(store.project.slug, snapshot.characters[0].file)}`);
		assert.equal(characterMedia.status, 200);
		assert.equal(characterMedia.headers.get("content-type"), "image/png");

		const range = await fetch(`${handle.url}${mediaPath(store.project.slug, snapshot.pages[0].panels[0].file)}`, {
			headers: { Range: "bytes=0-3" },
		});
		assert.equal(range.status, 206);
		assert.equal((await range.arrayBuffer()).byteLength, 4);

		const traversal = await fetch(
			`${handle.url}/media/${encodeURIComponent(store.project.slug)}/%2e%2e%2fproject.json`,
		);
		assert.notEqual(traversal.status, 200);

		const post = await fetch(`${handle.url}/api/projects`, { method: "POST" });
		assert.equal(post.status, 405);
	} finally {
		await handle.close();
	}
});

test("legacy web token config migrates to the no-auth 0.0.0.0 default", () => {
	const legacy = structuredClone(DEFAULT_CONFIG) as typeof DEFAULT_CONFIG & { web: { token?: string } };
	legacy.web.host = "127.0.0.1";
	legacy.web.token = "auto";
	const normalized = normalizeConfig(legacy);
	assert.equal(normalized.web.host, "0.0.0.0");
	assert.equal("token" in normalized.web, false);
});

test("web defaults to 0.0.0.0, has no token, and rejects every mutation method", async () => {
	assert.equal(DEFAULT_WEB.host, "0.0.0.0");
	const { cwd, store, config } = makeTestProject();
	seed(store);
	let handle;
	try {
		const port = await freePort();
		handle = await startWebServer({ cwd, config, host: "0.0.0.0", port });
	} catch {
		return; // environment cannot bind 0.0.0.0; the config default is asserted above
	}
	try {
		const local = `http://127.0.0.1:${handle.port}`;
		assert.equal("token" in handle, false);
		assert.equal((await fetch(`${local}/api/projects`)).status, 200);
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
			const response = await fetch(`${local}/api/projects`, { method });
			assert.equal(response.status, 405, `${method} must be rejected`);
			assert.equal(response.headers.get("allow"), "GET, HEAD");
		}
		assert.equal(existsSync(join(cwd, ".automanga", "web-token.txt")), false);
	} finally {
		await handle.close();
	}
});

test("web media serves a compressed preview under 500 KB", async () => {
	const { cwd, store, config } = makeTestProject();
	const rel = "pages/page-001/panel-01.png";
	store.writePage({
		schemaVersion: 1,
		id: "page-001",
		index: 1,
		summary: "s",
		panels: [
			{
				id: "panel-01",
				shot: "wide",
				characters: [],
				action: "a",
				dialogue: [],
				image: { status: "done", file: rel },
			},
		],
	});
	writeNoisyPng(join(store.root, rel), 800, 1000);
	const sourceBytes = statSync(join(store.root, rel)).size;
	assert.ok(sourceBytes > 500_000);
	const batch = ensureProjectWebPreviews(store);
	assert.equal(batch.created, 1);
	const port = await freePort();
	const handle = await startWebServer({ cwd, config, host: "127.0.0.1", port });
	try {
		const response = await fetch(`${handle.url}${mediaPath(store.project.slug, rel)}`);
		assert.equal(response.status, 200);
		const body = Buffer.from(await response.arrayBuffer());
		assert.ok(body.byteLength <= 500_000, `served bytes=${body.byteLength}`);
		assert.ok(body.byteLength < sourceBytes);
	} finally {
		await handle.close();
	}
});

test("server refuses port 0 and busy ports instead of picking another port", async () => {
	const { cwd, store, config } = makeTestProject();
	seed(store);
	await assert.rejects(
		startWebServer({ cwd, config, host: "127.0.0.1", port: 0 }),
		/端口必须在 1–65535/,
	);
	const port = await freePort();
	const handle = await startWebServer({ cwd, config, host: "127.0.0.1", port });
	try {
		await assert.rejects(startWebServer({ cwd, config, host: "127.0.0.1", port }), /已被占用/);
	} finally {
		await handle.close();
	}
});

test("SSE sends a snapshot event on connect", async () => {
	const { cwd, store, config } = makeTestProject();
	seed(store);
	const port = await freePort();
	const handle = await startWebServer({ cwd, config, host: "127.0.0.1", port });
	const controller = new AbortController();
	try {
		const response = await fetch(`${handle.url}/api/events?p=${store.project.slug}`, { signal: controller.signal });
		assert.equal(response.status, 200);
		const reader = response.body?.getReader();
		assert.ok(reader);
		const decoder = new TextDecoder();
		let text = "";
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && !text.includes("event: snapshot")) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		assert.match(text, /event: snapshot/);
		assert.match(text, /page-001/);
	} finally {
		controller.abort();
		await handle.close();
	}
});
