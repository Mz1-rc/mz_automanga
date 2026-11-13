import type { ImageProvider, ImageProviderConfig, ImageProviderFactory } from "./types.ts";
import { ImageGenError } from "./errors.ts";
import { createAgnesProvider } from "./providers/agnes.ts";

/**
 * Provider registry. New image models can be added at runtime:
 *
 * ```ts
 * registerImageProvider("my-model", (config) => new MyProvider(config));
 * ```
 */
export class ImageProviderRegistry {
	private readonly factories = new Map<string, ImageProviderFactory>();

	register(id: string, factory: ImageProviderFactory): this {
		const key = id.trim().toLowerCase();
		if (!key) throw new ImageGenError("provider", "图像提供方 id 不能为空");
		this.factories.set(key, factory);
		return this;
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
imageProviders.register("agnes", createAgnesProvider);

/** Convenience wrapper around the global registry. */
export function createImageProvider(id: string, config: Omit<ImageProviderConfig, "id"> & { id?: string }): ImageProvider {
	return imageProviders.create(id, config);
}

export function registerImageProvider(id: string, factory: ImageProviderFactory): void {
	imageProviders.register(id, factory);
}
