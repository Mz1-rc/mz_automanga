import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportCbz } from "../src/export.ts";
import { makeTestProject, writeTinyPng } from "./helpers.ts";

test("exportCbz writes a store-only zip with page/panel entries", async () => {
	const { store } = makeTestProject();
	for (let n = 1; n <= 3; n++) {
		store.writePage({
			schemaVersion: 1,
			id: "page-001",
			index: 1,
			summary: "s",
			panels: Array.from({ length: 3 }, (_, index) => ({
				id: `panel-${String(index + 1).padStart(2, "0")}`,
				shot: "wide",
				characters: [],
				action: "a",
				dialogue: [],
				image: { status: "done" as const, file: `pages/page-001/panel-0${index + 1}.png` },
			})),
		});
		writeTinyPng(join(store.root, "pages", "page-001", `panel-${String(n).padStart(2, "0")}.png`), 8 + n, 8 + n);
	}
	const result = await exportCbz({ store, chunkBytes: 1024 });
	assert.equal(result.entries, 3);
	const data = readFileSync(result.file);
	assert.equal(data.subarray(0, 4).toString("binary"), "PK\u0003\u0004");
	for (let n = 1; n <= 3; n++) {
		const name = `page-001/panel-${String(n).padStart(2, "0")}.png`;
		assert.ok(data.includes(Buffer.from(name, "utf8")));
	}
	assert.equal(data.subarray(data.length - 22, data.length - 18).toString("binary"), "PK\u0005\u0006");
});

test("exportCbz refuses to export an empty project", async () => {
	const { store } = makeTestProject();
	await assert.rejects(exportCbz({ store, chunkBytes: 1024 }), /没有可导出的画面/);
});
