import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	SessionWorktreeSnapshotRecorder,
	type WorktreeSnapshotUnavailable,
} from "../src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { snapshotBlobHashes } from "../src/core/worktree-snapshot/blob-store.ts";
import { captureWorktreeSnapshot, recordWorktreeCapture } from "../src/core/worktree-snapshot/capture.ts";
import { WorkspaceSnapshotError } from "../src/core/worktree-snapshot/errors.ts";
import { collectSnapshotGarbage } from "../src/core/worktree-snapshot/garbage.ts";
import { restoreWorktreeSnapshot } from "../src/core/worktree-snapshot/restore.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

const writing = (path: string) =>
	fauxAssistantMessage([fauxToolCall("write", { path, content: "x" })], { stopReason: "toolUse" });

async function openSession() {
	const { clone } = await sandbox.remoteWithClone();
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const manager = await SessionManager.create(store, clone);
	const unavailable: WorktreeSnapshotUnavailable[] = [];
	const recorder = new SessionWorktreeSnapshotRecorder({
		sessionManager: manager,
		cwd: () => clone,
		settings: () => DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		declaresWrites: () => false,
		onUnavailable: (reason) => unavailable.push(reason),
	});
	return { clone, store, manager, recorder, unavailable };
}

/** Runs a collection with no grace window right after each of the next `times` blob writes, as a racing process would. */
function collectAfterBlobWrites(store: SqlSessionStore, times: number): void {
	const putBlobs = store.snapshotBlobs.putBlobs.bind(store.snapshotBlobs);
	let left = times;
	store.snapshotBlobs.putBlobs = async (blobs) => {
		await putBlobs(blobs);
		if (left-- > 0) await collectSnapshotGarbage(store.snapshotBlobs, { graceSeconds: 0 });
	};
}

test("a turn whose blobs a collection deletes before its entry is written still records a restorable snapshot (#5077)", async () => {
	const { clone, store, manager, recorder, unavailable } = await openSession();
	sandbox.write(join(clone, "a.txt"), "first\n");
	await recorder.recordTurn(writing(join(clone, "a.txt")));
	const first = manager.getLatestWorktreeSnapshots().get(clone)!;
	collectAfterBlobWrites(store, 1);
	sandbox.write(join(clone, "a.txt"), "second\n");
	await recorder.recordTurn(writing(join(clone, "a.txt")));

	assert.deepEqual(unavailable, []);
	const latest = manager.getLatestWorktreeSnapshots().get(clone)!;
	assert.notEqual(latest.id, first.id, "the turn recorded a new snapshot");
	const stored = new Set(await store.snapshotBlobs.listBlobHashes());
	for (const hash of snapshotBlobHashes(latest)) assert.ok(stored.has(hash), `blob ${hash} is stored`);
	const restored = await restoreWorktreeSnapshot(latest, {
		blobs: store.snapshotBlobs,
		storeDir: sandbox.path("restores"),
	});
	assert.equal(readFileSync(join(restored, "a.txt"), "utf8"), "second\n");
});

test("a turn whose blobs are collected every time it stores them records no snapshot and says why (#5077)", async () => {
	const { clone, store, manager, recorder, unavailable } = await openSession();
	sandbox.write(join(clone, "a.txt"), "first\n");
	await recorder.recordTurn(writing(join(clone, "a.txt")));
	const first = manager.getLatestWorktreeSnapshots().get(clone)!;
	const entries = manager.getEntries().length;
	collectAfterBlobWrites(store, Number.POSITIVE_INFINITY);
	sandbox.write(join(clone, "a.txt"), "second\n");
	await recorder.recordTurn(writing(join(clone, "a.txt")));

	assert.equal(unavailable.length, 1);
	assert.equal(unavailable[0]?.name, "WorkspaceSnapshotError");
	assert.equal(unavailable[0]?.code, "blobs-collected");
	assert.equal(manager.getEntries().length, entries, "no entry was written");
	assert.equal(manager.getLatestWorktreeSnapshots().get(clone)?.id, first.id, "the head is still the first snapshot");
	const reopened = await SessionManager.open(store, manager.getSessionId());
	assert.equal(reopened.getLatestWorktreeSnapshots().get(clone)?.id, first.id, "the store holds no new head");
});

test("appending a snapshot whose blobs were collected is refused and writes nothing (#5077)", async () => {
	const { clone, store, manager } = await openSession();
	sandbox.write(join(clone, "a.txt"), "edit\n");
	const capture = await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
	if (capture.status !== "captured") throw new Error("expected a new snapshot");
	const { deleted } = await collectSnapshotGarbage(store.snapshotBlobs, { graceSeconds: 0 });
	assert.deepEqual(deleted, snapshotBlobHashes(capture.snapshot));

	await manager.appendSessionInfo("an entry before the snapshot");
	const append = store.append.bind(store);
	let appends = 0;
	store.append = (...args) => {
		appends++;
		return append(...args);
	};
	await assert.rejects(manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot), {
		name: "WorkspaceSnapshotError",
		code: "blobs-collected",
	});
	assert.equal(appends, 1, "a refused append wrote nothing, so the manager does not reconcile and try again");
	assert.equal(manager.getLatestWorktreeSnapshots().size, 0);
	const reopened = await SessionManager.open(store, manager.getSessionId());
	assert.equal(reopened.getLatestWorktreeSnapshots().size, 0, "the store holds no head");
});

/** Records `clone`'s capture with `recordWorktreeCapture`, counting captures and the appends that were tried. */
async function recordCounting(manager: SessionManager, store: SqlSessionStore, clone: string) {
	const counts = { captures: 0, appends: 0 };
	const recorded = recordWorktreeCapture(
		store.snapshotBlobs,
		async () => {
			counts.captures++;
			return captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
		},
		async (result) => {
			counts.appends++;
			if (result.status !== "captured") throw new Error(`unexpected ${result.status}`);
			await manager.appendWorktreeSnapshot(clone, result.snapshot.id, result.snapshot);
		},
	);
	return { counts, recorded };
}

test("a capture whose blobs were collected is recorded after storing them again, without capturing again (#5077)", async () => {
	const { clone, store, manager } = await openSession();
	sandbox.write(join(clone, "a.txt"), "edit\n");
	collectAfterBlobWrites(store, 1);
	const { counts, recorded } = await recordCounting(manager, store, clone);
	await recorded;
	assert.deepEqual(counts, { captures: 1, appends: 2 });
	assert.equal(manager.getLatestWorktreeSnapshots().size, 1);
});

test("a capture whose blobs are collected again after storing them again is captured once more and recorded (#5077)", async () => {
	const { clone, store, manager } = await openSession();
	sandbox.write(join(clone, "a.txt"), "edit\n");
	collectAfterBlobWrites(store, 2);
	const { counts, recorded } = await recordCounting(manager, store, clone);
	await recorded;
	assert.deepEqual(counts, { captures: 2, appends: 3 });
	assert.equal(manager.getLatestWorktreeSnapshots().size, 1);
});

test("a capture whose blobs are always collected rejects with blobs-collected after one more capture (#5077)", async () => {
	const { clone, store, manager } = await openSession();
	sandbox.write(join(clone, "a.txt"), "edit\n");
	collectAfterBlobWrites(store, Number.POSITIVE_INFINITY);
	const { counts, recorded } = await recordCounting(manager, store, clone);
	await assert.rejects(recorded, { name: "WorkspaceSnapshotError", code: "blobs-collected" });
	assert.deepEqual(counts, { captures: 2, appends: 3 });
	assert.equal(manager.getLatestWorktreeSnapshots().size, 0);
});

for (const [name, failures] of [
	["fails for another reason", [new Error("not a collection")]],
	["fails with another snapshot error", [new WorkspaceSnapshotError("blob-store-failed", "node-sqlite")]],
	["fails with an error that only shares the code", [Object.assign(new Error("other"), { code: "blobs-collected" })]],
	[
		"is refused, then fails for another reason once its blobs are stored again",
		[new WorkspaceSnapshotError("blobs-collected", "hash"), new Error("not a collection")],
	],
] as const) {
	test(`a record that ${name} is not tried again and the checkout is not captured again (#5077)`, async () => {
		const { clone, store } = await openSession();
		let captures = 0;
		let records = 0;
		await assert.rejects(
			recordWorktreeCapture(
				store.snapshotBlobs,
				async () => {
					captures++;
					return captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
				},
				async () => {
					throw failures[records++];
				},
			),
			(error) => error === failures.at(-1),
		);
		assert.deepEqual([captures, records], [1, failures.length]);
	});
}

test("an unchanged capture refused for collected blobs is captured again rather than stored again (#5077)", async () => {
	const { clone, store } = await openSession();
	const stored: number[] = [];
	const blobs = Object.create(store.snapshotBlobs, {
		putBlobs: { value: async (written: readonly unknown[]) => stored.push(written.length) },
	}) as SqlSessionStore["snapshotBlobs"];
	const results: string[] = [];
	let refusals = 1;
	await recordWorktreeCapture(
		blobs,
		async () => {
			const capture = await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
			if (capture.status !== "captured") throw new Error("expected a capture");
			return { status: "unchanged", snapshot: capture.snapshot, binding: capture.binding };
		},
		async (result) => {
			results.push(result.status);
			if (refusals-- > 0) throw new WorkspaceSnapshotError("blobs-collected", "hash");
		},
	);
	assert.deepEqual(results, ["unchanged", "unchanged"]);
	assert.deepEqual(stored, [], "an unchanged capture has no blobs of its own to store again");
});
