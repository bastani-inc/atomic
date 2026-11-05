import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { setWorktreeSnapshotGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import {
	captureWorktreeSnapshot,
	isHeadOnlyAdvance,
	isWorkspaceDriftError,
	verifyWorktree,
	WorkspaceDriftError,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

async function recorded(clone: string): Promise<WorktreeSnapshot> {
	sandbox.write(join(clone, "edit.txt"), "recorded edit\n");
	const result = await captureWorktreeSnapshot(clone);
	assert.equal(result.status, "captured");
	return (result as { snapshot: WorktreeSnapshot }).snapshot;
}

async function driftOf(snapshot: WorktreeSnapshot, clone: string): Promise<WorkspaceDriftError> {
	try {
		await verifyWorktree(snapshot, clone);
	} catch (error) {
		assert.ok(isWorkspaceDriftError(error));
		return error as WorkspaceDriftError;
	}
	throw new Error("expected the checkout to have drifted");
}

describe("a drift that only moved HEAD forward over the recorded tree (#4245)", () => {
	test("committing the recorded edits keeps the tree and descends from the recorded HEAD", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const snapshot = await recorded(clone);
		await sandbox.commitAll(clone, "commit the recorded edit");
		const drift = await driftOf(snapshot, clone);
		assert.equal(drift.actualTree, drift.expectedTree);
		assert.equal(await isHeadOnlyAdvance(drift), true);
	});

	test("a HEAD with the same tree that does not descend from the recorded HEAD is real drift", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const snapshot = await recorded(clone);
		const orphan = await sandbox.git(clone, "commit-tree", snapshot.tree, "-m", "same tree, unrelated history");
		await sandbox.git(clone, "reset", "-q", "--hard", orphan);
		const drift = await driftOf(snapshot, clone);
		assert.equal(drift.actualTree, drift.expectedTree);
		assert.equal(await isHeadOnlyAdvance(drift), false);
	});

	test("changed content, or a recorded HEAD this repository does not have, is real drift", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const snapshot = await recorded(clone);
		await sandbox.commitAll(clone, "commit the recorded edit");
		sandbox.write(join(clone, "edit.txt"), "changed again\n");
		assert.equal(await isHeadOnlyAdvance(await driftOf(snapshot, clone)), false);
		const foreign = new WorkspaceDriftError({
			root: clone,
			expectedHead: "f".repeat(40),
			actualHead: await sandbox.git(clone, "rev-parse", "HEAD"),
			expectedTree: snapshot.tree,
			actualTree: snapshot.tree,
			snapshotId: snapshot.id,
		});
		assert.equal(await isHeadOnlyAdvance(foreign), false);
		let gitCalls = 0;
		setWorktreeSnapshotGit(async () => {
			gitCalls++;
			return sandbox.executable;
		});
		assert.equal(
			await isHeadOnlyAdvance(new WorkspaceDriftError({ ...foreign.fields, actualHead: null } as never)),
			false,
		);
		assert.equal(gitCalls, 0, "a checkout without a HEAD has no ancestry to ask Git about");
	});
});
