import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import type { AuthStorageData } from "./auth-storage.ts";

export type LockResult<T> = {
	result: T;
	next?: string;
};

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

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
	deleteProvider?(provider: string): string | undefined;
	deleteProviderAsync?(provider: string): Promise<string | undefined>;
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	declare private authPath: string;
	declare private readPaths: string[];

	constructor(
		authPath: string = join(getAgentDir(), "auth.json"),
		readPaths: string[] = [authPath],
	) {
		this.authPath = normalizePath(authPath);
		this.readPaths = readPaths.map((readPath) => normalizePath(readPath));
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

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	private readMergedAuth(): string | undefined {
		let merged: AuthStorageData = {};
		let found = false;
		for (let i = this.readPaths.length - 1; i >= 0; i--) {
			const readPath = this.readPaths[i]!;
			if (!existsSync(readPath)) continue;
			const parsed = JSON.parse(readFileSync(readPath, "utf-8")) as AuthStorageData;
			merged = { ...merged, ...parsed };
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
		const tempPath = join(
			dir,
			`.${`auth.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`}.tmp`,
		);
		try {
			writeFileSync(tempPath, content, AUTH_FILE_WRITE_OPTIONS);
			chmodSync(tempPath, 0o600);
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

	deleteProvider(provider: string): string | undefined {
		const paths = [...new Set(this.readPaths.filter((path) => existsSync(path)))].sort();
		const releases: Array<() => void> = [];
		try {
			for (const path of paths) releases.push(this.acquireLockSyncWithRetry(path));
			for (const path of paths) {
				const data = JSON.parse(readFileSync(path, "utf-8")) as AuthStorageData;
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
				releases.push(await lockfile.lock(path, {
					realpath: false,
					retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10000, randomize: true },
					stale: 30000,
				}));
			}
			for (const path of paths) {
				const data = JSON.parse(readFileSync(path, "utf-8")) as AuthStorageData;
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
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

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
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

