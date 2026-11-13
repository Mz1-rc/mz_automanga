async function getJson(url) {
	const response = await fetch(url, { credentials: "same-origin" });
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
	return response.json();
}

export function fetchProjects() {
	return getJson("/api/projects");
}

export function fetchProject(slug) {
	return getJson(`/api/project?p=${encodeURIComponent(slug)}`);
}

/** Subscribe to live snapshots. Returns a function that closes the stream. */
export function subscribeProject(slug, onSnapshot) {
	const events = new EventSource(`/api/events?p=${encodeURIComponent(slug)}`);
	const listener = (event) => {
		try {
			const snapshot = JSON.parse(event.data);
			onSnapshot(snapshot);
		} catch {
			// ignore malformed snapshots; the next revision will retry
		}
	};
	events.addEventListener("snapshot", listener);
	return () => {
		events.removeEventListener("snapshot", listener);
		events.close();
	};
}
