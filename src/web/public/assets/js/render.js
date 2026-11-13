import { pageTitle, roleLabel } from "./format.js";
import { mediaUrl } from "./media.js";
import { $, setProjectMeta, showEmpty } from "./ui.js";

function activate(card, alt, handler) {
	card.tabIndex = 0;
	card.setAttribute("role", "button");
	card.setAttribute("aria-label", alt);
	card.addEventListener("click", handler);
	card.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		handler();
	});
}

function renderCharacters(slug, characters, images, onImageClick) {
	const grid = $("cast-grid");
	grid.replaceChildren();
	if (!characters.length) {
		showEmpty("cast-grid", "尚无角色设定。运行 /manga cast --regen 生成人设图。");
		return;
	}
	for (const character of characters) {
		const card = document.createElement("figure");
		card.className = `cast-card ${character.version > 0 ? "" : "pending"}`;
		card.title = `${character.id} · ${character.name}`;
		if (character.version > 0) {
			const img = document.createElement("img");
			img.loading = "lazy";
			img.decoding = "async";
			img.draggable = false;
			img.alt = `${character.name}（${character.id}）人设图`;
			img.src = mediaUrl(slug, character.file, character.version);
			card.append(img);
			const index = images.length;
			images.push({ src: img.src, alt: img.alt });
			activate(card, img.alt, () => onImageClick(index));
		}
		const caption = document.createElement("figcaption");
		caption.textContent = `${character.name} · ${roleLabel(character.role)}`;
		card.append(caption);
		grid.append(card);
	}
}

export function render(snapshot, { onImageClick }) {
	setProjectMeta(snapshot);
	document.title = snapshot.title ? `${snapshot.title} · mz_automanga` : "mz_automanga";
	const grid = $("grid");
	grid.replaceChildren();
	if (snapshot.style?.ratio) {
		grid.style.setProperty("--panel-ratio", snapshot.style.ratio.replace(":", " / "));
	}
	const images = [];

	const pages = snapshot.pages || [];
	if (!pages.length) showEmpty("grid", "尚无分镜页面。运行 /manga next 推进流水线。");
	for (const page of pages) {
		const section = document.createElement("section");
		const title = document.createElement("h2");
		title.className = "page-title";
		title.textContent = pageTitle(page, snapshot);
		section.append(title);
		const panels = document.createElement("div");
		panels.className = "panels";

		for (const panel of page.panels || []) {
			const card = document.createElement("figure");
			card.className = `panel ${panel.status === "failed" ? "failed" : panel.version > 0 ? "" : "pending"}`;
			card.dataset.panel = panel.file;
			card.title = panel.id;
			if (panel.version > 0) {
				const img = document.createElement("img");
				img.loading = "lazy";
				img.decoding = "async";
				img.draggable = false;
				img.alt = `${page.id}/${panel.id}`;
				img.src = mediaUrl(snapshot.slug, panel.file, panel.version);
				card.append(img);
				const index = images.length;
				images.push({ src: img.src, alt: img.alt });
				activate(card, `查看 ${img.alt}`, () => onImageClick(index));
			}
			panels.append(card);
		}
		section.append(panels);
		grid.append(section);
	}

	renderCharacters(snapshot.slug, snapshot.characters || [], images, onImageClick);
	return images;
}
