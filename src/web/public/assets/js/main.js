import { fetchProject, fetchProjects, subscribeProject } from "./api.js";
import { statusText } from "./format.js";
import { createReader } from "./reader.js";
import { render } from "./render.js";
import { $, setStatus, setView, showEmpty, showError } from "./ui.js";

const SLUG_KEY = "mz_automanga_slug";
const VIEW_KEY = "mz_automanga_view";

function readStorage(key) {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key, value) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// private mode / storage disabled: URL state still works
	}
}

const state = {
	slug: undefined,
	images: [],
	closeEvents: undefined,
};

const reader = createReader(() => state.images);

function apply(snapshot) {
	const wasOpen = reader.isOpen();
	const previousIndex = reader.index();
	state.images = render(snapshot, { onImageClick: reader.open });
	setStatus(statusText(snapshot));
	if (wasOpen) reader.open(previousIndex);
}

async function loadProject(slug) {
	if (state.closeEvents) state.closeEvents();
	state.slug = slug;
	reader.close();
	const snapshot = await fetchProject(slug);
	if (snapshot.slug !== state.slug) return;
	apply(snapshot);
	state.closeEvents = subscribeProject(slug, (next) => {
		if (next.slug === state.slug) apply(next);
	});
	const url = new URL(location.href);
	url.searchParams.set("p", slug);
	history.replaceState(null, "", url);
}

function wantsSlug(projects) {
	const wanted = new URLSearchParams(location.search).get("p") || readStorage(SLUG_KEY);
	return projects.some((project) => project.slug === wanted) ? wanted : projects[0].slug;
}

function bindTabs() {
	for (const tab of document.querySelectorAll(".tab")) {
		tab.addEventListener("click", () => {
			const view = tab.dataset.view === "cast" ? "cast" : "pages";
			setView(view);
			writeStorage(VIEW_KEY, view);
		});
	}
}

async function boot() {
	bindTabs();
	setView(readStorage(VIEW_KEY) === "cast" ? "cast" : "pages");
	try {
		const { projects } = await fetchProjects();
		const select = $("project");
		select.replaceChildren();
		if (!projects || projects.length === 0) {
			showEmpty("grid", "还没有漫画项目。先在 pi 中运行 /manga init。");
			return;
		}
		for (const project of projects) {
			const option = document.createElement("option");
			option.value = project.slug;
			option.textContent = `${project.title}（${project.images}/${project.panels}）`;
			select.append(option);
		}
		select.addEventListener("change", () => {
			const slug = select.value;
			writeStorage(SLUG_KEY, slug);
			loadProject(slug)
				.then(() => window.scrollTo({ top: 0, behavior: "smooth" }))
				.catch((error) => showError("grid", error));
		});
		const slug = wantsSlug(projects);
		select.value = slug;
		await loadProject(slug);
	} catch (error) {
		showError("grid", error);
	}
}

boot();
