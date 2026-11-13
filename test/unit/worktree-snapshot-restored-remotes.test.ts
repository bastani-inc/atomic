import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	captureWorktreeSnapshot,
	MemorySnapshotBlobStore,
	restoreWorktree,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

async function capture(dir: string, blobs: MemorySnapshotBlobStore): Promise<WorktreeSnapshot> {
	const result = await captureWorktreeSnapshot(dir, { blobs });
	assert.equal(result.status, "captured");
	return (result as Extract<typeof result, { status: "captured" }>).snapshot;
}

/** Restores `snapshot` on a "machine" of its own: a fresh host directory with its own shared object store. */
async function restoreOn(machine: string, snapshot: WorktreeSnapshot, blobs: MemorySnapshotBlobStore) {
	return restoreWorktree(snapshot, { blobs, storeDir: sandbox.path(machine) });
}

/**
 * A fully pushed repository whose history, like many public ones, once committed a deny-listed file (`.env.example`),
 * and a clone of it with an uncommitted edit.
 */
async function pushedRepository(): Promise<{ remote: string; clone: string }> {
	const { remote, clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	sandbox.write(join(clone, ".env.example"), "TOKEN=placeholder\n");
	await sandbox.commitAll(clone, "add an example environment");
	sandbox.write(join(clone, "src.txt"), "one\n");
	await sandbox.commitAll(clone, "add source");
	await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
	sandbox.write(join(clone, "README.md"), "edited on machine 1\n");
	return { remote, clone };
}

async function assertNoBlobHolds(blobs: MemorySnapshotBlobStore, text: string): Promise<void> {
	for (const hash of await blobs.listBlobHashes()) {
		assert.ok(
			!Buffer.from((await blobs.getBlob(hash))!)
				.toString("latin1")
				.includes(text),
			`blob ${hash}`,
		);
	}
}

describe("captures in a restored worktree know the recorded remotes and what is pushed (#4732)", () => {
	test("a three-machine resume chain of a pushed repository succeeds, bundling only unpushed commits (#4732)", async () => {
		const blobs = new MemorySnapshotBlobStore();
		const { remote, clone } = await pushedRepository();
		const first = await capture(clone, blobs);
		assert.deepEqual(first.remotes, [remote]);
		assert.equal(first.bundle, null);

		const second = await restoreOn("machine-2", first, blobs);
		assert.equal(await sandbox.git(second.path, "remote", "get-url", "origin"), remote);
		sandbox.write(join(second.path, "src.txt"), "two\n");
		const unpushed = await sandbox.commitAll(second.path, "work on machine 2");
		sandbox.write(join(second.path, "README.md"), "edited on machine 2\n");
		const recorded = await capture(second.path, blobs);
		assert.deepEqual(recorded.remotes, [remote], "the second capture records the remotes");
		assert.deepEqual(recorded.bundle?.commits, [unpushed], "only the commit made on machine 2 travels");
		assert.deepEqual(
			recorded.omitted.filter((omission) => !("path" in omission)),
			[],
		);

		const third = await restoreOn("machine-3", recorded, blobs);
		assert.equal(await sandbox.git(third.path, "rev-parse", "HEAD"), unpushed);
		assert.equal(readFileSync(join(third.path, "README.md"), "utf8"), "edited on machine 2\n");
		assert.equal(readFileSync(join(third.path, "src.txt"), "utf8"), "two\n");
		assert.deepEqual((await capture(third.path, blobs)).remotes, [remote], "and so does every later capture");
	});

	test("commits that only a bundle carried stay unpushed in the next capture (#4732)", async () => {
		const blobs = new MemorySnapshotBlobStore();
		const { clone } = await pushedRepository();
		const local = await sandbox.commitAll(clone, "unpushed on machine 1");
		const first = await capture(clone, blobs);
		assert.deepEqual(first.bundle?.commits, [local]);

		const second = await restoreOn("machine-2", first, blobs);
		sandbox.write(join(second.path, "src.txt"), "two\n");
		const next = await sandbox.commitAll(second.path, "work on machine 2");
		const recorded = await capture(second.path, blobs);
		assert.deepEqual(recorded.bundle?.commits, [next, local]);

		const third = await restoreOn("machine-3", recorded, blobs);
		assert.equal(await sandbox.git(third.path, "rev-parse", "HEAD"), next);
	});

	test("an unpushed commit that adds a denied file in a restored worktree is still left out (#4732)", async () => {
		const blobs = new MemorySnapshotBlobStore();
		const { clone } = await pushedRepository();
		const second = await restoreOn("machine-2", await capture(clone, blobs), blobs);
		sandbox.write(join(second.path, ".env"), "SECRET=restored-worktree-secret\n");
		const denied = await sandbox.commitAll(second.path, "commit a secret on machine 2");
		const recorded = await capture(second.path, blobs);
		assert.equal(recorded.bundle, null);
		assert.deepEqual(
			recorded.omitted.filter((omission) => omission.reason === "unpushed-history-denied"),
			[{ reason: "unpushed-history-denied", commits: [denied], paths: [".env"] }],
			"only the new commit is named, not the pushed history that holds .env.example",
		);
		await assertNoBlobHolds(blobs, "restored-worktree-secret");
	});

	test("a repository without remotes restores and captures as before, carrying its whole history (#4732)", async () => {
		const blobs = new MemorySnapshotBlobStore();
		const repo = sandbox.path("local");
		await sandbox.git(sandbox.root, "init", "-q", repo);
		sandbox.write(join(repo, "README.md"), "hello\n");
		const base = await sandbox.commitAll(repo, "initial");
		const first = await capture(repo, blobs);
		assert.deepEqual(first.remotes, []);

		const second = await restoreOn("machine-2", first, blobs);
		assert.equal(await sandbox.git(second.path, "remote"), "");
		assert.equal(await sandbox.git(second.path, "for-each-ref", "refs/remotes"), "");
		sandbox.write(join(second.path, "README.md"), "two\n");
		const next = await sandbox.commitAll(second.path, "work on machine 2");
		const recorded = await capture(second.path, blobs);
		assert.deepEqual(recorded.remotes, []);
		assert.deepEqual(recorded.bundle?.commits, [next, base]);

		const third = await restoreOn("machine-3", recorded, blobs);
		assert.equal(await sandbox.git(third.path, "rev-parse", "HEAD"), next);
	});
});
