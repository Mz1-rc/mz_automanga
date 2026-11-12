const state = {
	slug: undefined,
	snapshot: undefined,
	events: undefined,
	images: [],
	readerIndex: 0,
};

const $ = (id) => document.getElementById(id);

/** Build a media URL that survives Chinese project slugs and file names. */
function mediaUrl(file, version) {
	const encoded = String(file)
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
	return `/media/${encodeURIComponent(state.slug)}/${encoded}?v=${version}`;
}

function params() {
	return new URLSearchParams(location.search);
}

async function json(url) {
	const response = await fetch(url, { credentials: "same-origin" });
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
	return response.json();
}

const PHASE_LABELS = {
	idle: "未开始",
	script_analysis: "剧本分析",
	script_gate: "剧本确认",
	design: "企划",
	cast: "角色设计",
	character_images: "角色立绘",
	cast_gate: "角色确认",
	storyboard: "分镜",
	storyboard_gate: "分镜确认",
	prompts: "提示词",
	image_gen: "出图中",
	qa: "审校",
	repair: "修复",
	build: "导出",
	final_gate: "成品确认",
	done: "完成",
	paused: "已暂停",
	error: "出错",
};

function statusText(snapshot) {
	if (!snapshot) return "";
	const stats = snapshot.stats || {};
	const characters = snapshot.characters || [];
	const phase = PHASE_LABELS[snapshot.phase] || snapshot.phase;
	const cast = characters.length ? ` · 角色 ${characters.filter((item) => item.version > 0).length}/${characters.length}` : "";
	return `${phase} · 页 ${stats.pages ?? 0} · 图 ${stats.images ?? 0}/${stats.panels ?? 0}${cast}`;
}

function render(snapshot) {
	state.snapshot = snapshot;
	$("status").textContent = statusText(snapshot);
	setProjectMeta(snapshot);
	const grid = $("grid");
	grid.replaceChildren();
	if (snapshot.style && snapshot.style.ratio) {
		grid.style.setProperty("--panel-ratio", snapshot.style.ratio.replace(":", " / "));
	}
	state.images = [];

	for (const page of snapshot.pages || []) {
		const section = document.createElement("section");
		const title = document.createElement("h2");
		title.className = "page-title";
		title.textContent = `${page.id} · ${(snapshot.title && page.index === 1) ? snapshot.title : ""}`.trim();
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
				img.alt = `${page.id}/${panel.id}`;
				img.src = mediaUrl(panel.file, panel.version);
				card.append(img);
				const index = state.images.length;
				state.images.push({ src: img.src, alt: img.alt });
				card.addEventListener("click", () => openReader(index));
			}
			panels.append(card);
		}
		section.append(panels);
		grid.append(section);
	}

	renderCharacters(snapshot.characters || []);
}

function renderCharacters(characters) {
	const grid = $("cast-grid");
	grid.replaceChildren();
	if (!characters.length) {
		grid.innerHTML = '<div class="error">尚无角色设定。运行 /manga cast --regen 生成人设图。</div>';
		return;
	}
	const roleLabels = { protagonist: "主角", antagonist: "反派", supporting: "配角" };
	for (const character of characters) {
		const card = document.createElement("figure");
		card.className = `cast-card ${character.version > 0 ? "" : "pending"}`;
		card.title = `${character.id} · ${character.name}`;
		if (character.version > 0) {
			const img = document.createElement("img");
			img.loading = "lazy";
			img.alt = `${character.name}（${character.id}）人设图`;
			img.src = mediaUrl(character.file, character.version);
			card.append(img);
			const index = state.images.length;
			state.images.push({ src: img.src, alt: img.alt });
			card.addEventListener("click", () => openReader(index));
		}
		const caption = document.createElement("figcaption");
		caption.textContent = `${character.name} · ${roleLabels[character.role] || character.role || "角色"}`;
		card.append(caption);
		grid.append(card);
	}
}

function showView(view) {
	const pages = view !== "cast";
	$("pages-view").hidden = !pages;
	$("cast-view").hidden = pages;
	$("tab-pages").classList.toggle("active", pages);
	$("tab-cast").classList.toggle("active", !pages);
}

function setProjectMeta(snapshot) {
	$("tab-cast").textContent = snapshot && (snapshot.characters || []).length ? `人设 ${snapshot.characters.length}` : "人设";
}

async function loadProject(slug) {
	state.slug = slug;
	const snapshot = await json(`/api/project?p=${encodeURIComponent(slug)}`);
	render(snapshot);
	subscribe(slug);
	const url = new URL(location.href);
	url.searchParams.set("p", slug);
	history.replaceState(null, "", url);
}

function subscribe(slug) {
	if (state.events) state.events.close();
	const events = new EventSource(`/api/events?p=${encodeURIComponent(slug)}`);
	state.events = events;
	events.addEventListener("snapshot", (event) => {
		try {
			const snapshot = JSON.parse(event.data);
			if (snapshot.slug === state.slug) render(snapshot);
		} catch {
			// ignore malformed snapshots
		}
	});
}

function openReader(index) {
	if (!state.images.length) return;
	state.readerIndex = Math.max(0, Math.min(index, state.images.length - 1));
	const image = state.images[state.readerIndex];
	$("reader-image").src = image.src;
	$("reader-image").alt = image.alt;
	$("reader").hidden = false;
}

function closeReader() {
	$("reader").hidden = true;
}

function step(delta) {
	if ($("reader").hidden) return;
	openReader(state.readerIndex + delta);
}

async function boot() {
	try {
		const { projects } = await json("/api/projects");
		const select = $("project");
		select.replaceChildren();
		for (const project of projects || []) {
			const option = document.createElement("option");
			option.value = project.slug;
			option.textContent = `${project.title}（${project.images}/${project.panels}）`;
			select.append(option);
		}
		if (!projects || projects.length === 0) {
			$("grid").innerHTML = '<div class="error">还没有漫画项目。先在 pi 中运行 /manga init。</div>';
			$("status").textContent = "";
			return;
		}
		select.addEventListener("change", () => {
			const slug = select.value;
			localStorage.setItem("mz_automanga_slug", slug);
			loadProject(slug).catch(showError);
		});
		const wanted = params().get("p") || localStorage.getItem("mz_automanga_slug");
		const slug = projects.some((project) => project.slug === wanted) ? wanted : projects[0].slug;
		select.value = slug;
		await loadProject(slug);
	} catch (error) {
		showError(error);
	}
}

function showError(error) {
	$("grid").innerHTML = `<div class="error">${String(error && error.message ? error.message : error)}</div>`;
	$("status").textContent = "";
}

$("tab-pages").addEventListener("click", () => showView("pages"));
$("tab-cast").addEventListener("click", () => showView("cast"));
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
$("close").addEventListener("click", closeReader);
$("reader").addEventListener("click", (event) => {
	if (event.target === $("reader")) closeReader();
});
window.addEventListener("keydown", (event) => {
	if (event.key === "Escape") closeReader();
	if (event.key === "ArrowLeft") step(-1);
	if (event.key === "ArrowRight") step(1);
});

boot();
