/** Build a media URL that survives Chinese project slugs and file names. */
export function mediaUrl(slug, file, version) {
	const encoded = String(file)
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
	return `/media/${encodeURIComponent(slug)}/${encoded}?v=${encodeURIComponent(version)}`;
}
