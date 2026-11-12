import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, readFileSync, readlinkSync, rmdirSync, rmSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { hostname, release } from "node:os";
import { join } from "node:path";
import { BroadcastChannel, isMainThread, receiveMessageOnPort } from "node:worker_threads";
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
/** A process directory's pid/start owner and optional instance nonce; old nonce-free names remain sweepable. */
const PROCESS_DIRECTORY_NAME = /^([1-9][0-9]*)-([A-Za-z0-9]+)(?:-[a-f0-9]{32})?$/;
/** Generated once for this owner, not per store: even identical pid/start pairs must never share exit cleanup. */
const PROCESS_NONCE = randomBytes(16).toString("hex");
/** How long a lookup of a process's start time may take before it counts as one that cannot tell. */
const START_TIME_TIMEOUT_MS = 30_000;

/** Where released sessions' history is kept under an agent directory: a directory per host, then one per process. */
export function releasedHistoryDirectory(agentDir: string): string {
	return join(agentDir, "released-history");
}

let identity: Promise<string | undefined> | undefined;

/** A boot and PID namespace in which a pid/start-time pair identifies the same owner for every reader. */
function namespaceIdentity(): Promise<string | undefined> {
	identity ??= (async () => {
		if (process.platform === "linux") {
			try {
				const ownNamespace = readlinkSync("/proc/self/ns/pid");
				// NSpid lists IDs from the proc mount's namespace down to ours. More than one means a foreign view,
				// even if the numeric IDs happen to coincide. Missing/unreadable status is not proof of a matching view.
				const status = readFileSync("/proc/self/status", "utf8");
				const procPid = /^NSpid:[ \t]+([0-9]+)[ \t]*$/m.exec(status);
				if (procPid?.[1] !== String(process.pid)) return undefined;
				const namespace = /^pid:\[([0-9]+)\]$/.exec(ownNamespace);
				const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
				if (namespace === null || boot.length === 0) return undefined;
				return `linux-${namespace[1]}-${boot}`;
			} catch {
				return undefined;
			}
		}
		if (process.platform === "darwin") {
			const boot = await run("sysctl", ["-n", "kern.boottime"]);
			const seconds = /sec = ([0-9]+), usec = ([0-9]+)/.exec(boot.stdout);
			return boot.ran && boot.exitCode === 0 && seconds !== null
				? `darwin-${release()}-${seconds[1]}-${seconds[2]}`
				: undefined;
		}
		if (process.platform === "win32") {
			for (const executable of powershellCandidates()) {
				const boot = await run(executable, [
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToFileTimeUtc()",
				]);
				if (boot.ran)
					return boot.exitCode === 0 && /^[0-9]+$/.test(boot.stdout)
						? `win32-${release()}-${boot.stdout}`
						: undefined;
			}
		}
		return undefined;
	})();
	return identity;
}

async function hostDirectory(agentDir: string): Promise<string> {
	// An unknown identity is never swept; the process-directory nonce still isolates owners with identical PIDs.
	const key = (await namespaceIdentity()) ?? `${process.platform}-unknown-${process.pid}-${await ownStartTime()}`;
	const host = hostname();
	// Hash the complete identity: truncating a long hostname must not drop the namespace or boot from the key.
	const digest = createHash("sha256")
		.update(JSON.stringify([host, key]))
		.digest("hex");
	return join(releasedHistoryDirectory(agentDir), `${sanitizeTempPathComponent(host, "host")}-${digest}`);
}

/**
 * When process `pid` started, as a token only ever compared with another reading of it: undefined when no process has
 * that pid, null when this platform, or that process, cannot tell.
 */
async function processStartTime(pid: number): Promise<string | null | undefined> {
	if (process.platform === "linux") {
		if ((await namespaceIdentity()) === undefined) return null;
		try {
			// Clock ticks from boot to the process's start. `/proc` is answered by the kernel, never from a disk.
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
			return start !== undefined && /^[0-9]+$/.test(start) ? start : null;
		} catch {
			return null;
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
			if (output.ran) return output.exitCode === 0 && /^[0-9]+$/.test(output.stdout) ? output.stdout : null;
		}
		return null;
	}
	const output = await run("ps", ["-o", "lstart=", "-p", String(pid)], { LC_ALL: "C", TZ: "UTC" });
	if (!output.ran) return null;
	// An unsuccessful or malformed lookup cannot establish that an owner has been replaced.
	if (output.exitCode === 1 && output.stdout.length === 0) return undefined;
	if (
		output.exitCode !== 0 ||
		!/^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)[ \t]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ \t]+[0-9]{1,2}[ \t]+[0-9]{2}:[0-9]{2}:[0-9]{2}[ \t]+[0-9]{4}$/.test(
			output.stdout,
		)
	)
		return null;
	return output.stdout.replace(/[^A-Za-z0-9]+/g, "");
}

/** Neutral working directory so background OS probes never hold a handle on the caller's cwd (#4655). */
function probeWorkingDirectory(): string {
	return process.platform === "win32" ? process.env.SystemRoot || process.env.windir || "C:\\Windows" : "/";
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
				cwd: probeWorkingDirectory(),
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

/** Whether a process has `pid`; only ESRCH proves absence, and permission failures remain unknown. */
function processExists(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return getErrnoCode(error) === "ESRCH" ? false : undefined;
	}
}

/**
 * Whether the process that created the directory named for `pid` and `start` may still run: a process has that pid
 * and started at that time, or has that pid and one of the two start times cannot be told.
 */
async function ownerMayRun(pid: number, start: string): Promise<boolean> {
	const exists = processExists(pid);
	if (exists === false) return false;
	if (exists === undefined) return true;
	const current = pid === process.pid ? await ownStartTime() : await processStartTime(pid);
	return current == null || current === UNKNOWN_START || start === UNKNOWN_START || current === start;
}

/**
 * Removes the directories that processes on this host left under `agentDir` when they ended without removing them,
 * such as one killed with SIGKILL: those whose pid no process has, or has with another start time. A directory whose
 * process may still run is kept, and so is anything this module does not create. Never rejects: what cannot be removed
 * now is left to the next sweep.
 */
export async function sweepReleasedHistory(agentDir: string): Promise<void> {
	if ((await namespaceIdentity()) === undefined) return;
	const host = await hostDirectory(agentDir);
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
	const path = join(await hostDirectory(agentDir), `${process.pid}-${await ownStartTime()}-${PROCESS_NONCE}`);
	try {
		await mkdir(path, { recursive: true, mode: SESSION_TEMP_DIR_MODE });
	} catch (cause) {
		return new SessionSpillError("spill-dir-refused", { directory: path, errno: getErrnoCode(cause) }, { cause });
	}
	usedProcessDirectories.add(path);
	if (!isMainThread) registry.postMessage({ directory: path });
	removeAtExit();
	return path;
}

let exitCleanupInstalled = false;

/** Process-local, including workers whose main thread owns no store. Registration never delays a release. */
const registry = new BroadcastChannel("atomic-released-history-directories");
registry.unref();
if (isMainThread) {
	registry.onmessage = ({ data }) => registerWorkerDirectory(data);
	removeAtExit();
	registry.postMessage({ announce: true });
} else {
	registry.onmessage = ({ data }) => {
		if (data.announce === true) for (const directory of usedProcessDirectories) registry.postMessage({ directory });
	};
}

function registerWorkerDirectory(data: { readonly directory?: string }): void {
	if (typeof data.directory !== "string") return;
	usedProcessDirectories.add(data.directory);
	registry.postMessage({ registered: data.directory });
}

function removeAtExit(): void {
	if (exitCleanupInstalled) return;
	exitCleanupInstalled = true;
	process.once("exit", removeDirectories);
}

/**
 * Removes at once what this thread keeps on disk, as it exits. Main removes only the nonce-bearing directories
 * created by itself or registered workers; a worker thread removes its own stores' directories.
 */
function removeDirectories(): void {
	if (isMainThread) {
		// A worker can report readiness on its parent port before this channel's event callback runs.
		// Node and Bun accept BroadcastChannel here; Bun's declaration still only lists MessagePort.
		const port = registry as unknown as Parameters<typeof receiveMessageOnPort>[0];
		for (let message = receiveMessageOnPort(port); message !== undefined; message = receiveMessageOnPort(port))
			registerWorkerDirectory(message.message);
	}
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
		// FICLONE requests reflinks where supported; Node falls back to a plain copy otherwise.
		if (previous !== undefined) await copyFile(previous.path, staging, constants.COPYFILE_FICLONE);
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
		async write(file, data, previous) {
			const before = previous === undefined ? undefined : { path: fileAt(previous.file), bytes: previous.bytes };
			try {
				await writeWhole(fileAt(file), data, before);
			} catch (error) {
				if (getErrnoCode(error) !== "ENOENT") throw error;
				await mkdir(path, { recursive: true, mode: SESSION_TEMP_DIR_MODE });
				await writeWhole(fileAt(file), data, before);
			}
		},
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
 * Released sessions' history in `<agentDir>/released-history/<host-identity>/<pid>-<start>-<nonce>/`: host identity includes
 * hostname, platform, boot, and Linux PID namespace. Store directories/files are owner-only (0700/0600) on POSIX;
 * Windows inherits the agent directory's ACL. The last handle closing removes its store directory. Main-thread exit
 * removes registered worker directories too, even after terminate(); worker-only SDK imports cannot install main
 * cleanup. Normal worker exit removes its stores. A matching namespace/boot's next startup sweeps killed owners;
 * uncertain identities and owners are always kept.
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
