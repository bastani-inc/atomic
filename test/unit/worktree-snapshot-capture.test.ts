import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	captureWorktreeSnapshot,
	GitUnavailableError,
	isGitUnavailableError,
	isWorkspaceConfigError,
	isWorkspaceSnapshotError,
	MemorySnapshotBlobStore,
	setWorktreeSnapshotGit,
	WorkspaceConfigError,
	WorkspaceSnapshotError,
	type WorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

function captured(result: WorktreeSnapshotCapture): Extract<WorktreeSnapshotCapture, { status: "captured" }> {
	assert.equal(result.status, "captured");
	return result as Extract<WorktreeSnapshotCapture, { status: "captured" }>;
}

async function blobText(cwd: string, tree: string, path: string): Promise<string> {
	return sandbox.git(cwd, "cat-file", "-p", `${tree}:${path}`);
}

async function treePaths(cwd: string, tree: string): Promise<string[]> {
	return (await sandbox.git(cwd, "ls-tree", "-r", "--name-only", tree)).split("\n").filter(Boolean);
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("captureWorktreeSnapshot availability", () => {
	test("records nothing when Git cannot be started (#4245)", async () => {
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("missing-git"), env: {} }));
		const result = await captureWorktreeSnapshot(sandbox.root);
		assert.equal(result.status, "unavailable");
		const reason = (result as Extract<WorktreeSnapshotCapture, { status: "unavailable" }>).reason;
		assert.ok(reason instanceof GitUnavailableError);
		assert.ok(isGitUnavailableError(reason));
		assert.equal(reason.code, "git-unavailable");
		assert.equal((reason as GitUnavailableError).executable, sandbox.path("missing-git"));
		assert.equal(reason.retryable, false);
	});

	test("records nothing outside a repository (#4245)", async () => {
		const result = await captureWorktreeSnapshot(sandbox.root);
		assert.equal(result.status, "unavailable");
		const reason = (result as Extract<WorktreeSnapshotCapture, { status: "unavailable" }>).reason;
		assert.ok(isWorkspaceSnapshotError(reason));
		assert.equal(reason.code, "not-a-repository");
		assert.equal((reason as WorkspaceSnapshotError).subject, sandbox.root);
	});

	test("records nothing for a missing directory or a repository without commits", async () => {
		const missing = await captureWorktreeSnapshot(sandbox.path("absent"));
		assert.equal(missing.status === "unavailable" && missing.reason.code, "not-a-repository");
		const empty = sandbox.path("empty");
		await sandbox.git(sandbox.root, "init", "-q", empty);
		const unborn = await captureWorktreeSnapshot(empty);
		assert.equal(unborn.status, "unavailable");
		const reason = (unborn as Extract<WorktreeSnapshotCapture, { status: "unavailable" }>).reason;
		assert.ok(reason instanceof WorkspaceSnapshotError);
		assert.equal(reason.code, "unborn-head");
		assert.equal(reason.subject, empty);
	});

	test("runs no Git command when disabled", async () => {
		let resolved = 0;
		setWorktreeSnapshotGit(async () => {
			resolved++;
			return sandbox.executable;
		});
		const result = await captureWorktreeSnapshot(sandbox.root, { settings: { enabled: false } });
		assert.deepEqual(result, { status: "disabled" });
		assert.equal(resolved, 0);
	});

	test("rejects invalid settings before running Git", async () => {
		let resolved = 0;
		setWorktreeSnapshotGit(async () => {
			resolved++;
			return sandbox.executable;
		});
		await assert.rejects(
			captureWorktreeSnapshot(sandbox.root, { settings: { maxFileBytes: 0 } }),
			(error: unknown) => {
				assert.ok(error instanceof WorkspaceConfigError);
				assert.ok(isWorkspaceConfigError(error));
				assert.equal(error.code, "invalid-setting");
				assert.equal(error.source, "sdk");
				assert.equal(error.field, "settings.maxFileBytes");
				assert.equal(error.expected, "a positive integer");
				return true;
			},
		);
		await assert.rejects(
			captureWorktreeSnapshot(sandbox.root, { settings: { includeUntracked: "yes" as unknown as boolean } }),
			(error: unknown) => isWorkspaceConfigError(error) && error.field === "settings.includeUntracked",
		);
		await assert.rejects(
			captureWorktreeSnapshot("", {}),
			(error: unknown) => isWorkspaceConfigError(error) && error.field === "dir",
		);
		assert.equal(resolved, 0);
	});
});

describe("captureWorktreeSnapshot content", () => {
	test("a clean tree records HEAD's tree with no patch or bundle", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const result = captured(await captureWorktreeSnapshot(clone));
		const head = await sandbox.git(clone, "rev-parse", "HEAD");
		assert.equal(result.snapshot.head, head);
		assert.equal(result.snapshot.tree, await sandbox.git(clone, "rev-parse", "HEAD^{tree}"));
		assert.equal(result.snapshot.root, clone);
		assert.equal(result.snapshot.branch, "main");
		assert.deepEqual(result.snapshot.remotes, [sandbox.path("repo.git")]);
		assert.deepEqual(result.snapshot.chain, [{ tree: result.snapshot.tree, patch: null, bytes: 0 }]);
		assert.deepEqual(result.snapshot.delta, { base: "head", patch: null, bytes: 0 });
		assert.equal(result.snapshot.bundle, null);
		assert.deepEqual(result.snapshot.omitted, []);
		assert.equal(result.snapshot.filters, null);
		assert.deepEqual(result.blobs, []);
		assert.deepEqual(result.binding, {
			remotes: [sandbox.path("repo.git")],
			head,
			tree: result.snapshot.tree,
			envHash: result.snapshot.envHash,
		});
		assert.equal(await sandbox.git(clone, "rev-parse", `${result.snapshot.snapshot}^{tree}`), result.snapshot.tree);
		assert.equal(await sandbox.git(clone, "rev-parse", `${result.snapshot.snapshot}^`), head);
	});

	test("captures staged, unstaged, untracked, deleted and binary content without touching the user's index", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "one\n", "gone.txt": "bye\n" });
		sandbox.write(join(clone, "a.txt"), "staged\n");
		await sandbox.git(clone, "add", "a.txt");
		sandbox.write(join(clone, "a.txt"), "staged\nunstaged\n");
		sandbox.write(join(clone, "new", "b.txt"), "untracked\n");
		sandbox.write(join(clone, "image.bin"), new Uint8Array([0, 1, 2, 255, 0, 10]));
		unlinkSync(join(clone, "gone.txt"));
		const indexBefore = sha256(join(clone, ".git", "index"));
		const statusBefore = await sandbox.git(clone, "status", "--porcelain=v2");
		const blobs = new MemorySnapshotBlobStore();
		const result = captured(await captureWorktreeSnapshot(clone, { blobs }));
		assert.equal(sha256(join(clone, ".git", "index")), indexBefore);
		assert.equal(await sandbox.git(clone, "status", "--porcelain=v2"), statusBefore);
		assert.equal(await blobText(clone, result.snapshot.tree, "a.txt"), "staged\nunstaged");
		assert.equal(await blobText(clone, result.snapshot.tree, "new/b.txt"), "untracked");
		assert.deepEqual(await treePaths(clone, result.snapshot.tree), ["a.txt", "image.bin", "new/b.txt"]);
		assert.equal(result.blobs.length, 1);
		const patch = await blobs.getBlob(result.snapshot.chain[0]!.patch!);
		assert.ok(patch);
		assert.equal(result.snapshot.chain[0]!.bytes, patch.byteLength);
		assert.match(Buffer.from(patch).toString("utf8"), /GIT binary patch/);
	});

	test("includeUntracked false lists untracked files as omitted", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "notes.txt"), "draft\n");
		const result = captured(await captureWorktreeSnapshot(clone, { settings: { includeUntracked: false } }));
		assert.deepEqual(await treePaths(clone, result.snapshot.tree), ["README.md"]);
		assert.deepEqual(result.snapshot.omitted, [{ reason: "untracked-excluded", path: "notes.txt" }]);
	});

	test("respects .gitignore, global excludes and .atomic/snapshot-ignore", async () => {
		sandbox.write(sandbox.path("global-excludes"), "*.global\n");
		sandbox.write(
			sandbox.globalConfig,
			`${readFileSync(sandbox.globalConfig, "utf8")}[core]\n\texcludesFile = ${sandbox.path("global-excludes")}\n`,
		);
		const { clone } = await sandbox.remoteWithClone("repo", {
			".gitignore": "build/\n",
			".atomic/snapshot-ignore": "scratch/\nkept.txt\n",
			"kept.txt": "base\n",
		});
		sandbox.write(join(clone, "build", "out.js"), "built\n");
		sandbox.write(join(clone, "cache.global"), "cached\n");
		sandbox.write(join(clone, "scratch", "tmp.txt"), "temp\n");
		sandbox.write(join(clone, "kept.txt"), "edited\n");
		sandbox.write(join(clone, "real.txt"), "real\n");
		const result = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(await treePaths(clone, result.snapshot.tree), [
			".atomic/snapshot-ignore",
			".gitignore",
			"kept.txt",
			"real.txt",
		]);
		assert.equal(await blobText(clone, result.snapshot.tree, "kept.txt"), "base");
		assert.deepEqual(result.snapshot.omitted, [
			{ reason: "snapshot-ignore", path: "kept.txt" },
			{ reason: "snapshot-ignore", path: "scratch/tmp.txt" },
		]);
	});

	test("denied paths never reach the tree or patch: tracked ones keep HEAD content (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", {
			"config/server.key": "HEAD-KEY\n",
			".env": "HEAD_ENV=1\n",
			"id_utils.ts": "export const id = 1;\n",
		});
		sandbox.write(join(clone, "config", "server.key"), "LEAKED-WORKING-KEY\n");
		unlinkSync(join(clone, ".env"));
		sandbox.write(join(clone, ".env.local"), "LEAKED-UNTRACKED\n");
		sandbox.write(join(clone, "keys", "id_ed25519"), "LEAKED-SSH\n");
		sandbox.write(join(clone, "keys", "id_ed25519.pub"), "public\n");
		sandbox.write(join(clone, "id_utils.ts"), "export const id = 2;\n");
		const blobs = new MemorySnapshotBlobStore();
		const result = captured(await captureWorktreeSnapshot(clone, { blobs }));
		const tree = result.snapshot.tree;
		assert.equal(await blobText(clone, tree, "config/server.key"), "HEAD-KEY");
		assert.equal(await blobText(clone, tree, ".env"), "HEAD_ENV=1");
		assert.equal(await blobText(clone, tree, "id_utils.ts"), "export const id = 2;");
		assert.equal(await blobText(clone, tree, "keys/id_ed25519.pub"), "public");
		assert.deepEqual(result.snapshot.omitted, [
			{ reason: "denied", path: ".env" },
			{ reason: "denied", path: ".env.local" },
			{ reason: "denied", path: "config/server.key" },
			{ reason: "denied", path: "keys/id_ed25519" },
		]);
		const patch = Buffer.from((await blobs.getBlob(result.snapshot.chain[0]!.patch!))!).toString("utf8");
		assert.doesNotMatch(patch, /LEAKED|HEAD-KEY|HEAD_ENV/);
	});

	test("over-cap files are omitted with their size", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "big.txt"), "x".repeat(200));
		sandbox.write(join(clone, "a.txt"), "a".repeat(60));
		sandbox.write(join(clone, "b.txt"), "b".repeat(60));
		const result = captured(
			await captureWorktreeSnapshot(clone, { settings: { maxFileBytes: 100, maxSnapshotBytes: 100 } }),
		);
		assert.deepEqual(await treePaths(clone, result.snapshot.tree), ["README.md", "a.txt"]);
		assert.deepEqual(result.snapshot.omitted, [
			{ reason: "over-snapshot-cap", path: "b.txt", bytes: 60 },
			{ reason: "over-file-cap", path: "big.txt", bytes: 200 },
		]);
	});

	test("unpushed commits travel in a bundle; pushed history does not", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "feature.txt"), "feature\n");
		const first = await sandbox.commitAll(clone, "feature");
		sandbox.write(join(clone, "feature.txt"), "feature 2\n");
		const second = await sandbox.commitAll(clone, "feature 2");
		const blobs = new MemorySnapshotBlobStore();
		const result = captured(await captureWorktreeSnapshot(clone, { blobs }));
		assert.ok(result.snapshot.bundle);
		assert.deepEqual(result.snapshot.bundle.commits, [second, first]);
		const bundle = await blobs.getBlob(result.snapshot.bundle.blob);
		assert.ok(bundle);
		assert.equal(bundle.byteLength, result.snapshot.bundle.bytes);
		assert.match(Buffer.from(bundle).toString("latin1"), /^# v[23] git bundle/);
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		const pushed = captured(await captureWorktreeSnapshot(clone));
		assert.equal(pushed.snapshot.bundle, null);
	});

	test("unpushed history touching a denied path leaves the bundle out and names commits and paths (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "secrets", "prod.pem"), "PRIVATE\n");
		const leaking = await sandbox.commitAll(clone, "add pem");
		unlinkSync(join(clone, "secrets", "prod.pem"));
		sandbox.write(join(clone, "app.txt"), "app\n");
		const later = await sandbox.commitAll(clone, "remove pem");
		const blobs = new MemorySnapshotBlobStore();
		const result = captured(await captureWorktreeSnapshot(clone, { blobs }));
		assert.equal(result.snapshot.bundle, null);
		assert.deepEqual(result.snapshot.omitted, [
			{ reason: "unpushed-history-denied", commits: [leaking], paths: ["secrets/prod.pem"] },
		]);
		assert.notEqual(later, leaking);
		for (const hash of await blobs.listBlobHashes()) {
			assert.doesNotMatch(Buffer.from((await blobs.getBlob(hash))!).toString("latin1"), /PRIVATE/);
		}
	});

	test("a bundle over the snapshot cap is left out with its commits", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "data.txt"), "unique content that will not compress to nothing\n".repeat(20));
		const commit = await sandbox.commitAll(clone, "data");
		const result = captured(await captureWorktreeSnapshot(clone, { settings: { maxSnapshotBytes: 64 } }));
		assert.equal(result.snapshot.bundle, null);
		const [omission] = result.snapshot.omitted;
		assert.ok(omission?.reason === "bundle-over-cap");
		assert.deepEqual(omission.commits, [commit]);
		assert.ok(omission.bytes > 64);
	});

	test("remote URLs drop embedded credentials", async () => {
		const { clone } = await sandbox.remoteWithClone();
		await sandbox.git(clone, "remote", "add", "mirror", "https://user:token123@example.com/org/repo.git");
		const result = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(result.snapshot.remotes, [sandbox.path("repo.git"), "https://example.com/org/repo.git"]);
	});

	test("records conversion filters the repository uses", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { ".gitattributes": "*.bin filter=lfs -text\n" });
		await sandbox.git(clone, "config", "core.autocrlf", "true");
		const result = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(result.snapshot.filters, { autocrlf: "true", eol: null, drivers: ["lfs"] });
	});
});

describe("captureWorktreeSnapshot no-op and deltas", () => {
	test("a dirty file edited again is a new snapshot even when status and HEAD match (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "base\n" });
		sandbox.write(join(clone, "a.txt"), "first edit\n");
		const first = captured(await captureWorktreeSnapshot(clone));
		const status = await sandbox.git(clone, "status", "--porcelain=v2");
		sandbox.write(join(clone, "a.txt"), "second edit\n");
		assert.equal(await sandbox.git(clone, "status", "--porcelain=v2"), status);
		const second = await captureWorktreeSnapshot(clone, { previous: first.snapshot });
		assert.equal(second.status, "captured");
		const next = captured(second).snapshot;
		assert.notEqual(next.tree, first.snapshot.tree);
		assert.equal(await blobText(clone, next.tree, "a.txt"), "second edit");
	});

	test("an unchanged tree and HEAD reuse the previous snapshot without new blobs", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "a.txt"), "edit\n");
		const first = captured(await captureWorktreeSnapshot(clone));
		const again = await captureWorktreeSnapshot(clone, { previous: first.snapshot });
		assert.equal(again.status, "unchanged");
		assert.equal((again as { snapshot: WorktreeSnapshot }).snapshot, first.snapshot);
		assert.deepEqual((again as { binding: object }).binding, first.binding);
	});

	test("deltas chain on the previous snapshot and restart from HEAD every fullEvery or when HEAD moves", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const settings = { fullEvery: 2 };
		const snapshots: WorktreeSnapshot[] = [];
		for (const content of ["1\n", "2\n", "3\n"]) {
			sandbox.write(join(clone, "n.txt"), content);
			const previous = snapshots.at(-1);
			snapshots.push(captured(await captureWorktreeSnapshot(clone, { settings, previous })).snapshot);
		}
		assert.deepEqual(
			snapshots.map((snapshot) => snapshot.chain.length),
			[1, 2, 1],
		);
		assert.equal(snapshots[1]!.delta.base, snapshots[0]!.id);
		assert.deepEqual(snapshots[1]!.chain[0], snapshots[0]!.chain[0]);
		assert.equal(snapshots[2]!.delta.base, "head");
		await sandbox.commitAll(clone, "move head");
		sandbox.write(join(clone, "n.txt"), "4\n");
		const moved = captured(await captureWorktreeSnapshot(clone, { previous: snapshots[2] })).snapshot;
		assert.equal(moved.delta.base, "head");
		assert.equal(moved.chain.length, 1);
	});

	test("a previous snapshot of another checkout is not a delta base", async () => {
		const one = await sandbox.remoteWithClone("one");
		const two = await sandbox.remoteWithClone("two");
		sandbox.write(join(one.clone, "x.txt"), "x\n");
		const first = captured(await captureWorktreeSnapshot(one.clone)).snapshot;
		const second = captured(await captureWorktreeSnapshot(two.clone, { previous: first })).snapshot;
		assert.equal(second.delta.base, "head");
		assert.equal(second.root, two.clone);
	});

	test("several repositories and linked worktrees are captured independently", async () => {
		const one = await sandbox.remoteWithClone("one");
		const two = await sandbox.remoteWithClone("two", { "other.txt": "other\n" });
		const linked = sandbox.path("one-linked");
		await sandbox.git(one.clone, "worktree", "add", "-q", "--detach", linked);
		sandbox.write(join(one.clone, "x.txt"), "main checkout\n");
		sandbox.write(join(linked, "y.txt"), "linked checkout\n");
		const results = await Promise.all([one.clone, two.clone, linked].map((dir) => captureWorktreeSnapshot(dir)));
		const snapshots = results.map((result) => captured(result).snapshot);
		assert.deepEqual(
			snapshots.map((snapshot) => snapshot.root),
			[one.clone, two.clone, linked],
		);
		assert.equal(new Set(snapshots.map((snapshot) => snapshot.id)).size, 3);
		assert.deepEqual(await treePaths(one.clone, snapshots[0]!.tree), ["README.md", "x.txt"]);
		assert.deepEqual(await treePaths(linked, snapshots[2]!.tree), ["README.md", "y.txt"]);
		assert.equal(snapshots[2]!.branch, null);
	});

	test("a capture from a subdirectory records the checkout root", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "src/index.ts": "1\n" });
		const result = captured(await captureWorktreeSnapshot(join(clone, "src")));
		assert.equal(result.snapshot.root, clone);
	});

	test("aborting rejects with the signal's reason", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const controller = new AbortController();
		const reason = new Error("stop");
		controller.abort(reason);
		await assert.rejects(captureWorktreeSnapshot(clone, { signal: controller.signal }), (error) => error === reason);
	});

	test("the environment hash follows lockfile content, not location", async () => {
		const one = await sandbox.remoteWithClone("one", { "package-lock.json": "{}\n" });
		const two = await sandbox.remoteWithClone("two", { "package-lock.json": "{}\n" });
		const first = captured(await captureWorktreeSnapshot(one.clone)).snapshot;
		const second = captured(await captureWorktreeSnapshot(two.clone)).snapshot;
		assert.equal(first.envHash, second.envHash);
		sandbox.write(join(two.clone, "package-lock.json"), '{"lockfileVersion":3}\n');
		const changed = captured(await captureWorktreeSnapshot(two.clone)).snapshot;
		assert.notEqual(changed.envHash, first.envHash);
		rmSync(join(two.clone, "package-lock.json"));
		assert.notEqual(captured(await captureWorktreeSnapshot(two.clone)).snapshot.envHash, first.envHash);
	});
});
