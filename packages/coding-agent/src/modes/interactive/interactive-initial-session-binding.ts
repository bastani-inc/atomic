import type { InteractiveModeBase } from "./interactive-mode-base.ts";
import { releaseStartupChatOutput } from "./interactive-startup-chat-container.ts";

/** Bind the eager startup session without letting the reusable runtime path append its disclosure. */
export async function bindInitialEagerSession(mode: InteractiveModeBase): Promise<void> {
	try {
		mode.initialStartupBinding = true;
		try {
			await mode.rebindCurrentSession();
		} finally {
			mode.initialStartupBinding = false;
		}
		mode.showLoadedResources({
			force: true,
			showDiagnosticsWhenQuiet: true,
			targetContainer: mode.resourceDisclosureContainer,
		});
		mode.showStartupNoticesIfNeeded(mode.startupNoticesContainer);
	} finally {
		releaseStartupChatOutput(mode);
	}
}
