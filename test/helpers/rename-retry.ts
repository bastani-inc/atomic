import { rename as renameAsync, stat as statAsync } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as sleepAsync } from "node:timers/promises";
import { moduleDir } from "./runtime.js";

/** Transient Windows error codes when another process, thread, or scanner briefly holds a path open. */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/** How long a refused directory rename is retried on Windows, matching graceful-fs (60 s). */
export const RENAME_RETRY_DIRECTORY_MS = 60_000;
/** How long a refused file rename is retried on Windows. */
export const RENAME_RETRY_FILE_MS = 10_000;
/** Initial backoff before retrying a refused rename; grows by this step up to the cap. */
export const RENAME_RETRY_BACKOFF_START_MS = 10;
export const RENAME_RETRY_BACKOFF_MAX_MS = 100;

/** Path to the CommonJS synchronous retry module, usable from child scripts and `--require` preloads. */
export const RENAME_RETRY_SYNC_MODULE_PATH = join(moduleDir(import.meta.url), "rename-retry-sync.cjs");

export interface RenameRetryFileSystem {
	rename(from: string, to: string): Promise<void>;
	stat(path: string): Promise<{ isDirectory(): boolean }>;
}

export interface RenameWithRetryOptions {
	readonly signal?: AbortSignal;
	readonly budgetMs?: number;
	readonly platform?: NodeJS.Platform;
	readonly fs?: RenameRetryFileSystem;
	readonly now?: () => number;
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RenameSyncWithRetryOptions {
	readonly budgetMs?: number;
	readonly platform?: NodeJS.Platform;
	readonly rename?: (from: string, to: string) => void;
	readonly stat?: (path: string) => { isDirectory(): boolean };
	readonly now?: () => number;
	readonly sleep?: (ms: number) => void;
}

const defaultAsyncFs: RenameRetryFileSystem = { rename: renameAsync, stat: statAsync };

async function defaultSleepAsync(ms: number, signal?: AbortSignal): Promise<void> {
	await sleepAsync(ms, undefined, { signal }).catch((abort: unknown) => {
		signal?.throwIfAborted();
		throw abort;
	});
}

const syncModule = createRequire(import.meta.url)("./rename-retry-sync.cjs") as {
	renameSyncWithRetry(from: string, to: string, options?: RenameSyncWithRetryOptions): number;
};

/**
 * Synchronously renames `from` to `to`, retrying transient Windows EPERM/EACCES/EBUSY failures with growing backoff
 * (10 ms up to 100 ms) bounded by `budgetMs` (60 s for directories, 10 s for files), modelled on graceful-fs.
 */
export function renameSyncWithRetry(from: string, to: string, options?: RenameSyncWithRetryOptions): number {
	return syncModule.renameSyncWithRetry(from, to, options);
}

/**
 * Asynchronously renames `from` to `to`, modelled on graceful-fs: on Windows, transient EPERM/EACCES/EBUSY failures
 * from another process's handle, a scanner, or a just-ended child are retried with a growing backoff (10 ms up to
 * 100 ms) until the rename succeeds or `budgetMs` is spent (60 s for directories, 10 s for files). Moving a directory
 * onto an existing directory (other than a case-only rename of the same path), any other error code, and any error off
 * Windows reject immediately.
 */
export async function renameWithRetry(from: string, to: string, options: RenameWithRetryOptions = {}): Promise<void> {
	const fs = options.fs ?? defaultAsyncFs;
	if ((options.platform ?? process.platform) !== "win32") return fs.rename(from, to);
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleepAsync;
	const started = now();
	let backoff = RENAME_RETRY_BACKOFF_START_MS;
	let directory: boolean | undefined;
	const caseOnly = from.toLowerCase() === to.toLowerCase();
	for (;;) {
		options.signal?.throwIfAborted();
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
			if (!TRANSIENT_RENAME_CODES.has(code)) throw error;
			directory ??= await fs.stat(from).then(
				(stats) => stats.isDirectory(),
				() => false,
			);
			const budget = options.budgetMs ?? (directory ? RENAME_RETRY_DIRECTORY_MS : RENAME_RETRY_FILE_MS);
			if (now() - started + backoff > budget) throw error;
			const occupied =
				directory &&
				!caseOnly &&
				(await fs.stat(to).then(
					() => true,
					() => false,
				));
			if (occupied) throw error;
			await sleep(backoff, options.signal);
			backoff = Math.min(backoff + RENAME_RETRY_BACKOFF_START_MS, RENAME_RETRY_BACKOFF_MAX_MS);
		}
	}
}
