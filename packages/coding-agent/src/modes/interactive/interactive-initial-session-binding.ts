import { type InitialBind, initialBindScope } from "../../core/extension-startup-close.ts";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";
import { releaseStartupChatOutput } from "./interactive-startup-chat-container.ts";

/** Bind the eager startup session without letting the reusable runtime path append its disclosure. */
export async function bindInitialEagerSession(mode: InteractiveModeBase): Promise<void> {
	try {
		mode.initialStartupBinding = true;
		const bind: InitialBind = { mode, active: true };
		try {
			await initialBindScope.run(new WeakRef(bind), () => mode.rebindCurrentSession());
		} finally {
			bind.active = false;
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
	} finally {
		releaseStartupChatOutput(mode);
	}
}
