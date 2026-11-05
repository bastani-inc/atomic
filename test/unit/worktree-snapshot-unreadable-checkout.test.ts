import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { runGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import {
	captureWorktreeSnapshot,
	isGitUnavailableError,
	MemorySnapshotBlobStore,
	verifyWorktree,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { assertCaptureUnreadable, assertUnreadablePath, GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
const locked: string[] = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	for (const directory of locked.splice(0)) chmodSync(directory, 0o755);
	sandbox.dispose();
});

function lock(directory: string): void {
	chmodSync(directory, 0o000);
	locked.push(directory);
}

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"a checkout this process cannot read (#4245)",
	() => {
		test("a Git command in it fails as an unreadable path, not as missing Git", async () => {
			const { clone } = await sandbox.remoteWithClone();
			lock(clone);
			await assert.rejects(runGit(["status"], { cwd: clone }), (error: unknown) => {
				assert.equal(isGitUnavailableError(error), false);
				assertUnreadablePath(error, clone, "EACCES");
				return true;
			});
		});

		test("capture is unavailable for that reason, and verification fails with it", async () => {
			const { clone } = await sandbox.remoteWithClone();
			sandbox.write(join(clone, "file.txt"), "recorded\n");
			const recorded = await captureWorktreeSnapshot(clone, { blobs: new MemorySnapshotBlobStore() });
			assert.equal(recorded.status, "captured");
			const snapshot = (recorded as { snapshot: WorktreeSnapshot }).snapshot;
			lock(clone);
			assertCaptureUnreadable(await captureWorktreeSnapshot(clone), clone, "EACCES");
			await assert.rejects(verifyWorktree(snapshot, clone), (error: unknown) => {
				assertUnreadablePath(error, clone, "EACCES");
				return true;
			});
		});
	},
);
