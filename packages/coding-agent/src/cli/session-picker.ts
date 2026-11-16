/**
 * TUI session selector for --resume flag
 */

import { ProcessTerminal, setCapabilityOverrides, setKeybindings, TuiMainScreen } from "@bastani/atomic-tui";
import { getAgentDir } from "../config.js";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { keepStartupDialogDraft, withEarlyInputHeldForStartupDialog } from "../main-early-input.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";
import {
	STARTUP_DECISION_TYPED_TEXT_NOTICE,
	TrustDecisionSelector,
} from "../modes/interactive/components/trust-decision-selector.ts";
import { StartupDialogInputGuard } from "./startup-ui.ts";

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/** Show TUI session selector and return the selected row with its store scope, or null if cancelled. */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	settingsManager: SettingsManager,
	deleteSession?: (sessionId: string) => Promise<void>,
): Promise<SessionInfo | null> {
	return withEarlyInputHeldForStartupDialog(({ hasUnfinishedInput }) =>
		openSessionPicker(currentSessionsLoader, allSessionsLoader, settingsManager, hasUnfinishedInput, deleteSession),
	);
}

function openSessionPicker(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	settingsManager: SettingsManager,
	hasUnfinishedInput: boolean,
	deleteSession?: (sessionId: string) => Promise<void>,
): Promise<SessionInfo | null> {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	return new Promise((resolve) => {
		const ui = new TuiMainScreen(new ProcessTerminal(), undefined, getAgentDir());
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;
		const finish = async (result: SessionInfo | null) => {
			if (resolved) return;
			resolved = true;
			selector.dispose();
			const trailingInput = new TrustDecisionSelector(
				{ render: () => [], invalidate: () => {}, handleInput: () => {} },
				keepStartupDialogDraft,
				STARTUP_DECISION_TYPED_TEXT_NOTICE,
			);
			ui.setFocus(trailingInput);
			await new Promise((resolve) => setTimeout(resolve, 0));
			ui.stop();
			trailingInput.dispose();
			resolve(result);
		};

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(session) => void finish(session),
			() => void finish(null),
			() => {
				selector.dispose();
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings, deleteSession },
		);

		const guardedSelector = new StartupDialogInputGuard(selector, hasUnfinishedInput);
		ui.addChild(guardedSelector);
		ui.setFocus(guardedSelector);
		ui.start();
	});
}
