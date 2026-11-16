import { renameSync } from "node:fs";
import { rename as renameAsync, stat as statAsync } from "node:fs/promises";
import { setTimeout as sleepAsync } from "node:timers/promises";

/**
 * How often a rename that Windows refuses for a moment is tried in all, 20 ms apart: about two seconds. Another
 * process's open handle (an antivirus scan, the indexer, a handle still closing) refuses it with EPERM, EACCES or EBUSY.
 */
export const RENAME_ATTEMPTS = 100;
const RENAME_RETRY_MS = 20;
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Whether a rename that failed with `error` on `attempt` is tried again. */
function retriesRename(error: unknown, attempt: number, platform: NodeJS.Platform): boolean {
	const code = (error as NodeJS.ErrnoException).code ?? "";
	return platform === "win32" && attempt < RENAME_ATTEMPTS && TRANSIENT_RENAME_CODES.has(code);
}

/**
 * Rename `from` to `to`. On Windows, a rename another process's handle refuses (EPERM, EACCES, EBUSY) is tried again,
 * {@link RENAME_ATTEMPTS} times in all; elsewhere, and for any other error, it throws at once.
 */
export function renameReplacing(
	from: string,
	to: string,
	platform: NodeJS.Platform = process.platform,
	rename: (from: string, to: string) => void = renameSync,
): void {
	for (let attempt = 1; ; attempt++) {
		try {
			rename(from, to);
			return;
		} catch (error) {
			if (!retriesRename(error, attempt, platform)) throw error;
			// Callers stay synchronous; block this thread without spinning the CPU.
			Atomics.wait(sleeper, 0, 0, RENAME_RETRY_MS);
		}
	}
}

/** {@link renameReplacing} for asynchronous callers. */
export async function renameReplacingAsync(
	from: string,
	to: string,
	platform: NodeJS.Platform = process.platform,
	rename: (from: string, to: string) => Promise<void> = renameAsync,
): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			if (!retriesRename(error, attempt, platform)) throw error;
			await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
		}
	}
}

/** How long a directory move Windows refuses for a moment is tried again: any program may hold one of its files. */
export const RENAME_RETRY_DIRECTORY_MS = 60_000;
/** How long the move of a file Windows refuses for a moment is tried again. */
export const RENAME_RETRY_FILE_MS = 10_000;
/** The first wait before a refused rename is tried again; each wait is 10 ms longer, up to 100 ms. */
const RENAME_BACKOFF_START_MS = 10;
const RENAME_BACKOFF_MAX_MS = 100;

/** The calls {@link renameWithRetry} makes, replaceable in a test. */
export interface RenameFileSystem {
	rename(from: string, to: string): Promise<void>;
	stat(path: string): Promise<{ isDirectory(): boolean }>;
}

export interface RenameWithRetryOptions {
	/** Stops the retries: the rename rejects with its reason. */
	readonly signal?: AbortSignal;
	/** How long a refused rename is tried again: {@link RENAME_RETRY_DIRECTORY_MS} for a directory, else {@link RENAME_RETRY_FILE_MS}. */
	readonly budgetMs?: number;
	readonly platform?: NodeJS.Platform;
	readonly fs?: RenameFileSystem;
}

const defaultRenameFileSystem: RenameFileSystem = { rename: renameAsync, stat: statAsync };

/**
 * Renames `from` to `to`, as graceful-fs does on Windows: a rename another program's handle refuses for a moment (an
 * antivirus scan, the indexer, an editor, a Git process that just ended) fails with EPERM, EACCES or EBUSY, and is tried
 * again with a growing wait, 10 ms up to 100 ms, until it succeeds or its budget is spent, a minute for a directory. A
 * directory refused while one is at `to` is not tried again: Windows never moves a directory onto another. Any other
 * error, such as ENOENT or EXDEV, rejects at once, and so does a rename on any other platform, which is one plain
 * rename.
 */
export async function renameWithRetry(from: string, to: string, options: RenameWithRetryOptions = {}): Promise<void> {
	const fs = options.fs ?? defaultRenameFileSystem;
	if ((options.platform ?? process.platform) !== "win32") return fs.rename(from, to);
	const started = Date.now();
	let backoff = RENAME_BACKOFF_START_MS;
	let directory: boolean | undefined;
	for (;;) {
		options.signal?.throwIfAborted();
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			if (!TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
			directory ??= await fs.stat(from).then(
				(stats) => stats.isDirectory(),
				() => false,
			);
			const budget = options.budgetMs ?? (directory ? RENAME_RETRY_DIRECTORY_MS : RENAME_RETRY_FILE_MS);
			if (Date.now() - started + backoff > budget) throw error;
			const occupied =
				directory &&
				(await fs.stat(to).then(
					() => true,
					() => false,
				));
			if (occupied) throw error;
			// Rejects with the signal's reason, as a rename aborted before it starts does.
			await sleepAsync(backoff, undefined, { signal: options.signal }).catch((abort: unknown) => {
				options.signal?.throwIfAborted();
				throw abort;
			});
			backoff = Math.min(backoff + RENAME_BACKOFF_START_MS, RENAME_BACKOFF_MAX_MS);
		}
	}
}
