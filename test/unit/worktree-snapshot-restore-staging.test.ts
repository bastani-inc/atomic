import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	captureWorktreeSnapshot,
	MemorySnapshotBlobStore,
	removeRestoredWorktree,
	restoreWorktree,
	type WorktreeRestoreWarning,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

test("a malformed stale record is retained, reported once, and cannot delete a user checkout (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "untracked.txt"), "recorded\n");
	const blobs = new MemorySnapshotBlobStore();
	const capture = await captureWorktreeSnapshot(clone, { blobs });
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") return;
	const storeDir = sandbox.path("host");
	mkdirSync(join(storeDir, "restores"), { recursive: true });
	const recordPath = join(storeDir, "restores", `${randomUUID()}.json`);
	writeFileSync(recordPath, JSON.stringify({ staging: clone, target: clone, store: clone, createdTarget: true }));
	const warnings: WorktreeRestoreWarning[] = [];
	const restored = await restoreWorktree(capture.snapshot, {
		blobs,
		storeDir,
		onWarning: (warning) => warnings.push(warning),
	});
	assert.deepEqual(warnings, [{ code: "stale-restore-retained", path: recordPath, kind: "record" }]);
	assert.equal(existsSync(recordPath), true);
	assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "hello\n");
	assert.equal(readFileSync(join(restored.path, "untracked.txt"), "utf8"), "recorded\n");
	assert.deepEqual(readdirSync(join(storeDir, "restores")), [recordPath.split(/[\\/]/).at(-1)]);
	const removalWarnings: WorktreeRestoreWarning[] = [];
	await removeRestoredWorktree(restored.path, { storeDir, onWarning: (warning) => removalWarnings.push(warning) });
	assert.deepEqual(removalWarnings, [{ code: "stale-restore-retained", path: recordPath, kind: "record" }]);
	assert.equal(existsSync(restored.path), false);
	assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "hello\n");
});

test.skipIf(process.platform === "win32")(
	"restore into a symlinked parent returns its verified destination (symbolic links need a privilege on Windows) (#4245)",
	async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "untracked.txt"), "recorded\n");
		const blobs = new MemorySnapshotBlobStore();
		const capture = await captureWorktreeSnapshot(clone, { blobs });
		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") return;
		const parent = sandbox.path("physical");
		mkdirSync(parent);
		const link = sandbox.path("link");
		symlinkSync(parent, link, "dir");
		const into = join(link, "restored");
		const restored = await restoreWorktree(capture.snapshot, { blobs, storeDir: sandbox.path("host"), into });
		assert.equal(restored.path, into);
		assert.equal(readFileSync(join(into, "untracked.txt"), "utf8"), "recorded\n");
	},
);

test("a plausible stale record cannot delete a directory that is not a registered Atomic worktree (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "untracked.txt"), "recorded\n");
	const blobs = new MemorySnapshotBlobStore();
	const capture = await captureWorktreeSnapshot(clone, { blobs });
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") return;
	const storeDir = sandbox.path("host");
	await restoreWorktree(capture.snapshot, { blobs, storeDir });
	const repo = join(storeDir, "repositories", readdirSync(join(storeDir, "repositories"))[0]!);
	const id = randomUUID();
	const target = sandbox.path("user-checkout");
	const staging = sandbox.path(`.user-checkout.atomic-restore-${id}`);
	mkdirSync(staging);
	writeFileSync(join(staging, "keep.txt"), "user data\n");
	const record = join(storeDir, "restores", `${id}.json`);
	writeFileSync(record, JSON.stringify({ staging, target, store: repo, createdTarget: true }));
	const warnings: WorktreeRestoreWarning[] = [];
	await restoreWorktree(capture.snapshot, { blobs, storeDir, onWarning: (warning) => warnings.push(warning) });
	assert.deepEqual(warnings, [{ code: "stale-restore-retained", path: staging, kind: "worktree" }]);
	assert.equal(readFileSync(join(staging, "keep.txt"), "utf8"), "user data\n");
	assert.equal(existsSync(record), true);
});

test.skipIf(process.platform === "win32")(
	"a stale staging symlink never removes a different registered worktree (symbolic links need a privilege on Windows) (#4245)",
	async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "untracked.txt"), "recorded\n");
		const blobs = new MemorySnapshotBlobStore();
		const capture = await captureWorktreeSnapshot(clone, { blobs });
		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") return;
		const storeDir = sandbox.path("host");
		const previous = await restoreWorktree(capture.snapshot, { blobs, storeDir });
		const repo = join(storeDir, "repositories", readdirSync(join(storeDir, "repositories"))[0]!);
		const id = randomUUID();
		const target = sandbox.path("user-checkout");
		const staging = sandbox.path(`.user-checkout.atomic-restore-${id}`);
		symlinkSync(previous.path, staging, "dir");
		writeFileSync(
			join(storeDir, "restores", `${id}.json`),
			JSON.stringify({ staging, target, store: repo, createdTarget: true }),
		);
		const warnings: WorktreeRestoreWarning[] = [];
		await restoreWorktree(capture.snapshot, { blobs, storeDir, onWarning: (warning) => warnings.push(warning) });
		assert.deepEqual(warnings, [{ code: "stale-restore-retained", path: staging, kind: "worktree" }]);
		assert.equal(readFileSync(join(previous.path, "untracked.txt"), "utf8"), "recorded\n");
	},
);
