import { isKeyRelease } from "@bastani/atomic-tui";
import { type StopAllBackgroundOutcome, stopAllBackgroundMessage } from "../../core/tasks/stop-all.ts";
import { NAV_CONFIRM_WINDOW_MS, type NavKeybindings, navActionText, TwoPressConfirm } from "./components/nav-keys.ts";
import { isPhysicalEscape } from "./interactive-key-identity.ts";

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
 * background subagent and shell of the session. The chord key itself still reaches whatever has the
 * keyboard (nothing binds it by default); only the stop-all key right after it is taken. Any other key ends the chord.
 * Returns the input listener to register.
 */
export function createStopAllChord(
	host: StopAllChordHost,
	now: () => number = Date.now,
): (data: string) => { consume: true } | undefined {
	const confirm = new TwoPressConfirm(now);
	let chordOpen = false;
	const chordKeybindings: NavKeybindings = {
		matches: (data, action) => host.keybindings.matches(data, action),
		getKeys: (action) =>
			(host.keybindings.getKeys?.(action) ?? []).filter((key) => key !== "esc" && key !== "escape"),
	};
	const chordText = () =>
		`${navActionText(chordKeybindings, "app.agents.chord")} ${navActionText(chordKeybindings, "app.agents.stopAll")}`;
	return (data) => {
		if (isKeyRelease(data)) return undefined;
		const cancelPending = () => {
			if (confirm.pending() === undefined) return;
			confirm.reset();
			host.clearStatus();
		};
		if (!host.chordAllowed() || isPhysicalEscape(data)) {
			chordOpen = false;
			cancelPending();
			return undefined;
		}
		if (chordOpen) {
			chordOpen = false;
			if (!host.keybindings.matches(data, "app.agents.stopAll")) {
				// Another chord key starts the chord over; any other key calls a waiting stop-all off.
				if (host.keybindings.matches(data, "app.agents.chord")) chordOpen = true;
				else cancelPending();
				return undefined;
			}
			if (!confirm.press("stop-all")) {
				host.showStatus(`Press ${chordText()} again within 3s to stop all`);
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

export interface StopAllNoticeSurfaces {
	setEngineNotice?(text: string | undefined): void;
	setFooterStatus?(text: string | undefined): void;
	showToast?(text: string): () => void;
	hasOverlay(): boolean;
	requestRender(): void;
}

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
