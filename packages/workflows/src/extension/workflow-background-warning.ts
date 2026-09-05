import type { ExtensionAPI, PiCommandContext } from "./public-types.js";

/** Background failures must never write over an interactive host's terminal. */
export function createWorkflowBackgroundWarningReporter(pi: Pick<ExtensionAPI, "on">): (message: string) => void {
	let context: PiCommandContext | undefined;
	const pending = new Set<string>();
	const reported = new Set<string>();
	const report = (message: string): void => {
		if (reported.has(message)) return;
		// Extension registration precedes session_start. Wait for the host mode,
		// rather than treating the engine child's non-TTY stdout as headless.
		if (context === undefined && pi.on !== undefined) {
			pending.add(message);
			return;
		}
		reported.add(message);
		if (context?.hasUI !== false && typeof context?.ui?.notify === "function") {
			try {
				context.ui.notify(message, "warning");
			} catch {
				// A broken UI sink does not authorize writing to its terminal transport.
			}
			return;
		}
		if (context?.hasUI === true) return;
		console.warn(message);
	};
	pi.on?.("session_start", (_event, ctx) => {
		context = ctx;
		for (const message of pending) report(message);
		if (ctx !== undefined) pending.clear();
	});
	return report;
}
