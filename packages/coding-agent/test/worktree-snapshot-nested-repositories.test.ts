import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { describeWorktreeSnapshot, formatWorktreeRestoreWarning } from "../src/core/session-worktree-snapshots.js";
import { MemorySnapshotBlobStore } from "../src/core/worktree-snapshot/blob-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { restoreWorktree } from "../src/core/worktree-snapshot/index.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

useTemporaryAgentDir();

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	sandbox.dispose();
});

async function capture(root: string, blobs = new MemorySnapshotBlobStore()): Promise<WorktreeSnapshot> {
	const captured = await captureWorktreeSnapshot(root, { settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, blobs });
	if (captured.status !== "captured") throw new Error(captured.status);
	return captured.snapshot;
}

/** A pushed superproject clone with the pushed repository `lib` checked out as the submodule `sub`. */
async function withSubmodule() {
	const { clone, remote } = await sandbox.remoteWithClone();
	const lib = await sandbox.remoteWithClone("lib", { "lib.txt": "lib\n" });
	await sandbox.git(clone, "submodule", "add", "-q", pathToFileURL(lib.remote).href, "sub");
	await sandbox.commitAll(clone, "add submodule");
	await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
	return { clone, remote, sub: join(clone, "sub") };
}

/** The restore warning text a resume shows for `snapshot`. */
async function restoreWarnings(snapshot: WorktreeSnapshot, blobs: MemorySnapshotBlobStore): Promise<string[]> {
	const restored = await restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") });
	return restored.warnings.map(formatWorktreeRestoreWarning);
}

describe("snapshots report work in nested repositories and submodules (#4905)", () => {
	test("an untracked nested repository is listed as omitted and named in the restore warning (#4905)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const tools = join(clone, "tools");
		await sandbox.git(clone, "init", "-q", tools);
		sandbox.write(join(tools, "build.sh"), "echo build\n");
		await sandbox.commitAll(tools, "tools");
		sandbox.write(join(clone, "notes.txt"), "notes\n");
		const blobs = new MemorySnapshotBlobStore();

		const snapshot = await capture(clone, blobs);

		assert.deepEqual(snapshot.omitted, [{ reason: "nested-repository", path: "tools/" }]);
		assert.deepEqual(await restoreWarnings(snapshot, blobs), [
			"The restored snapshot left out 1 item(s): tools/ (nested-repository)",
		]);
	});

	test("submodule edits and new files are listed as omitted and named in the restore warning (#4905)", async () => {
		const { clone, sub } = await withSubmodule();
		sandbox.write(join(sub, "lib.txt"), "edited\n");
		sandbox.write(join(sub, "new.txt"), "new\n");
		const blobs = new MemorySnapshotBlobStore();

		const snapshot = await capture(clone, blobs);

		assert.deepEqual(snapshot.omitted, [{ reason: "submodule-changes", path: "sub" }]);
		assert.deepEqual(await restoreWarnings(snapshot, blobs), [
			"The restored snapshot left out 1 item(s): sub (submodule-changes)",
		]);
	});

	test("an untracked file alone in a submodule is listed as omitted (#4905)", async () => {
		const { clone, sub } = await withSubmodule();
		sandbox.write(join(sub, "new.txt"), "new\n");

		const snapshot = await capture(clone);

		assert.deepEqual(snapshot.omitted, [{ reason: "submodule-changes", path: "sub" }]);
	});

	test("an unpushed submodule commit is listed as omitted and named in the restore warning (#4905)", async () => {
		const { clone, sub } = await withSubmodule();
		sandbox.write(join(sub, "lib.txt"), "local\n");
		await sandbox.commitAll(sub, "local only");
		await sandbox.commitAll(clone, "bump submodule");
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		const blobs = new MemorySnapshotBlobStore();

		const snapshot = await capture(clone, blobs);

		assert.deepEqual(snapshot.omitted, [{ reason: "unpushed-submodule-commit", path: "sub" }]);
		assert.deepEqual(await restoreWarnings(snapshot, blobs), [
			"The restored snapshot left out 1 item(s): sub (unpushed-submodule-commit)",
		]);
		assert.ok(describeWorktreeSnapshot(clone, snapshot).includes("  omitted: sub (unpushed-submodule-commit)"));
	});

	test("a submodule that cannot be checked is listed as unchecked and the capture still records (#4905)", async () => {
		const { clone, sub } = await withSubmodule();
		await sandbox.git(sub, "symbolic-ref", "HEAD", "refs/heads/unborn");
		sandbox.write(join(clone, "README.md"), "edited\n");

		const snapshot = await capture(clone);

		assert.deepEqual(snapshot.omitted, [{ reason: "submodule-unchecked", path: "sub" }]);
	});

	test("an unreadable .gitmodules is listed as unchecked and the capture still records (#4905)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, ".gitmodules"), "[submodule\n");

		const snapshot = await capture(clone);

		assert.deepEqual(
			snapshot.omitted.filter((omission) => omission.reason === "submodule-unchecked"),
			[{ reason: "submodule-unchecked", path: ".gitmodules" }],
		);
	});

	test("submodule paths outside the checkout or not checked out are not checked (#4905)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const outside = await sandbox.remoteWithClone("outside");
		sandbox.write(join(outside.clone, "dirty.txt"), "dirty\n");
		sandbox.write(
			join(clone, ".gitmodules"),
			'[submodule "out"]\n\tpath = ../outside\n[submodule "self"]\n\tpath = .\n[submodule "gone"]\n\tpath = gone\n',
		);
		await sandbox.commitAll(clone, "gitmodules");
		sandbox.write(join(clone, "notes.txt"), "notes\n");

		const snapshot = await capture(clone);

		assert.deepEqual(snapshot.omitted, []);
	});

	test("a submodule with both changes and an unpushed commit is listed for each (#4905)", async () => {
		const { clone, sub } = await withSubmodule();
		sandbox.write(join(sub, "lib.txt"), "local\n");
		await sandbox.commitAll(sub, "local only");
		sandbox.write(join(sub, "new.txt"), "new\n");

		const snapshot = await capture(clone);

		assert.deepEqual(snapshot.omitted, [
			{ reason: "submodule-changes", path: "sub" },
			{ reason: "unpushed-submodule-commit", path: "sub" },
		]);
	});

	test("a clean submodule at a pushed commit gives no omission and no warning (#4905)", async () => {
		const { clone, sub } = await withSubmodule();
		sandbox.write(join(clone, "README.md"), "edited\n");
		await sandbox.git(sub, "fetch", "-q");
		const blobs = new MemorySnapshotBlobStore();

		const snapshot = await capture(clone, blobs);

		assert.deepEqual(snapshot.omitted, []);
		assert.deepEqual(await restoreWarnings(snapshot, blobs), []);
	});
});
