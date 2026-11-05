import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.ts";
import {
	acquireWorkspaceWriterLease,
	isRetryableWorkspaceError,
	isWorkspaceBindingError,
	resolveWorkspace,
	workspace,
} from "../../packages/coding-agent/src/core/workspace/index.ts";
import { closeAfter } from "../../packages/coding-agent/src/core/workspace/lease.ts";
import {
	createRepository,
	git,
	gitTranscript,
	type WorkspaceSandboxDirs,
	workspaceSandbox,
} from "../helpers/workspace-repos.ts";

const DEFAULT_LOCK_WAIT_MS = 5_000;

let dirs: WorkspaceSandboxDirs;

beforeEach(() => {
	dirs = workspaceSandbox("atomic-workspace-lease-");
});

afterEach(() => {
	dirs.cleanup();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail("expected a rejection");
}

async function boundWorktree(name: string): Promise<string> {
	const repo = createRepository(dirs.root, name);
	return (await resolveWorkspace(workspace({ repo, branch: `${name}-work` }))).worktree;
}

function leaseFile(worktree: string): string {
	return join(git(worktree, "rev-parse", "--absolute-git-dir"), "atomic-writer-lease.sqlite");
}

/** Write a holder row directly, as another process or host would have left it. */
function plantHolder(worktree: string, holder: { pid: number; host: string; acquiredAt?: string }): void {
	const database = new DatabaseSync(leaseFile(worktree));
	try {
		database.exec(
			"CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, owner TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, acquired_at TEXT NOT NULL)",
		);
		database
			.prepare("INSERT OR REPLACE INTO writer VALUES (1, 'planted', 'planted-owner', ?, ?, ?)")
			.run(holder.pid, holder.host, holder.acquiredAt ?? new Date().toISOString());
	} finally {
		database.close();
	}
}

/** The holder rows of a worktree's lease store. */
function assertLeaseStore(worktree: string): readonly { readonly owner: string }[] {
	const database = new DatabaseSync(leaseFile(worktree));
	try {
		return database
			.prepare("SELECT owner FROM writer")
			.all()
			.map((row) => ({ owner: String(row.owner) }));
	} finally {
		database.close();
	}
}

function exitedPid(): number {
	const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
		encoding: "utf-8",
	});
	return Number(child.stdout);
}

describe("workspace writer lease (#3109)", () => {
	test("admits one writer per worktree and admits the next after release (#3109)", async () => {
		const worktree = await boundWorktree("single");
		const first = await acquireWorkspaceWriterLease({ worktree }, { owner: "run-1/goal-a" });
		assert.equal(first.holder.pid, process.pid);
		assert.equal(first.holder.host, hostname());
		const conflict = await rejection(acquireWorkspaceWriterLease({ worktree }, { owner: "run-1/goal-b" }));
		assert.ok(isWorkspaceBindingError(conflict));
		assert.equal(conflict.code, "writer-conflict");
		assert.equal(conflict.fields.holder, "run-1/goal-a");
		assert.equal(conflict.fields.holderPid, process.pid);
		assert.equal(conflict.fields.lockFile, first.lockFile);
		assert.equal(conflict.retryable, true);
		assert.equal(isRetryableWorkspaceError(new Error("wrapped", { cause: conflict })), true);
		await first.release();
		assert.deepEqual(assertLeaseStore(worktree), [], "release removes the holder row");
		const second = await acquireWorkspaceWriterLease({ worktree }, { owner: "run-1/goal-b" });
		await second.release();
	});

	test("takes over a lease whose process exited on this host (#3109)", async () => {
		const worktree = await boundWorktree("stale");
		plantHolder(worktree, { pid: exitedPid(), host: hostname() });
		const lease = await acquireWorkspaceWriterLease({ worktree }, { owner: "recovered" });
		assert.equal(lease.holder.owner, "recovered");
		await lease.release();
	});

	test("takes over a lease an earlier process left with this process's pid, as after a container restart (#3109)", async () => {
		const worktree = await boundWorktree("same-pid");
		plantHolder(worktree, { pid: process.pid, host: hostname() });
		const lease = await acquireWorkspaceWriterLease({ worktree }, { owner: "restarted" });
		assert.equal(lease.holder.owner, "restarted");
		const second = await rejection(acquireWorkspaceWriterLease({ worktree }, { owner: "second" }));
		assert.ok(isWorkspaceBindingError(second), "a lease this process holds stays held");
		assert.equal(second.fields.holder, "restarted");
		await lease.release();
	});

	test("a lease whose release failed can be taken over by the same process (#3109)", async () => {
		const worktree = await boundWorktree("failed-release");
		const lease = await acquireWorkspaceWriterLease({ worktree }, { owner: "first" });
		renameSync(lease.lockFile, `${lease.lockFile}.aside`);
		mkdirSync(lease.lockFile);
		await rejection(lease.release());
		rmSync(lease.lockFile, { recursive: true, force: true });
		renameSync(`${lease.lockFile}.aside`, lease.lockFile);
		const next = await acquireWorkspaceWriterLease({ worktree }, { owner: "next" });
		assert.equal(next.holder.owner, "next");
		await next.release();
	});

	test("keeps a lease held on another host: liveness there cannot be checked (#3109)", async () => {
		const worktree = await boundWorktree("remote-holder");
		plantHolder(worktree, { pid: exitedPid(), host: "another-host.example" });
		const error = await rejection(acquireWorkspaceWriterLease({ worktree }, { owner: "here" }));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "writer-conflict");
		assert.equal(error.fields.holderHost, "another-host.example");
	});

	test("ignores lease timestamps, so clock skew neither expires nor extends a lease (#3109)", async () => {
		const worktree = await boundWorktree("skew");
		plantHolder(worktree, { pid: process.ppid, host: hostname(), acquiredAt: "1970-01-01T00:00:00.000Z" });
		const ancient = await rejection(acquireWorkspaceWriterLease({ worktree }, { owner: "skewed" }));
		assert.ok(isWorkspaceBindingError(ancient));
		assert.equal(ancient.code, "writer-conflict");
		plantHolder(worktree, { pid: exitedPid(), host: hostname(), acquiredAt: "2999-01-01T00:00:00.000Z" });
		const future = await acquireWorkspaceWriterLease({ worktree }, { owner: "skewed" });
		await future.release();
	});

	test("a released or superseded lease never removes its successor (#3109)", async () => {
		const worktree = await boundWorktree("superseded");
		const first = await acquireWorkspaceWriterLease({ worktree }, { owner: "first" });
		await first.release();
		const second = await acquireWorkspaceWriterLease({ worktree }, { owner: "second" });
		await first.release();
		const conflict = await rejection(acquireWorkspaceWriterLease({ worktree }, { owner: "third" }));
		assert.ok(isWorkspaceBindingError(conflict));
		assert.equal(conflict.fields.holder, "second");
		await second.release();
	});

	test("releasing after the worktree's git directory is gone is a no-op (#3109)", async () => {
		const worktree = await boundWorktree("removed");
		const lease = await acquireWorkspaceWriterLease({ worktree }, { owner: "removed" });
		rmSync(join(lease.lockFile, ".."), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		await lease.release();
	});

	test("cancellation before the lease is taken rejects with signal.reason (#3109)", async () => {
		const worktree = await boundWorktree("cancelled");
		const controller = new AbortController();
		const reason = new Error("cancelled");
		controller.abort(reason);
		assert.equal(
			await rejection(acquireWorkspaceWriterLease({ worktree }, { owner: "x", signal: controller.signal })),
			reason,
		);
	});

	// POSIX: pid 1 belongs to root, so signalling it reports EPERM rather than ESRCH.
	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"treats a holder this user may not signal as alive (#3109)",
		async () => {
			const worktree = await boundWorktree("eperm");
			plantHolder(worktree, { pid: 1, host: hostname() });
			const error = await rejection(acquireWorkspaceWriterLease({ worktree }, { owner: "eperm" }));
			assert.ok(isWorkspaceBindingError(error));
			assert.equal(error.code, "writer-conflict");
			assert.equal(error.fields.holderPid, 1);
		},
	);

	test("reports a lease store held mid-transaction by another writer as a typed conflict within the wait (#3109)", async () => {
		const worktree = await boundWorktree("busy");
		const first = await acquireWorkspaceWriterLease({ worktree }, { owner: "first" });
		await first.release();
		const blocker = new DatabaseSync(leaseFile(worktree));
		blocker.exec("BEGIN IMMEDIATE");
		try {
			const error = await rejection(acquireWorkspaceWriterLease({ worktree }, { owner: "second", lockWaitMs: 200 }));
			assert.ok(isWorkspaceBindingError(error));
			assert.equal(error.code, "writer-conflict");
			assert.equal(error.fields.holder, "an in-flight lease transaction");
			assert.equal(error.fields.holderPid, null);
			assert.equal(error.fields.holderHost, null);
			assert.equal((error.cause as { name?: string }).name, "StorageUnavailableError");
			const waited = Number(/gave up after (\d+) ms/.exec(String((error.cause as Error).message))?.[1]);
			assert.ok(
				waited >= 200 && waited < DEFAULT_LOCK_WAIT_MS,
				`waited ${waited} ms: its own lock wait, not the default`,
			);
		} finally {
			blocker.exec("ROLLBACK");
			blocker.close();
		}
		const after = await acquireWorkspaceWriterLease({ worktree }, { owner: "after" });
		assert.equal(after.holder.owner, "after");
		await after.release();
	});

	test("reports a malformed lease store as the storage failure it is, not as another writer (#3109)", async () => {
		const worktree = await boundWorktree("malformed");
		const database = new DatabaseSync(leaseFile(worktree));
		database.exec("CREATE TABLE writer (id INTEGER PRIMARY KEY)");
		database.close();
		const error = await rejection(acquireWorkspaceWriterLease({ worktree }, { owner: "malformed" }));
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(isWorkspaceBindingError(error), false);
		assert.match(error.message, /no such column: token/);
	});

	test("locates the lease store with one local git command (#3109)", async () => {
		const worktree = await boundWorktree("lease-phase");
		const { result, transcript } = await gitTranscript(() =>
			acquireWorkspaceWriterLease({ worktree }, { owner: "phase" }),
		);
		assert.deepEqual(transcript, ["lease: rev-parse --absolute-git-dir"]);
		await result.release();
	});

	test("closing after a failure records a close failure without replacing the failure (#3109)", async () => {
		const failure = new Error("body failed");
		const closeFailure = new Error("close failed");
		const error = await rejection(
			closeAfter({ close: () => Promise.reject(closeFailure) }, () => Promise.reject(failure)),
		);
		assert.equal(error, failure);
		assert.equal((error as { cleanupCause?: unknown }).cleanupCause, closeFailure);
		let closed = 0;
		const value = await closeAfter(
			{
				close: async () => {
					closed += 1;
				},
			},
			async () => "done",
		);
		assert.equal(value, "done");
		assert.equal(closed, 1);
	});
});
