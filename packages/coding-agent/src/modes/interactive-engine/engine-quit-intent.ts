import { writeSync } from "node:fs";
import { markEventLoopShutdown } from "../../core/event-loop-monitor.ts";
import { flushLifecycleTraceAtQuit } from "../../core/lifecycle-timings.ts";
import { parseEngineExplicitQuitCommand, serializeInteractiveEngineMessage } from "./protocol.ts";

/**
 * Child-side record of whether the host is quitting on purpose.
 *
 * The host stops the engine by closing stdin and then sending SIGTERM, and a host
 * that was itself signalled stops it the same way, so the child cannot infer the cause
 * from how it was stopped. The host announces an explicit quit first and waits for the
 * acknowledgement, which makes the flag visible before any stop signal can arrive.
 */
export class EngineQuitIntent {
	private explicit = false;

	private readonly send: (line: string) => void;

	constructor(send: (line: string) => void) {
		this.send = send;
	}

	get explicitQuitRequested(): boolean {
		return this.explicit;
	}

	handleLine(line: string): boolean {
		if (!parseEngineExplicitQuitCommand(line)) return false;
		this.explicit = true;
		// The host may end this process as soon as it has the acknowledgement: write the diagnostics first.
		markEventLoopShutdown();
		flushLifecycleTraceAtQuit();
		this.send(serializeInteractiveEngineMessage({ type: "engine_explicit_quit_ack" }));
		return true;
	}
}

/** The engine child's last exit handler: a synchronous write, since nothing asynchronous runs after exit begins. */
function writeShutdownComplete(): void {
	try {
		writeSync(1, serializeInteractiveEngineMessage({ type: "engine_shutdown_complete" }));
	} catch {
		// The host stopped reading; it ends this process on its own deadline.
	}
}

/**
 * Tell the host, once every exit handler registered so far has run, that this engine child has shut down. Call it
 * immediately before `process.exit`. The diagnostics' last records are among those handlers, so they are written
 * by then. What remains is the runtime's own exit work, such as writing its compile cache, which the host need not
 * wait for.
 */
export function reportShutdownCompleteAtExit(): void {
	process.once("exit", writeShutdownComplete);
}

/** Whether this process leads a process group: one with its own process ID, which only it can have created. */
function leadsProcessGroup(): boolean {
	try {
		process.kill(-process.pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** End this process's group, this process with it. */
function endOwnProcessGroup(): void {
	try {
		process.kill(-process.pid, "SIGKILL");
	} catch {
		// Nothing to end.
	}
}

/**
 * Once every exit handler registered so far has run, among them the ones that write this engine child's last
 * diagnostics records, end its whole process group, itself last. Call it immediately before `process.exit`, when the
 * host stopped the engine because it was itself signalled: a host signal used to end the group at once, so a process
 * an extension started in it, neither detached nor stopped in its shutdown, would otherwise outlive the engine. Only an
 * engine that leads its own group ends it: its host creates one for it, and while the engine runs no other group can
 * have its process ID, so an engine started inside another process's group never ends that group. Not on Windows,
 * which has no process groups.
 */
export function endProcessGroupAtExit(): void {
	if (process.platform === "win32" || !leadsProcessGroup()) return;
	process.once("exit", endOwnProcessGroup);
}
