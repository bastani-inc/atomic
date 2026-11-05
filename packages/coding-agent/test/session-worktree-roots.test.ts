import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager, type WorktreeSnapshotEntry } from "../src/core/session-manager.ts";
import {
	compareWorktreeSnapshot,
	openSessionInWorktree,
	resumeSessionWorktree,
	sessionContinuesIn,
} from "../src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { isWorkspaceDriftError, isWorkspaceRestoreError } from "../src/core/worktree-snapshot/errors.ts";
import { setWorktreeSnapshotGit } from "../src/core/worktree-snapshot/git.ts";
import { verifyWorktree } from "../src/core/worktree-snapshot/restore.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";

let sandbox: GitSandbox;
let store: SqlSessionStore;
let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
beforeEach(async () => {
	sandbox = new GitSandbox();
	database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	store = await SqlSessionStore.open(database);
});
afterEach(async () => {
	await store.close();
	await database.close();
	sandbox.dispose();
});

async function record(manager: SessionManager, root: string): Promise<void> {
	const result = await captureWorktreeSnapshot(root, { blobs: store.snapshotBlobs });
	assert.equal(result.status, "captured");
	if (result.status !== "captured") throw new Error("snapshot unavailable");
	await manager.appendWorktreeSnapshot(root, result.snapshot.id, result.snapshot);
}

const options = () => ({ settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, storeDir: sandbox.path("host") });

test.skipIf(process.platform === "win32")("a symlinked session cwd follows a restored checkout (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "file.txt"), "recorded\n");
	symlinkSync(clone, sandbox.path("link"), "dir");
	const manager = await SessionManager.create(store, sandbox.path("link"));
	await record(manager, clone);
	sandbox.write(join(clone, "file.txt"), "drifted\n");
	const result = await resumeSessionWorktree(manager, options());
	assert.equal(result.status, "restored");
	if (result.status !== "restored") return;
	assert.equal(result.cwd, result.mappings[0]!.to);
	symlinkSync(result.cwd, sandbox.path("restored-link"), "dir");
	assert.equal(await sessionContinuesIn(store, manager.getSessionId(), sandbox.path("restored-link")), true);
	assert.equal(readFileSync(join(result.cwd, "file.txt"), "utf8"), "recorded\n");
});

test("committing the recorded edits keeps a session in place, while SDK verification remains strict (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "file.txt"), "recorded\n");
	const manager = await SessionManager.create(store, clone);
	await record(manager, clone);
	const snapshot = manager.getLatestWorktreeSnapshots().get(clone)!;
	await sandbox.commitAll(clone, "commit recorded content");
	await assert.rejects(verifyWorktree(snapshot, clone), (error: unknown) => {
		assert.ok(isWorkspaceDriftError(error));
		assert.equal(error.code, "tree-drift");
		assert.equal(error.expectedTree, error.actualTree);
		return true;
	});
	const result = await resumeSessionWorktree(manager, options());
	assert.equal(result.status, "verified");
	assert.equal(result.status === "verified" && result.cwd, clone);
	assert.deepEqual(manager.getWorktreeRootMappings(), []);
});

test("a session in a parent directory restores both missing recorded repositories, reports each and reuses them (#4245)", async () => {
	const a = await sandbox.remoteWithClone("a");
	const b = await sandbox.remoteWithClone("b");
	sandbox.write(join(a.clone, "file.txt"), "a\n");
	sandbox.write(join(b.clone, "file.txt"), "b\n");
	const manager = await SessionManager.create(store, sandbox.root);
	await record(manager, a.clone);
	await record(manager, b.clone);
	renameSync(a.clone, sandbox.path("a-away"));
	renameSync(b.clone, sandbox.path("b-away"));
	const opened = await openSessionInWorktree(manager, options());
	const mappings = manager.getWorktreeRootMappings();
	assert.equal(mappings.length, 2);
	assert.equal(opened.sessionManager.getCwd(), sandbox.root);
	assert.deepEqual(
		mappings.map((mapping) => mapping.from),
		[a.clone, b.clone],
	);
	assert.equal(readFileSync(join(mappings[0]!.to, "file.txt"), "utf8"), "a\n");
	assert.equal(readFileSync(join(mappings[1]!.to, "file.txt"), "utf8"), "b\n");
	assert.equal(opened.notices.filter((notice) => notice.type === "info").length, 2);
	const again = await resumeSessionWorktree(manager, options());
	assert.equal(again.status, "verified");
	assert.equal(readdirSync(join(options().storeDir, "worktrees")).length, 2);
	assert.equal(manager.getWorktreeRootMappings().length, 2);
});

test("the newest snapshot under a restored root supersedes its original location on later resumes (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "file.txt"), "first\n");
	const manager = await SessionManager.create(store, clone);
	await record(manager, clone);
	renameSync(clone, sandbox.path("original-away"));
	const first = await resumeSessionWorktree(manager, options());
	assert.equal(first.status, "restored");
	if (first.status !== "restored") return;
	sandbox.write(join(first.cwd, "file.txt"), "newest\n");
	await record(manager, first.cwd);
	assert.equal((await resumeSessionWorktree(manager, options())).status, "verified");
	sandbox.write(join(first.cwd, "file.txt"), "after the newest snapshot\n");
	const next = await resumeSessionWorktree(manager, options());
	assert.equal(next.status, "restored");
	if (next.status !== "restored") return;
	assert.equal(next.mappings.length, 1);
	assert.equal(next.mappings[0]!.from, first.cwd);
	assert.equal(readFileSync(join(next.cwd, "file.txt"), "utf8"), "newest\n");
	assert.equal((await resumeSessionWorktree(manager, options())).status, "verified");
});

test("a session inside one drifted repository restores it and another drifted recorded repository (#4245)", async () => {
	const a = await sandbox.remoteWithClone("a");
	const b = await sandbox.remoteWithClone("b");
	sandbox.write(join(a.clone, "file.txt"), "a\n");
	sandbox.write(join(b.clone, "file.txt"), "b\n");
	const manager = await SessionManager.create(store, a.clone);
	await record(manager, a.clone);
	await record(manager, b.clone);
	sandbox.write(join(a.clone, "file.txt"), "a drift\n");
	sandbox.write(join(b.clone, "file.txt"), "b drift\n");
	const result = await resumeSessionWorktree(manager, options());
	assert.equal(result.status, "restored");
	if (result.status !== "restored") return;
	assert.equal(result.mappings.length, 2);
	assert.equal(result.cwd, result.mappings[0]!.to);
	assert.equal(readFileSync(join(result.cwd, "file.txt"), "utf8"), "a\n");
	assert.equal(readFileSync(join(result.mappings[1]!.to, "file.txt"), "utf8"), "b\n");
});

test("an unavailable second repository fails closed and rolls back the first restore (#4245)", async () => {
	const a = await sandbox.remoteWithClone("a");
	const b = await sandbox.remoteWithClone("b");
	sandbox.write(join(a.clone, "file.txt"), "recorded\n");
	sandbox.write(join(b.clone, "private.pem"), "private\n");
	const deniedCommit = await sandbox.commitAll(b.clone, "denied history");
	const manager = await SessionManager.create(store, a.clone);
	await record(manager, a.clone);
	await record(manager, b.clone);
	renameSync(a.clone, sandbox.path("a-away"));
	renameSync(b.clone, sandbox.path("b-away"));
	await assert.rejects(resumeSessionWorktree(manager, options()), (error: unknown) => {
		assert.ok(isWorkspaceDriftError(error));
		assert.equal(error.code, "tree-drift");
		assert.equal(error.reason, "restore-failed");
		assert.ok(isWorkspaceRestoreError(error.cause));
		assert.equal(error.cause.code, "commits-unavailable");
		assert.deepEqual(error.cause.commits, [deniedCommit]);
		return true;
	});
	assert.deepEqual(manager.getWorktreeRootMappings(), []);
	const worktrees = join(options().storeDir, "worktrees");
	assert.deepEqual(existsSync(worktrees) ? readdirSync(worktrees) : [], []);
});

test("a retry heals a mapping persisted before a later mapping append failed (#4245)", async () => {
	const a = await sandbox.remoteWithClone("a");
	const b = await sandbox.remoteWithClone("b");
	sandbox.write(join(a.clone, "file.txt"), "a\n");
	sandbox.write(join(b.clone, "file.txt"), "b\n");
	const manager = await SessionManager.create(store, a.clone);
	await record(manager, a.clone);
	await record(manager, b.clone);
	renameSync(a.clone, sandbox.path("a-away"));
	renameSync(b.clone, sandbox.path("b-away"));
	const originalAppend = store.append.bind(store);
	const failure = new Error("second mapping could not be persisted");
	let count = 0;
	store.append = async (...args) => {
		if (++count === 2) throw failure;
		return originalAppend(...args);
	};
	try {
		await assert.rejects(resumeSessionWorktree(manager, options()), (error: unknown) => error === failure);
	} finally {
		store.append = originalAppend;
	}
	assert.equal(manager.getWorktreeRootMappings().length, 1);
	assert.equal(existsSync(manager.getWorktreeRootMappings()[0]!.to), false);
	const retried = await resumeSessionWorktree(manager, options());
	assert.equal(retried.status, "restored");
	if (retried.status !== "restored") return;
	assert.equal(retried.mappings.length, 2);
	assert.equal(readFileSync(join(retried.cwd, "file.txt"), "utf8"), "a\n");
	assert.equal(readFileSync(join(retried.mappings[1]!.to, "file.txt"), "utf8"), "b\n");
});

test("cancellation while publishing mappings propagates its reason and removes both worktrees (#4245)", async () => {
	const a = await sandbox.remoteWithClone("a");
	const b = await sandbox.remoteWithClone("b");
	sandbox.write(join(a.clone, "file.txt"), "a\n");
	sandbox.write(join(b.clone, "file.txt"), "b\n");
	const manager = await SessionManager.create(store, a.clone);
	await record(manager, a.clone);
	await record(manager, b.clone);
	renameSync(a.clone, sandbox.path("a-away"));
	renameSync(b.clone, sandbox.path("b-away"));
	const controller = new AbortController();
	const reason = new Error("stop publishing mappings");
	const originalAppend = store.append.bind(store);
	store.append = async (...args) => {
		const result = await originalAppend(...args);
		controller.abort(reason);
		return result;
	};
	try {
		await assert.rejects(
			resumeSessionWorktree(manager, { ...options(), signal: controller.signal }),
			(error: unknown) => error === reason,
		);
	} finally {
		store.append = originalAppend;
	}
	assert.deepEqual(readdirSync(join(options().storeDir, "worktrees")), []);
});

test("an identical tree on an unrelated HEAD restores the recorded history instead of continuing (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "file.txt"), "recorded\n");
	const manager = await SessionManager.create(store, clone);
	await record(manager, clone);
	const snapshot = manager.getLatestWorktreeSnapshots().get(clone)!;
	await sandbox.git(clone, "checkout", "-q", "--orphan", "unrelated");
	await sandbox.git(clone, "add", "-A");
	await sandbox.git(clone, "commit", "-q", "-m", "same content, unrelated history");
	const comparison = await compareWorktreeSnapshot(snapshot, clone, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS);
	assert.equal(comparison.status, "differs");
	assert.equal(comparison.status === "differs" && comparison.tree, snapshot.tree);
	const result = await resumeSessionWorktree(manager, options());
	assert.equal(result.status, "restored");
	if (result.status !== "restored") return;
	assert.equal(await sandbox.git(result.cwd, "rev-parse", "HEAD"), snapshot.head);
});

test("a recorded repository replaced by an unborn checkout restores its snapshot (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "file.txt"), "recorded\n");
	const manager = await SessionManager.create(store, clone);
	await record(manager, clone);
	rmSync(join(clone, ".git"), { recursive: true });
	await sandbox.git(clone, "init", "-q");
	const result = await resumeSessionWorktree(manager, options());
	assert.equal(result.status, "restored");
	if (result.status !== "restored") return;
	assert.equal(readFileSync(join(result.cwd, "file.txt"), "utf8"), "recorded\n");
});

test("snapshot comparison reports a matching tree and the advanced HEAD after committing recorded edits (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "file.txt"), "recorded\n");
	const manager = await SessionManager.create(store, clone);
	await record(manager, clone);
	const snapshot = manager.getLatestWorktreeSnapshots().get(clone)!;
	const head = await sandbox.commitAll(clone, "commit recorded content");
	assert.deepEqual(await compareWorktreeSnapshot(snapshot, clone, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS), {
		status: "match",
		tree: snapshot.tree,
		head,
	});
});

test("a missing latest snapshot record fails before any repository is restored (#4245)", async () => {
	const a = await sandbox.remoteWithClone("a");
	const b = await sandbox.remoteWithClone("b");
	const manager = await SessionManager.create(store, a.clone);
	await record(manager, a.clone);
	const ghost: WorktreeSnapshotEntry = {
		type: "worktree_snapshot",
		id: "ghost-entry",
		parentId: manager.getLeafId(),
		timestamp: new Date().toISOString(),
		root: b.clone,
		snapshotId: "missing-record",
	};
	const { lastSeq } = await store.load(manager.getSessionId());
	await store.append(manager.getSessionId(), [ghost], { expectSeq: lastSeq });
	const reopened = await SessionManager.open(store, manager.getSessionId());
	renameSync(a.clone, sandbox.path("a-away"));
	let calls = 0;
	setWorktreeSnapshotGit(async () => {
		calls++;
		return sandbox.executable;
	});
	await assert.rejects(resumeSessionWorktree(reopened, options()), (error: unknown) => {
		assert.ok(isWorkspaceRestoreError(error));
		assert.equal(error.code, "snapshot-not-found");
		assert.equal(error.snapshotId, "missing-record");
		assert.equal(error.target, b.clone);
		return true;
	});
	assert.equal(calls, 0);
	assert.equal(existsSync(options().storeDir), false);
});
