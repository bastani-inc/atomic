import { setKeybindings } from "@earendil-works/pi-tui";
import { waitForInteractiveEngineProjectTrust } from "../interactive-engine/extension-ui-bridge.ts";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";

export async function holdTuiForStartupTrust(mode: InteractiveModeBase): Promise<void> {
	mode.startupDialogsStandalone = true;
	try {
		await waitForInteractiveEngineProjectTrust(mode.runtimeHost).catch(() => undefined);
	} finally {
		mode.startupDialogsStandalone = false;
		setKeybindings(mode.keybindings);
	}
}
