import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	captureWorktreeSnapshot,
	MemorySnapshotBlobStore,
	restoreWorktree,
	setWorktreeSnapshotGit,
	verifyWorktree,
	type WorktreeRestoreWarning,
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
	if (result.status !== "captured") throw new Error("capture failed");
	return result.snapshot;
}

/** A `git-lfs` on PATH that logs the remote it is asked to pull from and fails for every remote in `failing`. */
function fakeLfs(failing: readonly string[]): { log: string } {
	const bin = mkdtempSync(join(sandbox.root, "bin-"));
	const log = join(sandbox.root, "lfs.log");
	const script = join(bin, "git-lfs");
	writeFileSync(
		script,
		`#!/bin/sh\nfor last; do :; done\nprintf '%s|%s|%s\\n' "$*" "$GIT_TERMINAL_PROMPT" "$GIT_SSH_COMMAND" >> '${log}'\ncase ",$FAKE_LFS_FAIL," in *",$last,"*) exit 1 ;; esac\nexit 0\n`,
	);
	chmodSync(script, 0o755);
	setWorktreeSnapshotGit(async () => ({
		path: "git",
		env: { ...sandbox.executable.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LFS_FAIL: failing.join(",") },
	}));
	return { log };
}

/** What Git LFS is asked for when the recorded remote is a local path: its `file://` URL. */
const asUrl = (path: string): string => pathToFileURL(path).href;

const pulls = (log: string): string[] =>
	existsSync(log)
		? readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => line.split("|")[0]!)
		: [];

/** Two remotes that both hold the repository, and a snapshot that names them in this order. */
async function lfsSnapshotWithTwoRemotes() {
	const { clone, remote } = await sandbox.remoteWithClone("repo", {
		".gitattributes": "*.bin filter=lfs -text\n",
		"data.bin": "pointer-ish\n",
	});
	const mirror = sandbox.path("mirror.git");
	await sandbox.git(sandbox.root, "clone", "-q", "--bare", remote, mirror);
	sandbox.write(join(clone, "notes.txt"), "notes\n");
	const blobs = new MemorySnapshotBlobStore();
	const snapshot = { ...(await capture(clone, blobs)), remotes: [remote, mirror] };
	assert.deepEqual(snapshot.filters?.drivers, ["lfs"]);
	return { blobs, snapshot, remote, mirror };
}

async function restoreCollectingWarnings(snapshot: WorktreeSnapshot, blobs: MemorySnapshotBlobStore) {
	const warnings: WorktreeRestoreWarning[] = [];
	const restored = await restoreWorktree(snapshot, {
		blobs,
		storeDir: sandbox.path("host"),
		onWarning: (warning) => warnings.push(warning),
	});
	return { restored, warnings };
}

describe.skipIf(process.platform === "win32")("which remotes an LFS restore pulls from (#4245)", () => {
	test("the first recorded remote that has the objects ends the search, and the pull names it after `--`", async () => {
		const { blobs, snapshot, remote } = await lfsSnapshotWithTwoRemotes();
		const { log } = fakeLfs([]);
		const { warnings } = await restoreCollectingWarnings(snapshot, blobs);
		assert.deepEqual(pulls(log), [`pull -- ${asUrl(remote)}`]);
		assert.deepEqual(
			warnings.map((warning) => warning.code),
			["filters"],
		);
	});

	test("a remote that fails is followed by the next one, in the recorded order, with no warning when it succeeds", async () => {
		const { blobs, snapshot, remote, mirror } = await lfsSnapshotWithTwoRemotes();
		const { log } = fakeLfs([asUrl(remote)]);
		const { warnings } = await restoreCollectingWarnings(snapshot, blobs);
		assert.deepEqual(pulls(log), [`pull -- ${asUrl(remote)}`, `pull -- ${asUrl(mirror)}`]);
		assert.deepEqual(
			warnings.map((warning) => warning.code),
			["filters"],
		);
	});

	test("when every remote fails the pointer files are reported once, after each remote was tried", async () => {
		const { blobs, snapshot, remote, mirror } = await lfsSnapshotWithTwoRemotes();
		const { log } = fakeLfs([asUrl(remote), asUrl(mirror)]);
		const { restored, warnings } = await restoreCollectingWarnings(snapshot, blobs);
		assert.deepEqual(pulls(log), [`pull -- ${asUrl(remote)}`, `pull -- ${asUrl(mirror)}`]);
		assert.deepEqual(warnings, [
			{ code: "lfs-objects-unavailable", paths: ["data.bin"] },
			{ code: "filters", filters: { autocrlf: null, eol: null, drivers: ["lfs"] } },
		]);
		assert.deepEqual(restored.warnings, warnings);
	});

	test("a remote that is a URL, not a path, is handed to Git LFS exactly as recorded", async () => {
		const { blobs, snapshot, remote } = await lfsSnapshotWithTwoRemotes();
		const url = "https://example.invalid/team/repo.git";
		const { log } = fakeLfs([asUrl(remote)]);
		await restoreCollectingWarnings({ ...snapshot, remotes: [remote, url] }, blobs);
		assert.deepEqual(pulls(log), [`pull -- ${asUrl(remote)}`, `pull -- ${url}`]);
	});

	test("the download can never wait for a person: no terminal prompt, and ssh runs in batch mode", async () => {
		const { blobs, snapshot } = await lfsSnapshotWithTwoRemotes();
		const { log } = fakeLfs([]);
		await restoreCollectingWarnings(snapshot, blobs);
		const [, prompt, ssh] = readFileSync(log, "utf8").trim().split("|");
		assert.equal(prompt, "0");
		assert.match(ssh ?? "", /BatchMode=yes/);
	});

	test("a repository with no recorded remote has nothing to pull from, so it warns without running git-lfs", async () => {
		const repository = sandbox.path("solo");
		mkdirSync(repository);
		await sandbox.git(repository, "init", "-q");
		sandbox.write(join(repository, ".gitattributes"), "*.bin filter=lfs -text\n");
		sandbox.write(join(repository, "data.bin"), "x\n");
		await sandbox.commitAll(repository, "initial");
		sandbox.write(join(repository, "notes.txt"), "notes\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(repository, blobs);
		assert.deepEqual(snapshot.remotes, []);
		const { log } = fakeLfs([]);
		const { warnings } = await restoreCollectingWarnings(snapshot, blobs);
		assert.deepEqual(pulls(log), []);
		assert.deepEqual(warnings[0], { code: "lfs-objects-unavailable", paths: ["data.bin"] });
	});
});

describe.skipIf(process.platform === "win32")("restoring real Git LFS content (#4245)", () => {
	test("a file stored in LFS on the remote is restored with its content, with no warning, and the tree verifies", async () => {
		const version = await sandbox.git(sandbox.root, "lfs", "version").catch((error: unknown) => {
			throw new Error(
				`These tests need git-lfs on PATH, and it could not be started: ${String(error)}. Install it with \`git lfs install\` available, for example \`sudo apt-get install git-lfs\`.`,
			);
		});
		assert.match(version, /^git-lfs\//);
		await sandbox.git(sandbox.root, "lfs", "install", "--skip-repo");
		const { clone } = await sandbox.remoteWithClone("repo", {
			".gitattributes": "*.bin filter=lfs -text\n",
			"data.bin": "LFS-CONTENT-123\n",
		});
		await sandbox.git(clone, "lfs", "push", "--all", "origin");
		sandbox.write(join(clone, "notes.txt"), "unrelated edit\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		assert.deepEqual(snapshot.filters?.drivers, ["lfs"]);
		const warnings: WorktreeRestoreWarning[] = [];
		const restored = await restoreWorktree(snapshot, {
			blobs,
			storeDir: sandbox.path("host"),
			onWarning: (warning) => warnings.push(warning),
		});
		assert.equal(readFileSync(join(restored.path, "data.bin"), "utf8"), "LFS-CONTENT-123\n");
		assert.deepEqual(
			warnings.map((warning) => warning.code),
			["filters"],
		);
		assert.equal((await verifyWorktree(snapshot, restored.path)).tree, snapshot.tree);
	});
});
