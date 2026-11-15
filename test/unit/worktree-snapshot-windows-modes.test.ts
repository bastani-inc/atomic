import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { objectStorePath } from "../../packages/coding-agent/src/core/worktree-snapshot/restore.ts";
import {
	captureWorktreeSnapshot,
	MemorySnapshotBlobStore,
	removeRestoredWorktree,
	restoreWorktree,
	type WorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

function snapshotOf(result: WorktreeSnapshotCapture): WorktreeSnapshot {
	assert.equal(result.status, "captured");
	return (result as Extract<WorktreeSnapshotCapture, { status: "captured" }>).snapshot;
}

/** Repository settings Git for Windows sets when it creates a repository. */
async function asOnWindows(gitDir: string): Promise<void> {
	await sandbox.git(gitDir, "config", "core.filemode", "false");
	await sandbox.git(gitDir, "config", "core.symlinks", "false");
}

/** Mode and blob of `path` in `tree`. */
async function entryOf(cwd: string, tree: string, path: string): Promise<string> {
	return (await sandbox.git(cwd, "ls-tree", tree, "--", path)).split("\t")[0]!.replace(/ blob /, " ");
}

/** A 255-character path whose restore staging path is over Windows' 260-character limit. */
const LONG_PATH = `${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(49)}.txt`;

test("a capture after a restore on a store without exec bits or symlinks keeps both, and long paths restore (#4932)", async () => {
	assert.equal(LONG_PATH.length, 255);
	const remote = sandbox.path("repo.git");
	await sandbox.git(sandbox.root, "init", "-q", "--bare", remote);
	const clone = sandbox.path("repo");
	await sandbox.git(sandbox.root, "clone", "-q", remote, clone);
	await asOnWindows(clone);
	// The user's own checkout may allow long paths; the restore store is the one that must not need it.
	await sandbox.git(clone, "config", "core.longpaths", "true");
	sandbox.write(join(clone, "README.md"), "hello\n");
	sandbox.write(join(clone, LONG_PATH), "deep\n");
	await sandbox.commitAll(clone, "initial");
	await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");

	// `run.sh` is executable and `link` is a symbolic link, recorded through Git as Windows has neither.
	sandbox.write(join(clone, "run.sh"), "#!/bin/sh\necho hi\n");
	sandbox.write(join(clone, "link"), "run.sh");
	await sandbox.git(clone, "add", "run.sh");
	await sandbox.git(clone, "update-index", "--chmod=+x", "run.sh");
	const linkBlob = await sandbox.git(clone, "hash-object", "-w", "link");
	await sandbox.git(clone, "update-index", "--add", "--cacheinfo", `120000,${linkBlob},link`);
	await sandbox.git(clone, "commit", "-q", "-m", "script and link");
	const blobs = new MemorySnapshotBlobStore();
	const committed = snapshotOf(await captureWorktreeSnapshot(clone, { blobs }));

	// Uncommitting them leaves the files as they are: the next capture keeps the modes it recorded.
	await sandbox.git(clone, "reset", "-q", "--mixed", "HEAD~1");
	const uncommitted = snapshotOf(await captureWorktreeSnapshot(clone, { blobs, previous: committed }));
	assert.equal(await entryOf(clone, uncommitted.tree, "run.sh"), await entryOf(clone, committed.tree, "run.sh"));
	assert.match(await entryOf(clone, uncommitted.tree, "run.sh"), /^100755 /);
	assert.equal(await entryOf(clone, uncommitted.tree, "link"), `120000 ${linkBlob}`);
	assert.equal(uncommitted.tree, committed.tree);

	const storeDir = sandbox.path("host");
	const store = objectStorePath(storeDir, uncommitted.remotes);
	mkdirSync(dirname(store), { recursive: true });
	await sandbox.git(sandbox.root, "init", "-q", "--bare", store);
	await asOnWindows(store);
	const restored = await restoreWorktree(uncommitted, { storeDir, blobs });
	try {
		assert.equal(readFileSync(join(restored.path, LONG_PATH), "utf8"), "deep\n");
		const recaptured = snapshotOf(await captureWorktreeSnapshot(restored.path, { blobs }));
		assert.equal(
			await entryOf(restored.path, recaptured.tree, "run.sh"),
			await entryOf(clone, uncommitted.tree, "run.sh"),
		);
		assert.equal(await entryOf(restored.path, recaptured.tree, "link"), `120000 ${linkBlob}`);
		assert.equal(recaptured.tree, uncommitted.tree);

		// An edit is recorded as the working file, and a new file takes Git's usual mode.
		writeFileSync(join(restored.path, "run.sh"), "#!/bin/sh\necho changed\n");
		writeFileSync(join(restored.path, "new.sh"), "#!/bin/sh\n");
		const edited = snapshotOf(await captureWorktreeSnapshot(restored.path, { blobs, previous: recaptured }));
		assert.match(await entryOf(restored.path, edited.tree, "run.sh"), /^100644 /);
		assert.match(await entryOf(restored.path, edited.tree, "new.sh"), /^100644 /);
		assert.equal(await entryOf(restored.path, edited.tree, "link"), `120000 ${linkBlob}`);
	} finally {
		await removeRestoredWorktree(restored.path, { storeDir });
	}
});
