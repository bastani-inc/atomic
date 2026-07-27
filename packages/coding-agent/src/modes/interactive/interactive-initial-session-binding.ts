import type { InteractiveModeBase } from "./interactive-mode-base.ts";

/** Bind the eager startup session without letting the reusable runtime path append its disclosure. */
export async function bindInitialEagerSession(mode: InteractiveModeBase): Promise<void> {
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
}
