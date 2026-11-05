import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { runGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import {
	captureWorktreeSnapshot,
	isGitUnavailableError,
	WorkspaceGitError,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

function snapshotOf(result: WorktreeSnapshotCapture) {
	assert.equal(result.status, "captured");
	return (result as Extract<WorktreeSnapshotCapture, { status: "captured" }>).snapshot;
}

test("commented .gitattributes lines name no filter driver", async () => {
	const { clone } = await sandbox.remoteWithClone("repo", {
		".gitattributes": "# *.bin filter=commented\n  # *.dat filter=indented\n*.lfs filter=lfs -text\n",
	});
	assert.deepEqual(snapshotOf(await captureWorktreeSnapshot(clone)).filters, {
		autocrlf: null,
		eol: null,
		drivers: ["lfs"],
	});
});

test("a regular file named .atomic means there is no snapshot-ignore file", async () => {
	const { clone } = await sandbox.remoteWithClone("repo", { ".atomic": "not a directory\n" });
	writeFileSync(join(clone, "notes.txt"), "kept\n");
	const snapshot = snapshotOf(await captureWorktreeSnapshot(clone));
	assert.deepEqual(snapshot.omitted, []);
	assert.equal(await sandbox.git(clone, "cat-file", "-p", `${snapshot.tree}:notes.txt`), "kept");
});

test("a missing working directory is a Git failure, not missing Git", async () => {
	const missing = sandbox.path("gone");
	await assert.rejects(runGit(["status"], { cwd: missing }), (error: unknown) => {
		assert.ok(error instanceof WorkspaceGitError);
		assert.equal(isGitUnavailableError(error), false);
		assert.equal(error.cwd, missing);
		assert.equal(error.exitCode, null);
		assert.equal(error.detail, "the working directory does not exist");
		return true;
	});
	mkdirSync(missing);
	assert.equal((await runGit(["--version"], { cwd: missing })).exitCode, 0);
});
