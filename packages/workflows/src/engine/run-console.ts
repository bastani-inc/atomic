import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { currentRunConsole, type RunConsole } from "./run-rejection-boundary.js";

/**
 * Keeps workflow code's console output out of a terminal UI's chat (#4175).
 *
 * In the terminal UI the engine's stderr is shown in the chat one status line per write, so a workflow that logs from a
 * loop (or from a `.catch` on every pending durable step when its run is quit) floods the chat. A run started by a
 * terminal-UI session carries that decision in its scope (`consoleLog`), and its code's console calls go to this
 * process's workflow log instead, one line each tagged with the run, while the chat gets one line per run naming the
 * file. Cancellations from a quit never produce that line. Console calls outside such a run keep writing to stderr:
 * code outside any run, runs of other owners (an RPC or SDK host in the same process, or a run resumed by one), and
 * every run in print, JSON, RPC and SDK modes or on pooled worker processes.
 *
 * Each process writes its own file, `<pid>-<start ms>.log`, created exclusively and written synchronously and in full,
 * so no other process appends to it, nothing queued can be lost at exit, and its size is known without reopening it.
 * A run's share and announcement live with its scope, so they last exactly as long as its code can still log.
 */

const METHODS = ["log", "info", "debug", "warn", "error"] as const;
type ConsoleMethod = (typeof METHODS)[number];
type ConsoleWriter = (...args: unknown[]) => void;

const ROUTER_KEY = Symbol.for("atomic-workflows/run-console@4");
/** Per run tree, within this process's log. */
export const MAX_RUN_CONSOLE_BYTES = 8 * 1024 * 1024;
/** Per process log, markers included. */
export const MAX_PROCESS_CONSOLE_LOG_BYTES = 64 * 1024 * 1024;
/** Logs of exited processes not written for this long are deleted when routing starts, then the oldest until the directory fits. */
export const CONSOLE_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_CONSOLE_LOG_DIRECTORY_BYTES = 1024 * 1024 * 1024;
const MAX_CAUSE_DEPTH = 8;
const LOG_NAME = /^(\d+)-\d+\.log$/;

interface ProcessLog {
	readonly path: string;
	readonly fd: number;
	bytes: number;
	capped: boolean;
}

interface RouterState {
	logDirectory: string | undefined;
	log: ProcessLog | undefined;
	/** Set once a write failed; routed output is dropped from then on. */
	failed: boolean;
	readonly originals: Record<ConsoleMethod, ConsoleWriter>;
}

function routerBag(): Record<symbol, RouterState | undefined> {
	return globalThis as typeof globalThis & Record<symbol, RouterState | undefined>;
}

/** Whether a logged value is a cancellation; never throws, since it only decides whether to announce the log. */
function isAbortCancellation(value: unknown, depth = 0): boolean {
	if (!(value instanceof Error) || depth > MAX_CAUSE_DEPTH) return false;
	try {
		if (value.name === "AbortError") return true;
		const cause: unknown = value.cause;
		return cause !== value && isAbortCancellation(cause, depth + 1);
	} catch {
		return false;
	}
}

/** Writes every byte of `text`, or throws. Returns the bytes written. */
function writeAll(fd: number, text: string): number {
	const buffer = Buffer.from(text);
	let offset = 0;
	while (offset < buffer.length) {
		const written = writeSync(fd, buffer, offset, buffer.length - offset);
		if (written <= 0) throw new Error(`wrote ${offset} of ${buffer.length} bytes`);
		offset += written;
	}
	return buffer.length;
}

function processLog(state: RouterState, directory: string): ProcessLog {
	if (state.log !== undefined) return state.log;
	const path = join(directory, `${process.pid}-${Date.now()}.log`);
	const fd = openSync(path, "wx");
	state.log = { path, fd, bytes: 0, capped: false };
	return state.log;
}

/**
 * Appends one routed call; returns whether its text is in the log. Every write leaves room for the process-limit
 * marker, so the log never exceeds its limit, markers included.
 */
function append(log: ProcessLog, run: RunConsole, method: ConsoleMethod, args: unknown[]): boolean {
	if (log.capped || run.capped) return false;
	const stamp = new Date().toISOString();
	const processMarker = `${stamp} log limit reached; later workflow console output is dropped\n`;
	const fits = (text: string) =>
		log.bytes + Buffer.byteLength(text) + Buffer.byteLength(processMarker) <= MAX_PROCESS_CONSOLE_LOG_BYTES;
	const capProcess = () => {
		log.capped = true;
		log.bytes += writeAll(log.fd, processMarker);
		return false;
	};
	const line = `${stamp} ${run.rootRunId} ${method} ${format(...args)}\n`;
	const size = Buffer.byteLength(line);
	// The run's share is decided first: a call its run cannot afford caps that run only, unless its marker no longer fits.
	if (run.bytes + size > MAX_RUN_CONSOLE_BYTES) {
		run.capped = true;
		const runMarker = `${stamp} ${run.rootRunId} run log limit reached; its later output is dropped\n`;
		if (!fits(runMarker)) return capProcess();
		log.bytes += writeAll(log.fd, runMarker);
		return false;
	}
	if (!fits(line)) return capProcess();
	log.bytes += writeAll(log.fd, line);
	run.bytes += size;
	return true;
}

function write(state: RouterState, method: ConsoleMethod, args: unknown[], run: RunConsole, directory: string): void {
	if (state.failed) return;
	let log: ProcessLog;
	let written: boolean;
	try {
		log = processLog(state, directory);
		written = append(log, run, method, args);
	} catch (error) {
		state.failed = true;
		const path = state.log?.path ?? directory;
		if (state.log !== undefined) {
			try {
				closeSync(state.log.fd);
			} catch {}
			state.log = undefined;
		}
		const cause = error instanceof Error ? error.message : String(error);
		state.originals.warn(
			`atomic-workflows: workflow console output could not be written to ${path} (${cause}); later workflow console output is dropped`,
		);
		return;
	}
	if (written && !run.announced && !args.some((arg) => isAbortCancellation(arg))) {
		run.announced = true;
		state.originals.warn(`atomic-workflows: run ${run.rootRunId} console output is in ${log.path}`);
	}
}

function routed(state: RouterState, method: ConsoleMethod): ConsoleWriter {
	return (...args: unknown[]) => {
		const directory = state.logDirectory;
		const run = directory === undefined ? undefined : currentRunConsole();
		if (directory === undefined || run === undefined) state.originals[method](...args);
		else write(state, method, args, run, directory);
	};
}

function installedRouter(): RouterState {
	const bag = routerBag();
	const existing = bag[ROUTER_KEY];
	if (existing !== undefined) return existing;
	const originals = Object.fromEntries(METHODS.map((method) => [method, console[method].bind(console)])) as Record<
		ConsoleMethod,
		ConsoleWriter
	>;
	const state: RouterState = { logDirectory: undefined, log: undefined, failed: false, originals };
	for (const method of METHODS) console[method] = routed(state, method);
	bag[ROUTER_KEY] = state;
	return state;
}

function processAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Deletes logs of exited processes not written within the retention, then the oldest until the directory fits. */
function pruneLogs(directory: string, now: number): void {
	const logs = readdirSync(directory).flatMap((name) => {
		const pid = LOG_NAME.exec(name)?.[1];
		if (pid === undefined) return [];
		const path = join(directory, name);
		try {
			const { mtimeMs, size } = statSync(path);
			return [{ path, mtimeMs, size, live: processAlive(Number(pid)) }];
		} catch {
			return [];
		}
	});
	let total = logs.reduce((sum, log) => sum + log.size, 0);
	for (const log of logs.filter(({ live }) => !live).sort((left, right) => left.mtimeMs - right.mtimeMs)) {
		if (now - log.mtimeMs < CONSOLE_LOG_RETENTION_MS && total <= MAX_CONSOLE_LOG_DIRECTORY_BYTES) break;
		try {
			rmSync(log.path, { force: true });
			total -= log.size;
		} catch {}
	}
}

/**
 * Sends the console output of runs started with `consoleLog` to this process's workflow log under `logDirectory`,
 * after deleting logs there that are past their retention. Idempotent.
 */
export function routeWorkflowConsoleOutput(logDirectory: string, now = Date.now()): void {
	const state = installedRouter();
	if (state.logDirectory === logDirectory) return;
	// Routing starts even when the directory cannot be made: the first routed write then fails and is reported once,
	// rather than every routed call going to stderr.
	try {
		mkdirSync(logDirectory, { recursive: true });
		pruneLogs(logDirectory, now);
	} catch {}
	state.logDirectory = logDirectory;
}

/** Restores stderr for every later console call and closes the log; output already routed stays in its file. */
export function stopRoutingWorkflowConsoleOutput(): void {
	const state = routerBag()[ROUTER_KEY];
	if (state === undefined) return;
	state.logDirectory = undefined;
	state.failed = false;
	if (state.log !== undefined) {
		try {
			closeSync(state.log.fd);
		} catch {}
		state.log = undefined;
	}
}

/** This process's workflow log, once something was written to it. */
export function workflowConsoleLogPath(): string | undefined {
	return routerBag()[ROUTER_KEY]?.log?.path;
}
