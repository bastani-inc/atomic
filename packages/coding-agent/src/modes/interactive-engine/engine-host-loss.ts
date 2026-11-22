import { hasQuitStoppableCommands, killQuitStoppableCommandsNow } from "../../core/exec.ts";

/** How long an engine whose channel to its host closed waits at its exit for the system to give it another parent. */
export const REPARENT_WAIT_MS = 1_000;
const REPARENT_POLL_MS = 5;

/**
 * Whether this engine child exits because its host is gone: the host announced no quit, and this process, which the
 * host started, has another parent, as when the host was killed. Unlike the host's pid, the parent cannot name a later
 * process. The system closes a killed host's pipes before it gives the host's children another parent, and the engine,
 * which exits once those pipes close, can get there first: when the channel to the host closed (`channelClosed`), it
 * waits until `waitMs` have passed on the monotonic clock `now` for its parent to change, and reads it once more at the
 * end. A host that lives, though the channel closed, stays its parent, and the engine leaves its commands' processes as
 * before. A host whose exit gives its children another parent only after the wait is taken for alive too.
 */
export function hostIsGone(
	hostPid: number,
	quitAnnounced: boolean,
	channelClosed: boolean,
	parent: () => number,
	pause: (ms: number) => void,
	now: () => number,
	waitMs = REPARENT_WAIT_MS,
): boolean {
	if (quitAnnounced) return false;
	if (parent() !== hostPid) return true;
	if (!channelClosed) return false;
	const deadline = now() + waitMs;
	for (let left = waitMs; left > 0; left = deadline - now()) {
		pause(Math.min(REPARENT_POLL_MS, left));
		if (parent() !== hostPid) return true;
	}
	return parent() !== hostPid;
}

let pauseCell: Int32Array | undefined;

/** Blocks this thread for `ms`, for a process exiting that can no longer wait for its event loop. */
function pauseNow(ms: number): void {
	pauseCell ??= new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(pauseCell, 0, 0, ms);
}

/**
 * When this engine child exits after its host is gone without quitting, it ends the extensions' `pi.exec` commands
 * still running that a quit would have stopped, with the processes they started, at once (`SIGKILL`). Other processes
 * extensions started, a command a `session_shutdown` handler started, and what a finished command left running stay as
 * they are, as after a quit. Only for an engine its host started itself, and not on Windows, where the host's end ends
 * the engine and the processes it started. `channelClosed` says whether the engine's input ended or a write to its
 * output failed, also while the engine shuts down. Returns whether this engine watches for its host's loss so.
 */
export function endCommandsWhenHostIsGone(
	hostPid: number,
	quitAnnounced: () => boolean,
	channelClosed: () => boolean,
): boolean {
	if (process.platform === "win32" || process.ppid !== hostPid) return false;
	process.on("exit", () => {
		if (
			hasQuitStoppableCommands() &&
			hostIsGone(
				hostPid,
				quitAnnounced(),
				channelClosed(),
				() => process.ppid,
				pauseNow,
				() => performance.now(),
			)
		) {
			killQuitStoppableCommandsNow();
		}
	});
	return true;
}
