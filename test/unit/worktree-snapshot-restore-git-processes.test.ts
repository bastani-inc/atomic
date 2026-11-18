import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	captureWorktreeSnapshot,
	MemorySnapshotBlobStore,
	restoreWorktreeSnapshot,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox, startedGitProcesses } from "../helpers/worktree-snapshot.js";

/**
 * A restore into a store that lacks the snapshot's HEAD asks the store whether it holds HEAD before fetching it and once
 * after, and whether it holds the snapshot's tree: three single-object lookups, each a Git process on its own.
 */
const OBJECT_LOOKUPS_PER_COLD_RESTORE = 3;

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

function captured(result: Awaited<ReturnType<typeof captureWorktreeSnapshot>>): WorktreeSnapshot {
	assert.equal(result.status, "captured");
	return (result as { snapshot: WorktreeSnapshot }).snapshot;
}

test("a restore asks Git about the store's HEAD once before and once after fetching it, and finds the restored worktree's Git directory without asking Git", async () => {
	const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "a\n", "dir/b.txt": "b\n" });
	const blobs = new MemorySnapshotBlobStore();
	sandbox.write(join(clone, "a.txt"), "changed\n");
	const first = captured(await captureWorktreeSnapshot(clone, { blobs }));
	sandbox.write(join(clone, "dir/b.txt"), "b2\n");
	const snapshot = captured(await captureWorktreeSnapshot(clone, { blobs, previous: first }));
	const trace = sandbox.traceGitProcesses();
	const restored = await restoreWorktreeSnapshot(snapshot, { blobs, storeDir: sandbox.path("host") });
	assert.equal(readFileSync(join(restored, "dir/b.txt"), "utf8"), "b2\n");
	const started = startedGitProcesses(trace).map((event) => event.argv ?? []);
	const lookups = started.filter((argv) => argv.includes("cat-file") && argv.includes("-e"));
	assert.equal(
		lookups.length,
		OBJECT_LOOKUPS_PER_COLD_RESTORE,
		`single-object lookups: ${lookups.map((argv) => argv.at(-1)).join(", ")}`,
	);
	assert.deepEqual(
		started.filter((argv) => argv.at(-1) === "--absolute-git-dir"),
		[],
		"the restored worktree's .git file names its Git directory",
	);
});
