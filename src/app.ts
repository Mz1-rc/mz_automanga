import { loadGlobalConfig, projectConfig, type MangaConfig } from "./config.ts";
import { createProject, listProjects, ProjectStore, type ProjectSummary } from "./state.ts";
import type { StyleSelection } from "./types.ts";

export interface BackgroundJob {
	label: string;
	startedAt: number;
	controller: AbortController;
	done: boolean;
	error?: string;
}

export class MangaApp {
	active?: ProjectStore;
	readonly agentDir: string;
	currentJob?: BackgroundJob;
	currentAbort?: AbortController;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	baseConfig(): MangaConfig {
		return loadGlobalConfig(this.agentDir);
	}

	configFor(cwd: string, store: ProjectStore): MangaConfig {
		return projectConfig(cwd, store.project, this.baseConfig());
	}

	ensure(cwd: string, slug?: string): { store: ProjectStore; config: MangaConfig } {
		if (!this.active || (slug && this.active.project.slug !== slug)) {
			this.active = ProjectStore.load(cwd, this.baseConfig(), slug);
		}
		return { store: this.active, config: this.configFor(cwd, this.active) };
	}

	list(cwd: string): ProjectSummary[] {
		return listProjects(cwd, this.baseConfig());
	}

	create(cwd: string, input: { title?: string; style: StyleSelection; script: string }): { store: ProjectStore; config: MangaConfig } {
		const config = this.baseConfig();
		const store = createProject(cwd, { title: input.title, style: input.style, script: input.script, config });
		this.active = store;
		return { store, config: this.configFor(cwd, store) };
	}

	isBusy(): boolean {
		return Boolean(this.currentJob && !this.currentJob.done);
	}

	busyMessage(): string {
		const job = this.currentJob;
		if (!job || job.done) return "";
		const seconds = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
		return `后台任务运行中：${job.label}（已运行 ${seconds}s）。可使用 /manga status 查看，/manga abort 中止。`;
	}

	startJob(label: string, runner: (controller: AbortController) => Promise<void>): BackgroundJob {
		if (this.isBusy()) throw new Error(this.busyMessage());
		const controller = new AbortController();
		const job: BackgroundJob = { label, startedAt: Date.now(), controller, done: false };
		this.currentJob = job;
		this.currentAbort = controller;
		void (async () => {
			try {
				await runner(controller);
			} catch (error) {
				job.error = error instanceof Error ? error.message : String(error);
			} finally {
				job.done = true;
				if (this.currentJob === job) this.currentJob = undefined;
				if (this.currentAbort === controller) this.currentAbort = undefined;
			}
		})();
		return job;
	}

	abortCurrent(): boolean {
		if (!this.currentAbort) return false;
		this.currentAbort.abort();
		this.currentAbort = undefined;
		return true;
	}
}
