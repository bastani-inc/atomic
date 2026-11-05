import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { runGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import {
	captureWorktreeSnapshot,
	findWorkspaceError,
	GitUnavailableError,
	gitInstallCommand,
	isGitUnavailableError,
	isWorkspaceConfigError,
	isWorkspaceDriftError,
	isWorkspaceError,
	isWorkspaceGitError,
	isWorkspaceRestoreError,
	isWorkspaceSnapshotError,
	MemorySnapshotBlobStore,
	rehydrateWorkspaceError,
	restoreWorktreeSnapshot,
	type SerializedWorkspaceError,
	serializeWorkspaceError,
	setWorktreeSnapshotGit,
	WorkspaceConfigError,
	WorkspaceDriftError,
	WorkspaceError,
	WorkspaceGitError,
	WorkspaceRestoreError,
	WorkspaceSnapshotError,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

const drift = () =>
	new WorkspaceDriftError({
		root: "/work/repo",
		expectedHead: "a".repeat(40),
		actualHead: "b".repeat(40),
		expectedTree: "c".repeat(40),
		actualTree: "d".repeat(40),
		snapshotId: "snap",
	});

describe("WorkspaceError rendering", () => {
	test("each class renders <what failed>: <subject> (<code>). <hint>", () => {
		const git = new GitUnavailableError("not-installed", "/opt/git/bin/git");
		const alternative = process.platform === "linux" ? " (or your distribution's package manager)" : "";
		const hint = `Install Git with \`${gitInstallCommand()}\`${alternative} or put it on PATH, then retry.`;
		assert.equal(
			git.message,
			`Git is unavailable: /opt/git/bin/git could not be started, and worktree snapshots need it to read and rebuild repository state (not-installed). ${hint}`,
		);
		assert.equal(git.hint, hint);
		assert.equal(gitInstallCommand("darwin"), "xcode-select --install");
		assert.equal(gitInstallCommand("win32"), "winget install --id Git.Git -e");
		assert.equal(gitInstallCommand("aix"), "install Git from https://git-scm.com/downloads");
		assert.equal(
			new WorkspaceConfigError("settings", "snapshots.fullEvery", "a positive integer").message,
			"Invalid worktree snapshot setting: snapshots.fullEvery from settings (invalid-setting). Set snapshots.fullEvery to a positive integer.",
		);
		assert.equal(
			new WorkspaceGitError({
				operation: "fetch",
				cwd: "/store",
				exitCode: 128,
				detail: "fatal: repository not found",
			}).message,
			"Git fetch failed in /store: fatal: repository not found (git-failed). Check that the repository is readable, its disk has free space, and no other Git process holds its lock, then retry.",
		);
		assert.equal(
			new WorkspaceSnapshotError("not-a-repository", "/tmp/x").message,
			"Worktree snapshot unavailable: /tmp/x is not inside a Git repository (not-a-repository). Work inside a Git checkout to record snapshots.",
		);
		assert.equal(
			new WorkspaceRestoreError("commits-unavailable", {
				snapshotId: "snap",
				head: "h",
				commits: ["c1", "c2"],
				paths: [".env"],
				remotes: ["https://example.com/r.git"],
				reason: "denied-history",
			}).message,
			"Cannot restore snapshot snap: commit h is not on https://example.com/r.git and its unpushed history touches denied paths .env (commits-unavailable). Push commit h (with its history) to a recorded remote, then retry. Commits c1, c2 add or change denied paths .env, so pushing publishes those files.",
		);
		assert.equal(
			drift().message,
			`Worktree drifted from its recorded snapshot: /work/repo has tree ${"d".repeat(40)} at ${"b".repeat(40)}, expected ${"c".repeat(40)} at ${"a".repeat(40)} (tree-drift). Restore the recorded snapshot into a new worktree, or undo the changes, then resume.`,
		);
	});

	test("the Git install hint is the platform's command, with the package-manager alternative only on Linux", () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform")!;
		const hintOn = (platform: NodeJS.Platform) => {
			Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value: platform });
			const error = new GitUnavailableError("not-installed", "git");
			assert.equal(error.platform, platform);
			return error.hint;
		};
		try {
			assert.equal(hintOn("darwin"), "Install Git with `xcode-select --install` or put it on PATH, then retry.");
			assert.equal(
				hintOn("linux"),
				"Install Git with `sudo apt-get install git` (or your distribution's package manager) or put it on PATH, then retry.",
			);
		} finally {
			Object.defineProperty(process, "platform", original);
		}
	});

	test("every error keeps hint and fields separately for UIs and logs", () => {
		const error = new WorkspaceRestoreError("unsafe-target", { snapshotId: null, target: "/x", reason: "not-empty" });
		assert.equal(error.name, "WorkspaceRestoreError");
		assert.equal(error.hint, "Choose a new or empty directory, or omit `into` to restore under Atomic home.");
		assert.deepEqual(error.fields, { snapshotId: null, target: "/x", reason: "not-empty" });
		assert.equal(error.retryable, false);
		assert.ok(Object.isFrozen(error.fields));
		assert.ok(error instanceof WorkspaceError);
	});
});

describe("WorkspaceError guards and chains", () => {
	test("guards accept instances and structurally equal values from another realm, and nothing else", () => {
		const structural = { name: "WorkspaceDriftError", code: "tree-drift", message: "x" };
		assert.equal(isWorkspaceDriftError(drift()), true);
		assert.equal(isWorkspaceDriftError(structural), true);
		assert.equal(isWorkspaceError(structural), true);
		assert.equal(isWorkspaceDriftError({ name: "WorkspaceDriftError", code: "unsafe-target" }), false);
		assert.equal(isWorkspaceRestoreError(structural), false);
		assert.equal(isWorkspaceError({ name: "Error", code: "tree-drift" }), false);
		assert.equal(isWorkspaceError(new Error("tree-drift")), false);
		assert.equal(isWorkspaceError(null), false);
		assert.equal(isWorkspaceError("WorkspaceError"), false);
		assert.equal(isGitUnavailableError(new GitUnavailableError("offline", "git")), true);
		assert.equal(isGitUnavailableError({ name: "GitUnavailableError", code: "checksum-mismatch" }), true);
		assert.equal(isGitUnavailableError({ name: "GitUnavailableError", code: "tree-drift" }), false);
		assert.equal(isWorkspaceError(new GitUnavailableError("not-installed", "git")), false);
		assert.equal(
			isWorkspaceGitError(new WorkspaceGitError({ operation: "x", cwd: "/", exitCode: 1, detail: "" })),
			true,
		);
		assert.equal(isWorkspaceSnapshotError(new WorkspaceSnapshotError("unborn-head", "/r")), true);
		assert.equal(isWorkspaceConfigError(new WorkspaceConfigError("sdk", "f", "x")), true);
	});

	test("findWorkspaceError walks at most eight causes", () => {
		const nest = (depth: number): Error => {
			let error: Error = drift();
			for (let level = 0; level < depth; level++) error = new Error(`wrapper ${level}`, { cause: error });
			return error;
		};
		assert.equal(findWorkspaceError(nest(7), isWorkspaceDriftError)?.code, "tree-drift");
		assert.equal(findWorkspaceError(nest(8), isWorkspaceDriftError), undefined);
		assert.equal(findWorkspaceError(nest(3))?.name, "WorkspaceDriftError");
		assert.equal(findWorkspaceError(new Error("plain")), undefined);
	});

	test("errors survive a JSON round trip across a process boundary with class, code, fields and causes", () => {
		const original = new WorkspaceDriftError(
			{ root: "/r", expectedHead: "h", actualHead: null, expectedTree: "t", actualTree: null, snapshotId: null },
			new WorkspaceRestoreError(
				"commits-unavailable",
				{ snapshotId: "s", head: "h", commits: ["c"], remotes: ["u"], reason: "not-fetched" },
				new WorkspaceGitError({ operation: "fetch", cwd: "/store", exitCode: 128, detail: "denied" }),
			),
		);
		const wire = JSON.parse(JSON.stringify(serializeWorkspaceError(original))) as SerializedWorkspaceError;
		const rehydrated = rehydrateWorkspaceError(wire);
		assert.ok(rehydrated instanceof WorkspaceDriftError);
		assert.deepEqual(rehydrated.fields, original.fields);
		assert.equal(rehydrated.message, original.message);
		const restore = rehydrated.cause;
		assert.ok(restore instanceof WorkspaceRestoreError);
		assert.equal(restore.code, "commits-unavailable");
		assert.deepEqual(restore.commits, ["c"]);
		assert.ok(restore.cause instanceof WorkspaceGitError);
		assert.equal(restore.cause.exitCode, 128);
		for (const error of [
			new GitUnavailableError("unsupported-platform", "git"),
			new WorkspaceConfigError("env", "F", "x"),
			new WorkspaceSnapshotError("blob-store-unsupported", "jsonl"),
		]) {
			const back = rehydrateWorkspaceError(serializeWorkspaceError(error));
			assert.equal(back.constructor, error.constructor);
			assert.deepEqual((back as WorkspaceError).fields, error.fields);
			assert.equal((back as WorkspaceError).code, error.code);
		}
	});

	test("an unknown workspace error name keeps its name and code in the family base; other errors stay plain", () => {
		const future = rehydrateWorkspaceError({
			name: "WorkspaceLeaseError",
			code: "lease-lost",
			message: "m",
			hint: "h",
		});
		assert.ok(future instanceof WorkspaceError);
		assert.equal(future.name, "WorkspaceLeaseError");
		assert.equal((future as WorkspaceError).code, "lease-lost");
		const plain = rehydrateWorkspaceError({ name: "TypeError", message: "boom" });
		assert.ok(!(plain instanceof WorkspaceError));
		assert.equal(plain.name, "TypeError");
	});
});

describe("fail-fast setup errors", () => {
	test("missing Git fails a restore after one executable lookup, before touching the target (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const result = await captureWorktreeSnapshot(clone, { blobs });
		assert.equal(result.status, "captured");
		let lookups = 0;
		setWorktreeSnapshotGit(async () => {
			lookups++;
			return { path: sandbox.path("missing-git"), env: {} };
		});
		await assert.rejects(
			restoreWorktreeSnapshot((result as { snapshot: WorktreeSnapshot }).snapshot, {
				blobs,
				storeDir: sandbox.path("host"),
				into: sandbox.path("target"),
			}),
			(error: unknown) => {
				assert.ok(error instanceof GitUnavailableError);
				assert.equal(error.code, "not-installed");
				assert.match(error.hint, /Install Git with `.+`/);
				return true;
			},
		);
		assert.equal(lookups, 1);
	});

	test("a missing blob fails a restore before any Git command (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const result = await captureWorktreeSnapshot(clone, { blobs: new MemorySnapshotBlobStore() });
		let lookups = 0;
		setWorktreeSnapshotGit(async () => {
			lookups++;
			return sandbox.executable;
		});
		await assert.rejects(
			restoreWorktreeSnapshot((result as { snapshot: WorktreeSnapshot }).snapshot, {
				blobs: new MemorySnapshotBlobStore(),
				storeDir: sandbox.path("host"),
			}),
			(error: unknown) =>
				isWorkspaceRestoreError(error) && error.code === "blob-missing" && /atomic --import/.test(error.hint),
		);
		assert.equal(lookups, 0);
	});

	test("an over-cap unpushed bundle fails a restore naming its commits until they are pushed", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "data.txt"), "content that does not compress away\n".repeat(30));
		const commit = await sandbox.commitAll(clone, "data");
		const blobs = new MemorySnapshotBlobStore();
		const result = await captureWorktreeSnapshot(clone, { blobs, settings: { maxSnapshotBytes: 64 } });
		await assert.rejects(
			restoreWorktreeSnapshot((result as { snapshot: WorktreeSnapshot }).snapshot, {
				blobs,
				storeDir: sandbox.path("host"),
			}),
			(error: unknown) => {
				assert.ok(isWorkspaceRestoreError(error));
				assert.equal(error.code, "commits-unavailable");
				assert.equal(error.reason, "bundle-over-cap");
				assert.deepEqual(error.commits, [commit]);
				assert.deepEqual(error.remotes, [sandbox.path("repo.git")]);
				return true;
			},
		);
	});

	test("a failing Git command is a typed git-failed error with credentials removed from its detail", async () => {
		await assert.rejects(
			runGit(["fetch", "https://user:secret-token@127.0.0.1:9/none.git"], { cwd: sandbox.root }),
			(error: unknown) => {
				assert.ok(error instanceof WorkspaceGitError);
				assert.equal(error.code, "git-failed");
				assert.equal(error.operation, "fetch");
				assert.equal(error.cwd, sandbox.root);
				assert.notEqual(error.exitCode, 0);
				assert.doesNotMatch(error.message, /secret-token/);
				return true;
			},
		);
	});
});
