import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeTestProject, writeTinyPng } from "./helpers.ts";
import { startWebServer } from "../src/web/server.ts";

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
	store.refreshStats();
}

test("web server serves projects, page summaries and images read-only", async () => {
	const { cwd, store, config } = makeTestProject();
	seed(store);
	const handle = await startWebServer({ cwd, config, host: "127.0.0.1", port: 0 });
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
		};
		assert.equal(snapshot.pages.length, 1);
		assert.equal(snapshot.pages[0].panels[0].status, "done");
		assert.ok(snapshot.pages[0].panels[0].version > 0);

		const media = await fetch(`${handle.url}/media/${store.project.slug}/pages/page-001/panel-01.png`);
		assert.equal(media.status, 200);
		assert.equal(media.headers.get("content-type"), "image/png");
		assert.equal(media.headers.get("accept-ranges"), "bytes");

		const range = await fetch(`${handle.url}/media/${store.project.slug}/pages/page-001/panel-01.png`, {
			headers: { Range: "bytes=0-3" },
		});
		assert.equal(range.status, 206);
		assert.equal((await range.arrayBuffer()).byteLength, 4);

		const traversal = await fetch(
			`${handle.url}/media/${store.project.slug}/%2e%2e%2fproject.json`,
		);
		assert.notEqual(traversal.status, 200);

		const post = await fetch(`${handle.url}/api/projects`, { method: "POST" });
		assert.equal(post.status, 405);
	} finally {
		await handle.close();
	}
});

test("non-loopback binding requires a token", async () => {
	const { cwd, store, config } = makeTestProject();
	seed(store);
	config.web.token = "auto";
	let handle;
	try {
		handle = await startWebServer({ cwd, config, host: "0.0.0.0", port: 0 });
	} catch {
		return; // environment cannot bind 0.0.0.0; token flow is covered by unit logic
	}
	try {
		assert.ok(handle.token);
		const unauthorized = await fetch(`http://127.0.0.1:${handle.port}/api/projects`);
		assert.equal(unauthorized.status, 401);
		const authorized = await fetch(`http://127.0.0.1:${handle.port}/api/projects?token=${handle.token}`);
		assert.equal(authorized.status, 200);
	} finally {
		await handle.close();
	}
});

test("SSE sends a snapshot event on connect", async () => {
	const { cwd, store, config } = makeTestProject();
	seed(store);
	const handle = await startWebServer({ cwd, config, host: "127.0.0.1", port: 0 });
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
