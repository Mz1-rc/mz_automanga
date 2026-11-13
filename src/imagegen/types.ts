/**
 * Public contracts of the image-generation module.
 *
 * This folder is intentionally decoupled from the rest of the app:
 * - providers only know about prompts, references, files and HTTP;
 * - stages only know about a narrow `ImageGenWorkspace` port;
 * - style enforcement knows nothing about projects, state or the pipeline.
 *
 * Only the pure domain types in `../types.ts` are imported (no runtime deps).
 */
import type { Bible, MangaPage } from "../types.ts";

export type ImageSizeTier = "1K" | "2K" | "3K" | "4K";
export type ImageRatio = "1:1" | "3:4" | "2:3" | "4:3" | "16:9" | "9:16";
export type ImageFormat = "png" | "jpeg" | "unknown";

/** A reference image: prefer a provider URL, fall back to a local file. */
export interface ImageReference {
	/** Public URL returned by a previous generation. Preferred: no local read. */
	url?: string;
	/** Absolute local path. Converted to a data URI by providers that support it. */
	path?: string;
}

/** One image request, independent from any provider. */
export interface ImageGenerateRequest {
	prompt: string;
	negative?: string;
	size: ImageSizeTier;
	ratio?: ImageRatio;
	refs?: ImageReference[];
	/** Absolute output path; the provider must stream/copy the image here. */
	outPath: string;
	signal?: AbortSignal;
}

export interface ImageGenerateResult {
	file: string;
	sourceUrl?: string;
	width: number;
	height: number;
	bytes: number;
	attempts: number;
	size: ImageSizeTier;
	ratio?: ImageRatio;
	format: ImageFormat;
}

export interface ImageProviderTestResult {
	width: number;
	height: number;
	format: ImageFormat;
	file: string;
}

/** Runtime configuration handed to a provider factory. */
export interface ImageProviderConfig {
	readonly id: string;
	readonly model: string;
	readonly apiKey: string;
	readonly baseUrl?: string;
	readonly timeoutMs?: number;
	readonly retries?: number;
	readonly maxDownloadBytes?: number;
	readonly streamChunkBytes?: number;
	readonly fetchImpl?: typeof fetch;
	/** Provider-specific extras (kept generic on purpose). */
	readonly options?: Record<string, unknown>;
}

/**
 * A pluggable image model. Add a new model by implementing this interface and
 * registering a factory: `registerImageProvider("my-model", createMyProvider)`.
 */
export interface ImageProvider {
	readonly id: string;
	readonly model?: string;
	generate(request: ImageGenerateRequest): Promise<ImageGenerateResult>;
	/** Optional cheap connectivity/auth probe used by `/manga key --test`. */
	test?(signal?: AbortSignal): Promise<ImageProviderTestResult>;
	dispose?(): void | Promise<void>;
}

export type ImageProviderFactory = (config: ImageProviderConfig) => ImageProvider;

/** Image stage settings (a structural subset of the app `ImageConfig`). */
export interface ImageGenConfig {
	provider?: string;
	model: string;
	draftSize: ImageSizeTier;
	finalSize: ImageSizeTier;
	maxRefs: number;
	usePreviousPanel: boolean;
	keepVersions: number;
	timeoutMs: number;
	retries: number;
	maxDownloadBytes: number;
	streamChunkBytes: number;
}

/** Style data needed by the image module. `StyleSelection` is compatible. */
export interface ImageStyle {
	preset: string;
	label?: string;
	customPrompt?: string | null;
	ratio: ImageRatio;
	lockedTokens: string[];
}

/**
 * Storage/processing port used by the project-level stages.
 *
 * The app implements this over `ProjectStore`, `previews.ts` and
 * `png-grayscale.ts`. Tests can implement it with a plain object.
 */
export interface ImageGenWorkspace {
	readonly root: string;
	readonly style: ImageStyle;
	readBible(): Bible | undefined;
	listPageKeys(): string[];
	readPage(index: number): MangaPage | undefined;
	readPageByKey(key: string): MangaPage | undefined;
	writePage(page: MangaPage): void;
	touch(): void;
	refreshStats(): void;
	readText(rel: string): string | undefined;
	imageExists(rel: string): boolean;
	imageAbsPath(rel: string): string;
	/** Bump old versions (ref.v1.png …) and return the absolute target path. */
	prepareImage(rel: string, keepVersions: number): string;
	/** Post-process a freshly written image (monochrome lock, web preview). */
	afterImageWritten(rel: string): void;
	readSourceUrl(rel: string): string | undefined;
	writeSourceUrl(rel: string, url: string | undefined): void;
}

export interface ImageProgress {
	kind:
		| "panel-start"
		| "panel-done"
		| "panel-skip"
		| "panel-fail"
		| "char-start"
		| "char-done"
		| "char-skip"
		| "char-fail";
	label: string;
	index: number;
	total: number;
	error?: string;
}

export interface ImageStageOptions {
	workspace: ImageGenWorkspace;
	config: ImageGenConfig;
	provider: ImageProvider;
	signal?: AbortSignal;
	final?: boolean;
	force?: boolean;
	/** Regenerate only this cast id (character images stage). */
	onlyId?: string;
	onProgress?: (progress: ImageProgress) => void;
}
