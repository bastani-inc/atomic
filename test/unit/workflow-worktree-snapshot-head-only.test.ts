import assert from "node:assert/strict";

import { join } from "node:path";
import { captureWorktreeSnapshot, isWorkspaceDriftError, verifyWorktree } from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";

import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
let priorAgentDir: string | undefined;
beforeEach(() => {
	sandbox = new GitSandbox();
	priorAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = sandbox.path("agent");
});
afterEach(async () => {
	if (priorAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = priorAgentDir;
	sandbox.dispose();
});

test("verifyWorktree stays strict: a commit that only moves HEAD is still tree-drift with equal trees (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "x.txt"), "recorded\n");
	const capture = await captureWorktreeSnapshot(clone);
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") return;
	await sandbox.commitAll(clone, "commit the recorded edits");
	await assert.rejects(verifyWorktree(capture.snapshot, clone), (error: unknown) => {
		assert.ok(isWorkspaceDriftError(error));
		assert.equal(error.code, "tree-drift");
		assert.equal(error.expectedTree, error.actualTree);
		assert.notEqual(error.actualHead, error.expectedHead);
		return true;
	});
});
