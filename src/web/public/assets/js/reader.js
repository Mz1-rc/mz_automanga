import { $ } from "./ui.js";

/**
 * Fullscreen reader with keyboard navigation and horizontal swipe on touch.
 * The image list is supplied by the caller so snapshots can refresh in place.
 */
export function createReader(getImages) {
	const root = $("reader");
	const image = $("reader-image");
	const counter = $("reader-counter");
	let index = 0;
	let lastFocus = null;
	let startX = 0;
	let startY = 0;
	let tracking = false;
	let suppressClick = false;

	const isOpen = () => !root.hidden;

	function update() {
		const images = getImages();
		if (!images.length) {
			close();
			return;
		}
		index = Math.max(0, Math.min(index, images.length - 1));
		const item = images[index];
		image.src = item.src;
		image.alt = item.alt;
		counter.textContent = `${index + 1} / ${images.length}`;
	}

	function open(nextIndex) {
		const images = getImages();
		if (!images.length) return;
		index = Math.max(0, Math.min(nextIndex, images.length - 1));
		if (!isOpen()) {
			lastFocus = document.activeElement;
			document.body.classList.add("reader-open");
			root.hidden = false;
		}
		update();
		$("close").focus({ preventScroll: true });
	}

	function close() {
		if (!isOpen()) return;
		root.hidden = true;
		document.body.classList.remove("reader-open");
		image.removeAttribute("src");
		image.alt = "";
		if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true });
	}

	function step(delta) {
		if (!isOpen()) return;
		open(index + delta);
	}

	function currentIndex() {
		return index;
	}

	$("prev").addEventListener("click", () => step(-1));
	$("next").addEventListener("click", () => step(1));
	$("close").addEventListener("click", close);
	root.addEventListener("click", (event) => {
		if (suppressClick) return;
		if (event.target === root) close();
	});

	root.addEventListener(
		"pointerdown",
		(event) => {
			if (event.target.closest("button")) return;
			if (event.pointerType === "mouse" && event.button !== 0) return;
			tracking = true;
			startX = event.clientX;
			startY = event.clientY;
		},
		{ passive: true },
	);
	root.addEventListener(
		"pointerup",
		(event) => {
			if (!tracking) return;
			tracking = false;
			const dx = event.clientX - startX;
			const dy = event.clientY - startY;
			if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
			suppressClick = true;
			window.setTimeout(() => {
				suppressClick = false;
			}, 0);
			step(dx < 0 ? 1 : -1);
		},
		{ passive: true },
	);
	root.addEventListener("pointercancel", () => {
		tracking = false;
	});

	window.addEventListener("keydown", (event) => {
		if (!isOpen()) return;
		if (event.key === "Escape") close();
		if (event.key === "ArrowLeft") step(-1);
		if (event.key === "ArrowRight") step(1);
	});

	return { open, close, step, isOpen, index: currentIndex };
}
