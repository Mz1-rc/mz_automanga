/** Provider-independent image error. Providers should throw this (or a subclass). */
export class ImageGenError extends Error {
	readonly code: string;
	readonly status?: number;
	readonly detail?: string;

	constructor(code: string, message: string, options: { status?: number; detail?: string } = {}) {
		super(message);
		this.name = "ImageGenError";
		this.code = code;
		this.status = options.status;
		this.detail = options.detail;
	}
}
