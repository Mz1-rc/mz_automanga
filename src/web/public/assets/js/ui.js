export const $ = (id) => document.getElementById(id);

export function setStatus(text) {
	const node = $("status");
	node.textContent = text || "";
	node.hidden = !text;
}

export function setProjectMeta(snapshot) {
	const count = (snapshot?.characters || []).length;
	$("tab-cast").textContent = count ? `人设 ${count}` : "人设";
}

export function setView(view) {
	const cast = view === "cast";
	$("pages-view").hidden = cast;
	$("cast-view").hidden = !cast;
	for (const tab of document.querySelectorAll(".tab")) {
		const active = tab.dataset.view === view;
		tab.classList.toggle("active", active);
		tab.setAttribute("aria-selected", String(active));
	}
}

export function showError(targetId, error) {
	const message = String(error?.message ?? error ?? "未知错误");
	const box = document.createElement("div");
	box.className = "error";
	box.textContent = message;
	$(targetId).replaceChildren(box);
	setStatus("");
}

export function showEmpty(targetId, message) {
	const box = document.createElement("div");
	box.className = "empty";
	box.textContent = message;
	$(targetId).replaceChildren(box);
	setStatus("");
}
