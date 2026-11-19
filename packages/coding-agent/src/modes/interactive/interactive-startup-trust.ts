import { setKeybindings } from "@bastani/atomic-tui";
import { waitForInteractiveEngineProjectTrust } from "../interactive-engine/extension-ui-bridge.ts";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";

/** A view drawn from provisional saved trust must remove any withdrawn project values. */
export function onPreliminaryCatalogWithdrawn(
	mode: InteractiveModeBase,
	rebuild: () => void,
): (() => void) | undefined {
	const runtime = mode.runtimeHost;
	if (!(runtime instanceof IsolatedInteractiveRuntime) || !runtime.isProjectTrustPending()) return undefined;
	const settings = mode.settingsManager;
	if (!settings.isProjectTrusted()) return undefined;
	const unsubscribe = runtime.onProjectTrustChanged((changed) => {
		if (mode.settingsManager !== settings) return unsubscribe();
		if (changed && !settings.isProjectTrusted()) {
			unsubscribe();
			rebuild();
		} else if (!runtime.isProjectTrustPending()) unsubscribe();
	});
	return unsubscribe;
}

type StartupTrustHoldState = Pick<InteractiveModeBase, "options" | "startupTrustReleased">;

export function isStartupTrustHeld(mode: StartupTrustHoldState): boolean {
	return mode.options?.holdTuiForStartupTrust === true && !mode.startupTrustReleased;
}

export async function holdTuiForStartupTrust(mode: InteractiveModeBase): Promise<void> {
	try {
		await waitForInteractiveEngineProjectTrust(mode.runtimeHost).catch(() => undefined);
	} finally {
		mode.startupTrustReleased = true;
		setKeybindings(mode.keybindings);
	}
}
