/** Defaults and normalization for the image module. No imports from app runtime. */
import type { ImageConfig } from "../types.ts";
import type { ImageGenConfig } from "./types.ts";

export const DEFAULT_IMAGE: ImageConfig = {
	provider: "agnes",
	providerOptions: {},
	model: "agnes-image-2.5-flash",
	draftSize: "1K",
	finalSize: "2K",
	maxRefs: 4,
	usePreviousPanel: true,
	keepVersions: 2,
	timeoutMs: 240000,
	retries: 3,
	maxDownloadBytes: 32 * 1024 * 1024,
	streamChunkBytes: 64 * 1024,
};

function clamp(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.round(n)));
}

/** Clamp image settings. Called from the app config normalization. */
export function normalizeImageConfig(image: ImageConfig): ImageConfig {
	image.provider = typeof image.provider === "string" && image.provider.trim() ? image.provider.trim() : "agnes";
	image.providerOptions =
		image.providerOptions && typeof image.providerOptions === "object" && !Array.isArray(image.providerOptions)
			? image.providerOptions
			: {};
	image.maxRefs = clamp(image.maxRefs, 4, 0, 8);
	image.keepVersions = clamp(image.keepVersions, 2, 0, 10);
	image.timeoutMs = clamp(image.timeoutMs, 240000, 60000, 360000);
	image.retries = clamp(image.retries, 3, 0, 6);
	image.maxDownloadBytes = clamp(image.maxDownloadBytes, 32 * 1024 * 1024, 1024 * 1024, 128 * 1024 * 1024);
	image.streamChunkBytes = clamp(image.streamChunkBytes, 64 * 1024, 16 * 1024, 1024 * 1024);
	return image;
}

/** Narrow the app config down to the provider-facing shape. */
export function toImageGenConfig(image: ImageConfig): ImageGenConfig {
	return {
		provider: image.provider,
		model: image.model,
		draftSize: image.draftSize,
		finalSize: image.finalSize,
		maxRefs: image.maxRefs,
		usePreviousPanel: image.usePreviousPanel,
		keepVersions: image.keepVersions,
		timeoutMs: image.timeoutMs,
		retries: image.retries,
		maxDownloadBytes: image.maxDownloadBytes,
		streamChunkBytes: image.streamChunkBytes,
	};
}
