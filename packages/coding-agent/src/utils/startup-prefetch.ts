import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, constants, setPriority, uptime } from "node:os";
import { join } from "node:path";
import { startupNodeOptions } from "@bastani/atomic-codemode/node-options";
import { getAgentDir, isBunBinary, VERSION } from "../config.js";

/** Options that make Node run code of the user's in every process it starts: a preload or a module loader. */
const USER_CODE_OPTIONS = new Set(["--require", "-r", "--import", "--loader", "--experimental-loader"]);

/**
 * Reads the startup's files with this many in flight, on the reader process's own I/O pool, never this process's: four
 * per CPU, from 4 to 32, so that on a machine with few CPUs the reader leaves them to Atomic's own start.
 */
function readerThreads(): string {
	return String(Math.min(32, Math.max(4, 4 * availableParallelism())));
}

/**
 * The record, in the agent directory, that a reader read this installation's startup files (or found them already in
 * memory) since the machine last started: `startup-prefetch-reader.ts` writes it.
 */
export const STARTUP_FILES_READ_MARKER = "startup-files-read.json";

/** How far two readings of when the machine last started may differ and still name the same start. */
const BOOT_TIME_TOLERANCE_MS = 10_000;

/** When the machine last started, from how long it has been running; the system clock moving changes it. */
export function machineStartTimeMs(): number {
	return Date.now() - uptime() * 1000;
}

/**
 * Whether a marker says this installation's startup files were read since the machine last started: its version, its
 * installation and that start. A missing, unreadable or other marker says no.
 */
export function startupFilesReadThisStart(
	marker: string | undefined,
	version: string,
	install: string,
	startTimeMs: number,
): boolean {
	if (marker === undefined) return false;
	try {
		const read = JSON.parse(marker) as { version?: unknown; install?: unknown; bootTimeMs?: unknown };
		return (
			read.version === version &&
			read.install === install &&
			typeof read.bootTimeMs === "number" &&
			Math.abs(read.bootTimeMs - startTimeMs) <= BOOT_TIME_TOLERANCE_MS
		);
	} catch {
		return false;
	}
}

/**
 * Starts a short-lived process that reads the files this interactive session is about to load, many at once
 * (`startup-prefetch-reader.ts`). On a cold start an antivirus scans each file when it is first opened, and the module
 * loader opens them one at a time; read ahead in parallel, they are scanned in parallel. The reader only reads, ends
 * when it is done, and ends with this process if this process ends first. Once it has read them (or found them in
 * memory), it records so in the agent directory, and later starts until the machine restarts start no reader for this
 * installation and version. Nothing starts in the standalone binary
 * (one file), without the file list the build writes, when the package directory is overridden (it then names assets,
 * not this installation's code), when the user sets Node's I/O pool size, or when the process runs a preload, a module
 * loader or the permission model.
 */
export function startStartupPrefetch(packageDir: string): void {
	// Windows only: the files' first-open antivirus scans are what the reader overlaps. Node only: the reader's read
	// concurrency comes from Node's I/O pool, which the reader's own environment sizes.
	if (process.platform !== "win32" || process.versions.bun !== undefined || isBunBinary) return;
	if (process.permission !== undefined || process.env.ATOMIC_PACKAGE_DIR || process.env.PI_PACKAGE_DIR) return;
	// A pool size the user chose budgets Node's I/O on this machine: no helper reads past it.
	if (process.env.UV_THREADPOOL_SIZE !== undefined) return;
	if (startupNodeOptions().some((option) => USER_CODE_OPTIONS.has(option.name))) return;
	const listPath = join(packageDir, "dist", "startup-files.json");
	const readerPath = join(packageDir, "dist", "utils", "startup-prefetch-reader.js");
	if (!existsSync(listPath) || !existsSync(readerPath)) return;
	// Already read since the machine started: they are in memory, where reading them again only costs CPU time.
	const marker = join(getAgentDir(), STARTUP_FILES_READ_MARKER);
	let markerText: string | undefined;
	try {
		markerText = readFileSync(marker, "utf8");
	} catch {
		// None yet: read them.
	}
	if (startupFilesReadThisStart(markerText, VERSION, packageDir, machineStartTimeMs())) return;
	try {
		// The reader's standard input is a pipe this process holds open for as long as it runs: the reader ends when the
		// pipe does, also when this process is killed before it could end the reader itself.
		const reader = spawn(process.execPath, [readerPath, listPath, packageDir, marker, VERSION], {
			stdio: ["pipe", "ignore", "ignore"],
			windowsHide: true,
			env: { ...process.env, UV_THREADPOOL_SIZE: readerThreads(), NODE_OPTIONS: "" },
		});
		// Below Atomic's own priority: where the files are already in memory, and there are few CPUs, reading them would
		// otherwise take CPU time from Atomic's own start.
		try {
			if (reader.pid !== undefined) setPriority(reader.pid, constants.priority.PRIORITY_BELOW_NORMAL);
		} catch {
			// It reads at normal priority.
		}
		reader.on("error", () => {});
		reader.stdin?.on("error", () => {});
		reader.unref();
		(reader.stdin as { unref?: () => void } | null)?.unref?.();
		const stop = () => {
			if (reader.exitCode === null && reader.signalCode === null) reader.kill();
		};
		process.once("exit", stop);
		// "close" follows the reader's exit, and also a start that failed, which has no "exit".
		reader.once("close", () => process.off("exit", stop));
	} catch {
		// Startup reads its files as it always does.
	}
}
