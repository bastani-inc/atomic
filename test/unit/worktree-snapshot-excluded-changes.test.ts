import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	captureWorktreeSnapshot,
	isWorkspaceDriftError,
	MemorySnapshotBlobStore,
	restoreWorktree,
	verifyWorktree,
	type WorktreeRestoreWarning,
	type WorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { RUN_EVENT_TYPES, type RunEvent } from "../../packages/workflows/src/durable/journal/types.js";
import { resolveWorkflowSnapshotFrontier } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { openSqlSnapshotJournal } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

type Captured = Extract<WorktreeSnapshotCapture, { status: "captured" }>;
function captured(result: WorktreeSnapshotCapture): Captured {
	assert.equal(result.status, "captured");
	return result as Captured;
}

const capped = { maxFileBytes: 1000 };

describe("verification of a recorded file that the policy or caps now leave out (#4245)", () => {
	test("a recorded file that grew past maxFileBytes is drift, not a match", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "data.json"), "x".repeat(500));
		const snapshot = captured(await captureWorktreeSnapshot(clone, { settings: capped })).snapshot;
		sandbox.write(join(clone, "data.json"), "y".repeat(3000));
		await assert.rejects(verifyWorktree(snapshot, clone, { settings: capped }), (error: unknown) => {
			assert.ok(isWorkspaceDriftError(error));
			assert.equal(error.code, "tree-drift");
			assert.equal(error.expectedTree, snapshot.tree);
			assert.notEqual(error.actualTree, snapshot.tree);
			return true;
		});
	});

	test("a changed recorded file that .atomic/snapshot-ignore now lists is drift", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", ".gitignore": ".atomic/\n" });
		sandbox.write(join(clone, "notes.txt"), "recorded\n");
		const snapshot = captured(await captureWorktreeSnapshot(clone)).snapshot;
		sandbox.write(join(clone, "notes.txt"), "changed\n");
		sandbox.write(join(clone, ".atomic", "snapshot-ignore"), "notes.txt\n");
		await assert.rejects(verifyWorktree(snapshot, clone), (error: unknown) => {
			assert.ok(isWorkspaceDriftError(error));
			assert.equal(error.expectedTree, snapshot.tree);
			assert.notEqual(error.actualTree, snapshot.tree);
			return true;
		});
	});

	test("a tracked denied file edited after the capture still matches, because both keep its HEAD content", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", ".env": "COMMITTED=1\n" });
		sandbox.write(join(clone, "a.txt"), "a\n");
		const snapshot = captured(await captureWorktreeSnapshot(clone)).snapshot;
		sandbox.write(join(clone, ".env"), "SECRET=2\n");
		assert.equal((await verifyWorktree(snapshot, clone)).tree, snapshot.tree);
	});

	test("a resumed workflow restores instead of continuing on a checkout whose recorded file grew past the cap", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const fixture = await openSqlSnapshotJournal(sandbox.path("journal.sqlite"));
		const { journal } = fixture;
		await journal.createRun({ runId: "run", name: "run", cwd: clone, status: "running", createdAt: 1 });
		const acquired = await journal.acquire("run", "holder");
		if (acquired.status !== "acquired") throw new Error("lease not acquired");
		sandbox.write(join(clone, "data.json"), "x".repeat(500));
		const snapshot = captured(
			await captureWorktreeSnapshot(clone, { settings: capped, blobs: journal.snapshotBlobs }),
		).snapshot;
		await journal.append(acquired.lease, {
			type: RUN_EVENT_TYPES.checkpointRecorded,
			payload: { kind: "tool", checkpointId: "T1", worktreeSnapshots: [snapshot] },
		} as unknown as RunEvent);
		sandbox.write(join(clone, "data.json"), "y".repeat(3000));
		const mappings = await resolveWorkflowSnapshotFrontier(journal, "run", {
			settings: capped,
			storeDir: sandbox.path("host"),
		});
		assert.equal(mappings.length, 1);
		assert.equal(mappings[0]!.from, clone);
		assert.equal(readFileSync(join(mappings[0]!.to, "data.json"), "utf8"), "x".repeat(500));
	});
});

describe("a capture whose tree is unchanged but whose omissions changed (#4245)", () => {
	test("records a new snapshot listing the new omission, with a new id, and an exact repeat is unchanged", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "a.txt"), "a\n");
		const blobs = new MemorySnapshotBlobStore();
		const first = captured(await captureWorktreeSnapshot(clone, { blobs })).snapshot;
		sandbox.write(join(clone, ".env.local"), "TOKEN=1\n");
		const second = captured(await captureWorktreeSnapshot(clone, { blobs, previous: first })).snapshot;
		assert.equal(second.tree, first.tree);
		assert.notEqual(second.id, first.id);
		assert.deepEqual(second.omitted, [{ reason: "denied", path: ".env.local" }]);
		const repeat = await captureWorktreeSnapshot(clone, { blobs, previous: second });
		assert.equal(repeat.status, "unchanged");
		const warnings: WorktreeRestoreWarning[] = [];
		await restoreWorktree(second, { blobs, storeDir: sandbox.path("host"), onWarning: (w) => warnings.push(w) });
		assert.deepEqual(warnings, [{ code: "omitted-content", omitted: second.omitted }]);
	});

	test("a file that keeps growing past a cap is the same omission, so the capture stays unchanged", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "log.txt"), "x".repeat(2000));
		const first = captured(await captureWorktreeSnapshot(clone, { settings: capped })).snapshot;
		assert.deepEqual(first.omitted, [{ reason: "over-file-cap", path: "log.txt", bytes: 2000 }]);
		sandbox.write(join(clone, "log.txt"), "x".repeat(4000));
		const again = await captureWorktreeSnapshot(clone, { settings: capped, previous: first });
		assert.equal(again.status, "unchanged");
		assert.equal((again as { snapshot: WorktreeSnapshot }).snapshot, first);
	});

	test("an omission that disappears is a change too", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, ".env.local"), "TOKEN=1\n");
		const first = captured(await captureWorktreeSnapshot(clone)).snapshot;
		const { unlinkSync } = await import("node:fs");
		unlinkSync(join(clone, ".env.local"));
		const second = captured(await captureWorktreeSnapshot(clone, { previous: first })).snapshot;
		assert.deepEqual(second.omitted, []);
		assert.equal(second.tree, first.tree);
	});
});
