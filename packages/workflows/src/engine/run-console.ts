import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { currentRunTreeId } from "./run-rejection-boundary.js";

/**
 * Keeps workflow code's console output out of an interactive chat (#4175).
 *
 * In an interactive session the engine's stderr is shown in the chat, one status line per write, so a workflow that
 * logs from a loop (or from a `.catch` on every pending durable step when its run is quit) floods the chat. While
 * routing is enabled, console calls made by a run's code go to that run tree's log file instead, and the chat gets one
 * line per run naming the file. Cancellations from a quit never produce that line. Console calls outside any run, and
 * every call while routing is off (print mode, RPC and SDK hosts, pooled worker processes), keep writing to stderr.
 *
 * Writes are synchronous appends to an open descriptor, so nothing is queued that a process exit could lose, and a
 * failed write is reported at once, in one line, after which that run's output is dropped rather than flooding stderr.
 */

const METHODS = ["log", "info", "debug", "warn", "error"] as const;
type ConsoleMethod = (typeof METHODS)[number];
type ConsoleWriter = (...args: unknown[]) => void;

const ROUTER_KEY = Symbol.for("atomic-workflows/run-console@2");
/** Per run tree, counted from the log's size on disk, so a resumed run keeps its earlier output's share. */
export const MAX_RUN_CONSOLE_LOG_BYTES = 8 * 1024 * 1024;
/** Logs held open at once; the least recently written is closed first and reopened when its run writes again. */
const MAX_OPEN_LOGS = 64;
/** Run trees remembered as announced or failed, so neither line repeats after a log is closed and reopened. */
const MAX_REMEMBERED_RUNS = 4096;
/** Logs not written for this long are deleted when routing starts, then the oldest until the directory fits. */
export const RUN_CONSOLE_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_RUN_CONSOLE_LOG_DIRECTORY_BYTES = 1024 * 1024 * 1024;
const MAX_CAUSE_DEPTH = 8;
const LIMIT_MARKER = "log limit reached; later output is dropped\n";

interface RunLog {
	readonly path: string;
	readonly fd: number;
	bytes: number;
	capped: boolean;
}

interface RouterState {
	logDirectory: string | undefined;
	readonly originals: Record<ConsoleMethod, ConsoleWriter>;
	/** Open logs, least recently written first. */
	readonly logs: Map<string, RunLog>;
	readonly announced: Set<string>;
	readonly failed: Set<string>;
}

function routerBag(): Record<symbol, RouterState | undefined> {
	return globalThis as typeof globalThis & Record<symbol, RouterState | undefined>;
}

function remember(runs: Set<string>, rootRunId: string): void {
	runs.add(rootRunId);
	if (runs.size > MAX_REMEMBERED_RUNS) runs.delete(runs.values().next().value as string);
}

function isAbortCancellation(value: unknown, depth = 0): boolean {
	if (!(value instanceof Error) || depth > MAX_CAUSE_DEPTH) return false;
	if (value.name === "AbortError") return true;
	return value.cause !== value && isAbortCancellation(value.cause, depth + 1);
}

/** The log file of a run tree under `logDirectory`. */
export function runConsoleLogPath(logDirectory: string, rootRunId: string): string {
	return join(logDirectory, `${encodeURIComponent(rootRunId).replaceAll(".", "%2E")}.log`);
}

function close(state: RouterState, rootRunId: string): void {
	const log = state.logs.get(rootRunId);
	if (log === undefined) return;
	state.logs.delete(rootRunId);
	try {
		closeSync(log.fd);
	} catch {}
}

function openLog(state: RouterState, directory: string, rootRunId: string): RunLog {
	const open = state.logs.get(rootRunId);
	if (open !== undefined) {
		state.logs.delete(rootRunId);
		state.logs.set(rootRunId, open);
		return open;
	}
	const path = runConsoleLogPath(directory, rootRunId);
	const fd = openSync(path, "a");
	const bytes = fstatSync(fd).size;
	const log: RunLog = { path, fd, bytes, capped: bytes >= MAX_RUN_CONSOLE_LOG_BYTES };
	state.logs.set(rootRunId, log);
	while (state.logs.size > MAX_OPEN_LOGS) close(state, state.logs.keys().next().value as string);
	return log;
}

function append(log: RunLog, method: ConsoleMethod, args: unknown[]): void {
	if (log.capped) return;
	const line = `${new Date().toISOString()} ${method} ${format(...args)}\n`;
	const size = Buffer.byteLength(line);
	if (log.bytes + size > MAX_RUN_CONSOLE_LOG_BYTES) {
		log.capped = true;
		writeSync(log.fd, `${new Date().toISOString()} ${LIMIT_MARKER}`);
		return;
	}
	writeSync(log.fd, line);
	log.bytes += size;
}

function write(state: RouterState, method: ConsoleMethod, args: unknown[], rootRunId: string, directory: string): void {
	if (state.failed.has(rootRunId)) return;
	let log: RunLog;
	try {
		log = openLog(state, directory, rootRunId);
		append(log, method, args);
	} catch (error) {
		close(state, rootRunId);
		remember(state.failed, rootRunId);
		const path = runConsoleLogPath(directory, rootRunId);
		const cause = error instanceof Error ? error.message : String(error);
		state.originals.warn(
			`atomic-workflows: run ${rootRunId} console output could not be written to ${path} (${cause}); its later console output is dropped`,
		);
		return;
	}
	if (!state.announced.has(rootRunId) && !args.some((arg) => isAbortCancellation(arg))) {
		remember(state.announced, rootRunId);
		state.originals.warn(`atomic-workflows: run ${rootRunId} console output is in ${log.path}`);
	}
}

function routed(state: RouterState, method: ConsoleMethod): ConsoleWriter {
	return (...args: unknown[]) => {
		const directory = state.logDirectory;
		const rootRunId = directory === undefined ? undefined : currentRunTreeId();
		if (directory === undefined || rootRunId === undefined) state.originals[method](...args);
		else write(state, method, args, rootRunId, directory);
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
	const state: RouterState = {
		logDirectory: undefined,
		originals,
		logs: new Map(),
		announced: new Set(),
		failed: new Set(),
	};
	for (const method of METHODS) console[method] = routed(state, method);
	bag[ROUTER_KEY] = state;
	return state;
}

/** Deletes logs not written within the retention, then the oldest until the directory fits its bound. */
function pruneLogs(directory: string, now: number): void {
	const logs = readdirSync(directory)
		.filter((name) => name.endsWith(".log"))
		.flatMap((name) => {
			const path = join(directory, name);
			try {
				const { mtimeMs, size } = statSync(path);
				return [{ path, mtimeMs, size }];
			} catch {
				return [];
			}
		})
		.sort((left, right) => left.mtimeMs - right.mtimeMs);
	let total = logs.reduce((sum, log) => sum + log.size, 0);
	for (const log of logs) {
		if (now - log.mtimeMs < RUN_CONSOLE_LOG_RETENTION_MS && total <= MAX_RUN_CONSOLE_LOG_DIRECTORY_BYTES) break;
		rmSync(log.path, { force: true });
		total -= log.size;
	}
}

/**
 * Route console output of workflow code running in this process to per-run log files under `logDirectory`, after
 * deleting logs there that are past their retention.
 */
export function routeWorkflowConsoleOutput(logDirectory: string, now = Date.now()): void {
	mkdirSync(logDirectory, { recursive: true });
	pruneLogs(logDirectory, now);
	installedRouter().logDirectory = logDirectory;
}

/** Restore stderr for every later console call and close the open logs; output already routed stays in its files. */
export function stopRoutingWorkflowConsoleOutput(): void {
	const state = routerBag()[ROUTER_KEY];
	if (state === undefined) return;
	state.logDirectory = undefined;
	for (const rootRunId of [...state.logs.keys()]) close(state, rootRunId);
}

/** Run trees whose logs are open, least recently written first. */
export function openWorkflowConsoleLogs(): readonly string[] {
	return [...(routerBag()[ROUTER_KEY]?.logs.keys() ?? [])];
}
