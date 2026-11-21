import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startupNodeOptions } from "@bastani/atomic-codemode/node-options";
import { isBunBinary } from "../config.js";

/** Options that make Node run code of the user's in every process it starts: a preload or a module loader. */
const USER_CODE_OPTIONS = new Set(["--require", "-r", "--import", "--loader", "--experimental-loader"]);

/** Reads the startup's files with this many in flight: the reader process's own I/O pool, never this process's. */
const READER_THREADS = "32";

/**
 * Starts a short-lived process that reads the files this interactive session is about to load, many at once
 * (`startup-prefetch-reader.ts`). On a cold start an antivirus scans each file when it is first opened, and the module
 * loader opens them one at a time; read ahead in parallel, they are scanned in parallel. The reader only reads, ends
 * when it is done, and ends with this process if this process ends first. Nothing starts in the standalone binary
 * (one file), without the file list the build writes, when the package directory is overridden (it then names assets,
 * not this installation's code), or when the process runs a preload, a module loader or the permission model.
 */
export function startStartupPrefetch(packageDir: string): void {
	// Windows only: the files' first-open antivirus scans are what the reader overlaps. Node only: the reader's read
	// concurrency comes from Node's I/O pool, which the reader's own environment sizes.
	if (process.platform !== "win32" || process.versions.bun !== undefined || isBunBinary) return;
	if (process.permission !== undefined || process.env.ATOMIC_PACKAGE_DIR || process.env.PI_PACKAGE_DIR) return;
	if (startupNodeOptions().some((option) => USER_CODE_OPTIONS.has(option.name))) return;
	const listPath = join(packageDir, "dist", "startup-files.json");
	const readerPath = join(packageDir, "dist", "utils", "startup-prefetch-reader.js");
	if (!existsSync(listPath) || !existsSync(readerPath)) return;
	try {
		// The reader's standard input is a pipe this process holds open for as long as it runs: the reader ends when the
		// pipe does, also when this process is killed before it could end the reader itself.
		const reader = spawn(process.execPath, [readerPath, listPath, packageDir], {
			stdio: ["pipe", "ignore", "ignore"],
			windowsHide: true,
			env: { ...process.env, UV_THREADPOOL_SIZE: READER_THREADS, NODE_OPTIONS: "" },
		});
		reader.on("error", () => {});
		reader.stdin?.on("error", () => {});
		reader.unref();
		(reader.stdin as { unref?: () => void } | null)?.unref?.();
		const stop = () => {
			if (reader.exitCode === null && reader.signalCode === null) reader.kill();
		};
		process.once("exit", stop);
		reader.once("exit", () => process.off("exit", stop));
	} catch {
		// Startup reads its files as it always does.
	}
}
