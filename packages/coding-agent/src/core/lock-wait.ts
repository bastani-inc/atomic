import type * as nodeFs from "node:fs";
import { guardLockRemoval, guardLockRemovalSync, lockHolder, lockHolderAsync } from "./lock-takeover.ts";

export { lockHolder };

/** How long any lock wait lasts in all while the lock keeps changing hands, unless its caller says otherwise. */
export const LOCK_CONTENTION_WAIT_MS = 120_000;

/** How a caller waits for a proper-lockfile lock that other processes hold. */
export interface LockWait {
	/** The lock directory proper-lockfile creates: a new holder creates a new one. */
	readonly lockPath: string;
	/**
	 * The stale window proper-lockfile is given for this lock. Its removal of a lock it judged stale goes through the
	 * file system the attempt is given, which removes the lock only while it is still stale, under the takeover mutex
	 * (#5161).
	 */
	readonly staleMs: number;
	/** How long one holder may keep the lock before the wait fails with {@link LockWait.stuck}. */
	readonly holderWaitMs: number;
	/** How long the wait lasts in all while the lock keeps changing hands, before it fails with {@link LockWait.contended}. */
	readonly contentionWaitMs?: number;
	readonly pollMinMs: number;
	/** Keep this low: a waiter that has backed off far loses the lock to every process polling more often. */
	readonly pollMaxMs: number;
	/** Whether `error` from an attempt means another process holds the lock, so the wait goes on. */
	readonly retryable: (error: unknown) => boolean;
	/**
	 * Frees the lock when its holder is proven gone, true when it did, so the next attempt follows at once instead of
	 * waiting for the lock to go stale (#5161).
	 */
	readonly takeOver?: () => boolean;
	/** The error when one holder kept the lock for {@link LockWait.holderWaitMs}. */
	readonly stuck: (error: unknown) => Error;
	/** The error when the lock kept changing hands for {@link LockWait.contentionWaitMs}. */
	readonly contended: (error: unknown, waitedMs: number) => Error;
}

export interface AsyncLockWait extends Omit<LockWait, "takeOver"> {
	readonly takeOver?: () => Promise<boolean>;
}

/**
 * The wait for one lock. Contention alone never fails it: the holder's allowance starts over whenever the lock changes
 * hands, so a waiter fails only when one holder keeps the lock too long, or after the overall contention bound.
 */
class LockWaiter {
	private readonly startedAt = Date.now();
	private holder: string | undefined;
	private holderDeadline: number;
	private pollMs: number;
	private readonly wait: Omit<LockWait, "takeOver">;

	constructor(wait: Omit<LockWait, "takeOver">, holder: string | undefined) {
		this.wait = wait;
		this.holder = holder;
		this.holderDeadline = this.startedAt + wait.holderWaitMs;
		this.pollMs = wait.pollMinMs;
	}

	next(error: unknown, holder: string | undefined): number {
		const now = Date.now();
		if (holder !== this.holder) {
			this.holder = holder;
			this.holderDeadline = now + this.wait.holderWaitMs;
		}
		const waitedMs = now - this.startedAt;
		if (waitedMs >= (this.wait.contentionWaitMs ?? LOCK_CONTENTION_WAIT_MS))
			throw this.wait.contended(error, waitedMs);
		const remainingMs = this.holderDeadline - now;
		if (remainingMs <= 0) throw this.wait.stuck(error);
		const sleepMs = Math.min(Math.round(this.pollMs * (1 + Math.random())), remainingMs);
		this.pollMs = Math.min(this.pollMs * 2, this.wait.pollMaxMs);
		return sleepMs;
	}
}

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

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** The file system each attempt passes to proper-lockfile as its `fs` option. */
export type LockFileSystem = typeof nodeFs;

/**
 * Takes a lock with `acquire`, waiting synchronously as {@link LockWait} describes while other processes hold it.
 * `acquire` passes the file system it is given to proper-lockfile as its `fs` option.
 */
export function waitForLockSync<T>(acquire: (fs: LockFileSystem) => T, wait: LockWait): T {
	const waiter = new LockWaiter(wait, lockHolder(wait.lockPath));
	const guard = guardLockRemovalSync(wait.lockPath, wait.staleMs);
	try {
		for (;;) {
			try {
				return acquire(guard.fs);
			} catch (error) {
				if (!wait.retryable(error)) throw error;
				if (wait.takeOver?.()) continue;
				Atomics.wait(sleeper, 0, 0, waiter.next(error, lockHolder(wait.lockPath)));
			}
		}
	} finally {
		guard.done();
	}
}

export async function waitForLock<T>(
	acquire: (fs: LockFileSystem) => Promise<T>,
	wait: AsyncLockWait,
	signal?: AbortSignal,
): Promise<T> {
	const waiter = new LockWaiter(wait, await lockHolderAsync(wait.lockPath));
	const guard = guardLockRemoval(wait.lockPath, wait.staleMs);
	try {
		for (;;) {
			signal?.throwIfAborted();
			try {
				return await acquire(guard.fs);
			} catch (error) {
				if (!wait.retryable(error)) throw error;
				if (await wait.takeOver?.()) continue;
				await delay(waiter.next(error, await lockHolderAsync(wait.lockPath)), signal);
			}
		}
	} finally {
		guard.done();
	}
}

const lockTurns = new Map<string, Promise<void>>();

export async function inLockTurn<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const previous = lockTurns.get(path) ?? Promise.resolve();
	let end!: () => void;
	const ended = new Promise<void>((resolve) => {
		end = resolve;
	});
	const turn = previous.then(() => ended);
	lockTurns.set(path, turn);
	await previous;
	try {
		return await fn();
	} finally {
		end();
		if (lockTurns.get(path) === turn) lockTurns.delete(path);
	}
}
