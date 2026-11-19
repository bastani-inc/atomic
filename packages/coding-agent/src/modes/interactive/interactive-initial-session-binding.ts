import { onRequestedExtensionBindClose } from "../../core/agent-session-events.ts";
import { sessionQuitSignal } from "../../core/session-lifecycle-work.ts";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";
import { releaseStartupChatOutput } from "./interactive-startup-chat-container.ts";

/** Bind the eager startup session without letting the reusable runtime path append its disclosure. */
export async function bindInitialEagerSession(mode: InteractiveModeBase): Promise<"closed" | "bound"> {
	const session = mode.session;
	const quit = sessionQuitSignal(mode.runtimeHost);
	const cancelled = new WeakSet<Error>();
	const unsubscribe = onRequestedExtensionBindClose(session, (error) => {
		if (mode.isShuttingDown || quit.aborted) cancelled.add(error);
	});
	try {
		mode.initialStartupBinding = true;
		try {
			await mode.rebindCurrentSession();
		} catch (error) {
			if (!(error instanceof Error && cancelled.has(error))) throw error;
			if (mode.session === session) return "closed";
			// The replacement installed its own binding. Finish the startup display for it.
		} finally {
			unsubscribe();
			mode.initialStartupBinding = false;
		}
		mode.showLoadedResources({
			force: true,
			showDiagnosticsWhenQuiet: true,
			targetContainer: mode.resourceDisclosureContainer,
		});
		mode.showStartupNoticesIfNeeded(mode.startupNoticesContainer);
		// A suppressed derived `-fast` duplicate is a startup notice, so it renders here on the eager
		// path and again after deferred extension loading on the other branch of `run()`.
		mode.reportModelCatalogWarning(mode.startupNoticesContainer);
		return "bound";
	} finally {
		releaseStartupChatOutput(mode);
	}
}
