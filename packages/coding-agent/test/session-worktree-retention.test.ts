import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.ts";
import { listRetainedSessionSnapshots, resumeSessionWorktree } from "../src/core/session-worktree-snapshots.ts";
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

test("retention keeps the latest snapshot of each session and collects blobs nothing retains (#4245)", async () => {
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

	const retained = await listRetainedSessionSnapshots(store);
	assert.deepEqual(retained.map((snapshot) => snapshot.id).sort(), [newer.id, shared.id].sort());
	const { deleted } = await collectSnapshotGarbage(store.snapshotBlobs, retained, { graceSeconds: 0 });
	assert.deepEqual(deleted, snapshotBlobHashes(older));
	assert.deepEqual(await store.snapshotBlobs.listBlobHashes(), snapshotBlobHashes(newer));

	await store.delete(first.getSessionId());
	const afterDelete = await collectSnapshotGarbage(store.snapshotBlobs, await listRetainedSessionSnapshots(store), {
		graceSeconds: 0,
	});
	assert.deepEqual(afterDelete.deleted, [], "the other session still needs the shared blob");
	await store.delete(second.getSessionId());
	const afterAll = await collectSnapshotGarbage(store.snapshotBlobs, await listRetainedSessionSnapshots(store), {
		graceSeconds: 0,
	});
	assert.deepEqual(afterAll.deleted, snapshotBlobHashes(newer));
	assert.deepEqual(await store.snapshotBlobs.listBlobHashes(), []);
});

test("retention follows the branch a session reopens on, so collection never removes what resume restores (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const manager = await SessionManager.create(store, clone);
	const kept = await record(manager, store, clone, "kept\n");
	const branchPoint = manager.getLeafId()!;
	const abandoned = await record(manager, store, clone, "abandoned\n", kept);
	assert.equal(abandoned.chain.length, 1, "the abandoned snapshot shares no blob with the kept one");
	await manager.branch(branchPoint);
	await manager.appendSessionInfo("continued from the earlier snapshot");

	const retained = await listRetainedSessionSnapshots(store);
	assert.deepEqual(
		retained.map((snapshot) => snapshot.id),
		[kept.id],
	);
	const { deleted } = await collectSnapshotGarbage(store.snapshotBlobs, retained, { graceSeconds: 0 });
	assert.deepEqual(deleted, snapshotBlobHashes(abandoned));

	writeFileSync(join(clone, "notes.txt"), "drifted\n");
	const reopened = await SessionManager.open(store, manager.getSessionId());
	const result = await resumeSessionWorktree(reopened, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		storeDir: sandbox.path("host"),
	});
	assert.equal(result.status, "restored");
	assert.equal(result.status === "restored" && result.snapshot.id, kept.id);
});
