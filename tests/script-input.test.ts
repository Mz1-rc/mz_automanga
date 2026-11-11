import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isScriptTextFile, readScriptInput } from "../src/script-input.ts";
import { tempDir } from "./helpers.ts";

test("recognizes script text extensions and skips dotfiles", () => {
	assert.equal(isScriptTextFile("chapter-01.md"), true);
	assert.equal(isScriptTextFile("chapter-02.TXT"), true);
	assert.equal(isScriptTextFile("notes.json"), false);
	assert.equal(isScriptTextFile(".hidden.md"), false);
	assert.equal(isScriptTextFile("README"), false);
});

test("reads a single script file", () => {
	const dir = tempDir();
	const file = join(dir, "script.md");
	writeFileSync(file, "# 第一幕\n\n林澈站在天台。\n");
	const result = readScriptInput(file);
	assert.equal(result.fromDirectory, false);
	assert.equal(result.files.length, 1);
	assert.match(result.text, /林澈站在天台/);
});

test("merges a directory recursively in natural order and skips non-text files", () => {
	const dir = tempDir();
	mkdirSync(join(dir, "chapters", "act-2"), { recursive: true });
	mkdirSync(join(dir, "node_modules"), { recursive: true });
	mkdirSync(join(dir, ".git"), { recursive: true });
	writeFileSync(join(dir, "chapters", "ch1.md"), "# 第一章\n\n雨。\n");
	writeFileSync(join(dir, "chapters", "ch10.md"), "# 第十章\n\n晴。\n");
	writeFileSync(join(dir, "chapters", "ch2.md"), "# 第二章\n\n风。\n");
	writeFileSync(join(dir, "chapters", "act-2", "ch3.txt"), "# 第三章\n\n夜。\n");
	writeFileSync(join(dir, "notes.json"), "{\"ignored\":true}");
	writeFileSync(join(dir, "empty.md"), "   ");
	writeFileSync(join(dir, "node_modules", "x.md"), "ignored");
	writeFileSync(join(dir, ".git", "x.md"), "ignored");
	writeFileSync(join(dir, ".hidden.md"), "ignored");

	const result = readScriptInput(dir);
	assert.equal(result.fromDirectory, true);
	assert.deepEqual(result.files.map((file) => file.rel), [
		"chapters/act-2/ch3.txt",
		"chapters/ch1.md",
		"chapters/ch2.md",
		"chapters/ch10.md",
	]);
	assert.match(result.text, /# ===== chapters\/ch1\.md =====/);
	assert.match(result.text, /第一章/);
	assert.match(result.text, /第十章/);
	assert.doesNotMatch(result.text, /ignored/);
});

test("directory input rejects empty directories and oversized content", () => {
	const dir = tempDir();
	mkdirSync(join(dir, "empty"), { recursive: true });
	assert.throws(() => readScriptInput(join(dir, "empty")), /没有可读取的文本文件/);

	const big = tempDir();
	writeFileSync(join(big, "a.md"), "x".repeat(200));
	assert.throws(() => readScriptInput(big, { maxBytes: 50 }), /内容过大/);
});

test("missing path is reported clearly", () => {
	const dir = tempDir();
	assert.throws(() => readScriptInput(join(dir, "nope.md")), /找不到剧本路径/);
});
