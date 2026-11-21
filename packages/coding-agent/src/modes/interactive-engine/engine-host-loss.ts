import { hasQuitStoppableCommands, killQuitStoppableCommandsNow } from "../../core/exec.ts";

/**
 * Whether this engine child exits because its host is gone: the host announced no quit, and this process, which the
 * host started, has another parent now, as when the host was killed. Its stdout then fails or its stdin ends, and the
 * engine exits at once, without the quit that would have stopped its extensions' commands first. Unlike the host's
 * pid, the parent cannot name a later process.
 */
export function hostIsGone(hostPid: number, parentPid: number, quitAnnounced: boolean): boolean {
	return !quitAnnounced && parentPid !== hostPid;
}

/**
 * When this engine child exits after its host is gone without quitting, it ends the extensions' `pi.exec` commands
 * still running that a quit would have stopped, with the processes they started, at once (`SIGKILL`). Other processes
 * extensions started, a command a `session_shutdown` handler started, and what a finished command left running stay as
 * they are, as after a quit. Only for an engine its host started itself, and not on Windows, where the host's end ends
 * the engine and the processes it started.
 */
export function endCommandsWhenHostIsGone(hostPid: number, quitAnnounced: () => boolean): void {
	if (process.platform === "win32" || process.ppid !== hostPid) return;
	process.on("exit", () => {
		if (hasQuitStoppableCommands() && hostIsGone(hostPid, process.ppid, quitAnnounced())) {
			killQuitStoppableCommandsNow();
		}
	});
}
