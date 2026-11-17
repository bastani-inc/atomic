import { isKeyRelease } from "@bastani/atomic-tui";
import { type StopAllBackgroundOutcome, stopAllBackgroundMessage } from "../../core/tasks/stop-all.ts";
import { NAV_CONFIRM_WINDOW_MS, type NavKeybindings, navActionText, TwoPressConfirm } from "./components/nav-keys.ts";

/** The footer status key the chord's notices show under, so they are seen over overlays too. */
export const STOP_ALL_STATUS_KEY = "atomic.stop-all";

/** What the chord needs of the main chat. */
export interface StopAllChordHost {
	readonly keybindings: NavKeybindings;
	/** False while a dialog that binds the chord key itself (such as OAuth sign-in's copy) has the keyboard. */
	chordAllowed(): boolean;
	stopAll(): Promise<StopAllBackgroundOutcome>;
	showStatus(message: string): void;
	showWarning(message: string): void;
	/** Removes the "press again" notice once the stop-all is called off. */
	clearStatus(): void;
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
		// Any key other than the chord calls a waiting stop-all off, and its notice with it.
		const cancelPending = () => {
			if (confirm.pending() === undefined) return;
			confirm.reset();
			host.clearStatus();
		};
		if (chordOpen) {
			chordOpen = false;
			if (!host.keybindings.matches(data, "app.agents.stopAll")) {
				// Another chord key starts the chord over; any other key calls a waiting stop-all off.
				if (host.keybindings.matches(data, "app.agents.chord")) chordOpen = true;
				else cancelPending();
				return undefined;
			}
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
		else cancelPending();
		return undefined;
	};
}

/** Where a stop-all notice can show: never a chat transcript, only places that clear themselves. */
export interface StopAllNoticeSurfaces {
	/** The isolated engine's status line, which its views (the workflow graph, a subagent's chat) and the host footer show. */
	setEngineNotice?(text: string | undefined): void;
	/** The in-process footer's status line. */
	setFooterStatus?(text: string | undefined): void;
	/** A floating line over an in-process fullscreen view; returns its remover. */
	showToast?(text: string): () => void;
	hasOverlay(): boolean;
	requestRender(): void;
}

/**
 * Shows the chord's notices (the "press again" prompt, the result, a failure) in the view the user is in, for one
 * confirm window, and never in a chat transcript: the isolated engine's status line, or in process the footer status
 * plus a floating line over a fullscreen view.
 */
export function createStopAllNotices(
	surfaces: StopAllNoticeSurfaces,
	timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = { setTimeout, clearTimeout },
): { show(text: string): void; clear(): void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let hideToast: (() => void) | undefined;
	const clear = () => {
		if (timer !== undefined) timers.clearTimeout(timer);
		timer = undefined;
		hideToast?.();
		hideToast = undefined;
		surfaces.setEngineNotice?.(undefined);
		surfaces.setFooterStatus?.(undefined);
	};
	return {
		clear() {
			clear();
			surfaces.requestRender();
		},
		show(text) {
			clear();
			if (surfaces.setEngineNotice) surfaces.setEngineNotice(text);
			else {
				surfaces.setFooterStatus?.(text);
				if (surfaces.hasOverlay()) hideToast = surfaces.showToast?.(text);
			}
			timer = timers.setTimeout(() => {
				clear();
				surfaces.requestRender();
			}, NAV_CONFIRM_WINDOW_MS);
			(timer as { unref?: () => void }).unref?.();
			surfaces.requestRender();
		},
	};
}
