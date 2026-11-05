import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	SqlSnapshotBlobStore,
	snapshotBlobHashes,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import {
	captureWorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import type { WorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { ageBlobs } from "../helpers/snapshot-reference-index.js";
import { GitSandbox, loseSnapshotBlobs } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
let database: SqliteDatabase;
let blobs: SqlSnapshotBlobStore;
beforeEach(async () => {
	sandbox = new GitSandbox();
	database = await openNodeSqliteDatabase(sandbox.path("blobs.sqlite"));
	blobs = await SqlSnapshotBlobStore.open(database);
});
afterEach(async () => {
	await database.close();
	sandbox.dispose();
});

function captured(result: WorktreeSnapshotCapture): WorktreeSnapshot {
	if (result.status !== "captured" && result.status !== "unchanged") throw new Error(`unexpected ${result.status}`);
	return result.snapshot;
}

/** Seconds since each hash was stored or refreshed, on the database clock. */
async function ages(hashes: readonly string[]): Promise<number[]> {
	const ages: number[] = [];
	for (const hash of hashes) {
		const row = await database.get<{ age: number }>(
			`SELECT unixepoch() - created_at AS age FROM ${blobs.table} WHERE hash = ?`,
			hash,
		);
		ages.push(Number(row?.age));
	}
	return ages;
}

describe("capture keeps the blobs it reuses from collection until it publishes (#4355)", () => {
	test("an incremental capture restarts the age of the previous snapshot's blobs", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "a.txt"), "first\n");
		const first = captured(await captureWorktreeSnapshot(clone, { blobs }));
		await ageBlobs(database, blobs.table, 10_000);
		sandbox.write(join(clone, "a.txt"), "second\n");

		const second = await captureWorktreeSnapshot(clone, { blobs, previous: first });

		assert.equal(second.status, "captured");
		assert.equal(captured(second).chain.length, 2, "the capture is incremental on the previous snapshot");
		for (const age of await ages(snapshotBlobHashes(first))) assert.ok(age < 60, `reused blob is ${age}s old`);
	});

	test("an unchanged capture restarts their age too, since its entry references the same blobs", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "a.txt"), "same\n");
		const first = captured(await captureWorktreeSnapshot(clone, { blobs }));
		await ageBlobs(database, blobs.table, 10_000);

		const again = await captureWorktreeSnapshot(clone, { blobs, previous: first });

		assert.equal(again.status, "unchanged");
		for (const age of await ages(snapshotBlobHashes(first))) assert.ok(age < 60, `reused blob is ${age}s old`);
	});

	test("a previous snapshot whose blobs are gone is ignored: the capture records a full delta and stores its blobs", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "a.txt"), "first\n");
		const first = captured(await captureWorktreeSnapshot(clone, { blobs }));
		await loseSnapshotBlobs(blobs, snapshotBlobHashes(first));

		const unchangedTree = await captureWorktreeSnapshot(clone, { blobs, previous: first });
		assert.equal(unchangedTree.status, "captured", "an unchanged tree is captured again rather than referenced");
		assert.deepEqual(captured(unchangedTree).chain, first.chain);
		for (const hash of snapshotBlobHashes(first)) assert.ok(await blobs.getBlob(hash), `${hash} was stored again`);

		await loseSnapshotBlobs(blobs, snapshotBlobHashes(first));
		sandbox.write(join(clone, "a.txt"), "second\n");
		const changed = captured(await captureWorktreeSnapshot(clone, { blobs, previous: first }));
		assert.equal(changed.chain.length, 1);
		assert.equal(changed.delta.base, "head");
		for (const hash of snapshotBlobHashes(changed)) assert.ok(await blobs.getBlob(hash));
	});

	test("without a blob store the previous snapshot is used as given", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "a.txt"), "same\n");
		const first = captured(await captureWorktreeSnapshot(clone, { blobs }));
		await loseSnapshotBlobs(blobs, snapshotBlobHashes(first));

		assert.equal((await captureWorktreeSnapshot(clone, { previous: first })).status, "unchanged");
	});
});
