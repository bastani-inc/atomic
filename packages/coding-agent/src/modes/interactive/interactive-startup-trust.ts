import { setKeybindings } from "@earendil-works/pi-tui";
import { waitForInteractiveEngineProjectTrust } from "../interactive-engine/extension-ui-bridge.ts";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";

type StartupTrustHoldState = Pick<InteractiveModeBase, "options" | "startupTrustReleased">;

export function isStartupTrustHeld(mode: StartupTrustHoldState): boolean {
	return mode.options.holdTuiForStartupTrust === true && !mode.startupTrustReleased;
}

export async function holdTuiForStartupTrust(mode: InteractiveModeBase): Promise<void> {
	try {
		await waitForInteractiveEngineProjectTrust(mode.runtimeHost).catch(() => undefined);
	} finally {
		mode.startupTrustReleased = true;
		setKeybindings(mode.keybindings);
	}
}
