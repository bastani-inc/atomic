import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import { prepareSessionResume, ResumePreconditionError } from "../src/index.ts";

useTemporaryAgentDir();

const removal = vi.hoisted(() => ({ failure: undefined as Error | undefined }));

vi.mock("../src/core/worktree-snapshot/restore.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/worktree-snapshot/restore.ts")>();
	return {
		...actual,
		removeRestoredWorktree: async (...args: Parameters<typeof actual.removeRestoredWorktree>) => {
			if (removal.failure) throw removal.failure;
			return actual.removeRestoredWorktree(...args);
		},
	};
});

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	removal.failure = undefined;
	sandbox.dispose();
});

test("a rollback that fails is kept as the cleanup cause of the missing-hook error, not in its place (#4329)", async () => {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "package-lock.json": "{}\n" });
	sandbox.write(join(clone, "README.md"), "edited\n");
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const manager = await SessionManager.create(store, clone);
	await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
	const capture = await captureWorktreeSnapshot(clone, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		blobs: store.snapshotBlobs,
	});
	if (capture.status !== "captured") throw new Error(capture.status);
	await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	renameSync(clone, sandbox.path("gone"));
	removal.failure = new Error("worktree is busy");

	const error = await prepareSessionResume(manager, {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		storeDir: sandbox.path("host"),
		setup: { command: undefined, trusted: () => true },
	}).then(
		() => assert.fail("the repository has no setup hook"),
		(failure: Error) => failure,
	);

	assert.ok(error instanceof ResumePreconditionError);
	assert.equal(error.problems[0]?.code, "setup-hook-missing");
	assert.equal((error as Error & { cleanupCause?: unknown }).cleanupCause, removal.failure);
	assert.equal(Object.keys(error).includes("cleanupCause"), false);
});

test("a rollback of two restored worktrees that both fail keeps both causes together (#4329)", async () => {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const clones: string[] = [];
	for (const name of ["first", "second"]) {
		const { clone } = await sandbox.remoteWithClone(name, { "README.md": `${name}\n`, "package-lock.json": "{}\n" });
		sandbox.write(join(clone, "README.md"), "edited\n");
		clones.push(clone);
	}
	const manager = await SessionManager.create(store, clones[0]!);
	await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
	for (const clone of clones) {
		const capture = await captureWorktreeSnapshot(clone, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			blobs: store.snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		renameSync(clone, `${clone}-gone`);
	}
	removal.failure = new Error("worktree is busy");

	const error = await prepareSessionResume(manager, {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		storeDir: sandbox.path("host"),
		setup: { command: undefined, trusted: () => true },
	}).then(
		() => assert.fail("the repositories have no setup hook"),
		(failure: Error) => failure,
	);

	assert.ok(error instanceof ResumePreconditionError);
	const cause = (error as Error & { cleanupCause?: unknown }).cleanupCause;
	assert.ok(cause instanceof AggregateError);
	assert.deepEqual(cause.errors, [removal.failure, removal.failure]);
});
