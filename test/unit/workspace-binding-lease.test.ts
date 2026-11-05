import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	acquireWorkspaceWriterLease,
	isRetryableWorkspaceError,
	isWorkspaceBindingError,
	resolveWorkspace,
	workspace,
} from "../../packages/coding-agent/src/core/workspace/index.ts";
import { createRepository, git, type WorkspaceSandboxDirs, workspaceSandbox } from "../helpers/workspace-repos.ts";

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
		plantHolder(worktree, { pid: process.pid, host: hostname(), acquiredAt: "1970-01-01T00:00:00.000Z" });
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
		rmSync(join(lease.lockFile, ".."), { recursive: true, force: true });
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
});
