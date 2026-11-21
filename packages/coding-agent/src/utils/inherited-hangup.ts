/**
 * Whether Atomic was started with SIGHUP ignored, as `nohup` starts a command, so that a run without a terminal keeps
 * going when the terminal it was started from closes.
 *
 * Node sets an ignored signal back to its default before any of Atomic runs, so on Node this is never known. Bun keeps
 * it ignored until a listener for the signal is added, which replaces it; {@link noteInheritedHangup} reads it before.
 */
import { constants as osConstants } from "node:os";
import { createModuleRequire } from "./module-require.js";

let hangupIgnored = false;

/**
 * Reads whether SIGHUP is ignored and, when it is, keeps it from ending this process. Call it at startup, before
 * anything adds a listener for SIGHUP.
 */
export function noteInheritedHangup(): void {
	if (process.platform === "win32" || !("bun" in process.versions)) return;
	try {
		const natives = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
			signalIgnored?: (signal: number) => boolean | null;
		};
		hangupIgnored = natives.signalIgnored?.(osConstants.signals.SIGHUP) === true;
	} catch {
		// Without the native module the disposition cannot be read, and SIGHUP ends a run as before.
	}
	// A listener that does nothing: once any listener is added the signal is no longer ignored, and a library such as
	// `signal-exit` sends the signal again when only its own listeners remain.
	if (hangupIgnored) process.on("SIGHUP", () => {});
}

/** Whether Atomic was started with SIGHUP ignored, as {@link noteInheritedHangup} read it; SIGHUP then ends nothing. */
export function startedWithHangupIgnored(): boolean {
	return hangupIgnored;
}
