import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	captureWorktreeSnapshot,
	withScratchDirectory,
} from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import {
	computeEnvironmentHash,
	MemorySnapshotBlobStore,
	setWorktreeSnapshotGit,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/index.ts";
import { assertCaptureUnreadable, assertUnreadablePath, GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

type Captured = Extract<WorktreeSnapshotCapture, { status: "captured" }>;
function captured(result: WorktreeSnapshotCapture): Captured {
	assert.equal(result.status, "captured");
	return result as Captured;
}

/** A symbolic link that points at itself: every access that follows it fails with ELOOP. */
function selfLoop(path: string): void {
	symlinkSync(path.split(/[\\/]/).at(-1)!, path);
}

const treePaths = async (cwd: string, tree: string): Promise<string[]> =>
	(await sandbox.git(cwd, "ls-tree", "-r", "--name-only", tree)).split("\n").filter(Boolean);

describe("the scratch directory of one capture", () => {
	test("an action that removed its own directory neither fails after success nor adds a cleanup failure to its error", async () => {
		const result = await withScratchDirectory(async (directory) => {
			rmSync(directory, { recursive: true });
			return "finished";
		});
		assert.equal(result, "finished");

		const primary = new Error("the action failed");
		let scratch = "";
		await assert.rejects(
			withScratchDirectory(async (directory) => {
				scratch = directory;
				rmSync(directory, { recursive: true });
				throw primary;
			}),
			(error: unknown) => {
				assert.equal(error, primary);
				assert.equal(Object.hasOwn(primary, "cleanupCause"), false);
				return true;
			},
		);
		assert.equal(existsSync(scratch), false);
	});
});

describe.skipIf(process.platform === "win32")("filesystem failures other than absence are typed, not hidden", () => {
	test("a directory that cannot be resolved is unavailable as unreadable-path, not as not-a-repository", async () => {
		const loop = sandbox.path("loop");
		selfLoop(loop);
		assertCaptureUnreadable(await captureWorktreeSnapshot(loop), loop, "ELOOP");
	});

	test("a tracked .gitattributes that cannot be read makes the capture unavailable naming it", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { ".gitattributes": "*.txt text\n", "a.txt": "a\n" });
		unlinkSync(join(clone, ".gitattributes"));
		selfLoop(join(clone, ".gitattributes"));
		assertCaptureUnreadable(await captureWorktreeSnapshot(clone), join(clone, ".gitattributes"), "ELOOP");
	});

	test.skipIf(process.getuid?.() === 0)(
		"a file that Git lists but whose size cannot be read makes the capture unavailable naming that file",
		async () => {
			const { clone } = await sandbox.remoteWithClone();
			const unreadable = join(clone, "listed-only");
			mkdirSync(unreadable);
			writeFileSync(join(unreadable, "file.txt"), "content\n");
			chmodSync(unreadable, 0o444);
			try {
				assertCaptureUnreadable(await captureWorktreeSnapshot(clone), join(unreadable, "file.txt"), "EACCES");
			} finally {
				chmodSync(unreadable, 0o755);
			}
		},
	);

	test("an environment input that cannot be read fails the hash with a typed error naming it", async () => {
		const dir = sandbox.path("env-loop");
		mkdirSync(dir);
		selfLoop(join(dir, "package-lock.json"));
		await assert.rejects(computeEnvironmentHash(dir), (error: unknown) => {
			assertUnreadablePath(error, join(dir, "package-lock.json"), "ELOOP");
			return true;
		});
	});
});

describe("which files a capture sizes", () => {
	test("a tracked file deleted from the working tree weighs nothing, so the snapshot cap still applies to the files after it", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a-gone.txt": "to be deleted\n", "b.txt": "base\n" });
		unlinkSync(join(clone, "a-gone.txt"));
		sandbox.write(join(clone, "b.txt"), "0123456789");
		sandbox.write(join(clone, "c.txt"), "abcdefghij");
		const result = captured(
			await captureWorktreeSnapshot(clone, { settings: { maxFileBytes: 1000, maxSnapshotBytes: 15 } }),
		);
		assert.deepEqual(result.snapshot.omitted, [{ reason: "over-snapshot-cap", path: "c.txt", bytes: 10 }]);
		assert.deepEqual(await treePaths(clone, result.snapshot.tree), ["b.txt"]);
	});

	test("a path below a file that replaced a directory weighs nothing either", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "dir/inner.txt": "inner\n", "z.txt": "base\n" });
		rmSync(join(clone, "dir"), { recursive: true });
		writeFileSync(join(clone, "dir"), "now a file");
		sandbox.write(join(clone, "z.txt"), "0123456789");
		sandbox.write(join(clone, "zz.txt"), "abcdefghij");
		const result = captured(
			await captureWorktreeSnapshot(clone, { settings: { maxFileBytes: 1000, maxSnapshotBytes: 25 } }),
		);
		assert.deepEqual(result.snapshot.omitted, [{ reason: "over-snapshot-cap", path: "zz.txt", bytes: 10 }]);
	});

	test("a nested repository inside the checkout is not a file of it: it is neither omitted for its directory size nor in the tree", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "a\n" });
		const nested = join(clone, "vendor", "inner");
		mkdirSync(nested, { recursive: true });
		await sandbox.git(nested, "init", "-q", "-b", "main");
		sandbox.write(join(nested, "inner.txt"), "inner\n");
		await sandbox.commitAll(nested, "inner commit");
		sandbox.write(join(clone, "b.txt"), "b");
		const result = captured(await captureWorktreeSnapshot(clone, { settings: { maxFileBytes: 1 } }));
		assert.deepEqual(await treePaths(clone, result.snapshot.tree), ["a.txt", "b.txt"]);
		assert.deepEqual(result.snapshot.omitted, []);
	});
});

describe("unpushed history", () => {
	test("a file named like a commit id cannot hide a denied path later in the same commit", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const lookalike = "0123456789abcdef0123456789abcdef01234567";
		sandbox.write(join(clone, lookalike), "not a commit\n");
		sandbox.write(join(clone, "id_rsa"), "PRIVATE KEY\n");
		const commit = await sandbox.commitAll(clone, "add a lookalike and a key");
		const blobs = new MemorySnapshotBlobStore();
		const result = captured(await captureWorktreeSnapshot(clone, { blobs }));
		assert.equal(result.snapshot.bundle, null);
		assert.deepEqual(result.snapshot.omitted, [
			{ reason: "unpushed-history-denied", commits: [commit], paths: ["id_rsa"] },
		]);
		for (const hash of await blobs.listBlobHashes()) {
			assert.doesNotMatch(Buffer.from((await blobs.getBlob(hash))!).toString("latin1"), /PRIVATE KEY/);
		}
	});

	test("denied paths of several commits are listed in path order, not in the order the commits were read", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "a.pem"), "A\n");
		const older = await sandbox.commitAll(clone, "older key");
		sandbox.write(join(clone, "z.pem"), "Z\n");
		const newer = await sandbox.commitAll(clone, "newer key");
		const result = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(result.snapshot.omitted, [
			{ reason: "unpushed-history-denied", commits: [newer, older], paths: ["a.pem", "z.pem"] },
		]);
	});

	test("a bundle exactly as large as maxSnapshotBytes is kept and one byte less leaves it out", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "data.txt"), "unique content that will not compress to nothing\n".repeat(20));
		const commit = await sandbox.commitAll(clone, "data");
		const measured = captured(await captureWorktreeSnapshot(clone)).snapshot.bundle;
		assert.ok(measured);
		assert.deepEqual(measured.commits, [commit]);

		const exact = captured(await captureWorktreeSnapshot(clone, { settings: { maxSnapshotBytes: measured.bytes } }));
		assert.equal(exact.snapshot.bundle?.bytes, measured.bytes);
		assert.deepEqual(exact.snapshot.omitted, []);

		const under = captured(
			await captureWorktreeSnapshot(clone, { settings: { maxSnapshotBytes: measured.bytes - 1 } }),
		);
		assert.equal(under.snapshot.bundle, null);
		assert.deepEqual(under.snapshot.omitted, [
			{ reason: "bundle-over-cap", commits: [commit], bytes: measured.bytes },
		]);
	});

	test("an unchanged history reuses the bundle of the previous snapshot without reporting anything omitted", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "feature.txt"), "feature\n");
		await sandbox.commitAll(clone, "feature");
		const blobs = new MemorySnapshotBlobStore();
		const first = captured(await captureWorktreeSnapshot(clone, { blobs }));
		assert.ok(first.snapshot.bundle);
		sandbox.write(join(clone, "notes.txt"), "edited after the first capture\n");
		const second = captured(await captureWorktreeSnapshot(clone, { blobs, previous: first.snapshot }));
		assert.deepEqual(second.snapshot.bundle, first.snapshot.bundle);
		assert.deepEqual(second.snapshot.omitted, []);
		assert.equal(
			second.blobs.some((blob) => blob.hash === first.snapshot.bundle?.blob),
			false,
			"the bundle blob is not written again",
		);
	});
});

describe("cancellation reaches the work-tree step of a capture", () => {
	test("an abort raised while the working tree is being written rejects with its reason instead of finishing", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "a.txt"), "edit\n");
		const first = captured(await captureWorktreeSnapshot(clone));

		const executable = sandbox.executable;
		let invocations = 0;
		let abortAt = Number.POSITIVE_INFINITY;
		const controller = new AbortController();
		const restore = setWorktreeSnapshotGit(async () => {
			invocations++;
			if (invocations === abortAt) controller.abort(new Error("cancelled by the user"));
			return executable;
		});
		try {
			const unchanged = await captureWorktreeSnapshot(clone, { previous: first.snapshot });
			assert.equal(unchanged.status, "unchanged");
			const total = invocations;
			assert.ok(total >= 5, "writing the working tree takes several Git commands");

			invocations = 0;
			abortAt = total - 1;
			await assert.rejects(
				captureWorktreeSnapshot(clone, { previous: first.snapshot, signal: controller.signal }),
				(error: unknown) => error === controller.signal.reason,
			);
		} finally {
			setWorktreeSnapshotGit(restore);
		}
	});
});
