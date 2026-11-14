import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { SpawnRequest } from "../helpers/worktree-snapshot-faults.js";

/**
 * The `git lfs pull` commands a restore starts once a test calls {@link fakeLfs}, and the remotes whose pull fails;
 * every other pull, and every other command, runs the real Git and Git LFS.
 */
const lfs = vi.hoisted(() => ({
	pulls: [] as SpawnRequest[],
	failing: undefined as readonly string[] | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const { failingCommand, gitCommand, withSpawnFaults } = await import("../helpers/worktree-snapshot-faults.js");
	return withSpawnFaults(await importOriginal(), (request) => {
		const command = gitCommand(request.args);
		if (lfs.failing === undefined || command[0] !== "lfs" || command[1] !== "pull") return undefined;
		lfs.pulls.push(request);
		return lfs.failing.includes(command.at(-1)!) ? failingCommand(1) : undefined;
	});
});

import { ResumeTimingsRecorder, timeCheckoutRestore } from "../../packages/coding-agent/src/core/resume/timings.ts";
import {
	captureWorktreeSnapshot,
	MemorySnapshotBlobStore,
	restoreWorktree,
	verifyWorktree,
	type WorktreeRestoreWarning,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";
import { gitCommand } from "../helpers/worktree-snapshot-faults.js";

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	lfs.failing = undefined;
	lfs.pulls.length = 0;
	sandbox.dispose();
});

async function capture(dir: string, blobs: MemorySnapshotBlobStore): Promise<WorktreeSnapshot> {
	const result = await captureWorktreeSnapshot(dir, { blobs });
	assert.equal(result.status, "captured");
	if (result.status !== "captured") throw new Error("capture failed");
	return result.snapshot;
}

/** Records every `git lfs pull` from here on and fails the pull from each remote in `failing`, the way Git LFS exits. */
function fakeLfs(failing: readonly string[]): void {
	lfs.failing = failing;
	lfs.pulls.length = 0;
}

/** What Git LFS is asked for when the recorded remote is a local path: its `file://` URL. */
const asUrl = (path: string): string => pathToFileURL(path).href;

const pulls = (): string[] => lfs.pulls.map((request) => gitCommand(request.args).slice(1).join(" "));

/** Two remotes that both hold the repository and the LFS object of `data.bin`, and a snapshot that names them in this order. */
async function lfsSnapshotWithTwoRemotes() {
	await sandbox.git(sandbox.root, "lfs", "install", "--skip-repo");
	const { clone, remote } = await sandbox.remoteWithClone("repo", {
		".gitattributes": "*.bin filter=lfs -text\n",
		"data.bin": "LFS-CONTENT-123\n",
	});
	await sandbox.git(clone, "lfs", "push", "--all", "origin");
	const mirror = sandbox.path("mirror.git");
	await sandbox.git(sandbox.root, "clone", "-q", "--bare", remote, mirror);
	cpSync(join(remote, "lfs"), join(mirror, "lfs"), { recursive: true });
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

describe("LFS restore timings (#4748)", () => {
	test("an LFS restore reports its download as the LFS phase of the checkout restore it runs in (#4748)", async () => {
		const { blobs, snapshot } = await lfsSnapshotWithTwoRemotes();
		fakeLfs([]);
		const recorder = new ResumeTimingsRecorder();
		await recorder.run(() =>
			timeCheckoutRestore(
				snapshot.root,
				() => restoreCollectingWarnings(snapshot, blobs),
				() => "fresh",
			),
		);
		const [restore] = recorder.finish().restores;
		assert.ok(restore);
		assert.deepEqual(Object.keys(restore.phases).sort(), [
			"fetch",
			"lfs",
			"materialize",
			"publish",
			"reconstruct",
			"verify",
		]);
		const sum = Object.values(restore.phases).reduce((total, ms) => total + ms, 0);
		assert.ok(sum <= restore.ms, `phases ${sum} ms within the restore's ${restore.ms} ms`);
	});
});

describe("which remotes an LFS restore pulls from (#4245)", () => {
	test("the first recorded remote that has the objects ends the search, and the pull names it after `--`", async () => {
		const { blobs, snapshot, remote } = await lfsSnapshotWithTwoRemotes();
		fakeLfs([]);
		const { warnings } = await restoreCollectingWarnings(snapshot, blobs);
		assert.deepEqual(pulls(), [`pull -- ${asUrl(remote)}`]);
		assert.deepEqual(
			warnings.map((warning) => warning.code),
			["filters"],
		);
	});

	test("a remote that fails is followed by the next one, in the recorded order, with no warning when it succeeds", async () => {
		const { blobs, snapshot, remote, mirror } = await lfsSnapshotWithTwoRemotes();
		fakeLfs([asUrl(remote)]);
		const { warnings } = await restoreCollectingWarnings(snapshot, blobs);
		assert.deepEqual(pulls(), [`pull -- ${asUrl(remote)}`, `pull -- ${asUrl(mirror)}`]);
		assert.deepEqual(
			warnings.map((warning) => warning.code),
			["filters"],
		);
	});

	test("when every remote fails the pointer files are reported once, after each remote was tried", async () => {
		const { blobs, snapshot, remote, mirror } = await lfsSnapshotWithTwoRemotes();
		fakeLfs([asUrl(remote), asUrl(mirror)]);
		const { restored, warnings } = await restoreCollectingWarnings(snapshot, blobs);
		assert.deepEqual(pulls(), [`pull -- ${asUrl(remote)}`, `pull -- ${asUrl(mirror)}`]);
		assert.deepEqual(warnings, [
			{ code: "lfs-objects-unavailable", paths: ["data.bin"] },
			{ code: "filters", filters: { autocrlf: null, eol: null, drivers: ["lfs"] } },
		]);
		assert.deepEqual(restored.warnings, warnings);
	});

	test("a remote that is a URL, not a path, is handed to Git LFS exactly as recorded", async () => {
		const { blobs, snapshot, remote } = await lfsSnapshotWithTwoRemotes();
		const url = "https://example.invalid/team/repo.git";
		fakeLfs([asUrl(remote)]);
		await restoreCollectingWarnings({ ...snapshot, remotes: [remote, url] }, blobs);
		assert.deepEqual(pulls(), [`pull -- ${asUrl(remote)}`, `pull -- ${url}`]);
	});

	test("the download can never wait for a person: no terminal prompt, and ssh runs in batch mode", async () => {
		const { blobs, snapshot } = await lfsSnapshotWithTwoRemotes();
		fakeLfs([]);
		await restoreCollectingWarnings(snapshot, blobs);
		const [pull] = lfs.pulls;
		assert.equal(pull?.env.GIT_TERMINAL_PROMPT, "0");
		assert.match(pull?.env.GIT_SSH_COMMAND ?? "", /BatchMode=yes/);
	});

	test("a repository with no recorded remote has nothing to pull from, so it warns without running git-lfs", async () => {
		const repository = sandbox.path("solo");
		mkdirSync(repository);
		await sandbox.git(repository, "init", "-q");
		sandbox.write(join(repository, ".gitattributes"), "*.bin filter=lfs -text\n");
		sandbox.write(join(repository, "data.bin"), `${LFS_POINTER_PREFIX}\noid sha256:${sha256("x\n")}\nsize 2\n`);
		await sandbox.commitAll(repository, "initial");
		sandbox.write(join(repository, "notes.txt"), "notes\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(repository, blobs);
		assert.deepEqual(snapshot.remotes, []);
		fakeLfs([]);
		const { warnings } = await restoreCollectingWarnings(snapshot, blobs);
		assert.deepEqual(pulls(), []);
		assert.deepEqual(warnings[0], { code: "lfs-objects-unavailable", paths: ["data.bin"] });
	});
});

describe("restoring real Git LFS content (#4245)", () => {
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

/** A repository whose `data.bin` is stored in LFS and pushed, edited in the worktree with only the edit's object pushed. */
async function lfsEditedSnapshot(
	extra: Record<string, string> = {},
	pushed: readonly string[] = [],
	prepare: (clone: string) => void = () => {},
) {
	await sandbox.git(sandbox.root, "lfs", "install", "--skip-repo");
	const { clone } = await sandbox.remoteWithClone("repo", {
		".gitattributes": "*.bin filter=lfs -text\n",
		"data.bin": "ORIGINAL-CONTENT\n",
	});
	await sandbox.git(clone, "lfs", "push", "--all", "origin");
	sandbox.write(join(clone, "data.bin"), "EDITED-CONTENT\n");
	for (const [file, content] of Object.entries(extra)) sandbox.write(join(clone, file), content);
	prepare(clone);
	await sandbox.git(clone, "add", "-A");
	const objects = ["EDITED-CONTENT\n", ...pushed].map(sha256);
	await sandbox.git(clone, "lfs", "push", "--object-id", "origin", ...objects);
	await sandbox.git(clone, "reset", "-q");
	const blobs = new MemorySnapshotBlobStore();
	return { blobs, snapshot: await capture(clone, blobs) };
}

describe("restoring LFS files that changed since HEAD (#4245)", () => {
	test("an edited LFS file whose new object is on the remote is restored with its content and no LFS warning", async () => {
		const { blobs, snapshot } = await lfsEditedSnapshot();
		const { restored, warnings } = await restoreCollectingWarnings(snapshot, blobs);
		assert.equal(readFileSync(join(restored.path, "data.bin"), "utf8"), "EDITED-CONTENT\n");
		assert.deepEqual(
			warnings.map((warning) => warning.code),
			["filters"],
		);
		assert.equal((await verifyWorktree(snapshot, restored.path)).tree, snapshot.tree);
		assert.equal(
			await sandbox.git(restored.path, "diff-files", "--name-only"),
			"data.bin",
			"only the edit differs from a fresh index",
		);
	});

	test.skipIf(process.platform === "win32")(
		"fetched content that only starts like a pointer is content, and a link named like an LFS file is left alone (symbolic links need a privilege on Windows)",
		async () => {
			const lookalike = `${LFS_POINTER_PREFIX}\n`.padEnd(1024, "x");
			const { blobs, snapshot } = await lfsEditedSnapshot({ "lookalike.bin": lookalike }, [lookalike], (clone) =>
				symlinkSync("missing-target", join(clone, "link.bin")),
			);
			const { restored, warnings } = await restoreCollectingWarnings(snapshot, blobs);
			assert.equal(readFileSync(join(restored.path, "lookalike.bin"), "utf8"), lookalike);
			assert.equal(readlinkSync(join(restored.path, "link.bin")), "missing-target");
			assert.deepEqual(
				warnings.map((warning) => warning.code),
				["filters"],
			);
		},
	);

	test("a new LFS file whose object was never pushed stays a pointer, and only it is reported", async () => {
		const { blobs, snapshot } = await lfsEditedSnapshot({ "fresh.bin": "NEVER-PUSHED\n" });
		const { restored, warnings } = await restoreCollectingWarnings(snapshot, blobs);
		assert.equal(readFileSync(join(restored.path, "data.bin"), "utf8"), "EDITED-CONTENT\n");
		assert.ok(readFileSync(join(restored.path, "fresh.bin"), "utf8").startsWith(LFS_POINTER_PREFIX));
		assert.deepEqual(
			warnings.map((warning) => warning.code),
			["lfs-objects-unavailable", "filters"],
		);
		assert.deepEqual(warnings[0], { code: "lfs-objects-unavailable", paths: ["fresh.bin"] });
		assert.equal((await verifyWorktree(snapshot, restored.path)).tree, snapshot.tree);
	});
});
