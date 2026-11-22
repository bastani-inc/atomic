import assert from "node:assert/strict";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	captureWorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import { sha256Hex } from "../../packages/coding-agent/src/core/worktree-snapshot/env-hash.ts";
import { nulFields, runGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import {
	captureIndexPath,
	defaultWorktreeSnapshotStoreDir,
} from "../../packages/coding-agent/src/core/worktree-snapshot/paths.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

async function snapshotOf(dir: string, options: Parameters<typeof captureWorktreeSnapshot>[1] = {}) {
	const result: WorktreeSnapshotCapture = await captureWorktreeSnapshot(dir, options);
	if (result.status !== "captured" && result.status !== "unchanged") throw new Error(`unexpected ${result.status}`);
	return result.snapshot;
}

async function privateIndexOf(clone: string): Promise<string> {
	const gitDir = await sandbox.git(clone, "rev-parse", "--absolute-git-dir");
	return captureIndexPath(defaultWorktreeSnapshotStoreDir(), gitDir, clone);
}

/** Whether `git diff-files`, through an index of HEAD's tree whose file times were refreshed, lists `path`. */
async function diffFilesLists(clone: string, path: string): Promise<boolean> {
	const git = { cwd: clone, env: { GIT_INDEX_FILE: sandbox.path("head-index") } };
	await runGit(["read-tree", "HEAD"], git);
	await runGit(["update-index", "-q", "--refresh"], { ...git, allowExitCodes: [1] });
	return nulFields((await runGit(["diff-files", "-z", "--name-only"], git)).stdout).includes(path);
}

describe("captures through a private index that keeps HEAD's tree between them", () => {
	test("the tree of a checkout that matches HEAD follows HEAD when it moves", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
		const first = await snapshotOf(clone);
		assert.equal(first.tree, await sandbox.git(clone, "rev-parse", "HEAD^{tree}"));

		sandbox.write(join(clone, "added.txt"), "added\n");
		await sandbox.commitAll(clone, "add a file");
		const moved = await snapshotOf(clone);
		assert.equal(moved.tree, await sandbox.git(clone, "rev-parse", "HEAD^{tree}"));

		await sandbox.git(clone, "reset", "-q", "--hard", "HEAD~1");
		const back = await snapshotOf(clone);
		assert.equal(back.tree, first.tree);
	});

	test("a file edited after a capture of the unchanged checkout stays in every later capture", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "a.txt": "a\n" });
		const clean = await snapshotOf(clone);
		sandbox.write(join(clone, "a.txt"), "edited\n");
		const edited = await snapshotOf(clone, { previous: clean });
		assert.notEqual(edited.tree, clean.tree);
		const again = await snapshotOf(clone, { previous: edited });
		assert.equal(again.tree, edited.tree);
		// A capture with no earlier snapshot, as another session's first one, reads the same files.
		const fresh = await snapshotOf(clone);
		assert.equal(fresh.tree, edited.tree);
		assert.equal(await sandbox.git(clone, "cat-file", "-p", `${fresh.tree}:a.txt`), "edited");
	});

	test("a private index an earlier release left with a file it added is read from HEAD again", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", ".gitignore": "build/\n" });
		sandbox.write(join(clone, "build", "out.js"), "built\n");
		const head = await snapshotOf(clone);
		assert.equal(head.tree, await sandbox.git(clone, "rev-parse", "HEAD^{tree}"));

		// Earlier releases kept the files a capture added in the private index, under a record that names only the
		// index's bytes and the user's index it was seeded from.
		const index = await privateIndexOf(clone);
		await runGit(["update-index", "--add", "--", "build/out.js"], { cwd: clone, env: { GIT_INDEX_FILE: index } });
		const record = JSON.parse(readFileSync(`${index}.json`, "utf8")) as Record<string, unknown>;
		writeFileSync(
			`${index}.json`,
			JSON.stringify({ version: record.version, seed: record.seed, index: sha256Hex(readFileSync(index)) }),
		);

		const after = await snapshotOf(clone);
		assert.equal(after.tree, head.tree, "the ignored file the old index held is not recorded");
	});

	for (const [name, change] of [
		[
			"only untracked files in it",
			async (clone: string) => sandbox.write(join(clone, "mod", "untracked.txt"), "untracked\n"),
		],
		[
			"an edited file in it, where diff.ignoreSubmodules hides it from git diff",
			async (clone: string) => {
				await sandbox.git(clone, "config", "diff.ignoreSubmodules", "all");
				sandbox.write(join(clone, "mod", "s.txt"), "edited\n");
			},
		],
	] as const) {
		test(`a submodule with ${name} is a changed file exactly when git diff-files lists it`, async () => {
			const { clone: sub } = await sandbox.remoteWithClone("sub", { "s.txt": "s\n" });
			const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
			await sandbox.git(clone, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod");
			await sandbox.git(clone, "commit", "-q", "-m", "add a submodule");
			await change(clone);
			// A changed file is counted against the cap with its size; a submodule's is its directory's.
			const settings = { maxSnapshotBytes: 1 };
			const omitted = (await snapshotOf(clone, { settings })).omitted;
			const counted = omitted.some((omission) => omission.reason === "over-snapshot-cap" && omission.path === "mod");
			const directoryBytes = lstatSync(join(clone, "mod")).size;
			assert.equal(counted, directoryBytes > 1 && (await diffFilesLists(clone, "mod")));
		});
	}
});
