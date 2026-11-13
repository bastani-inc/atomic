import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.ts";
import { resumeSessionWorktree } from "../src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { snapshotBlobHashes } from "../src/core/worktree-snapshot/blob-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { collectSnapshotGarbage } from "../src/core/worktree-snapshot/garbage.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.ts";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function record(
	manager: SessionManager,
	store: SqlSessionStore,
	root: string,
	content: string,
	previous?: WorktreeSnapshot,
): Promise<WorktreeSnapshot> {
	writeFileSync(join(root, "notes.txt"), content);
	const capture = await captureWorktreeSnapshot(root, {
		blobs: store.snapshotBlobs,
		previous,
		settings: { fullEvery: 1 },
	});
	if (capture.status !== "captured") throw new Error("expected a new snapshot");
	await manager.appendWorktreeSnapshot(root, capture.snapshot.id, capture.snapshot);
	return capture.snapshot;
}

test("retention keeps the latest snapshot of each session and collects blobs nothing retains (#4245, #4355)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const first = await SessionManager.create(store, clone);
	const older = await record(first, store, clone, "one\n");
	const newer = await record(first, store, clone, "two\n", older);
	const second = await SessionManager.create(store, clone);
	const shared = await record(second, store, clone, "two\n");
	assert.equal(shared.chain[0]!.patch, newer.chain[0]!.patch, "equal content shares one blob");

	const { deleted } = await collectSnapshotGarbage(store.snapshotBlobs, { graceSeconds: 0 });
	assert.deepEqual(deleted, snapshotBlobHashes(older));
	assert.deepEqual(await store.snapshotBlobs.listBlobHashes(), snapshotBlobHashes(newer));

	await store.delete(first.getSessionId());
	const afterDelete = await collectSnapshotGarbage(store.snapshotBlobs, { graceSeconds: 0 });
	assert.deepEqual(afterDelete.deleted, [], "the other session still needs the shared blob");
	await store.delete(second.getSessionId());
	const afterAll = await collectSnapshotGarbage(store.snapshotBlobs, { graceSeconds: 0 });
	assert.deepEqual(afterAll.deleted, snapshotBlobHashes(newer));
	assert.deepEqual(await store.snapshotBlobs.listBlobHashes(), []);
});

test("retention keeps each leaf's latest snapshot, so every branch of a session still resumes after collection (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const manager = await SessionManager.create(store, clone);
	const base = await record(manager, store, clone, "base\n");
	const fork = manager.getLeafId()!;
	const first = await record(manager, store, clone, "first branch\n", base);
	const firstLeaf = manager.getLeafId()!;
	await manager.branch(fork);
	const second = await record(manager, store, clone, "second branch\n", base);
	const secondLeaf = manager.getLeafId()!;
	await manager.branch(fork);
	await manager.appendSessionInfo("a third leaf that recorded nothing new");
	for (const snapshot of [first, second]) assert.equal(snapshot.chain.length, 1, "each branch has its own full delta");

	const { deleted } = await collectSnapshotGarbage(store.snapshotBlobs, { graceSeconds: 0 });
	assert.deepEqual(deleted, [], "the base and the latest snapshot of each branch are all retained");
	assert.deepEqual(
		[...(await store.snapshotBlobs.listBlobHashes())].sort(),
		[...new Set([base, first, second].flatMap(snapshotBlobHashes))].sort(),
	);

	for (const [leaf, expected] of [
		[firstLeaf, "first branch\n"],
		[secondLeaf, "second branch\n"],
	] as const) {
		writeFileSync(join(clone, "notes.txt"), "drifted\n");
		const reopened = await SessionManager.open(store, manager.getSessionId());
		await reopened.branch(leaf);
		const result = await resumeSessionWorktree(reopened, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			storeDir: sandbox.path(`host-${expected.length}`),
		});
		assert.equal(result.status, "restored");
		if (result.status !== "restored") return;
		assert.equal(readFileSync(join(result.cwd, "notes.txt"), "utf8"), expected);
	}
});

test("retention follows a restored checkout to its newest snapshot and lets the one it replaced go (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const manager = await SessionManager.create(store, clone);
	const recorded = await record(manager, store, clone, "recorded\n");
	writeFileSync(join(clone, "notes.txt"), "drifted\n");
	const restore = await resumeSessionWorktree(manager, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		storeDir: sandbox.path("host"),
	});
	assert.equal(restore.status, "restored");
	if (restore.status !== "restored") return;
	const newer = await record(manager, store, restore.cwd, "newer\n", recorded);
	const { deleted } = await collectSnapshotGarbage(store.snapshotBlobs, { graceSeconds: 0 });
	assert.deepEqual(deleted, snapshotBlobHashes(recorded), "only the snapshot the restored checkout replaced goes");
	assert.deepEqual([...(await store.snapshotBlobs.listBlobHashes())].sort(), snapshotBlobHashes(newer).sort());
});

test("retention keeps the snapshot a recorded /tree move reopens at, so resume restores that branch (#3325)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const manager = await SessionManager.create(store, clone);
	const selected = await record(manager, store, clone, "selected\n");
	const selectedLeaf = manager.getLeafId()!;
	const abandoned = await record(manager, store, clone, "abandoned\n", selected);
	await manager.recordBranch(selectedLeaf);

	const { deleted } = await collectSnapshotGarbage(store.snapshotBlobs, { graceSeconds: 0 });
	assert.deepEqual(deleted, [], "the selected branch and the abandoned one each keep their latest snapshot");
	assert.deepEqual(
		[...(await store.snapshotBlobs.listBlobHashes())].sort(),
		[...new Set([selected, abandoned].flatMap(snapshotBlobHashes))].sort(),
	);

	writeFileSync(join(clone, "notes.txt"), "drifted\n");
	const reopened = await SessionManager.open(store, manager.getSessionId());
	assert.equal(reopened.getLeafId(), selectedLeaf);
	const result = await resumeSessionWorktree(reopened, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		storeDir: sandbox.path("host"),
	});
	assert.equal(result.status, "restored");
	if (result.status !== "restored") return;
	assert.equal(readFileSync(join(result.cwd, "notes.txt"), "utf8"), "selected\n");
});
