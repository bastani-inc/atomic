import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { MemorySnapshotBlobStore } from "../src/core/worktree-snapshot/blob-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { objectStorePath, removeRestoredWorktree, restoreWorktree } from "../src/core/worktree-snapshot/restore.js";
import type { WorktreeSnapshot, WorktreeSnapshotCapture } from "../src/core/worktree-snapshot/types.js";

useTemporaryAgentDir();

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

function snapshotOf(result: WorktreeSnapshotCapture): WorktreeSnapshot {
	assert.equal(result.status, "captured");
	return (result as Extract<WorktreeSnapshotCapture, { status: "captured" }>).snapshot;
}

/** Sets or, with `undefined`, removes each of `core.filemode` and `core.symlinks` in the repository at `gitDir`. */
async function trust(gitDir: string, settings: { filemode?: boolean; symlinks?: boolean }): Promise<void> {
	for (const key of ["filemode", "symlinks"] as const) {
		const value = settings[key];
		if (value === undefined) await sandbox.git(gitDir, "config", "--unset-all", `core.${key}`).catch(() => "");
		else await sandbox.git(gitDir, "config", `core.${key}`, String(value));
	}
}

/** Repository settings Git for Windows sets when it creates a repository. */
const AS_ON_WINDOWS = { filemode: false, symlinks: false };

/** Mode and blob of `path` in `tree`. */
async function entryOf(cwd: string, tree: string, path: string): Promise<string> {
	return (await sandbox.git(cwd, "ls-tree", tree, "--", path)).split("\t")[0]!.replace(/ blob /, " ");
}

/** A 255-character path whose restore staging path is over Windows' 260-character limit. */
const LONG_PATH = `${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(49)}.txt`;

/**
 * A clone with `files` pushed, then a local commit of an executable `run.sh` and a symbolic link `link`, recorded
 * through Git as Windows has neither, and its snapshot.
 */
async function scriptAndLink(files: Record<string, string> = {}) {
	const remote = sandbox.path("repo.git");
	await sandbox.git(sandbox.root, "init", "-q", "--bare", remote);
	const clone = sandbox.path("repo");
	await sandbox.git(sandbox.root, "clone", "-q", remote, clone);
	await trust(clone, AS_ON_WINDOWS);
	// The user's own checkout may allow long paths; the restore store is the one that must not need it.
	await sandbox.git(clone, "config", "core.longpaths", "true");
	for (const [path, content] of Object.entries({ "README.md": "hello\n", ...files })) {
		sandbox.write(join(clone, path), content);
	}
	await sandbox.commitAll(clone, "initial");
	await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
	sandbox.write(join(clone, "run.sh"), "#!/bin/sh\necho hi\n");
	sandbox.write(join(clone, "link"), "run.sh");
	await sandbox.git(clone, "add", "run.sh");
	await sandbox.git(clone, "update-index", "--chmod=+x", "run.sh");
	const linkBlob = await sandbox.git(clone, "hash-object", "-w", "link");
	await sandbox.git(clone, "update-index", "--add", "--cacheinfo", `120000,${linkBlob},link`);
	await sandbox.git(clone, "commit", "-q", "-m", "script and link");
	const blobs = new MemorySnapshotBlobStore();
	const committed = snapshotOf(await captureWorktreeSnapshot(clone, { blobs }));
	return { clone, blobs, committed, linkBlob };
}

test("a capture after a restore on a store without exec bits or symlinks keeps both, and long paths restore (#4932)", async () => {
	assert.equal(LONG_PATH.length, 255);
	const { clone, blobs, committed, linkBlob } = await scriptAndLink({ [LONG_PATH]: "deep\n" });

	// Uncommitting them leaves the files as they are: the next capture keeps the modes it recorded.
	await sandbox.git(clone, "reset", "-q", "--mixed", "HEAD~1");
	const uncommitted = snapshotOf(await captureWorktreeSnapshot(clone, { blobs, previous: committed }));
	assert.match(await entryOf(clone, uncommitted.tree, "run.sh"), /^100755 /);
	assert.equal(await entryOf(clone, uncommitted.tree, "link"), `120000 ${linkBlob}`);
	assert.equal(uncommitted.tree, committed.tree);

	const storeDir = sandbox.path("host");
	const store = objectStorePath(storeDir, uncommitted.remotes);
	mkdirSync(dirname(store), { recursive: true });
	await sandbox.git(sandbox.root, "init", "-q", "--bare", store);
	await trust(store, AS_ON_WINDOWS);
	const restored = await restoreWorktree(uncommitted, { storeDir, blobs });
	try {
		assert.equal(readFileSync(join(restored.path, LONG_PATH), "utf8"), "deep\n");
		const recaptured = snapshotOf(await captureWorktreeSnapshot(restored.path, { blobs }));
		assert.match(await entryOf(restored.path, recaptured.tree, "run.sh"), /^100755 /);
		assert.equal(await entryOf(restored.path, recaptured.tree, "link"), `120000 ${linkBlob}`);
		assert.equal(recaptured.tree, uncommitted.tree);

		// An edited script stays executable and a repointed link stays a link, as Git keeps an index entry's mode on edit
		// where it cannot read one from the file; a new file takes Git's usual mode.
		writeFileSync(join(restored.path, "run.sh"), "#!/bin/sh\necho changed\n");
		writeFileSync(join(restored.path, "link"), "README.md");
		writeFileSync(join(restored.path, "new.sh"), "#!/bin/sh\n");
		const edited = snapshotOf(await captureWorktreeSnapshot(restored.path, { blobs, previous: recaptured }));
		const runBlob = await sandbox.git(restored.path, "hash-object", "run.sh");
		const readmeLink = await sandbox.git(restored.path, "hash-object", "link");
		assert.equal(await entryOf(restored.path, edited.tree, "run.sh"), `100755 ${runBlob}`);
		assert.equal(await entryOf(restored.path, edited.tree, "link"), `120000 ${readmeLink}`);
		assert.notEqual(readmeLink, linkBlob);
		assert.match(await entryOf(restored.path, edited.tree, "new.sh"), /^100644 /);
	} finally {
		await removeRestoredWorktree(restored.path, { storeDir });
	}
});

/** The mode Git records for an executable file where exec bits are trusted: Windows has none to set. */
const EXECUTABLE = process.platform === "win32" ? "100644" : "100755";

describe("a repository that trusts its exec bits or its symbolic links records them as they are (#4932)", () => {
	for (const [name, settings, runMode, linkMode] of [
		["trusts both by default", {}, "100644", EXECUTABLE],
		["trusts both as configured", { filemode: true, symlinks: true }, "100644", EXECUTABLE],
		["trusts only symbolic links", { filemode: false }, "100755", "100644"],
		// Where the link's file is executable it is recorded as such; on Windows it is the recorded link's content.
		["trusts only exec bits", { symlinks: false }, "100644", process.platform === "win32" ? "120000" : "100755"],
	] as const) {
		test(`${name}: an uncommitted script and link file take the modes their files have (#4932)`, async () => {
			const { clone, blobs, committed } = await scriptAndLink();
			await trust(clone, settings);
			await sandbox.git(clone, "reset", "-q", "--mixed", "HEAD~1");
			// The working files are a script without its exec bit and an executable file holding the link's target.
			chmodSync(join(clone, "run.sh"), 0o644);
			chmodSync(join(clone, "link"), 0o755);

			const uncommitted = snapshotOf(await captureWorktreeSnapshot(clone, { blobs, previous: committed }));

			assert.match(await entryOf(clone, uncommitted.tree, "run.sh"), new RegExp(`^${runMode} `));
			assert.match(await entryOf(clone, uncommitted.tree, "link"), new RegExp(`^${linkMode} `));
		});
	}
});

test("a file the capture leaves out keeps HEAD's mode, not the recorded one (#4932)", async () => {
	const { clone, blobs, committed } = await scriptAndLink();
	// HEAD makes the script a regular file with the same content; the recorded tree still holds it as executable.
	await sandbox.git(clone, "update-index", "--chmod=-x", "run.sh");
	await sandbox.git(clone, "commit", "-q", "-m", "not executable");
	writeFileSync(join(clone, "run.sh"), `#!/bin/sh\n${"#".repeat(4096)}\n`);

	const capture = snapshotOf(
		await captureWorktreeSnapshot(clone, { blobs, previous: committed, settings: { maxFileBytes: 1024 } }),
	);

	assert.deepEqual(
		capture.omitted.map((omission) => ("path" in omission ? `${omission.reason} ${omission.path}` : omission.reason)),
		["over-file-cap run.sh"],
	);
	assert.equal(await entryOf(clone, capture.tree, "run.sh"), await entryOf(clone, "HEAD", "run.sh"));
});

test("a recorded tree the repository no longer holds gives no modes, and the capture still records (#4932)", async () => {
	const { clone, blobs, committed } = await scriptAndLink();
	await sandbox.git(clone, "reset", "-q", "--mixed", "HEAD~1");
	const gone = "1".repeat(committed.tree.length);

	const capture = snapshotOf(await captureWorktreeSnapshot(clone, { blobs, previous: { ...committed, tree: gone } }));

	assert.match(await entryOf(clone, capture.tree, "run.sh"), /^100644 /);
	assert.match(await entryOf(clone, capture.tree, "link"), /^100644 /);
});
