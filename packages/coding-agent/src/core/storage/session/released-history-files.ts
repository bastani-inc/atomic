import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmdirSync, rmSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { getErrnoCode } from "../../tools/errno.ts";
import {
	SESSION_TEMP_DIR_MODE,
	SESSION_TEMP_FILE_MODE,
	sanitizeTempPathComponent,
} from "../../tools/session-temp-dir.ts";
import { powershellCandidates } from "../../tools/windows-directory-security.ts";
import { SessionSpillError } from "../errors.js";
import type { SessionHistoryDirectory, SessionHistoryFiles } from "./memory-session-store.js";

/** The start time recorded for a process whose start time could not be told. */
const UNKNOWN_START = "unknown";
/** A process directory's name: the pid, then the start time, of the process that created it. */
const PROCESS_DIRECTORY_NAME = /^([1-9][0-9]*)-([A-Za-z0-9]+)$/;
/** How long a lookup of a process's start time may take before it counts as one that cannot tell. */
const START_TIME_TIMEOUT_MS = 30_000;

/** Where released sessions' history is kept under an agent directory: a directory per host, then one per process. */
export function releasedHistoryDirectory(agentDir: string): string {
	return join(agentDir, "released-history");
}

function hostDirectory(agentDir: string): string {
	return join(releasedHistoryDirectory(agentDir), sanitizeTempPathComponent(hostname(), "host"));
}

/**
 * When process `pid` started, as a token only ever compared with another reading of it: undefined when no process has
 * that pid, null when this platform, or that process, cannot tell.
 */
async function processStartTime(pid: number): Promise<string | null | undefined> {
	if (process.platform === "linux") {
		try {
			// Clock ticks from boot to the process's start. `/proc` is answered by the kernel, never from a disk.
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
		} catch (error) {
			return getErrnoCode(error) === "ENOENT" ? undefined : null;
		}
	}
	if (process.platform === "win32") {
		for (const executable of powershellCandidates()) {
			const output = await run(executable, [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
			]);
			if (output.ran) return /^[0-9]+$/.test(output.stdout) ? output.stdout : null;
		}
		return null;
	}
	const output = await run("ps", ["-o", "lstart=", "-p", String(pid)], { LC_ALL: "C", TZ: "UTC" });
	const start = output.stdout.replace(/[^A-Za-z0-9]+/g, "");
	if (start.length > 0) return start;
	// `ps` exits with 1 when no process has the pid.
	return output.ran && output.exitCode === 1 ? undefined : null;
}

/** Runs a short command; `ran` is false when it could not be started or did not finish in time. */
function run(
	command: string,
	args: readonly string[],
	env?: NodeJS.ProcessEnv,
): Promise<{ readonly ran: boolean; readonly exitCode: number; readonly stdout: string }> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{
				encoding: "utf8",
				timeout: START_TIME_TIMEOUT_MS,
				windowsHide: true,
				...(env === undefined ? {} : { env: { ...process.env, ...env } }),
			},
			(error, stdout) => {
				const exitCode = (error as { readonly code?: unknown } | null)?.code;
				resolve({
					ran: error === null || (typeof exitCode === "number" && error.killed !== true),
					exitCode: typeof exitCode === "number" ? exitCode : 0,
					stdout: stdout.trim(),
				});
			},
		);
	});
}

let ownStart: Promise<string> | undefined;

/** This process's start time, read once for the process; {@link UNKNOWN_START} when it cannot be told. */
function ownStartTime(): Promise<string> {
	ownStart ??= processStartTime(process.pid).then((start) => start ?? UNKNOWN_START);
	return ownStart;
}

/** Whether a process has `pid`; one that belongs to another account counts. */
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return getErrnoCode(error) !== "ESRCH";
	}
}

/**
 * Whether the process that created the directory named for `pid` and `start` may still run: a process has that pid
 * and started at that time, or has that pid and one of the two start times cannot be told.
 */
async function ownerMayRun(pid: number, start: string): Promise<boolean> {
	const current =
		pid === process.pid ? await ownStartTime() : processExists(pid) ? await processStartTime(pid) : undefined;
	if (current === undefined) return false;
	return current === null || current === UNKNOWN_START || start === UNKNOWN_START || current === start;
}

/**
 * Removes the directories that processes on this host left under `agentDir` when they ended without removing them,
 * such as one killed with SIGKILL: those whose pid no process has, or has with another start time. A directory whose
 * process may still run is kept, and so is anything this module does not create. Never rejects: what cannot be removed
 * now is left to the next sweep.
 */
export async function sweepReleasedHistory(agentDir: string): Promise<void> {
	const host = hostDirectory(agentDir);
	let names: string[];
	try {
		names = await readdir(host);
	} catch {
		return;
	}
	await Promise.all(
		names.map(async (name) => {
			const owner = PROCESS_DIRECTORY_NAME.exec(name);
			if (owner === null || (await ownerMayRun(Number(owner[1]), owner[2] as string))) return;
			await rm(join(host, name), { recursive: true, force: true }).catch(() => undefined);
		}),
	);
}

/** Agent directories this process has swept, or is sweeping. */
const swept = new Set<string>();

/** Sweeps `agentDir` in the background, once for this process; see {@link sweepReleasedHistory}. */
export function sweepReleasedHistoryOnce(agentDir: string): void {
	if (swept.has(agentDir)) return;
	swept.add(agentDir);
	void sweepReleasedHistory(agentDir);
}

/** Each agent directory's process directory, once this thread has created it. */
const processDirectories = new Map<string, Promise<string | SessionSpillError>>();
/** Process directories this thread created a store's directory in. */
const usedProcessDirectories = new Set<string>();
/** Store directories this thread created and has not removed. */
const openDirectories = new Set<string>();

/** The process directory under `agentDir`, created once; one that could not be created is tried again next time. */
function processDirectory(agentDir: string): Promise<string | SessionSpillError> {
	let directory = processDirectories.get(agentDir);
	if (directory === undefined) {
		const creating = createProcessDirectory(agentDir).then((created) => {
			if (created instanceof SessionSpillError) processDirectories.delete(agentDir);
			return created;
		});
		processDirectories.set(agentDir, creating);
		directory = creating;
	}
	return directory;
}

async function createProcessDirectory(agentDir: string): Promise<string | SessionSpillError> {
	const path = join(hostDirectory(agentDir), `${process.pid}-${await ownStartTime()}`);
	try {
		await mkdir(path, { recursive: true, mode: SESSION_TEMP_DIR_MODE });
	} catch (cause) {
		return new SessionSpillError("spill-dir-refused", { directory: path, errno: getErrnoCode(cause) }, { cause });
	}
	usedProcessDirectories.add(path);
	removeAtExit();
	return path;
}

let exitCleanupInstalled = false;

function removeAtExit(): void {
	if (exitCleanupInstalled) return;
	exitCleanupInstalled = true;
	process.once("exit", removeDirectories);
}

/**
 * Removes at once what this thread keeps on disk, as it exits. The main thread removes its process's whole directory,
 * with what its worker threads keep there, since they end with it; a worker thread removes its own stores' directories.
 */
function removeDirectories(): void {
	for (const path of isMainThread ? usedProcessDirectories : openDirectories) {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			// Nothing can report it while the thread ends; the next sweep removes what is left once the process is gone.
		}
	}
	openDirectories.clear();
	if (isMainThread) return;
	for (const path of usedProcessDirectories) {
		try {
			rmdirSync(path);
		} catch {
			// Another thread's stores are still in it.
		}
	}
}

/** A store's directory is gone; once this thread has none, its process directory goes too, unless a thread uses it. */
async function closed(path: string): Promise<void> {
	openDirectories.delete(path);
	if (openDirectories.size > 0) return;
	for (const directory of usedProcessDirectories) await rmdir(directory).catch(() => undefined);
}

/** Writes `data` at `position` of the file at `path`, creating the file when `position` is 0. */
async function writeAt(path: string, data: Uint8Array, position: number): Promise<void> {
	const handle = await open(path, position === 0 ? "w" : "r+", SESSION_TEMP_FILE_MODE);
	let failure: unknown;
	try {
		for (let written = 0; written < data.byteLength; ) {
			const { bytesWritten } = await handle.write(data, written, data.byteLength - written, position + written);
			written += bytesWritten;
		}
	} catch (error) {
		failure = error;
	}
	try {
		await handle.close();
	} catch (closeFailure) {
		if (failure === undefined) throw closeFailure;
		if (failure instanceof Error) Object.defineProperty(failure, "cleanupCause", { value: closeFailure });
	}
	if (failure !== undefined) throw failure;
}

/**
 * Writes the file at `path` whole, a copy of `previous` followed by `data`, into a file of its own that is renamed to
 * `path` once complete: a write cut short, by a failure or by the process being killed, never leaves part of a file
 * under that name.
 */
async function writeWhole(
	path: string,
	data: Uint8Array,
	previous: { readonly path: string; readonly bytes: number } | undefined,
): Promise<void> {
	const staging = `${path}.partial`;
	try {
		if (previous !== undefined) await copyFile(previous.path, staging);
		await writeAt(staging, data, previous?.bytes ?? 0);
		await rename(staging, path);
	} catch (error) {
		await rm(staging, { force: true }).catch(() => undefined);
		throw error;
	}
}

function historyDirectory(path: string): SessionHistoryDirectory {
	const fileAt = (file: number) => join(path, String(file));
	return {
		path,
		write: (file, data, previous) =>
			writeWhole(
				fileAt(file),
				data,
				previous === undefined ? undefined : { path: fileAt(previous.file), bytes: previous.bytes },
			),
		read: (file) => readFile(fileAt(file)),
		async removeFile(file) {
			await rm(fileAt(file), { force: true });
		},
		async remove() {
			await rm(path, { recursive: true, force: true });
			await closed(path);
		},
	};
}

/**
 * Released sessions' history in files under the agent directory, in `<agentDir>/released-history/<host>/<pid>-<start>/`,
 * a directory for this process named for its pid and start time: an owner-only directory (0700) per store, with an
 * owner-only file (0600) per session. A store's directory is removed when its last handle closes, and the process's
 * directory when the process exits, through `process.exit()` too, as Atomic's own signal handlers end it; a worker
 * thread removes its own stores' directories when it exits. What a process ended any other way leaves behind, such as
 * one killed with SIGKILL, or by a signal nothing handles, is removed by the next process that opens a store over
 * the same agent directory, once no process has that pid and start time; opening one starts that sweep.
 */
export function releasedHistoryFiles(agentDir: string): SessionHistoryFiles {
	sweepReleasedHistoryOnce(agentDir);
	return {
		async createDirectory() {
			const parent = await processDirectory(agentDir);
			if (parent instanceof SessionSpillError) return parent;
			const path = join(parent, randomBytes(6).toString("hex"));
			try {
				// Recursive: the process directory goes when this thread's last store closes, and comes back with the next.
				await mkdir(path, { recursive: true, mode: SESSION_TEMP_DIR_MODE });
			} catch (cause) {
				return new SessionSpillError(
					"spill-dir-refused",
					{ directory: path, errno: getErrnoCode(cause) },
					{ cause },
				);
			}
			openDirectories.add(path);
			return historyDirectory(path);
		},
		report(degradation) {
			process.emitWarning(degradation);
		},
	};
}
