import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	captureWorktreeSnapshot,
	isWorkspaceDriftError,
	MemorySnapshotBlobStore,
	restoreWorktreeSnapshot,
	verifyWorktree,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox, gitConfigPath } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

test("a recorded untracked file restores and verifies even when the new host excludes it (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "notes.log"), "recorded content\n");
	const blobs = new MemorySnapshotBlobStore();
	const captured = await captureWorktreeSnapshot(clone, { blobs });
	assert.equal(captured.status, "captured");
	if (captured.status !== "captured") return;
	const exclude = sandbox.path("exclude");
	writeFileSync(exclude, "*.log\n");
	writeFileSync(
		sandbox.globalConfig,
		`${readFileSync(sandbox.globalConfig, "utf8")}\n[core]\n\texcludesFile = ${gitConfigPath(exclude)}\n`,
	);
	const restored = await restoreWorktreeSnapshot(captured.snapshot, { blobs, storeDir: sandbox.path("host-b") });
	assert.equal(readFileSync(join(restored, "notes.log"), "utf8"), "recorded content\n");
	assert.equal((await verifyWorktree(captured.binding, restored)).tree, captured.binding.tree);
	sandbox.write(join(restored, "notes.log"), "tampered content\n");
	await assert.rejects(verifyWorktree(captured.binding, restored), (error: unknown) => isWorkspaceDriftError(error));
});

test("verification compares recorded files regardless of the new host's untracked and size settings (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "large.txt"), "recorded content longer than ten bytes\n");
	const blobs = new MemorySnapshotBlobStore();
	const captured = await captureWorktreeSnapshot(clone, { blobs });
	assert.equal(captured.status, "captured");
	if (captured.status !== "captured") return;
	const restored = await restoreWorktreeSnapshot(captured.snapshot, { blobs, storeDir: sandbox.path("host-b") });
	assert.equal(
		(await verifyWorktree(captured.snapshot, restored, { settings: { includeUntracked: false, maxFileBytes: 10 } }))
			.tree,
		captured.snapshot.tree,
	);
	sandbox.write(join(restored, "additional.txt"), "new\n");
	assert.equal(
		(await verifyWorktree(captured.binding, restored, { settings: { includeUntracked: false, maxFileBytes: 10 } }))
			.tree,
		captured.snapshot.tree,
	);
	await assert.rejects(verifyWorktree(captured.binding, restored), (error: unknown) => isWorkspaceDriftError(error));
});

test("a restore verifies with host-global attributes ignored but the repository attributes kept (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone("repo", {
		".gitattributes": "*.txt text\n",
		"README.md": "hello\n",
	});
	sandbox.write(join(clone, "note.txt"), "alpha\n");
	const blobs = new MemorySnapshotBlobStore();
	const captured = await captureWorktreeSnapshot(clone, { blobs });
	assert.equal(captured.status, "captured");
	if (captured.status !== "captured") return;
	const attributes = sandbox.path("host-attributes");
	writeFileSync(attributes, "*.txt filter=host\n");
	writeFileSync(
		sandbox.globalConfig,
		`${readFileSync(sandbox.globalConfig, "utf8")}\n[core]\n\tattributesFile = ${gitConfigPath(attributes)}\n[filter "host"]\n\tclean = sed s/alpha/omega/g\n`,
	);
	const restored = await restoreWorktreeSnapshot(captured.snapshot, { blobs, storeDir: sandbox.path("host-b") });
	assert.equal(readFileSync(join(restored, "note.txt"), "utf8"), "alpha\n");
	assert.equal(await sandbox.git(restored, "rev-parse", "HEAD"), captured.snapshot.head);
});

test("a checkout missing the recorded tree reports drift so a caller can restore it (#4245)", async () => {
	const { clone, remote } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "untracked.txt"), "not in remote\n");
	const captured = await captureWorktreeSnapshot(clone);
	assert.equal(captured.status, "captured");
	if (captured.status !== "captured") return;
	const other = sandbox.path("other-clone");
	await sandbox.git(sandbox.root, "clone", "-q", "--branch", "main", remote, other);
	await assert.rejects(verifyWorktree(captured.binding, other), (error: unknown) => {
		assert.ok(isWorkspaceDriftError(error));
		assert.equal(error.code, "tree-drift");
		assert.equal(error.expectedTree, captured.binding.tree);
		assert.equal(error.actualTree, null);
		return true;
	});
});

test("a checkout verifies under its own line-ending settings, so CRLF files edited with core.autocrlf stay verified (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "one\n" });
	await sandbox.git(clone, "config", "core.autocrlf", "true");
	sandbox.write(join(clone, "a.txt"), "one\r\ntwo\r\n");
	sandbox.write(join(clone, "b.txt"), "new\r\n");
	const captured = await captureWorktreeSnapshot(clone);
	assert.equal(captured.status, "captured");
	if (captured.status !== "captured") return;
	assert.equal(await sandbox.git(clone, "cat-file", "-p", `${captured.snapshot.tree}:a.txt`), "one\ntwo");
	assert.equal((await verifyWorktree(captured.snapshot, clone)).tree, captured.snapshot.tree);
});
