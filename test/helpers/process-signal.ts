/** What sending a signal found: the process took it, or it had already exited by itself. */
export type SignalOutcome = "signalled" | "already-exited";

/**
 * Sends `signal` to `pid` without first checking that it exists: a process can exit between such a check and the
 * signal, so only the signal's own ESRCH counts as already exited. Every other failure, EPERM included, is thrown.
 */
export function signalUnlessExited(pid: number, signal: NodeJS.Signals | number): SignalOutcome {
	try {
		process.kill(pid, signal);
		return "signalled";
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return "already-exited";
		throw error;
	}
}
