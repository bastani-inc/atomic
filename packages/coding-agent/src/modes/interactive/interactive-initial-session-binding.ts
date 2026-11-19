import { isAgentSessionClosed } from "../../core/agent-session-events.ts";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";
import { releaseStartupChatOutput } from "./interactive-startup-chat-container.ts";

/** Bind the eager startup session without letting the reusable runtime path append its disclosure. */
export async function bindInitialEagerSession(mode: InteractiveModeBase): Promise<"closed" | "bound"> {
	const session = mode.session;
	try {
		mode.initialStartupBinding = true;
		try {
			await mode.rebindCurrentSession();
		} catch (error) {
			// Shutdown or a session switch can retire this bind while startup is waiting.
			if (!isAgentSessionClosed(session) || (error as { code?: unknown } | null)?.code !== "SessionClosed") {
				throw error;
			}
			if (mode.session === session) return "closed";
			// The replacement installed its own binding. Finish the startup display for it.
		} finally {
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
