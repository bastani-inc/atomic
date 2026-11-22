/**
 * A process a test started, told apart from a later process the OS gives the same pid (#6095, #6125).
 *
 * Windows gives an exited process's pid to a new process within seconds. A cleanup that kills a pid it recorded earlier
 * can then end another test's or another job's process, and the failure shows up there. So a test records when its
 * process started while that process certainly runs, and signals the pid only while it still names a process that
 * started then. Each check reads the start again: a remembered read may describe the earlier process.
 */
import { createRequire } from "node:module";
import {
	readProcessCreationTime,
	readProcessStartToken,
} from "../../packages/coding-agent/src/core/process-start-token.js";
import { sleep } from "./runtime.js";

/** Where a process's start can be read, so that a pid is never taken for a later process given the same pid. */
export const READS_PROCESS_STARTS =
	process.platform === "linux" || process.platform === "win32" || process.platform === "darwin";

/** When macOS process `pid` started, as the native module reads it; undefined once it is gone. */
function macOSProcessStart(pid: number): string | undefined {
	const natives = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		readonly processCreationTime: (pid: number) => string | null;
	};
	return natives.processCreationTime(pid) ?? undefined;
}

/** A process a test started, and when it started. */
export interface RecordedProcess {
	readonly pid: number;
	/** When it started, read while it ran; undefined where starts cannot be read, or when it had already exited. */
	readonly started: string | undefined;
}

/** When process `pid` started, read now; undefined once it is gone, or where starts cannot be read. */
export function currentProcessStart(pid: number): Promise<string | undefined> {
	if (process.platform === "darwin") return Promise.resolve(macOSProcessStart(pid));
	return process.platform === "win32" ? readProcessCreationTime(pid) : readProcessStartToken(pid);
}

/** Records `pid` and when it started. Call it while the process certainly runs, such as while it waits to be released. */
export async function recordProcess(pid: number): Promise<RecordedProcess> {
	return { pid, started: await currentProcessStart(pid) };
}

function pidInUse(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Whether `recorded` still runs: its pid names a process that started when it was recorded. Where starts cannot be
 * read, whether its pid is in use. Where they can, a process recorded without a start is never taken for a running one.
 */
export async function stillRuns(recorded: RecordedProcess): Promise<boolean> {
	if (!READS_PROCESS_STARTS) return pidInUse(recorded.pid);
	return recorded.started !== undefined && (await currentProcessStart(recorded.pid)) === recorded.started;
}

/**
 * Sends `signal` to `recorded`, or with `group` to the process group it leads, only while its pid still names it.
 * Returns whether the signal was sent.
 */
export async function signalRecordedProcess(
	recorded: RecordedProcess,
	signal: NodeJS.Signals = "SIGKILL",
	{ group = false }: { readonly group?: boolean } = {},
): Promise<boolean> {
	if (!(await stillRuns(recorded))) return false;
	try {
		process.kill(group ? -recorded.pid : recorded.pid, signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether `recorded` is known to have exited: no process has its pid any more, or the process with its pid started at
 * another time. A process whose start cannot be read is not known to be gone, unlike in {@link stillRuns}: not being
 * allowed to signal a pid is no proof that its process ended.
 */
export async function isGone(recorded: RecordedProcess): Promise<boolean> {
	if (!pidInUse(recorded.pid)) return true;
	if (!READS_PROCESS_STARTS || recorded.started === undefined) return false;
	const current = await currentProcessStart(recorded.pid);
	return current !== undefined && current !== recorded.started;
}

/** Waits until `recorded` is known to have exited ({@link isGone}), for up to `timeoutMs`; whether it has. */
export async function waitUntilGone(recorded: RecordedProcess, timeoutMs: number, pollMs = 20): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!(await isGone(recorded))) {
		if (Date.now() >= deadline) return false;
		await sleep(pollMs);
	}
	return true;
}
