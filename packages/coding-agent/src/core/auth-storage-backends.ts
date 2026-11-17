import { createHash } from "node:crypto";
import { type Credential, OAUTH_REFRESH_LOCK_HOLD_MS, OAUTH_REFRESH_TIMEOUT_MS } from "@bastani/atomic-ai";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import lockfile, { type LockOptions } from "proper-lockfile";
import { getAgentDir } from "../config.js";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import type { AuthStorageData } from "./auth-storage.ts";
import { normalizeProviderKeys } from "./azure-provider-compat.js";
import { releaseLock, releaseLockSync } from "./lock-release.ts";
import { guardLockRemoval } from "./lock-takeover.ts";
import { type LockWait, waitForLock, waitForLockSync } from "./lock-wait.ts";

export type LockResult<T> = {
	result: T;
	next?: string;
};

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;
const AUTH_DELETE_LOCK_RETRY_OPTIONS = {
	retries: 5,
	factor: 2,
	minTimeout: 100,
	maxTimeout: 2_000,
	randomize: true,
} as const;

/** How often a provider lock holder refreshes the lock's heartbeat (its mtime). */
const PROVIDER_LOCK_HEARTBEAT_MS = 2_000;

/**
 * Another process takes over a provider lock only once the holder has missed heartbeats for this long:
 * a whole OAuth refresh plus the same again of event-loop lag. A waiter therefore never exchanges a
 * refresh token that a live, merely slow holder is still rotating.
 */
const PROVIDER_LOCK_STALE_MS = 2 * OAUTH_REFRESH_TIMEOUT_MS + PROVIDER_LOCK_HEARTBEAT_MS;

/** How long a commit waits for one other process to release the shared auth file lock. */
const AUTH_FILE_LOCK_WAIT_MS = 30_000;
/**
 * How long a synchronous save waits for one other process to release the auth file lock. Kept short: the wait blocks
 * this process, so a lock it holds asynchronously stops being refreshed and would be taken over as stale.
 */
const AUTH_FILE_SYNC_LOCK_WAIT_MS = 200;
/** proper-lockfile's default stale window, which a lock given no `stale` option has. */
const DEFAULT_LOCK_STALE_MS = 10_000;
/** How old the auth.json lock must be before a synchronous save judges it left by a killed process. */
const AUTH_FILE_SYNC_LOCK_STALE_MS = DEFAULT_LOCK_STALE_MS;
/** How old the auth.json lock must be before an asynchronous save or a deletion judges it left by a killed process. */
const AUTH_FILE_ASYNC_LOCK_STALE_MS = 30_000;
const AUTH_FILE_LOCK_POLL_MIN_MS = 10;
/** Low enough that a waiter which has backed off still competes with the processes polling at the minimum. */
const AUTH_FILE_LOCK_POLL_MAX_MS = 50;

/** Attempts to resolve an existing auth file's real path; see resolveExistingAuthPath. */
const REALPATH_ATTEMPTS = 20;

/**
 * Resolves symlinks of an auth file that exists, so every alias locks and replaces one real file (pi #11655).
 * Bun's realpath can fail with ENOENT while another process renames the target into place, so ENOENT is retried
 * while the path still exists.
 */
/**
 * The path whose lock guards auth.json at `path`: the resolved file, or, before auth.json exists, its name in the
 * resolved directory, so a first save is locked as well (#5161).
 */
function resolveAuthLockPath(path: string): string {
	try {
		return resolveExistingAuthPath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT" || existsSync(path)) throw error;
		return join(realpathSync(dirname(path)), basename(path));
	}
}

function resolveExistingAuthPath(path: string): string {
	for (let attempt = 1; ; attempt++) {
		try {
			return realpathSync(path);
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code !== "ENOENT" || attempt === REALPATH_ATTEMPTS || !existsSync(path)) throw error;
		}
	}
}

/**
 * How long a session waits for a provider lock another session holds. A live holder keeps it while its token
 * exchange runs (up to OAUTH_REFRESH_LOCK_HOLD_MS) and then waits for the auth file lock to commit; a dead one
 * loses it after PROVIDER_LOCK_STALE_MS. Waiting out both means a waiter gets the rotated token instead of an error.
 */
const PROVIDER_LOCK_WAIT_MS = Math.max(OAUTH_REFRESH_LOCK_HOLD_MS, PROVIDER_LOCK_STALE_MS) + AUTH_FILE_LOCK_WAIT_MS;

/** How long a session waits in all while other sessions refresh the provider one after another. */
const PROVIDER_LOCK_CONTENTION_WAIT_MS = 3 * PROVIDER_LOCK_WAIT_MS;

/** A waiter polls a held provider lock at growing intervals, at least once per holder heartbeat (plus jitter). */
const PROVIDER_LOCK_POLL_MIN_MS = 100;
const PROVIDER_LOCK_POLL_MAX_MS = PROVIDER_LOCK_HEARTBEAT_MS;

/** The result of a provider transaction may be a completed token rotation, so a lost or busy auth file lock retries its commit. */
const PROVIDER_COMMIT_ATTEMPTS = 3;

function isLockContention(error: unknown): boolean {
	const code = error instanceof Error && "code" in error ? error.code : undefined;
	return code === "ECOMPROMISED" || code === "ELOCKED";
}

function describeFileVersion(path: string): string {
	try {
		const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
		return stats ? `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}` : "absent";
	} catch (error) {
		return `unreadable:${error instanceof Error && "code" in error ? String(error.code) : "unknown"}`;
	}
}

export interface AuthStorageBackend {
	/**
	 * Read the current credential snapshot WITHOUT acquiring the exclusive write
	 * lock. Pure reads do not need cross-process write-exclusion: writers replace
	 * the file atomically (temp file + rename), so a lock-free reader always
	 * observes a complete previous-or-next snapshot, never a torn one. Keeping
	 * reads lock-free is what prevents many concurrent sessions from starving each
	 * other on `auth.json` and misreporting configured providers as unreadable
	 * under contention (issue #1431).
	 *
	 * Optional for backward compatibility with custom backends that predate this
	 * method (the released `AuthStorageBackend` interface): when absent,
	 * `AuthStorage.reload()` falls back to a `withLock`-based read.
	 */
	read?(): string | undefined;
	version?(): string;
	deleteProvider?(provider: string): string | undefined;
	deleteProviderAsync?(provider: string): Promise<string | undefined>;
	modifyProviderAsync?(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		signal?: AbortSignal,
	): Promise<LockResult<Credential | undefined>>;
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private declare authPath: string;
	private declare readPaths: string[];

	constructor(authPath: string = join(getAgentDir(), "auth.json"), readPaths: string[] = [authPath]) {
		this.authPath = normalizePath(authPath);
		this.readPaths = readPaths.map((readPath) => normalizePath(readPath));
	}

	async modifyProviderAsync(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		signal?: AbortSignal,
	): Promise<LockResult<Credential | undefined>> {
		this.ensureParentDir();
		this.ensureFileExists();
		const providerPath = `${resolveExistingAuthPath(this.authPath)}.${createHash("sha256").update(provider).digest("hex")}`;
		let compromised: Error | undefined;
		const release = await this.acquireProviderLock(
			providerPath,
			{
				realpath: false,
				stale: PROVIDER_LOCK_STALE_MS,
				update: PROVIDER_LOCK_HEARTBEAT_MS,
				onCompromised: (error) => {
					compromised = error;
				},
			},
			signal,
		);
		try {
			signal?.throwIfAborted();
			if (compromised) throw compromised;
			const originalData = JSON.parse(this.readMergedAuth() ?? "{}") as AuthStorageData;
			const original = JSON.stringify(originalData[provider]);
			const next = await fn(originalData[provider]);
			// Even when another process took over the provider lock meanwhile, `next` may be a token rotation the
			// provider already completed. It is committed only if the stored credential is still the one it replaces.
			const commit = async (
				content: string | undefined,
			): Promise<LockResult<LockResult<Credential | undefined>>> => {
				signal?.throwIfAborted();
				const current = JSON.parse(content ?? "{}") as AuthStorageData;
				if (next !== undefined && JSON.stringify(current[provider]) === original) {
					const merged = JSON.stringify({ ...current, [provider]: next }, null, 2);
					return { result: { result: next, next: merged }, next: merged };
				}
				return {
					result: {
						result: JSON.stringify(current[provider]) === original ? originalData[provider] : current[provider],
						next: content,
					},
				};
			};
			for (let attempt = 1; ; attempt++) {
				try {
					return await this.withLockAsync(commit);
				} catch (error) {
					if (attempt >= PROVIDER_COMMIT_ATTEMPTS || !isLockContention(error)) throw error;
				}
			}
		} finally {
			await releaseLock(release, providerPath);
		}
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	/**
	 * Creates an empty auth.json when there is none. The create is exclusive, so it never replaces a file another
	 * process has just saved credentials to (#5161).
	 */
	private ensureFileExists(): void {
		try {
			writeFileSync(this.authPath, "{}", { ...AUTH_FILE_WRITE_OPTIONS, flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
			throw error;
		}
		chmodSync(this.authPath, 0o600);
	}

	private getRetryableLockErrorCode(error: unknown): "ELOCKED" | "EPERM" | undefined {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "ELOCKED") return code;
		if (code === "EPERM" && process.platform === "win32") return code;
		return undefined;
	}

	/**
	 * Takes a provider lock, waiting up to PROVIDER_LOCK_WAIT_MS for each holder in turn, so sessions queued behind
	 * one another's refreshes all get the rotated token; the caller's signal stops the wait.
	 */
	private async acquireProviderLock(
		path: string,
		options: Omit<LockOptions, "retries">,
		signal: AbortSignal | undefined,
	): Promise<() => Promise<void>> {
		return waitForLock(
			(fs) => lockfile.lock(path, { ...options, retries: 0, fs }),
			{
				lockPath: `${path}.lock`,
				staleMs: options.stale ?? DEFAULT_LOCK_STALE_MS,
				holderWaitMs: PROVIDER_LOCK_WAIT_MS,
				contentionWaitMs: PROVIDER_LOCK_CONTENTION_WAIT_MS,
				pollMinMs: PROVIDER_LOCK_POLL_MIN_MS,
				pollMaxMs: PROVIDER_LOCK_POLL_MAX_MS,
				retryable: (error) => this.getRetryableLockErrorCode(error) !== undefined,
				stuck: (error) => error as Error,
				contended: (error, waitedMs) =>
					Object.assign(
						new Error(`Other sessions kept refreshing ${path} for ${Math.round(waitedMs / 1000)} s`, {
							cause: error,
						}),
						{ code: "ELOCKED" },
					),
			},
			signal,
		);
	}

	/** Takes the lock of the auth file `path`, waiting while other processes save to it (see {@link waitForLockSync}). */
	private acquireLockSyncWithRetry(path: string): () => void {
		// Lock the resolved file so symlinked aliases of auth.json share one lock (pi #11655).
		const resolved = resolveAuthLockPath(path);
		return waitForLockSync(
			(fs) => lockfile.lockSync(resolved, { realpath: false, stale: AUTH_FILE_SYNC_LOCK_STALE_MS, fs }),
			this.authFileLockWait(resolved, AUTH_FILE_SYNC_LOCK_WAIT_MS, AUTH_FILE_SYNC_LOCK_STALE_MS, () => true),
		);
	}

	/** How a save waits for the lock of the resolved auth file `path`; `retryEperm` decides whether a Windows EPERM is retried. */
	private authFileLockWait(
		path: string,
		holderWaitMs: number,
		staleMs: number,
		retryEperm: () => boolean,
	): Omit<LockWait, "takeOver"> {
		return {
			lockPath: `${path}.lock`,
			staleMs,
			holderWaitMs,
			pollMinMs: AUTH_FILE_LOCK_POLL_MIN_MS,
			pollMaxMs: AUTH_FILE_LOCK_POLL_MAX_MS,
			retryable: (error) => {
				const code = this.getRetryableLockErrorCode(error);
				return code === "ELOCKED" || (code === "EPERM" && retryEperm());
			},
			stuck: (error) => error as Error,
			contended: (error, waitedMs) =>
				Object.assign(
					new Error(`Other processes kept saving ${path} for ${Math.round(waitedMs / 1000)} s`, { cause: error }),
					{
						code: "ELOCKED",
					},
				),
		};
	}

	private readMergedAuth(): string | undefined {
		let merged: AuthStorageData = {};
		let found = false;
		for (let i = this.readPaths.length - 1; i >= 0; i--) {
			const readPath = this.readPaths[i]!;
			if (!existsSync(readPath)) continue;
			const parsed = JSON.parse(stripBom(readFileSync(readPath, "utf-8"))) as AuthStorageData;
			merged = { ...merged, ...normalizeProviderKeys(parsed) };
			found = true;
		}
		return found ? JSON.stringify(merged, null, 2) : undefined;
	}

	/**
	 * Atomically replace `auth.json` with `content`: write a sibling temp file
	 * (same directory, so `rename` is a same-filesystem atomic swap), fix its
	 * permissions, then `rename` it over the target. Lock-free readers therefore
	 * never observe a half-written file. The temp file is best-effort cleaned up
	 * if the rename fails.
	 */
	private writeAtomic(content: string, requestedPath = this.authPath): void {
		// Replace the resolved file, not a symlink to it, so every alias keeps sharing the file and its lock.
		const path = existsSync(requestedPath) ? resolveExistingAuthPath(requestedPath) : requestedPath;
		const dir = dirname(path);
		const mode = existsSync(path) ? statSync(path).mode & 0o777 : AUTH_FILE_WRITE_OPTIONS.mode;
		const tempPath = join(dir, `.${`auth.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`}.tmp`);
		try {
			writeFileSync(tempPath, content, { ...AUTH_FILE_WRITE_OPTIONS, mode });
			// Creation mode is filtered through umask; restore the exact managed mode
			// before publishing the replacement inode.
			chmodSync(tempPath, mode);
			renameSync(tempPath, path);
		} catch (error) {
			try {
				if (existsSync(tempPath)) rmSync(tempPath, { force: true });
			} catch {
				// Best-effort cleanup; ignore.
			}
			throw error;
		}
	}

	read(): string | undefined {
		return this.readMergedAuth();
	}

	version(): string {
		return this.readPaths.map((path) => describeFileVersion(path)).join("|");
	}

	/** Each existing auth file once, by its real path, so a symlinked alias is never locked twice (pi #11655). */
	private existingResolvedReadPaths(): string[] {
		return [
			...new Set(this.readPaths.filter((path) => existsSync(path)).map((path) => resolveExistingAuthPath(path))),
		].sort();
	}

	deleteProvider(provider: string): string | undefined {
		const paths = this.existingResolvedReadPaths();
		const releases: Array<{ path: string; release: () => void }> = [];
		try {
			for (const path of paths) releases.push({ path, release: this.acquireLockSyncWithRetry(path) });
			for (const path of paths) {
				const data = JSON.parse(stripBom(readFileSync(path, "utf-8"))) as AuthStorageData;
				if (!(provider in data)) continue;
				delete data[provider];
				this.writeAtomic(JSON.stringify(data, null, 2), path);
			}
			return this.readMergedAuth();
		} finally {
			for (const { path, release } of releases.reverse()) releaseLockSync(release, path);
		}
	}

	async deleteProviderAsync(provider: string): Promise<string | undefined> {
		const paths = this.existingResolvedReadPaths();
		const releases: Array<{ path: string; release: () => Promise<void> }> = [];
		try {
			for (const path of paths) {
				// Lock the resolved file so symlinked aliases share one lock (pi #11655).
				const resolved = resolveExistingAuthPath(path);
				// A stale lock is removed only under the takeover mutex, while it is still stale (#5161).
				const guard = guardLockRemoval(`${resolved}.lock`, AUTH_FILE_ASYNC_LOCK_STALE_MS);
				try {
					releases.push({
						path,
						release: await lockfile.lock(resolved, {
							realpath: false,
							// Keep layered-file deletion below the logout RPC's 30-second
							// deadline even if every auth path is actively locked. A caller
							// then receives the actionable lock error instead of an abandoned
							// request that poisons the engine's ordinary command lane.
							retries: AUTH_DELETE_LOCK_RETRY_OPTIONS,
							stale: AUTH_FILE_ASYNC_LOCK_STALE_MS,
							fs: guard.fs,
						}),
					});
				} finally {
					guard.done();
				}
			}
			for (const path of paths) {
				const data = JSON.parse(stripBom(readFileSync(path, "utf-8"))) as AuthStorageData;
				if (!(provider in data)) continue;
				delete data[provider];
				this.writeAtomic(JSON.stringify(data, null, 2), path);
			}
			return this.readMergedAuth();
		} finally {
			for (const { path, release } of releases.reverse()) await releaseLock(release, path);
		}
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();

		let release: (() => void) | undefined;
		try {
			// The lock is taken even before auth.json exists, so a first save never overwrites another process's (#5161).
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = this.readMergedAuth();
			const { result, next } = fn(current);
			if (next !== undefined) {
				this.ensureFileExists();
				this.writeAtomic(next);
			}
			return result;
		} finally {
			if (release) {
				releaseLockSync(release, this.authPath);
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			if (!existsSync(this.authPath)) {
				this.ensureFileExists();
			}
			let epermRetries = 0;
			// Lock the resolved file so symlinked aliases share one lock (pi #11655).
			const resolved = resolveExistingAuthPath(this.authPath);
			release = await waitForLock(
				(fs) =>
					lockfile.lock(resolved, {
						realpath: false,
						retries: 0,
						stale: AUTH_FILE_ASYNC_LOCK_STALE_MS,
						fs,
						onCompromised: (err) => {
							lockCompromised = true;
							lockCompromisedError = err;
						},
					}),
				this.authFileLockWait(
					resolved,
					AUTH_FILE_LOCK_WAIT_MS,
					AUTH_FILE_ASYNC_LOCK_STALE_MS,
					() => ++epermRetries <= 5,
				),
			);

			throwIfCompromised();
			const current = this.readMergedAuth();
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				this.writeAtomic(next);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				await releaseLock(release, this.authPath);
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private pendingWrite: Promise<void> = Promise.resolve();

	read(): string | undefined {
		return this.value;
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const previous = this.pendingWrite;
		let release!: () => void;
		this.pendingWrite = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			const { result, next } = await fn(this.value);
			if (next !== undefined) {
				this.value = next;
			}
			return result;
		} finally {
			release();
		}
	}
}
