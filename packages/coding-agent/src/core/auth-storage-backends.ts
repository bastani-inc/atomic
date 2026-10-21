import { createHash } from "node:crypto";
import { type Credential, OAUTH_REFRESH_LOCK_HOLD_MS, OAUTH_REFRESH_TIMEOUT_MS } from "@bastani/pi-ai";
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
import { dirname, join } from "path";
import lockfile, { type LockOptions } from "proper-lockfile";
import { getAgentDir } from "../config.js";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import type { AuthStorageData } from "./auth-storage.ts";
import { normalizeProviderKeys } from "./azure-provider-compat.js";

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

/** How long a commit waits for the shared auth file lock. */
const AUTH_FILE_LOCK_WAIT_MS = 30_000;

/**
 * How long a session waits for a provider lock another session holds. A live holder keeps it while its token
 * exchange runs (up to OAUTH_REFRESH_LOCK_HOLD_MS) and then waits for the auth file lock to commit; a dead one
 * loses it after PROVIDER_LOCK_STALE_MS. Waiting out both means a waiter gets the rotated token instead of an error.
 */
const PROVIDER_LOCK_WAIT_MS = Math.max(OAUTH_REFRESH_LOCK_HOLD_MS, PROVIDER_LOCK_STALE_MS) + AUTH_FILE_LOCK_WAIT_MS;

/** A waiter polls a held provider lock at growing intervals, at least once per holder heartbeat (plus jitter). */
const PROVIDER_LOCK_POLL_MIN_MS = 100;
const PROVIDER_LOCK_POLL_MAX_MS = PROVIDER_LOCK_HEARTBEAT_MS;

/** The result of a provider transaction may be a completed token rotation, so a lost or busy auth file lock retries its commit. */
const PROVIDER_COMMIT_ATTEMPTS = 3;

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

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
		const providerPath = `${realpathSync(this.authPath)}.${createHash("sha256").update(provider).digest("hex")}`;
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
			await release().catch(() => undefined);
		}
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);
			chmodSync(this.authPath, 0o600);
		}
	}

	private getRetryableLockErrorCode(error: unknown): "ELOCKED" | "EPERM" | undefined {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "ELOCKED") return code;
		if (code === "EPERM" && process.platform === "win32") return code;
		return undefined;
	}

	/** Takes a provider lock, waiting up to PROVIDER_LOCK_WAIT_MS for its holder; the caller's signal stops the wait. */
	private async acquireProviderLock(
		path: string,
		options: Omit<LockOptions, "retries">,
		signal: AbortSignal | undefined,
	): Promise<() => Promise<void>> {
		const deadline = Date.now() + PROVIDER_LOCK_WAIT_MS;
		for (let pollMs = PROVIDER_LOCK_POLL_MIN_MS; ; pollMs = Math.min(pollMs * 2, PROVIDER_LOCK_POLL_MAX_MS)) {
			signal?.throwIfAborted();
			try {
				return await lockfile.lock(path, { ...options, retries: 0 });
			} catch (error) {
				const remainingMs = deadline - Date.now();
				if (!this.getRetryableLockErrorCode(error) || remainingMs <= 0) throw error;
				await delay(Math.min(Math.round(pollMs * (1 + Math.random())), remainingMs), signal);
			}
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		for (let attempt = 1; ; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				if (!this.getRetryableLockErrorCode(error) || attempt === maxAttempts) throw error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}
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
	private writeAtomic(content: string, path = this.authPath): void {
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

	deleteProvider(provider: string): string | undefined {
		const paths = [...new Set(this.readPaths.filter((path) => existsSync(path)))].sort();
		const releases: Array<() => void> = [];
		try {
			for (const path of paths) releases.push(this.acquireLockSyncWithRetry(path));
			for (const path of paths) {
				const data = JSON.parse(stripBom(readFileSync(path, "utf-8"))) as AuthStorageData;
				if (!(provider in data)) continue;
				delete data[provider];
				this.writeAtomic(JSON.stringify(data, null, 2), path);
			}
			return this.readMergedAuth();
		} finally {
			for (const release of releases.reverse()) release();
		}
	}

	async deleteProviderAsync(provider: string): Promise<string | undefined> {
		const paths = [...new Set(this.readPaths.filter((path) => existsSync(path)))].sort();
		const releases: Array<() => Promise<void>> = [];
		try {
			for (const path of paths) {
				releases.push(
					await lockfile.lock(path, {
						realpath: false,
						// Keep layered-file deletion below the logout RPC's 30-second
						// deadline even if every auth path is actively locked. A caller
						// then receives the actionable lock error instead of an abandoned
						// request that poisons the engine's ordinary command lane.
						retries: AUTH_DELETE_LOCK_RETRY_OPTIONS,
						stale: 30000,
					}),
				);
			}
			for (const path of paths) {
				const data = JSON.parse(stripBom(readFileSync(path, "utf-8"))) as AuthStorageData;
				if (!(provider in data)) continue;
				delete data[provider];
				this.writeAtomic(JSON.stringify(data, null, 2), path);
			}
			return this.readMergedAuth();
		} finally {
			for (const release of releases.reverse()) await release();
		}
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();

		let release: (() => void) | undefined;
		try {
			if (existsSync(this.authPath)) {
				release = this.acquireLockSyncWithRetry(this.authPath);
			}
			const current = this.readMergedAuth();
			const { result, next } = fn(current);
			if (next !== undefined) {
				if (!existsSync(this.authPath)) {
					this.ensureFileExists();
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(this.authPath);
				}
				this.writeAtomic(next);
			}
			return result;
		} finally {
			if (release) {
				release();
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
			const deadline = Date.now() + AUTH_FILE_LOCK_WAIT_MS;
			let retry = 0;
			let epermRetries = 0;
			for (;;) {
				try {
					release = await lockfile.lock(this.authPath, {
						retries: 0,
						stale: 30_000,
						onCompromised: (err) => {
							lockCompromised = true;
							lockCompromisedError = err;
						},
					});
					break;
				} catch (error) {
					const code = this.getRetryableLockErrorCode(error);
					const remainingMs = deadline - Date.now();
					if (!code || remainingMs <= 0) throw error;
					if (code === "EPERM" && ++epermRetries > 5) throw error;
					const baseDelayMs = Math.min(10 * 2 ** retry++, 1_000);
					const delayMs = Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs);
					await new Promise((resolve) => setTimeout(resolve, delayMs));
				}
			}

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
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
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
