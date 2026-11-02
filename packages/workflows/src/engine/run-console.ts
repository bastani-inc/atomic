import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
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
 * every call while routing is off (print mode, SDK hosts, pooled worker processes), keep writing to stderr.
 */

const METHODS = ["log", "info", "debug", "warn", "error"] as const;
type ConsoleMethod = (typeof METHODS)[number];
type ConsoleWriter = (...args: unknown[]) => void;

const ROUTER_KEY = Symbol.for("atomic-workflows/run-console@1");
/** Per run tree; output past it is counted, not written. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_CAUSE_DEPTH = 8;

interface RunLog {
	readonly path: string;
	bytes: number;
	dropped: number;
	announced: boolean;
	tail: Promise<void>;
}

interface RouterState {
	logDirectory: string | undefined;
	readonly originals: Record<ConsoleMethod, ConsoleWriter>;
	readonly logs: Map<string, RunLog>;
}

function routerBag(): Record<symbol, RouterState | undefined> {
	return globalThis as typeof globalThis & Record<symbol, RouterState | undefined>;
}

function isAbortCancellation(value: unknown, depth = 0): boolean {
	if (!(value instanceof Error) || depth > MAX_CAUSE_DEPTH) return false;
	if (value.name === "AbortError") return true;
	return value.cause !== value && isAbortCancellation(value.cause, depth + 1);
}

function fileName(rootRunId: string): string {
	return `${encodeURIComponent(rootRunId).replaceAll(".", "%2E")}.log`;
}

function runLog(state: RouterState, directory: string, rootRunId: string): RunLog {
	const existing = state.logs.get(rootRunId);
	if (existing !== undefined) return existing;
	const created: RunLog = {
		path: join(directory, fileName(rootRunId)),
		bytes: 0,
		dropped: 0,
		announced: false,
		tail: Promise.resolve(),
	};
	state.logs.set(rootRunId, created);
	return created;
}

function append(log: RunLog, text: string): void {
	log.tail = log.tail.then(() => appendFile(log.path, text)).catch(() => undefined);
}

function write(state: RouterState, method: ConsoleMethod, args: unknown[], rootRunId: string, directory: string): void {
	const log = runLog(state, directory, rootRunId);
	if (!log.announced && !args.some((arg) => isAbortCancellation(arg))) {
		log.announced = true;
		state.originals.warn(`atomic-workflows: run ${rootRunId} console output is in ${log.path}`);
	}
	const line = `${new Date().toISOString()} ${method} ${format(...args)}\n`;
	const size = Buffer.byteLength(line);
	if (log.bytes + size > MAX_LOG_BYTES) {
		if (log.dropped++ === 0) append(log, `${new Date().toISOString()} log limit reached; later output is dropped\n`);
		return;
	}
	log.bytes += size;
	append(log, line);
}

function routed(state: RouterState, method: ConsoleMethod): ConsoleWriter {
	return (...args: unknown[]) => {
		const directory = state.logDirectory;
		const rootRunId = directory === undefined ? undefined : currentRunTreeId();
		if (directory === undefined || rootRunId === undefined) {
			state.originals[method](...args);
			return;
		}
		try {
			write(state, method, args, rootRunId, directory);
		} catch {
			state.originals[method](...args);
		}
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
	const state: RouterState = { logDirectory: undefined, originals, logs: new Map() };
	for (const method of METHODS) console[method] = routed(state, method);
	bag[ROUTER_KEY] = state;
	return state;
}

/** Route console output of workflow code running in this process to per-run log files under `logDirectory`. */
export function routeWorkflowConsoleOutput(logDirectory: string): void {
	mkdirSync(logDirectory, { recursive: true });
	installedRouter().logDirectory = logDirectory;
}

/** Restore stderr for every later console call; output already routed stays in its log files. */
export function stopRoutingWorkflowConsoleOutput(): void {
	const state = routerBag()[ROUTER_KEY];
	if (state !== undefined) state.logDirectory = undefined;
}

/** The log file a run tree's routed console output goes to, once it has written any. */
export function workflowConsoleLogPath(rootRunId: string): string | undefined {
	return routerBag()[ROUTER_KEY]?.logs.get(rootRunId)?.path;
}

/** Resolves when every routed write so far has reached its file. */
export async function flushWorkflowConsoleOutput(): Promise<void> {
	const state = routerBag()[ROUTER_KEY];
	if (state !== undefined) await Promise.all([...state.logs.values()].map((log) => log.tail));
}
