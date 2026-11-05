import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { test } from "vitest";
import { snapshotBlob } from "../../packages/coding-agent/src/core/worktree-snapshot/env-hash.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";

test("the in-memory workflow journal has no blob table, so runs on it record no snapshots (#4245)", async () => {
	const journal = new MemoryRunJournal();
	assert.equal("snapshotBlobs" in journal, false);
	await journal.close();
});

test("workflow SQL journals share prefixed snapshot blobs across connections (#4245)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "workflow-snapshot-journal-"));
	const one = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const two = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	try {
		const first = await SqlRunJournal.open(one, { prefix: "test_" });
		const second = await SqlRunJournal.open(two, { prefix: "test_" });
		const separate = await SqlRunJournal.open(two, { prefix: "other_" });
		const blob = snapshotBlob(Buffer.from("patch bytes"));
		assert.ok(first.snapshotBlobs);
		assert.ok(second.snapshotBlobs);
		assert.ok(separate.snapshotBlobs);
		await first.snapshotBlobs.putBlobs([blob, blob]);
		assert.deepEqual(await second.snapshotBlobs.getBlob(blob.hash), Uint8Array.from(blob.data));
		assert.equal(await separate.snapshotBlobs.getBlob(blob.hash), undefined);
		assert.deepEqual(await second.snapshotBlobs.listBlobHashes(), [blob.hash]);
		await Promise.all([first.close(), second.close(), separate.close()]);
	} finally {
		await Promise.all([one.close(), two.close()]);
		await rm(directory, { recursive: true, force: true });
	}
});
