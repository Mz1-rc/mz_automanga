/**
 * Public entry point of the image-generation module.
 *
 * Consumers should import from here (or from `imagegen/index.ts` in this repo):
 *
 * ```ts
 * import {
 *   createImageProvider,
 *   registerImageProvider,
 *   generatePanelImages,
 *   generateCharacterImages,
 *   regeneratePanel,
 *   type ImageProvider,
 *   type ImageGenWorkspace,
 * } from "./imagegen/index.ts";
 * ```
 */
export * from "./types.ts";
export * from "./errors.ts";
export * from "./style.ts";
export * from "./config.ts";
export * from "./references.ts";
export * from "./stages.ts";
export * from "./provider.ts";
export { AgnesClient, AgnesError, createAgnesProvider } from "./providers/agnes.ts";
export { ArkClient, ARK_MODELS, createArkProvider, DEFAULT_ARK_MODEL } from "./providers/ark.ts";
export type {
	AgnesClientOptions,
	AgnesReference,
	AgnesGenerateOptions,
	AgnesGenerateResult,
} from "./providers/agnes.ts";
export type { ArkClientOptions } from "./providers/ark.ts";
