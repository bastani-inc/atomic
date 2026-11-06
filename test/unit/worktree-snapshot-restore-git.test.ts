import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { withWorktreeSnapshotGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import {
	bindingOf,
	captureWorktreeSnapshot,
	isGitUnavailableError,
	isWorkspaceConfigError,
	MemorySnapshotBlobStore,
	restoreWorktree,
	setWorktreeSnapshotGit,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

async function dirtySnapshot(blobs: MemorySnapshotBlobStore): Promise<WorktreeSnapshot> {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "README.md"), "uncommitted\n");
	const capture = await captureWorktreeSnapshot(clone, { blobs });
	assert.equal(capture.status, "captured");
	return (capture as Extract<typeof capture, { status: "captured" }>).snapshot;
}

test("a restore given a git runs every Git command on it, never the process's resolver (#4416)", async () => {
	const blobs = new MemorySnapshotBlobStore();
	const snapshot = await dirtySnapshot(blobs);
	let resolved = 0;
	setWorktreeSnapshotGit(async () => {
		resolved++;
		return { path: sandbox.path("no-such-git"), env: {} };
	});
	const restored = await restoreWorktree(bindingOf(snapshot), {
		snapshots: [snapshot],
		blobs,
		storeDir: sandbox.path("host"),
		git: sandbox.executable,
	});
	assert.equal(readFileSync(join(restored.path, "README.md"), "utf8"), "uncommitted\n");
	assert.equal(resolved, 0, "the process's resolver was never asked");
});

test("a restore given a git that does not run fails as Git unavailable, though the process's Git runs (#4416)", async () => {
	const blobs = new MemorySnapshotBlobStore();
	const snapshot = await dirtySnapshot(blobs);
	await assert.rejects(
		restoreWorktree(bindingOf(snapshot), {
			snapshots: [snapshot],
			blobs,
			storeDir: sandbox.path("host"),
			git: { path: sandbox.path("no-such-git"), env: {} },
		}),
		(error: unknown) => isGitUnavailableError(error),
	);
	const restored = await restoreWorktree(bindingOf(snapshot), {
		snapshots: [snapshot],
		blobs,
		storeDir: sandbox.path("host"),
	});
	assert.equal(
		readFileSync(join(restored.path, "README.md"), "utf8"),
		"uncommitted\n",
		"the next restore runs its own",
	);
});

test("a restore without a git runs the git of the scope it runs in, like any other snapshot operation (#4416)", async () => {
	const blobs = new MemorySnapshotBlobStore();
	const snapshot = await dirtySnapshot(blobs);
	setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-such-git"), env: {} }));
	const restored = await withWorktreeSnapshotGit(sandbox.executable, () =>
		restoreWorktree(bindingOf(snapshot), { snapshots: [snapshot], blobs, storeDir: sandbox.path("host") }),
	);
	assert.equal(readFileSync(join(restored.path, "README.md"), "utf8"), "uncommitted\n");
});

test("a restore's git is checked before any Git work (#4416)", async () => {
	let lookups = 0;
	setWorktreeSnapshotGit(async () => {
		lookups++;
		return sandbox.executable;
	});
	const binding = { remotes: ["r"], head: "h", tree: "t", envHash: "e" };
	for (const git of [{ path: "", env: {} }, { env: {} }, { path: 5, env: {} }, null]) {
		await assert.rejects(
			restoreWorktree(binding, { git: git as never, storeDir: sandbox.path("host") }),
			(error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.deepEqual(error.fields, {
					source: "sdk",
					field: "git",
					expected: "a Git executable with a non-empty path",
				});
				return true;
			},
		);
	}
	assert.equal(lookups, 0);
	assert.equal(existsSync(sandbox.path("host")), false);
});
