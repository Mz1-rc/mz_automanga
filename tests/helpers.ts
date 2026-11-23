import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { DEFAULT_CONFIG, type MangaConfig } from "../src/config.ts";
import { createProject, ProjectStore, type ProjectStore as Store } from "../src/state.ts";
import { makeStyle } from "../src/config.ts";
import { crc32Update } from "../src/util/stream.ts";
import type { PipelineUi } from "../src/pipeline.ts";
import type { RunStatus, RunUsage } from "../src/types.ts";

/** Reserve a concrete port for tests (startWebServer refuses port 0). */
export async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
	const address = server.address();
	const port = address && typeof address === "object" ? address.port : 0;
	await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	if (!port) throw new Error("无法分配测试端口");
	return port;
}

export function tempDir(prefix = "mz-auto-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function testConfig(overrides: Partial<MangaConfig> = {}): MangaConfig {
	return {
		...structuredClone(DEFAULT_CONFIG),
		...overrides,
		image: { ...DEFAULT_CONFIG.image, ...(overrides.image ?? {}) },
		agents: { ...DEFAULT_CONFIG.agents, ...(overrides.agents ?? {}) },
		web: { ...DEFAULT_CONFIG.web, ...(overrides.web ?? {}) },
		qa: { ...DEFAULT_CONFIG.qa, ...(overrides.qa ?? {}) },
		memory: { ...DEFAULT_CONFIG.memory, ...(overrides.memory ?? {}) },
		gates: { ...DEFAULT_CONFIG.gates, ...(overrides.gates ?? {}) },
		source: { ...DEFAULT_CONFIG.source, ...(overrides.source ?? {}) },
	};
}

export function makeTestProject(options: Partial<{ title: string; script: string; config: MangaConfig }> = {}): {
	cwd: string;
	store: Store;
	config: MangaConfig;
} {
	const cwd = tempDir();
	const config = options.config ?? testConfig();
	mkdirSync(cwd, { recursive: true });
	const store = createProject(cwd, {
		title: options.title ?? "测试漫画",
		style: makeStyle("manga-bw"),
		script: options.script ?? "# 第一页\n林澈在天台等一个人。",
		config,
	});
	return { cwd, store, config };
}

export function reloadStore(store: Store): Store {
	return ProjectStore.loadByPath(store.root);
}

function encodeRgbPng(raw: Buffer, width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer): Buffer => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length, 0);
		const typeBuf = Buffer.from(type, "ascii");
		const crcBuf = Buffer.alloc(4);
		crcBuf.writeUInt32BE(crc32Update(crc32Update(0, typeBuf), data), 0);
		return Buffer.concat([length, typeBuf, data, crcBuf]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Minimal valid PNG (RGB, no interlace). */
export function tinyPng(width = 8, height = 8): Buffer {
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width * 3 + 1);
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			const off = row + 1 + x * 3;
			raw[off] = 40 + x * 3;
			raw[off + 1] = 60 + y * 3;
			raw[off + 2] = 90;
		}
	}
	return encodeRgbPng(raw, width, height);
}

/** Larger, noisy PNG used to exercise <500 KB preview compression. */
export function noisyPng(width = 800, height = 1000, seed = 123456789): Buffer {
	const raw = Buffer.alloc((width * 3 + 1) * height);
	let state = seed >>> 0;
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return (state >>> 24) & 0xff;
	};
	for (let y = 0; y < height; y++) {
		const row = y * (width * 3 + 1);
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			const off = row + 1 + x * 3;
			raw[off] = next();
			raw[off + 1] = next();
			raw[off + 2] = next();
		}
	}
	return encodeRgbPng(raw, width, height);
}

export function writeTinyPng(path: string, width = 8, height = 8): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, tinyPng(width, height));
}

export function writeNoisyPng(path: string, width = 800, height = 1000): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, noisyPng(width, height));
}

export interface FakeUiState {
	status: RunStatus[];
	widget: string[][];
	notes: string[];
	answers: string[];
	usages: RunUsage[];
	selectHandler?: (title: string, options: string[]) => string | undefined;
}

export function fakeUi(state: Partial<FakeUiState> = {}): PipelineUi & { state: FakeUiState } {
	const merged: FakeUiState = {
		status: [],
		widget: [],
		notes: [],
		answers: [],
		usages: [],
		...state,
	};
	const ui: PipelineUi & { state: FakeUiState } = {
		state: merged,
		hasUI: false,
		async select(title, options) {
			return merged.selectHandler ? merged.selectHandler(title, options) : options[0];
		},
		async confirm() {
			return true;
		},
		async input() {
			return undefined;
		},
		async editor() {
			return undefined;
		},
		notify(message) {
			merged.notes.push(message);
		},
		updateStatus(_store, progress, usage) {
			if (progress) merged.status.push(progress);
			if (usage) merged.usages.push({ ...usage });
		},
	};
	return ui;
}
