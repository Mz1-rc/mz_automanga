/**
 * Style presets and deterministic style enforcement for image prompts.
 * Moved out of `config.ts` so the image module owns everything that affects
 * the pixels. `config.ts` re-exports these symbols for backwards compatibility.
 */
import type { StylePreset } from "../types.ts";
import type { ImageStyle } from "./types.ts";

export const LOCKED_TOKENS = [
	"no watermark",
	"no signature",
	"no text other than the specified lettering",
];

export const STYLE_PRESETS: Record<
	Exclude<StylePreset, "custom">,
	{ label: string; ratio: ImageStyle["ratio"]; prompt: string }
> = {
	"manga-bw": {
		label: "黑白漫画",
		ratio: "3:4",
		prompt:
			"modern seinen manga drawn strictly in black and white, pure monochrome ink lineart, screentone dot shading, high contrast, no color at all, no colored lighting, cinematic composition",
	},
	"manhua-color": {
		label: "全彩国漫",
		ratio: "3:4",
		prompt:
			"Chinese manhua, full color, cel shading, crisp outlines, vibrant but controlled palette",
	},
	webtoon: {
		label: "竖屏条漫",
		ratio: "9:16",
		prompt:
			"Korean webtoon style, full color, soft gradients, vertical composition, generous negative space",
	},
};

export const LETTERING_STYLE =
	"clean black comic lettering, rounded white speech bubbles with thin black outlines";

/**
 * Explicit color lock for monochrome presets. Image models often read
 * "seinen manga" as a color style, so every request repeats the color policy.
 */
export const MONOCHROME_LOCK =
	"COLOR LOCK: strict black-and-white monochrome artwork only — every surface, skin, hair, clothing, background and light is rendered in black, white and grey screentone; absolutely no color, no colored accents, no sepia, no blue or orange tint";

const MONOCHROME_NEGATIVE = [
	"color",
	"full color",
	"colored",
	"chromatic colors",
	"saturated colors",
	"colored lighting",
	"sepia",
	"blue tint",
	"orange tint",
];

export function isMonochromeStyle(style: Pick<ImageStyle, "preset">): boolean {
	return style.preset === "manga-bw";
}

export function styleBasePrompt(style: ImageStyle): string {
	const base = style.preset === "custom" ? (style.customPrompt ?? "").trim() : STYLE_PRESETS[style.preset as Exclude<StylePreset, "custom">]?.prompt ?? "";
	return base;
}

/**
 * The style block appended verbatim to every image prompt. Agents must copy it
 * without edits; validators check that the locked tokens are present.
 */
export function composeStylePrompt(style: ImageStyle): string {
	return [
		styleBasePrompt(style),
		isMonochromeStyle(style) ? MONOCHROME_LOCK : undefined,
		LETTERING_STYLE,
		`${style.lockedTokens.join(", ")}`,
	]
		.filter(Boolean)
		.join(", ");
}

/**
 * Code-level style enforcement. Agents are supposed to copy the style block,
 * but a missing or stale block must never silently produce a color image for a
 * black-and-white project. This appends the color lock and full style block
 * only when they are absent, so prompts sent to the provider always carry them.
 */
export function enforceStylePrompt(prompt: string, style: ImageStyle): string {
	const core = prompt.trim();
	if (!isMonochromeStyle(style)) return core;
	const lower = core.toLowerCase();
	const additions: string[] = [];
	if (!/black[\s-]*and[\s-]*white|monochrome|greyscale|grayscale/.test(lower)) {
		additions.push("RENDER IN STRICT BLACK AND WHITE (monochrome ink, grey screentone, no color)");
	}
	if (!lower.includes("no color")) {
		additions.push("convert every reference-sheet color to grey tone; no color anywhere in the image");
	}
	const styleBlock = composeStylePrompt(style);
	if (!lower.includes(styleBasePrompt(style).toLowerCase()) || !lower.includes("no text other than the specified lettering")) {
		additions.push(styleBlock);
	}
	if (additions.length === 0) return core;
	const separator = /[.!?。！？]$/.test(core) ? " " : ". ";
	return `${core}${separator}${additions.join(". ")}`;
}

/** Merge monochrome anti-color terms into the negative prompt. */
export function enforceStyleNegative(negative: string | undefined, style: ImageStyle): string | undefined {
	const core = (negative ?? "").trim();
	if (!isMonochromeStyle(style)) return core || undefined;
	const existing = new Set(core.toLowerCase().split(",").map((item) => item.trim()).filter(Boolean));
	const additions = MONOCHROME_NEGATIVE.filter((term) => !existing.has(term));
	const merged = [core, ...additions].filter(Boolean).join(", ");
	return merged || undefined;
}
