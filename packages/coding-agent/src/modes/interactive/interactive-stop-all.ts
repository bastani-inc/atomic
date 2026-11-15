import { isKeyRelease } from "@bastani/atomic-tui";
import { type StopAllBackgroundOutcome, stopAllBackgroundMessage } from "../../core/tasks/stop-all.ts";
import { type NavKeybindings, navActionText, TwoPressConfirm } from "./components/nav-keys.ts";

/** What the chord needs of the main chat. */
export interface StopAllChordHost {
	readonly keybindings: NavKeybindings;
	/** False while a dialog that binds the chord key itself (such as OAuth sign-in's copy) has the keyboard. */
	chordAllowed(): boolean;
	stopAll(): Promise<StopAllBackgroundOutcome>;
	showStatus(message: string): void;
	showWarning(message: string): void;
}

/**
 * Ctrl+X Ctrl+K anywhere: the chord key, then the stop-all key, pressed twice within three seconds, stops every
 * background subagent, shell and workflow run of the session. The chord key itself still reaches whatever has the
 * keyboard (nothing binds it by default); only the stop-all key right after it is taken. Any other key ends the chord.
 * Returns the input listener to register.
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
		if (!host.chordAllowed()) {
			chordOpen = false;
			return undefined;
		}
		if (chordOpen) {
			chordOpen = false;
			if (!host.keybindings.matches(data, "app.agents.stopAll")) return undefined;
			if (!confirm.press("stop-all")) {
				host.showStatus(
					`Press ${chordText()} again within 3s to stop all background subagents, shells and workflow runs`,
				);
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
		if (host.keybindings.matches(data, "app.agents.chord")) chordOpen = true;
		return undefined;
	};
}
