import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { currentRunTreeId } from "./run-rejection-boundary.js";

/**
 * Keeps workflow code's console output out of a terminal UI's chat (#4175).
 *
 * In the terminal UI the engine's stderr is shown in the chat one status line per write, so a workflow that logs from a
 * loop (or from a `.catch` on every pending durable step when its run is quit) floods the chat. While a terminal-UI
 * session owns runs in this process, console calls made by those runs' code go to this process's workflow log instead,
 * one line each tagged with the run, and the chat gets one line per run naming the file. Cancellations from a quit never
 * produce that line. Console calls outside a run, from runs no terminal-UI session owns, and every call in other modes
 * (print, JSON, RPC, SDK hosts, pooled worker processes) keep writing to stderr.
 *
 * Each process writes its own file, `<pid>-<start ms>.log`, created exclusively and written synchronously and in full,
 * so no other process appends to it, nothing queued can be lost at exit, and its size is known without reopening it.
 */

const METHODS = ["log", "info", "debug", "warn", "error"] as const;
type ConsoleMethod = (typeof METHODS)[number];
type ConsoleWriter = (...args: unknown[]) => void;

const ROUTER_KEY = Symbol.for("atomic-workflows/run-console@3");
/** Per run, within this process's log. */
export const MAX_RUN_CONSOLE_BYTES = 8 * 1024 * 1024;
/** Per process log. */
export const MAX_PROCESS_CONSOLE_LOG_BYTES = 64 * 1024 * 1024;
/** Logs of exited processes not written for this long are deleted when routing starts, then the oldest until the directory fits. */
export const CONSOLE_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_CONSOLE_LOG_DIRECTORY_BYTES = 1024 * 1024 * 1024;
/** Runs whose byte count, cap and announcement are remembered; the oldest is forgotten first. */
const MAX_REMEMBERED_RUNS = 4096;
const MAX_CAUSE_DEPTH = 8;
const LOG_NAME = /^(\d+)-\d+\.log$/;

type RunOwner = (rootRunId: string) => boolean;

interface RunRecord {
	bytes: number;
	capped: boolean;
	announced: boolean;
}

interface ProcessLog {
	readonly path: string;
	readonly fd: number;
	bytes: number;
	capped: boolean;
}

interface RouterState {
	logDirectory: string | undefined;
	log: ProcessLog | undefined;
	/** Set once a write failed; the process's routed output is dropped from then on. */
	failed: boolean;
	readonly owners: Set<RunOwner>;
	readonly originals: Record<ConsoleMethod, ConsoleWriter>;
	/** Least recently written first. */
	readonly runs: Map<string, RunRecord>;
}

function routerBag(): Record<symbol, RouterState | undefined> {
	return globalThis as typeof globalThis & Record<symbol, RouterState | undefined>;
}

function isAbortCancellation(value: unknown, depth = 0): boolean {
	if (!(value instanceof Error) || depth > MAX_CAUSE_DEPTH) return false;
	if (value.name === "AbortError") return true;
	return value.cause !== value && isAbortCancellation(value.cause, depth + 1);
}

/** Writes every byte, or throws. */
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

function runRecord(state: RouterState, rootRunId: string): RunRecord {
	const existing = state.runs.get(rootRunId);
	if (existing !== undefined) {
		state.runs.delete(rootRunId);
		state.runs.set(rootRunId, existing);
		return existing;
	}
	const created: RunRecord = { bytes: 0, capped: false, announced: false };
	state.runs.set(rootRunId, created);
	if (state.runs.size > MAX_REMEMBERED_RUNS) state.runs.delete(state.runs.keys().next().value as string);
	return created;
}

/** Appends one routed call; returns whether its text is in the log. */
function append(log: ProcessLog, run: RunRecord, rootRunId: string, method: ConsoleMethod, args: unknown[]): boolean {
	if (log.capped || run.capped) return false;
	const stamp = new Date().toISOString();
	const line = `${stamp} ${rootRunId} ${method} ${format(...args)}\n`;
	const size = Buffer.byteLength(line);
	if (log.bytes + size > MAX_PROCESS_CONSOLE_LOG_BYTES) {
		log.capped = true;
		log.bytes += writeAll(log.fd, `${stamp} log limit reached; later workflow console output is dropped\n`);
		return false;
	}
	if (run.bytes + size > MAX_RUN_CONSOLE_BYTES) {
		run.capped = true;
		log.bytes += writeAll(log.fd, `${stamp} ${rootRunId} run log limit reached; its later output is dropped\n`);
		return false;
	}
	log.bytes += writeAll(log.fd, line);
	run.bytes += size;
	return true;
}

function write(state: RouterState, method: ConsoleMethod, args: unknown[], rootRunId: string, directory: string): void {
	if (state.failed) return;
	const run = runRecord(state, rootRunId);
	let log: ProcessLog;
	let written: boolean;
	try {
		log = processLog(state, directory);
		written = append(log, run, rootRunId, method, args);
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
		state.originals.warn(`atomic-workflows: run ${rootRunId} console output is in ${log.path}`);
	}
}

function routed(state: RouterState, method: ConsoleMethod): ConsoleWriter {
	return (...args: unknown[]) => {
		const directory = state.logDirectory;
		const rootRunId = directory === undefined ? undefined : currentRunTreeId();
		if (directory === undefined || rootRunId === undefined || ![...state.owners].some((owns) => owns(rootRunId)))
			state.originals[method](...args);
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
		log: undefined,
		failed: false,
		owners: new Set(),
		originals,
		runs: new Map(),
	};
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
 * Routes console output of the runs `owns` reports to this process's workflow log under `logDirectory`, after deleting
 * logs there that are past their retention. Returns a function that stops routing that owner's runs.
 */
export function routeWorkflowConsoleOutput(logDirectory: string, owns: RunOwner, now = Date.now()): () => void {
	mkdirSync(logDirectory, { recursive: true });
	try {
		pruneLogs(logDirectory, now);
	} catch {}
	const state = installedRouter();
	state.logDirectory = logDirectory;
	state.owners.add(owns);
	return () => state.owners.delete(owns);
}

/** Restores stderr for every later console call and closes the log; output already routed stays in its file. */
export function stopRoutingWorkflowConsoleOutput(): void {
	const state = routerBag()[ROUTER_KEY];
	if (state === undefined) return;
	state.logDirectory = undefined;
	state.owners.clear();
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
