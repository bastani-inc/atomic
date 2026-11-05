import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	captureWorktreeSnapshot,
	isWorkspaceDriftError,
	restoreWorktreeSnapshot,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.js";
import { RUN_EVENT_TYPES, type RunEvent } from "../../packages/workflows/src/durable/journal/types.js";
import {
	listWorkflowSnapshotBoundaries,
	resolveWorkflowSnapshotFrontier,
} from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { openSqlSnapshotJournal } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

test("resume validates the latest boundary once, fails on drift, and can restore it (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournal(sandbox.path("journal.sqlite"));
	const { journal } = fixture;
	await journal.createRun({ runId: "run", name: "run", cwd: clone, status: "running", createdAt: 1 });
	const acquired = await journal.acquire("run", "holder");
	assert.equal(acquired.status, "acquired");
	if (acquired.status !== "acquired") throw new Error("lease not acquired");
	const snapshots: WorktreeSnapshot[] = [];
	for (const value of ["T1", "T2", "T3"]) {
		sandbox.write(join(clone, "state.txt"), `${value}\n`);
		const capture = await captureWorktreeSnapshot(clone, {
			blobs: journal.snapshotBlobs,
			previous: snapshots.at(-1),
		});
		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") throw new Error("capture failed");
		snapshots.push(capture.snapshot);
		await journal.append(acquired.lease, {
			type: RUN_EVENT_TYPES.checkpointRecorded,
			payload: {
				kind: "tool",
				checkpointId: value,
				worktreeSnapshots: [capture.snapshot],
			},
		} as unknown as RunEvent);
	}
	assert.deepEqual(await resolveWorkflowSnapshotFrontier(journal, "run"), []);
	sandbox.write(join(clone, "state.txt"), "drift\n");
	const mappings = await resolveWorkflowSnapshotFrontier(journal, "run", { storeDir: sandbox.path("host") });
	assert.equal(mappings.length, 1);
	assert.equal(mappings[0]!.from, clone);
	assert.equal(mappings[0]!.snapshotId, snapshots[2]!.id);
	assert.equal(mappings[0]!.tree, snapshots[2]!.tree);
	assert.notEqual(mappings[0]!.to, clone);
	assert.equal(readFileSync(join(mappings[0]!.to, "state.txt"), "utf8"), "T3\n");
	assert.equal(readFileSync(join(clone, "state.txt"), "utf8"), "drift\n");
	const missingBlob = snapshots[2]!.chain.find((link) => link.patch)?.patch;
	assert.ok(missingBlob);
	const blobData = await journal.snapshotBlobs.getBlob(missingBlob);
	assert.ok(blobData);
	await journal.snapshotBlobs.deleteBlobs([missingBlob], { olderThanSeconds: 0 });
	await assert.rejects(
		resolveWorkflowSnapshotFrontier(journal, "run", { storeDir: sandbox.path("other-host") }),
		(error: unknown) => {
			assert.ok(isWorkspaceDriftError(error));
			assert.equal(error.code, "tree-drift");
			assert.equal(error.root, clone);
			assert.equal(error.expectedTree, snapshots[2]!.tree);
			assert.notEqual(error.actualTree, snapshots[2]!.tree);
			assert.equal((error.cause as { code?: string }).code, "blob-missing");
			assert.equal(error.reason, "restore-failed");
			assert.equal(error.restoreCode, "blob-missing");
			assert.equal(error.hint, (error.cause as { hint?: string }).hint);
			assert.ok(
				error.message.includes(
					`, and the automatic restore failed: Cannot restore snapshot ${snapshots[2]!.id}: patch blob ${missingBlob} is missing from storage (tree-drift). Use the storage the snapshot was recorded in`,
				),
				error.message,
			);
			return true;
		},
	);
	await journal.snapshotBlobs.putBlobs([{ hash: missingBlob, data: blobData }]);
	const boundary = (await listWorkflowSnapshotBoundaries(journal, "run"))[1]!;
	const tool2 = await restoreWorktreeSnapshot(boundary.snapshot, {
		blobs: journal.snapshotBlobs,
		storeDir: sandbox.path("host"),
	});
	assert.equal(readFileSync(join(tool2, "state.txt"), "utf8"), "T2\n");
	await fixture.close();
});

test("failed multi-root restore removes earlier fresh worktrees and records no mapping (#4245)", async () => {
	const first = await sandbox.remoteWithClone("one");
	const second = await sandbox.remoteWithClone("two");
	const fixture = await openSqlSnapshotJournal(sandbox.path("journal.sqlite"));
	const { journal } = fixture;
	await journal.createRun({ runId: "run", name: "run", cwd: first.clone, status: "running", createdAt: 1 });
	const acquired = await journal.acquire("run", "holder");
	assert.equal(acquired.status, "acquired");
	if (acquired.status !== "acquired") throw new Error("lease not acquired");
	for (const [index, clone] of [first.clone, second.clone].entries()) {
		sandbox.write(join(clone, "change.txt"), `captured ${index}\n`);
		const capture = await captureWorktreeSnapshot(clone, { blobs: journal.snapshotBlobs });
		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") throw new Error("capture failed");
		await journal.append(acquired.lease, {
			type: RUN_EVENT_TYPES.checkpointRecorded,
			payload: { kind: "tool", checkpointId: `tool-${index}`, worktreeSnapshots: [capture.snapshot] },
		} as unknown as RunEvent);
		sandbox.write(join(clone, "change.txt"), `drift ${index}\n`);
		if (index === 1)
			await journal.snapshotBlobs.deleteBlobs([capture.snapshot.chain[0]!.patch!], { olderThanSeconds: 0 });
	}
	const storeDir = sandbox.path("rollback-host");
	await assert.rejects(resolveWorkflowSnapshotFrontier(journal, "run", { storeDir }), (error: unknown) => {
		assert.ok(isWorkspaceDriftError(error));
		assert.equal(error.code, "tree-drift");
		assert.equal(error.root, second.clone);
		assert.equal((error.cause as { code?: string }).code, "blob-missing");
		return true;
	});
	const worktrees = join(storeDir, "worktrees");
	assert.deepEqual(existsSync(worktrees) ? readdirSync(worktrees) : [], []);
	const entries = [];
	for await (const entry of journal.read("run")) entries.push(entry);
	assert.equal(entries.length, 2);
	assert.equal(
		entries.every((entry) => entry.event.type === RUN_EVENT_TYPES.checkpointRecorded),
		true,
	);
	await fixture.close();
});
