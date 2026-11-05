import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { SqliteExecutor } from "../storage/database.js";
import { findStorageWriteLockTimeoutError } from "../storage/errors.js";
import { openNodeSqliteDatabase } from "../storage/node-sqlite.js";
import { isSqliteBusy } from "../storage/write-ahead-log.js";
import { attachCleanupCause, isWorkspaceError, WorkspaceBindingError, WorkspaceTimeoutError } from "./errors.ts";
import { gitOutput } from "./git.ts";
import type { BoundWorkspace } from "./resolve.ts";

/** Who holds a worktree's writer lease. */
export interface WorkspaceWriterLeaseHolder {
	readonly token: string;
	readonly owner: string;
	readonly pid: number;
	readonly host: string;
	readonly acquiredAt: string;
}

/** Exclusive right to write a worktree. Release it when the writer finishes. */
export interface WorkspaceWriterLease {
	readonly worktree: string;
	readonly lockFile: string;
	readonly holder: WorkspaceWriterLeaseHolder;
	release(): Promise<void>;
}

export interface AcquireWorkspaceWriterLeaseOptions {
	/** Human-readable owner recorded with the lease, for example a run and stage. */
	readonly owner: string;
	readonly signal?: AbortSignal;
	/** How long to wait for another process's in-flight lease transaction. Default 5 s. */
	readonly lockWaitMs?: number;
}

const LEASE_DATABASE = "atomic-writer-lease.sqlite";
const REPOSITORY_LOCK_DATABASE = "atomic-repository-lock.sqlite";
const REPOSITORY_LOCK_WAIT_MS = 10 * 60_000;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const SCHEMA =
	"CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, owner TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, acquired_at TEXT NOT NULL)";

interface HolderRow {
	readonly token: string;
	readonly owner: string;
	readonly pid: number;
	readonly host: string;
	readonly acquired_at: string;
}

/** Whether `pid` is a live process on this host. A process we may not signal (EPERM) still exists. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { readonly code?: unknown }).code === "EPERM";
	}
}

/** Tokens of the leases this process holds and has not released. */
const heldTokens = new Set<string>();

/**
 * A holder is stale only when it ran on this host and its process is gone. A holder with this process's pid but a
 * token this process does not hold was an earlier process given the same pid, as after a container restart. A holder
 * on another host, or a live one (including a stopped one), keeps the lease, so the check fails closed. Wall-clock
 * time is never consulted.
 */
function isStale(holder: HolderRow): boolean {
	if (holder.host !== hostname()) return false;
	return holder.pid === process.pid ? !heldTokens.has(holder.token) : !processAlive(holder.pid);
}

async function leaseDatabase(worktree: string, signal: AbortSignal | undefined, lockWaitMs: number) {
	const gitDir = await gitOutput({
		cwd: worktree,
		args: ["rev-parse", "--absolute-git-dir"],
		phase: "lease",
		signal,
	});
	const lockFile = join(gitDir, LEASE_DATABASE);
	return { database: await openLeaseDatabase(lockFile, lockWaitMs), lockFile };
}

function openLeaseDatabase(lockFile: string, lockWaitMs: number) {
	return openNodeSqliteDatabase(lockFile, { busyTimeoutMs: lockWaitMs, lockWaitMs });
}

function conflict(worktree: string, lockFile: string, holder: HolderRow | undefined, cause?: unknown) {
	return new WorkspaceBindingError({
		code: "writer-conflict",
		fields: {
			worktree,
			lockFile,
			holder: holder?.owner ?? "an in-flight lease transaction",
			holderPid: holder?.pid ?? null,
			holderHost: holder?.host ?? null,
		},
		cause,
	});
}

/** Run `body`, then close `database`. A close failure after `body` failed is recorded as its `cleanupCause`. */
export async function closeAfter<T>(database: { close(): Promise<void> }, body: () => Promise<T>): Promise<T> {
	let result: T;
	try {
		result = await body();
	} catch (error) {
		const cleanupCause = await database.close().then(
			() => undefined,
			(cause: unknown) => cause,
		);
		throw attachCleanupCause(error, cleanupCause);
	}
	await database.close();
	return result;
}

/**
 * Run `body` holding the repository's lock: a SQLite write transaction in its git directory, so processes on this host
 * fetch a shared store and add worktrees to one repository one at a time. A lock whose process dies is released with it.
 * A holder that keeps it for `waitMs` without anyone else committing, such as a stopped process, fails the wait with a
 * `WorkspaceTimeoutError` naming that holder.
 */
export async function withRepositoryLock<T>(
	commonDir: string,
	body: () => Promise<T>,
	waitMs = REPOSITORY_LOCK_WAIT_MS,
): Promise<T> {
	const lockFile = join(commonDir, REPOSITORY_LOCK_DATABASE);
	try {
		const database = await openLeaseDatabase(lockFile, waitMs);
		return await closeAfter(database, () => database.transaction(body));
	} catch (error) {
		const timeout = isWorkspaceError(error) ? undefined : findStorageWriteLockTimeoutError(error);
		if (timeout === undefined) throw error;
		throw new WorkspaceTimeoutError({
			phase: "repository-lock",
			timeoutMs: timeout.timeoutMs,
			elapsedMs: timeout.elapsedMs,
			command: lockFile,
			holderPid: timeout.holderPid ?? null,
			cause: timeout,
		});
	}
}

/**
 * Take the writer lease of a bound worktree. The lease is one row in a SQLite database in the worktree's git directory,
 * claimed in a write transaction, so concurrent writers in any process see exactly one winner. A lease left by a process
 * that exited on this host (crash, SIGKILL) is taken over; any other holder makes this fail with `writer-conflict`.
 */
export async function acquireWorkspaceWriterLease(
	binding: Pick<BoundWorkspace, "worktree">,
	options: AcquireWorkspaceWriterLeaseOptions,
): Promise<WorkspaceWriterLease> {
	options.signal?.throwIfAborted();
	const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
	const { database, lockFile } = await leaseDatabase(binding.worktree, options.signal, lockWaitMs);
	const holder: WorkspaceWriterLeaseHolder = {
		token: randomUUID(),
		owner: options.owner,
		pid: process.pid,
		host: hostname(),
		acquiredAt: new Date().toISOString(),
	};
	const current = await closeAfter(database, async () => {
		try {
			await database.exec(SCHEMA);
			return await database.transaction(async (transaction: SqliteExecutor) => {
				const row = (await transaction.get(
					"SELECT token, owner, pid, host, acquired_at FROM writer WHERE id = 1",
				)) as HolderRow | undefined;
				if (row !== undefined && !isStale(row)) return row;
				await transaction.run(
					"INSERT OR REPLACE INTO writer (id, token, owner, pid, host, acquired_at) VALUES (1, ?, ?, ?, ?, ?)",
					holder.token,
					holder.owner,
					holder.pid,
					holder.host,
					holder.acquiredAt,
				);
				return undefined;
			});
		} catch (error) {
			if (isSqliteBusy(error)) throw conflict(binding.worktree, lockFile, undefined, error);
			throw error;
		}
	});
	if (current !== undefined) throw conflict(binding.worktree, lockFile, current);
	heldTokens.add(holder.token);
	return {
		worktree: binding.worktree,
		lockFile,
		holder,
		async release(): Promise<void> {
			heldTokens.delete(holder.token);
			if (!existsSync(lockFile)) return;
			const opened = await openLeaseDatabase(lockFile, lockWaitMs);
			await closeAfter(opened, async () => {
				await opened.run("DELETE FROM writer WHERE id = 1 AND token = ?", holder.token);
			});
		},
	};
}
