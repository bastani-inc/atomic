import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { FilesystemFault } from "../helpers/worktree-snapshot-faults.js";

/** Directories this process cannot list or enter, as `chmod 000` makes them on POSIX: injected where Git is started. */
const unreadable = vi.hoisted(() => ({ directories: [] as string[] }));

vi.mock("node:child_process", async (importOriginal) => {
	const { isSameOrWithin, systemError, withSpawnFaults } = await import("../helpers/worktree-snapshot-faults.js");
	return withSpawnFaults(await importOriginal(), ({ command, cwd }) =>
		unreadable.directories.some((directory) => isSameOrWithin(directory, cwd))
			? { error: systemError("EACCES", `spawn ${command}`, command) }
			: undefined,
	);
});

vi.mock("node:fs", async (importOriginal) => {
	const { withFilesystemFaults } = await import("../helpers/worktree-snapshot-faults.js");
	return withFilesystemFaults(await importOriginal<typeof import("node:fs")>(), "sync", ["accessSync"], () =>
		unreadable.directories.map((path): FilesystemFault => ({ call: "accessSync", path, code: "EACCES" })),
	);
});

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
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	unreadable.directories.length = 0;
	sandbox.dispose();
});

function lock(directory: string): void {
	unreadable.directories.push(directory);
}

describe("a checkout this process cannot read (#4245)", () => {
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
});
