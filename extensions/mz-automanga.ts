import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stopWebServer } from "../src/actions.ts";
import { MangaApp } from "../src/app.ts";
import { registerMangaCommand } from "../src/commands.ts";
import { registerMangaTool } from "../src/tools.ts";
import { clearStatus, updateStatus } from "../src/ui.ts";

/**
 * mz_automanga — multi-agent manga production pipeline.
 *
 * The main session is the coordinator. Each role runs in its own nested,
 * in-memory AgentSession, one at a time, and writes only its declared
 * artifacts through `save_artifact`. Image generation runs in the host process,
 * strictly serial, streaming each image to disk. The web preview is read-only
 * and serves only the generated images.
 */
export default function mzAutomangaExtension(pi: ExtensionAPI): void {
	const app = new MangaApp(getAgentDir());

	registerMangaCommand(pi, app);
	registerMangaTool(pi, app);

	const refresh = (ctx: any) => {
		try {
			const { store } = app.ensure(ctx.cwd);
			updateStatus(ctx, store);
		} catch {
			// No project yet is a normal first-run state.
		}
	};

	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("session_tree", async (_event, ctx) => refresh(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		app.abortCurrent();
		await stopWebServer();
		try {
			app.active?.releaseLock();
		} catch {
			// ignore
		}
		try {
			clearStatus(ctx);
		} catch {
			// ignore
		}
	});
}
