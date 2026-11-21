/**
 * The end of the user's Windows session: signing out, restarting or shutting down. Windows tells only top-level
 * windows, so the native module gives the interactive host a hidden one. Without the native module, or with one too old
 * to have it, Windows ends Atomic with the session without warning, as it always did.
 */
import { createModuleRequire } from "../../utils/module-require.js";

/** Told that the session ends, with how many milliseconds ago Windows said so. */
export type WindowsSessionEndListener = (endedMsAgo: number) => void;

interface SessionEndBinding {
	watchSessionEnd?: (onEnd: (endedMsAgo: number) => boolean) => void;
}

const listeners = new Set<WindowsSessionEndListener>();
let watching = false;

/**
 * Tells the listeners that the session ends. Windows waits for Atomic only while the answer is true: with no listener,
 * nothing shuts down, and the session ends at once.
 */
function sessionEnds(endedMsAgo: number): boolean {
	const current = [...listeners];
	for (const listener of current) listener(endedMsAgo);
	return current.length > 0;
}

/** On Windows, starts hearing the end of the session, once per process. Elsewhere it does nothing. */
export function watchWindowsSessionEnd(): void {
	if (watching || process.platform !== "win32") return;
	watching = true;
	let binding: SessionEndBinding;
	try {
		binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as SessionEndBinding;
	} catch {
		return;
	}
	binding.watchSessionEnd?.(sessionEnds);
}

/** Calls `listener` when the Windows session ends, until the returned function is called. */
export function onWindowsSessionEnd(listener: WindowsSessionEndListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
