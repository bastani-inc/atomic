import { closeSync, fstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { type FileHandle, mkdir, open, readdir, rm, stat } from "node:fs/promises";
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
 * Each process writes its own file, `<pid>-<start ms>.log`, created exclusively, so no other process appends to it.
 * A console call never waits for the disk: its line is counted against the limits when it is made, so the log's size is
 * known without reopening it, and queued for one writer that appends lines in call order. Whatever is still queued when
 * the process exits is written then, so nothing accepted is lost. A run's share and announcement live with its scope,
 * so they last exactly as long as its code can still log.
 */

const METHODS = ["log", "info", "debug", "warn", "error"] as const;
type ConsoleMethod = (typeof METHODS)[number];
type ConsoleWriter = (...args: unknown[]) => void;

const ROUTER_KEY = Symbol.for("atomic-workflows/run-console@5");
/** Per run tree, within this process's log. */
export const MAX_RUN_CONSOLE_BYTES = 8 * 1024 * 1024;
/** Per process log, markers included. */
export const MAX_PROCESS_CONSOLE_LOG_BYTES = 64 * 1024 * 1024;
/** Logs of exited processes not written for this long are deleted when routing starts, then the oldest until the directory fits. */
export const CONSOLE_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_CONSOLE_LOG_DIRECTORY_BYTES = 1024 * 1024 * 1024;
const MAX_CAUSE_DEPTH = 8;
const LOG_NAME = /^(\d+)-\d+\.log$/;

/** Text accepted into a log, with the announcement to print once it is on disk. */
interface QueuedText {
	readonly text: string;
	readonly announcement?: string;
}

/** Text the writer is writing, until it knows the write completed. */
interface InFlight {
	readonly buffer: Buffer;
	readonly announcements: readonly string[];
}

interface ProcessLog {
	readonly directory: string;
	readonly path: string;
	/** Creating and pruning `directory`; the log is opened after it. */
	readonly directoryReady: Promise<void>;
	/** Bytes accepted, written or still queued. */
	bytes: number;
	/** Bytes known to be in the file. */
	written: number;
	capped: boolean;
	handle: FileHandle | undefined;
	readonly queue: QueuedText[];
	inFlight: InFlight | undefined;
	/** The writer appending `queue`, while one runs. */
	writing: Promise<void> | undefined;
}

interface RouterState {
	logDirectory: string | undefined;
	/** Creating and pruning the log directory routing last started with. */
	directoryReady: Promise<void>;
	log: ProcessLog | undefined;
	/** Logs not closed yet: the current one, and stopped ones still writing their queue. */
	readonly open: Set<ProcessLog>;
	/** Set once a write failed; routed output is dropped from then on. */
	failed: boolean;
	readonly originals: Record<ConsoleMethod, ConsoleWriter>;
}

function routerBag(): Record<symbol, RouterState | undefined> {
	return globalThis as typeof globalThis & Record<symbol, RouterState | undefined>;
}

/** Whether a logged value is a cancellation; never throws, since it only decides whether to announce the log. */
function isAbortCancellation(value: unknown, depth = 0): boolean {
	try {
		if (!(value instanceof Error) || depth > MAX_CAUSE_DEPTH) return false;
		if (value.name === "AbortError") return true;
		const cause: unknown = value.cause;
		return cause !== value && isAbortCancellation(cause, depth + 1);
	} catch {
		return false;
	}
}

/** Writes every byte of `buffer`, or throws. */
async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
		if (bytesWritten <= 0) throw new Error(`wrote ${offset} of ${buffer.length} bytes`);
		offset += bytesWritten;
	}
}

function processLog(state: RouterState, directory: string): ProcessLog {
	if (state.log !== undefined) return state.log;
	state.log = {
		directory,
		path: join(directory, `${process.pid}-${Date.now()}.log`),
		directoryReady: state.directoryReady,
		bytes: 0,
		written: 0,
		capped: false,
		handle: undefined,
		queue: [],
		inFlight: undefined,
		writing: undefined,
	};
	state.open.add(state.log);
	return state.log;
}

async function closeLog(state: RouterState, log: ProcessLog): Promise<void> {
	state.open.delete(log);
	const handle = log.handle;
	log.handle = undefined;
	await handle?.close().catch(() => undefined);
}

/** A write failed: report it once, and drop the queue and every later routed call. */
async function failLog(state: RouterState, log: ProcessLog, error: unknown): Promise<void> {
	const path = log.handle === undefined ? log.directory : log.path;
	log.queue.length = 0;
	log.inFlight = undefined;
	if (state.log === log) {
		state.log = undefined;
		state.failed = true;
	}
	const cause = error instanceof Error ? error.message : String(error);
	state.originals.warn(
		`atomic-workflows: workflow console output could not be written to ${path} (${cause}); later workflow console output is dropped`,
	);
	await closeLog(state, log);
}

/** Appends the queue in call order: one writer per log, started by queued text and ending once the queue is empty. */
function startWriting(state: RouterState, log: ProcessLog): void {
	if (log.writing !== undefined) return;
	log.writing = (async () => {
		try {
			await log.directoryReady;
			log.handle ??= await open(log.path, "wx");
			while (log.queue.length > 0) {
				const batch = log.queue.splice(0);
				const inFlight: InFlight = {
					buffer: Buffer.from(batch.map(({ text }) => text).join("")),
					announcements: batch.flatMap(({ announcement }) => (announcement === undefined ? [] : [announcement])),
				};
				log.inFlight = inFlight;
				await writeAll(log.handle, inFlight.buffer);
				log.written += inFlight.buffer.length;
				log.inFlight = undefined;
				for (const announcement of inFlight.announcements) state.originals.warn(announcement);
			}
		} catch (error) {
			await failLog(state, log, error);
		} finally {
			log.writing = undefined;
		}
	})();
}

/** Accepts `text` into the log; returns its size in bytes. */
function enqueue(state: RouterState, log: ProcessLog, text: string, announcement?: string): number {
	log.queue.push(announcement === undefined ? { text } : { text, announcement });
	startWriting(state, log);
	return Buffer.byteLength(text);
}

/** Writes every byte of `buffer` at `position`, or throws. */
function writeAllSync(fd: number, buffer: Buffer, position: number): void {
	let offset = 0;
	while (offset < buffer.length) {
		const written = writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
		if (written <= 0) throw new Error(`wrote ${offset} of ${buffer.length} bytes`);
		offset += written;
	}
}

/**
 * Writes what the writer has not, as the process exits and no writer can run any more. The writer's last write may
 * have reached the file, wholly or in part, without its completion being seen: the file's size says how much did.
 */
function writeQueuedAtExit(state: RouterState): void {
	for (const log of state.open) {
		const inFlight = log.inFlight;
		const queued = log.queue.splice(0);
		if (inFlight === undefined && queued.length === 0) continue;
		try {
			let fd = log.handle?.fd;
			if (fd === undefined) {
				// The writer may have created the file without getting its handle back, so it need not be new.
				mkdirSync(log.directory, { recursive: true });
				fd = openSync(log.path, "a");
			}
			const onDisk = fstatSync(fd).size;
			const unwritten = inFlight?.buffer.subarray(Math.max(0, onDisk - log.written)) ?? Buffer.alloc(0);
			writeAllSync(fd, Buffer.concat([unwritten, Buffer.from(queued.map(({ text }) => text).join(""))]), onDisk);
			if (log.handle === undefined) closeSync(fd);
			for (const announcement of inFlight?.announcements ?? []) state.originals.warn(announcement);
			for (const { announcement } of queued) if (announcement !== undefined) state.originals.warn(announcement);
		} catch {}
	}
}

/**
 * Accepts one routed call; returns whether its text goes to the log. Every write leaves room for the process-limit
 * marker, so the log never exceeds its limit, markers included. `announcement` is printed once the call's line is in
 * the file.
 */
function append(
	state: RouterState,
	log: ProcessLog,
	run: RunConsole,
	method: ConsoleMethod,
	args: unknown[],
	announcement: string | undefined,
): boolean {
	if (log.capped || run.capped) return false;
	const stamp = new Date().toISOString();
	const processMarker = `${stamp} log limit reached; later workflow console output is dropped\n`;
	const fits = (text: string) =>
		log.bytes + Buffer.byteLength(text) + Buffer.byteLength(processMarker) <= MAX_PROCESS_CONSOLE_LOG_BYTES;
	const capProcess = () => {
		log.capped = true;
		log.bytes += enqueue(state, log, processMarker);
		return false;
	};
	const line = `${stamp} ${run.rootRunId} ${method} ${format(...args)}\n`;
	const size = Buffer.byteLength(line);
	// The run's share is decided first: a call its run cannot afford caps that run only, unless its marker no longer fits.
	if (run.bytes + size > MAX_RUN_CONSOLE_BYTES) {
		run.capped = true;
		const runMarker = `${stamp} ${run.rootRunId} run log limit reached; its later output is dropped\n`;
		if (!fits(runMarker)) return capProcess();
		log.bytes += enqueue(state, log, runMarker);
		return false;
	}
	if (!fits(line)) return capProcess();
	log.bytes += enqueue(state, log, line, announcement);
	run.bytes += size;
	return true;
}

function write(state: RouterState, method: ConsoleMethod, args: unknown[], run: RunConsole, directory: string): void {
	if (state.failed) return;
	const log = processLog(state, directory);
	// A cancellation never names the log; any other first line of a run does, once it is on disk.
	const announcement =
		run.announced || args.some((arg) => isAbortCancellation(arg))
			? undefined
			: `atomic-workflows: run ${run.rootRunId} console output is in ${log.path}`;
	if (append(state, log, run, method, args, announcement) && announcement !== undefined) run.announced = true;
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
	const state: RouterState = {
		logDirectory: undefined,
		directoryReady: Promise.resolve(),
		log: undefined,
		open: new Set(),
		failed: false,
		originals,
	};
	for (const method of METHODS) console[method] = routed(state, method);
	process.on("exit", () => writeQueuedAtExit(state));
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
async function pruneLogs(directory: string, now: number): Promise<void> {
	const logs: Array<{
		readonly path: string;
		readonly mtimeMs: number;
		readonly size: number;
		readonly live: boolean;
	}> = [];
	for (const name of await readdir(directory)) {
		const pid = LOG_NAME.exec(name)?.[1];
		if (pid === undefined) continue;
		const path = join(directory, name);
		try {
			const { mtimeMs, size } = await stat(path);
			logs.push({ path, mtimeMs, size, live: processAlive(Number(pid)) });
		} catch {}
	}
	let total = logs.reduce((sum, log) => sum + log.size, 0);
	for (const log of logs.filter(({ live }) => !live).sort((left, right) => left.mtimeMs - right.mtimeMs)) {
		if (now - log.mtimeMs < CONSOLE_LOG_RETENTION_MS && total <= MAX_CONSOLE_LOG_DIRECTORY_BYTES) break;
		try {
			await rm(log.path, { force: true });
			total -= log.size;
		} catch {}
	}
}

/**
 * Sends the console output of runs started with `consoleLog` to this process's workflow log under `logDirectory`,
 * after deleting logs there that are past their retention. Idempotent. Routing starts at once; the directory is made
 * and pruned in the background, before the log is first written.
 */
export function routeWorkflowConsoleOutput(logDirectory: string, now = Date.now()): void {
	const state = installedRouter();
	if (state.logDirectory === logDirectory) return;
	// Routing starts even when the directory cannot be made: the first routed write then fails and is reported once,
	// rather than every routed call going to stderr.
	state.directoryReady = (async () => {
		try {
			await mkdir(logDirectory, { recursive: true });
			await pruneLogs(logDirectory, now);
		} catch {}
	})();
	state.logDirectory = logDirectory;
}

/** Resolves once every console call routed so far is in its log, or dropped after a failed write. */
export async function flushWorkflowConsoleOutput(): Promise<void> {
	const state = routerBag()[ROUTER_KEY];
	if (state === undefined) return;
	await state.directoryReady;
	for (const log of [...state.open]) while (log.writing !== undefined) await log.writing;
}

/**
 * Restores stderr for every later console call and closes the log once its queued output is written; output already
 * routed stays in its file.
 */
export async function stopRoutingWorkflowConsoleOutput(): Promise<void> {
	const state = routerBag()[ROUTER_KEY];
	if (state === undefined) return;
	state.logDirectory = undefined;
	state.failed = false;
	const log = state.log;
	state.log = undefined;
	if (log === undefined) return;
	while (log.writing !== undefined) await log.writing;
	await closeLog(state, log);
}

/** This process's workflow log, once something was routed to it. */
export function workflowConsoleLogPath(): string | undefined {
	return routerBag()[ROUTER_KEY]?.log?.path;
}
