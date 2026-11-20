/**
 * The only bridge between the image module and the rest of the app.
 *
 * It implements the narrow `ImageGenWorkspace` port with `ProjectStore`,
 * `previews.ts` and `png-grayscale.ts`, and maps `MangaConfig` to a generic
 * provider config. Everything inside `src/imagegen/` stays independent from
 * these modules.
 */
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { MangaConfig } from "./config.ts";
import { createImageProvider, imageProviders, type ImageProvider, type ImageProviderConfig, type ImageGenWorkspace } from "./imagegen/index.ts";
import { ensureDir, panelRelPath, readText, resolveWithin, writeAtomic } from "./paths.ts";
import { ensureWebPreview } from "./previews.ts";
import type { ProjectStore } from "./state.ts";
import { toMonochromePng } from "./util/png-grayscale.ts";
import { isMonochromeStyle } from "./imagegen/style.ts";

/** Sidecar path for any image extension, not just PNG. */
function sourceUrlPath(imageRel: string): string {
	const slash = Math.max(imageRel.lastIndexOf("/"), imageRel.lastIndexOf("\\"));
	const dot = imageRel.lastIndexOf(".");
	if (dot <= slash) return `${imageRel}.source-url.txt`;
	return `${imageRel.slice(0, dot)}.source-url.txt`;
}

/** Keep at most `keepVersions` previous images: ref.png → ref.v1.png → … */
function bumpVersion(path: string, keepVersions: number): void {
	if (!existsSync(path) || keepVersions <= 0) return;
	const ext = extname(path);
	const stem = ext ? path.slice(0, -ext.length) : path;
	const versionPath = (n: number) => `${stem}.v${n}${ext}`;
	for (let n = keepVersions; n >= 1; n--) {
		const target = versionPath(n);
		const source = n === 1 ? path : versionPath(n - 1);
		if (existsSync(source)) {
			try {
				renameSync(source, target);
			} catch {
				// ignore versioning failures
			}
		}
	}
}

class ProjectImageWorkspace implements ImageGenWorkspace {
	private readonly store: ProjectStore;

	constructor(store: ProjectStore) {
		this.store = store;
	}

	get root(): string {
		return this.store.root;
	}

	get style() {
		return this.store.project.style;
	}

	readBible() {
		return this.store.readBible();
	}

	listPageKeys(): string[] {
		return this.store.listPageKeys();
	}

	readPage(index: number) {
		return this.store.readPage(index);
	}

	readPageByKey(key: string) {
		return this.store.readPageByKey(key);
	}

	writePage(page: Parameters<ProjectStore["writePage"]>[0]): void {
		this.store.writePage(page);
	}

	touch(): void {
		this.store.touch();
	}

	refreshStats(): void {
		this.store.refreshStats();
	}

	readText(rel: string): string | undefined {
		return readText(resolveWithin(this.store.root, rel));
	}

	imageExists(rel: string): boolean {
		return existsSync(resolveWithin(this.store.root, rel));
	}

	imageAbsPath(rel: string): string {
		return resolveWithin(this.store.root, rel);
	}

	prepareImage(rel: string, keepVersions: number): string {
		const abs = resolveWithin(this.store.root, rel);
		bumpVersion(abs, keepVersions);
		ensureDir(dirname(abs));
		return abs;
	}

	afterImageWritten(rel: string): void {
		const abs = resolveWithin(this.store.root, rel);
		if (/\.png$/i.test(rel) && isMonochromeStyle(this.store.project.style)) toMonochromePng(abs);
		ensureWebPreview(this.store.root, rel);
	}

	ensurePreview(rel: string): void {
		ensureWebPreview(this.store.root, rel);
	}

	readSourceUrl(rel: string): string | undefined {
		const text = readText(resolveWithin(this.store.root, sourceUrlPath(rel)))?.trim();
		return text && /^https?:\/\//i.test(text) ? text : undefined;
	}

	writeSourceUrl(rel: string, url: string | undefined): void {
		const path = resolveWithin(this.store.root, sourceUrlPath(rel));
		if (!url) {
			try {
				unlinkSync(path);
			} catch {
				// no stale source URL
			}
			return;
		}
		writeAtomic(path, `${url}\n`);
	}
}

export function createProjectImageWorkspace(store: ProjectStore): ImageGenWorkspace {
	return new ProjectImageWorkspace(store);
}

/**
 * Map app config to the generic provider config.
 *
 * `image.provider` selects a registered provider (default `agnes`).
 * Provider-specific values can live in `image.providerOptions`; Agnes keeps
 * reading its legacy top-level `agnes` block as the fallback.
 */
function isAnotherProvidersDefault(config: MangaConfig, providerId: string, model: string): boolean {
	return Object.entries(config.providers ?? {}).some(
		([id, settings]) => id !== providerId && Boolean(settings.model) && settings.model === model,
	);
}

export function createProviderFromConfig(
	config: MangaConfig,
	apiKey: string,
	overrides: Omit<Partial<ImageProviderConfig>, "id"> = {},
	target: { provider?: string; model?: string } = {},
): ImageProvider {
	const options = config.image.providerOptions ?? {};
	const providerId = (target.provider || config.image.provider || "agnes").trim().toLowerCase();
	const settings = config.providers?.[providerId];
	const isCurrent = providerId === (config.image.provider || "agnes").trim().toLowerCase();
	const baseUrl =
		typeof options.baseUrl === "string" && options.baseUrl.trim()
			? options.baseUrl
			: settings?.baseUrl || (providerId === "agnes" ? config.agnes.baseUrl : undefined);
	const configuredModel = isCurrent && !isAnotherProvidersDefault(config, providerId, config.image.model) ? config.image.model : undefined;
	const model =
		target.model ||
		configuredModel ||
		settings?.model ||
		imageProviders.defaultModel(providerId) ||
		config.image.model ||
		config.agnes.model;
	return createImageProvider(providerId, {
		model,
		baseUrl,
		apiKey,
		timeoutMs: config.image.timeoutMs,
		retries: config.image.retries,
		maxDownloadBytes: config.image.maxDownloadBytes,
		streamChunkBytes: config.image.streamChunkBytes,
		options,
		...overrides,
	});
}

export { panelRelPath };
