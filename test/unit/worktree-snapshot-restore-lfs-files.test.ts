import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	captureWorktreeSnapshot,
	isWorkspaceSnapshotError,
	MemorySnapshotBlobStore,
	restoreWorktree,
	setWorktreeSnapshotGit,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox, lfsPointer } from "../helpers/worktree-snapshot.js";

const files = vi.hoisted(() => ({ refuse: undefined as string | undefined, opened: 0, closed: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const open: typeof actual.open = async (path, ...rest) => {
		const name = String(path);
		if (files.refuse !== undefined && name.endsWith(`${sep}${files.refuse}`)) {
			throw Object.assign(new Error(`EACCES: permission denied, open '${name}'`), {
				code: "EACCES",
				syscall: "open",
				path: name,
			});
		}
		const handle = await actual.open(path, ...rest);
		if (!name.endsWith(".bin")) return handle;
		files.opened++;
		const close = handle.close.bind(handle);
		handle.close = async () => {
			files.closed++;
			return close();
		};
		return handle;
	};
	return { ...actual, open, default: { ...actual, open } };
});

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
	Object.assign(files, { refuse: undefined, opened: 0, closed: 0 });
});
afterEach(() => sandbox.dispose());

/** A snapshot of an LFS repository whose objects no remote has, restored with a `git-lfs` that always fails. */
async function unfetchableLfsSnapshot(): Promise<{ blobs: MemorySnapshotBlobStore; snapshot: WorktreeSnapshot }> {
	const { clone } = await sandbox.remoteWithClone("repo", {
		".gitattributes": "*.bin filter=lfs -text\n",
		"data.bin": lfsPointer("base\n"),
		"more.bin": lfsPointer("more\n"),
	});
	sandbox.write(join(clone, "data.bin"), lfsPointer("edited\n"));
	const blobs = new MemorySnapshotBlobStore();
	const result = await captureWorktreeSnapshot(clone, { blobs });
	if (result.status !== "captured") throw new Error("no snapshot");
	const bin = mkdtempSync(join(sandbox.root, "bin-"));
	writeFileSync(join(bin, "git-lfs"), "#!/bin/sh\nexit 1\n");
	chmodSync(join(bin, "git-lfs"), 0o755);
	setWorktreeSnapshotGit(async () => ({
		path: "git",
		env: { ...sandbox.executable.env, PATH: `${bin}:${process.env.PATH}` },
	}));
	return { blobs, snapshot: result.snapshot };
}

describe.skipIf(process.platform === "win32")("the LFS files a restore inspects (#4245)", () => {
	test("each file read for an LFS pointer is closed again", async () => {
		const { blobs, snapshot } = await unfetchableLfsSnapshot();
		const restored = await restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") });
		assert.deepEqual(restored.warnings[0], { code: "lfs-objects-unavailable", paths: ["data.bin", "more.bin"] });
		assert.ok(files.opened >= 2);
		assert.equal(files.closed, files.opened);
	});

	test("a staged LFS file that cannot be read fails the restore as an unreadable path and leaves nothing behind", async () => {
		const { blobs, snapshot } = await unfetchableLfsSnapshot();
		files.refuse = "more.bin";
		const storeDir = sandbox.path("host");
		await assert.rejects(restoreWorktree(snapshot, { blobs, storeDir }), (error: unknown) => {
			assert.ok(isWorkspaceSnapshotError(error));
			assert.equal(error.code, "unreadable-path");
			assert.ok(error.subject.endsWith(`${sep}more.bin`), error.subject);
			assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
			return true;
		});
		const worktrees = join(storeDir, "worktrees");
		assert.deepEqual(existsSync(worktrees) ? readdirSync(worktrees) : [], []);
	});
});
