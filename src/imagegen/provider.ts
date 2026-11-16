import type { ImageModelOption, ImageProvider, ImageProviderConfig, ImageProviderFactory } from "./types.ts";
import { ImageGenError } from "./errors.ts";
import { createAgnesProvider } from "./providers/agnes.ts";
import { ARK_MODELS, createArkProvider, DEFAULT_ARK_MODEL } from "./providers/ark.ts";

/**
 * Provider registry. New image models can be added at runtime:
 *
 * ```ts
 * registerImageProvider("my-model", (config) => new MyProvider(config));
 * ```
 */
export class ImageProviderRegistry {
	private readonly factories = new Map<string, ImageProviderFactory>();
	private readonly defaults = new Map<string, string>();
	private readonly options = new Map<string, ImageModelOption[]>();

	register(id: string, factory: ImageProviderFactory, defaultModel?: string, models?: ImageModelOption[]): this {
		const key = id.trim().toLowerCase();
		if (!key) throw new ImageGenError("provider", "图像提供方 id 不能为空");
		this.factories.set(key, factory);
		if (defaultModel) this.defaults.set(key, defaultModel);
		const list = models?.length ? models : defaultModel ? [{ id: defaultModel }] : [];
		if (list.length > 0) this.options.set(key, list.map((model) => ({ ...model })));
		else this.options.delete(key);
		return this;
	}

	defaultModel(id: string): string | undefined {
		return this.defaults.get(id.trim().toLowerCase());
	}

	/** Selectable models for a provider (used by `/manga provider`). */
	models(id: string): ImageModelOption[] {
		return (this.options.get(id.trim().toLowerCase()) ?? []).map((model) => ({ ...model }));
	}

	has(id: string): boolean {
		return this.factories.has(id.trim().toLowerCase());
	}

	list(): string[] {
		return [...this.factories.keys()].sort();
	}

	create(id: string, config: Omit<ImageProviderConfig, "id"> & { id?: string }): ImageProvider {
		const key = (id || "agnes").trim().toLowerCase();
		const factory = this.factories.get(key);
		if (!factory) {
			throw new ImageGenError(
				"provider",
				`未知图像提供方：${key}（可用：${this.list().join(", ") || "无"}）。请在 image.provider 中选择，或用 registerImageProvider 注册。`,
			);
		}
		return factory({ ...config, id: key });
	}
}

export const imageProviders = new ImageProviderRegistry();

// Built-in providers. Keep additions here (or register at runtime).
imageProviders.register("agnes", createAgnesProvider, "agnes-image-2.5-flash");
imageProviders.register("ark", createArkProvider, DEFAULT_ARK_MODEL, ARK_MODELS);

/** Convenience wrapper around the global registry. */
export function createImageProvider(id: string, config: Omit<ImageProviderConfig, "id"> & { id?: string }): ImageProvider {
	return imageProviders.create(id, config);
}

export function registerImageProvider(
	id: string,
	factory: ImageProviderFactory,
	defaultModel?: string,
	models?: ImageModelOption[],
): void {
	imageProviders.register(id, factory, defaultModel, models);
}
