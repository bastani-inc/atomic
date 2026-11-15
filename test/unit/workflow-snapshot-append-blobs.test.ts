import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	collectSnapshotGarbage,
	isWorkspaceSnapshotError,
	rehydrateWorkspaceError,
	restoreWorktreeSnapshot,
	snapshotBlobHashes,
} from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { listWorkflowSnapshotBoundaries } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { closeSnapshotJournals, openSqlSnapshotJournalBackend } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	await closeSnapshotJournals();
	sandbox.dispose();
});

/** Runs a collection with no grace window right after each of the next `times` blob writes, as a racing process would. */
function collectAfterBlobWrites(journal: SqlRunJournal, times: number): void {
	const blobs = journal.snapshotBlobs;
	const putBlobs = blobs.putBlobs.bind(blobs);
	let left = times;
	blobs.putBlobs = async (written) => {
		await putBlobs(written);
		if (left-- > 0) await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
	};
}

const editing = workflow({
	name: "snapshot-race",
	description: "",
	inputs: {},
	outputs: { ok: Type.Boolean() },
	run: async (ctx) => {
		await ctx.tool("write", {}, async () => {
			sandbox.write(join(ctx.cwd!, "a.txt"), "edited\n");
			return "done";
		});
		return { ok: true };
	},
});

test("a checkpoint whose snapshot blobs a collection deletes before it is committed still records a restorable snapshot (#5077)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const { journal, backend } = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	collectAfterBlobWrites(journal, 1);
	const store = createStore();
	const result = await run(editing, {}, { cwd: clone, durableBackend: backend, store });

	assert.equal(result.status, "completed", JSON.stringify(result.error ?? result));
	assert.equal(store.run(result.runId)?.snapshotUnavailable, undefined);
	const [boundary] = await listWorkflowSnapshotBoundaries(journal, result.runId);
	assert.ok(boundary, "the tool checkpoint carries a snapshot");
	const stored = new Set(await journal.snapshotBlobs.listBlobHashes());
	for (const hash of snapshotBlobHashes(boundary.snapshot)) assert.ok(stored.has(hash), `blob ${hash} is stored`);
	const restored = await restoreWorktreeSnapshot(boundary.snapshot, {
		blobs: journal.snapshotBlobs,
		storeDir: sandbox.path("restores"),
	});
	assert.equal(readFileSync(join(restored, "a.txt"), "utf8"), "edited\n");
});

test("a checkpoint whose snapshot blobs are collected every time records no snapshot, keeps the run going and says why (#5077)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const { journal, backend } = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	collectAfterBlobWrites(journal, Number.POSITIVE_INFINITY);
	const store = createStore();
	const result = await run(editing, {}, { cwd: clone, durableBackend: backend, store });

	assert.equal(result.status, "completed");
	assert.deepEqual(await listWorkflowSnapshotBoundaries(journal, result.runId), []);
	const reason = store.run(result.runId)?.snapshotUnavailable;
	assert.ok(reason);
	const error = rehydrateWorkspaceError(reason);
	assert.ok(isWorkspaceSnapshotError(error));
	assert.equal(error.code, "blobs-collected");
});
