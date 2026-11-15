import { isKeyRelease } from "@bastani/atomic-tui";
import { type StopAllBackgroundOutcome, stopAllBackgroundMessage } from "../../core/tasks/stop-all.ts";
import { type NavKeybindings, navActionText, TwoPressConfirm } from "./components/nav-keys.ts";

/** What the chord needs of the main chat. */
export interface StopAllChordHost {
	readonly keybindings: NavKeybindings;
	/** Whether the main chat's prompt has the keyboard, so a dialog keeps its own Ctrl+X. */
	editorOwnsInput(): boolean;
	stopAll(): Promise<StopAllBackgroundOutcome>;
	showStatus(message: string): void;
	showWarning(message: string): void;
}

/**
 * Ctrl+X Ctrl+K in the main chat: the chord key, then the stop-all key, pressed twice within three seconds, stops every
 * background subagent and workflow run of the session. The chord key does nothing else; any other key after it ends
 * the chord and reaches the prompt as usual. Returns the input listener to register.
 */
export function createStopAllChord(
	host: StopAllChordHost,
	now: () => number = Date.now,
): (data: string) => { consume: true } | undefined {
	const confirm = new TwoPressConfirm(now);
	let chordOpen = false;
	const chordText = () =>
		`${navActionText(host.keybindings, "app.agents.chord")} ${navActionText(host.keybindings, "app.agents.stopAll")}`;
	return (data) => {
		if (isKeyRelease(data)) return undefined;
		if (!host.editorOwnsInput()) {
			chordOpen = false;
			return undefined;
		}
		if (chordOpen) {
			chordOpen = false;
			if (!host.keybindings.matches(data, "app.agents.stopAll")) return undefined;
			if (!confirm.press("stop-all")) {
				host.showStatus(`Press ${chordText()} again within 3s to stop all background subagents and workflow runs`);
				return { consume: true };
			}
			void host.stopAll().then(
				(outcome) => {
					const message = stopAllBackgroundMessage(outcome);
					if (outcome.failures.length > 0) host.showWarning(message);
					else host.showStatus(message);
				},
				(error: unknown) => host.showWarning(error instanceof Error ? error.message : String(error)),
			);
			return { consume: true };
		}
		if (host.keybindings.matches(data, "app.agents.chord")) {
			chordOpen = true;
			return { consume: true };
		}
		return undefined;
	};
}
