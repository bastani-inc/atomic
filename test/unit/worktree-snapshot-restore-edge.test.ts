import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { SpawnRequest } from "../helpers/worktree-snapshot-faults.js";

/** The `git lfs` commands a restore starts once a test calls {@link fakeLfs}, each answered with that exit status. */
const lfs = vi.hoisted(() => ({ status: undefined as number | undefined, commands: [] as SpawnRequest[] }));

vi.mock("node:child_process", async (importOriginal) => {
	const { failingCommand, gitCommand, withSpawnFaults } = await import("../helpers/worktree-snapshot-faults.js");
	return withSpawnFaults(await importOriginal(), (request) => {
		if (lfs.status === undefined || gitCommand(request.args)[0] !== "lfs") return undefined;
		lfs.commands.push(request);
		return failingCommand(lfs.status);
	});
});

import {
	captureWorktreeSnapshot,
	isGitUnavailableError,
	isWorkspaceConfigError,
	isWorkspaceDriftError,
	isWorkspaceRestoreError,
	MemorySnapshotBlobStore,
	removeRestoredWorktree,
	restoreWorktree,
	restoreWorktreeSnapshot,
	setWorktreeSnapshotGit,
	verifyWorktree,
	type WorkspaceBinding,
	type WorktreeRestoreWarning,
	type WorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/index.ts";
import { GitSandbox, gitConfigPath, lfsPointer, loseSnapshotBlobs } from "../helpers/worktree-snapshot.js";
import { gitCommand } from "../helpers/worktree-snapshot-faults.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	lfs.status = undefined;
	lfs.commands.length = 0;
	sandbox.dispose();
});

function snapshotOf(result: WorktreeSnapshotCapture): WorktreeSnapshot {
	assert.equal(result.status, "captured");
	return (result as Extract<WorktreeSnapshotCapture, { status: "captured" }>).snapshot;
}

async function capture(dir: string, blobs: MemorySnapshotBlobStore): Promise<WorktreeSnapshot> {
	return snapshotOf(await captureWorktreeSnapshot(dir, { blobs }));
}

const bindingOf = (snapshot: WorktreeSnapshot): WorkspaceBinding => ({
	remotes: [...snapshot.remotes],
	head: snapshot.head,
	tree: snapshot.tree,
	envHash: snapshot.envHash,
});

function appendGlobalConfig(text: string): void {
	writeFileSync(sandbox.globalConfig, `${readFileSync(sandbox.globalConfig, "utf8")}${text}`);
}

/** Answers every `git lfs` command from here on with `status`, recording its arguments and working directory. */
function fakeLfs(status: number): void {
	lfs.status = status;
	lfs.commands.length = 0;
}

/** The `git lfs` commands since {@link fakeLfs}, each as its arguments and working directory. */
const lfsCalls = (): string[] =>
	lfs.commands.map((request) => `${gitCommand(request.args).slice(1).join(" ")}|${request.cwd}`);

describe("restore input validation", () => {
	test("a target without the four binding fields is rejected before any Git work", async () => {
		let lookups = 0;
		setWorktreeSnapshotGit(async () => {
			lookups++;
			return sandbox.executable;
		});
		const good = { remotes: ["r"], head: "h", tree: "t", envHash: "e" };
		const bad: unknown[] = [
			undefined,
			null,
			"binding",
			5,
			{ ...good, remotes: "r" },
			{ ...good, remotes: undefined },
			{ ...good, remotes: ["r", 5] },
			{ ...good, head: 5 },
			{ ...good, tree: undefined },
			{ ...good, envHash: null },
		];
		for (const target of bad) {
			await assert.rejects(
				restoreWorktree(target as never, { storeDir: sandbox.path("host") }),
				(error: unknown) => {
					assert.ok(isWorkspaceConfigError(error));
					assert.deepEqual(error.fields, {
						source: "sdk",
						field: "target",
						expected: "a WorkspaceBinding or a WorktreeSnapshot",
					});
					return true;
				},
			);
			await assert.rejects(verifyWorktree(target as never, sandbox.root), (error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.deepEqual(error.fields, { source: "sdk", field: "binding", expected: "a WorkspaceBinding" });
				return true;
			});
		}
		assert.equal(lookups, 0);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("a bad destination, directory or setting is rejected before any Git work", async () => {
		let lookups = 0;
		setWorktreeSnapshotGit(async () => {
			lookups++;
			return sandbox.executable;
		});
		const binding = { remotes: ["r"], head: "h", tree: "t", envHash: "e" };
		for (const into of ["", 5]) {
			await assert.rejects(restoreWorktree(binding, { into: into as never }), (error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.deepEqual(error.fields, { source: "sdk", field: "into", expected: "a directory path" });
				return true;
			});
		}
		for (const dir of ["", 5, undefined]) {
			await assert.rejects(verifyWorktree(binding, dir as never), (error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.deepEqual(error.fields, { source: "sdk", field: "dir", expected: "a directory path" });
				return true;
			});
		}
		await assert.rejects(
			verifyWorktree(binding, sandbox.root, { settings: { enabled: "yes" as never } }),
			(error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.deepEqual(error.fields, { source: "sdk", field: "settings.enabled", expected: "true or false" });
				return true;
			},
		);
		assert.equal(lookups, 0);
	});

	test("an object that is not a complete snapshot is treated as a binding and needs a recorded snapshot", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const storeDir = sandbox.path("host");
		const incomplete = [
			{ ...snapshot, version: 2 },
			{ ...snapshot, chain: undefined },
			{ ...snapshot, id: 5 },
		];
		for (const target of incomplete) {
			await assert.rejects(
				restoreWorktreeSnapshot(target as never, { blobs, storeDir }),
				(error: unknown) => isWorkspaceRestoreError(error) && error.code === "snapshot-not-found",
			);
		}
		assert.ok(await restoreWorktreeSnapshot(snapshot, { blobs, storeDir }));
	});
});

describe("choosing the snapshot a binding names", () => {
	test("the last snapshot with the binding's head and tree wins; others, or none, do not match", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const base = await capture(clone, blobs);
		const older = { ...base, id: "01d" };
		const newer = { ...base, id: "02e" };
		const sameTreeOtherHead = { ...base, id: "0dec1", head: "9".repeat(40) };
		const sameHeadOtherTree = { ...base, id: "0dec2", tree: "8".repeat(40) };
		const restored = await restoreWorktree(bindingOf(base), {
			blobs,
			storeDir: sandbox.path("host"),
			snapshots: [older, newer, sameTreeOtherHead, sameHeadOtherTree],
		});
		assert.equal(restored.snapshot?.id, "02e");
		assert.deepEqual(restored.binding, bindingOf(base));
		assert.equal(readFileSync(join(restored.path, "x.txt"), "utf8"), "x\n");
		await assert.rejects(
			restoreWorktree(bindingOf(base), { blobs, storeDir: sandbox.path("host-cold"), snapshots: [] }),
			(error: unknown) => isWorkspaceRestoreError(error) && error.code === "snapshot-not-found",
		);
		await assert.rejects(
			restoreWorktree(bindingOf(base), {
				blobs,
				storeDir: sandbox.path("host-cold"),
				snapshots: [sameTreeOtherHead, sameHeadOtherTree],
			}),
			(error: unknown) => isWorkspaceRestoreError(error) && error.code === "snapshot-not-found",
		);
	});

	test("without a snapshot the head must already be in the shared store, and only a warm tree can be restored", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const missingTree = { ...bindingOf(snapshot), tree: "7".repeat(40) };
		await assert.rejects(restoreWorktree(missingTree, { storeDir: sandbox.path("host") }), (error: unknown) => {
			assert.ok(isWorkspaceRestoreError(error));
			assert.equal(error.code, "snapshot-not-found");
			assert.equal(error.tree, "7".repeat(40));
			assert.equal(error.snapshotId, null);
			return true;
		});
		const warm = await restoreWorktree(bindingOf(snapshot), { storeDir: sandbox.path("host") });
		assert.equal(warm.snapshot, null);
		assert.deepEqual(warm.warnings, []);
	});
});

describe("restoring a chain", () => {
	test("a link without a patch changes nothing and a chain of links is applied in order", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		sandbox.write(join(clone, "x.txt"), "1\n");
		const first = await capture(clone, blobs);
		const forged: WorktreeSnapshot = {
			...first,
			id: "f0a1",
			chain: [...first.chain, { tree: first.tree, patch: null, bytes: 0 }],
		};
		const restored = await restoreWorktree(forged, { blobs, storeDir: sandbox.path("host") });
		assert.equal(readFileSync(join(restored.path, "x.txt"), "utf8"), "1\n");
	});

	test("a link without a patch that does not reproduce its tree is named without a blob", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const wrong = "6".repeat(40);
		const forged: WorktreeSnapshot = {
			...snapshot,
			id: "f0a2",
			tree: wrong,
			chain: [{ tree: wrong, patch: null, bytes: 0 }],
		};
		await assert.rejects(restoreWorktree(forged, { blobs, storeDir: sandbox.path("host") }), (error: unknown) => {
			assert.ok(isWorkspaceRestoreError(error));
			assert.equal(error.code, "delta-failed");
			assert.equal(error.deltaIndex, 0);
			assert.equal(error.expectedTree, wrong);
			assert.equal(error.actualTree, snapshot.tree);
			assert.equal(Object.hasOwn(error.fields, "blob"), false);
			assert.equal(Object.hasOwn(error, "cause"), false);
			assert.match(error.message, /\(patch none\)/);
			return true;
		});
	});

	test("the head is kept reachable in the shared store after a restore", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const restored = await restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") });
		const store = await sandbox.git(restored.path, "rev-parse", "--git-common-dir");
		assert.equal(await sandbox.git(store, "rev-parse", `refs/atomic/heads/${snapshot.head}`), snapshot.head);
	});
});

describe("finding the head", () => {
	test("remotes are tried in order, a failing one is skipped, and later ones are not touched once the head is present", async () => {
		const { remote, clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const bogus = sandbox.path("bogus.git");
		const viaSecond = await restoreWorktree(
			{ ...snapshot, remotes: [bogus, remote] },
			{ blobs, storeDir: sandbox.path("host-1") },
		);
		assert.equal(await sandbox.git(viaSecond.path, "rev-parse", "HEAD"), snapshot.head);
		const viaFirst = await restoreWorktree(
			{ ...snapshot, remotes: [remote, bogus] },
			{ blobs, storeDir: sandbox.path("host-2") },
		);
		assert.equal(await sandbox.git(viaFirst.path, "rev-parse", "HEAD"), snapshot.head);
	});

	test("when no remote can supply the head the failure of the last one is the cause", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const first = sandbox.path("first-missing.git");
		const last = sandbox.path("last-missing.git");
		await assert.rejects(
			restoreWorktree({ ...snapshot, remotes: [first, last] }, { blobs, storeDir: sandbox.path("host") }),
			(error: unknown) => {
				assert.ok(isWorkspaceRestoreError(error));
				assert.equal(error.code, "commits-unavailable");
				assert.deepEqual(error.remotes, [first, last]);
				assert.match((error.cause as Error).message, /last-missing/);
				assert.doesNotMatch((error.cause as Error).message, /first-missing/);
				return true;
			},
		);
	});

	test("a bundle without a blank line still has its prerequisites fetched before it fails to unpack", async () => {
		const { remote, clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "feature.txt"), "feature\n");
		await sandbox.commitAll(clone, "unpushed");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		assert.ok(snapshot.bundle);
		const pushedBase = await sandbox.git(clone, "rev-parse", "origin/main");
		const forgedBytes = new TextEncoder().encode(`# v2 git bundle\n-${pushedBase} initial`);
		const { snapshotBlob } = await import("../../packages/coding-agent/src/index.ts");
		const forgedBlob = snapshotBlob(forgedBytes);
		await blobs.putBlobs([forgedBlob]);
		const forged: WorktreeSnapshot = {
			...snapshot,
			remotes: [remote],
			bundle: { blob: forgedBlob.hash, bytes: forgedBytes.byteLength, commits: snapshot.bundle.commits },
		};
		const storeDir = sandbox.path("host");
		await assert.rejects(
			restoreWorktree(forged, { blobs, storeDir }),
			(error: unknown) => isWorkspaceRestoreError(error) && error.code === "commits-unavailable",
		);
		const store = join(storeDir, "repositories", readdirSync(join(storeDir, "repositories"))[0]!);
		assert.equal(await sandbox.git(sandbox.root, "--git-dir", store, "cat-file", "-t", pushedBase), "commit");
	});

	test("a missing bundle blob is reported before anything is fetched", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "feature.txt"), "feature\n");
		await sandbox.commitAll(clone, "unpushed");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		assert.ok(snapshot.bundle);
		await loseSnapshotBlobs(blobs, [snapshot.bundle.blob]);
		await assert.rejects(restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") }), (error: unknown) => {
			assert.ok(isWorkspaceRestoreError(error));
			assert.equal(error.code, "blob-missing");
			assert.equal(error.role, "bundle");
			assert.equal(error.blob, snapshot.bundle?.blob);
			return true;
		});
	});

	test("an aborted signal stops the restore with its reason before a store is created", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const controller = new AbortController();
		const reason = new Error("stop now");
		controller.abort(reason);
		const storeDir = sandbox.path("host");
		await assert.rejects(
			restoreWorktree(snapshot, { blobs, storeDir, signal: controller.signal }),
			(error: unknown) => error === reason,
		);
		assert.equal(existsSync(storeDir), false);
	});
});

describe("materializing under the host's configuration", () => {
	test("a host that converts line endings and refuses irreversible conversions still restores mixed-ending content as stored", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "mixed.txt": "one\r\ntwo\nthree\r\n" });
		sandbox.write(join(clone, "extra.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		appendGlobalConfig("[core]\n\tautocrlf = true\n\tsafecrlf = true\n");
		const restored = await restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") });
		assert.equal(readFileSync(join(restored.path, "mixed.txt"), "utf8"), "one\r\ntwo\nthree\r\n");
		assert.equal(restored.binding.tree, snapshot.tree);
	});

	test("checkout filters are told to skip LFS smudging so the worktree holds pointers", async () => {
		const marker = join(sandbox.root, "smudge-env");
		const script = join(sandbox.root, "smudge.sh");
		writeFileSync(script, `#!/bin/sh\nprintf '%s' "$GIT_LFS_SKIP_SMUDGE" > '${marker}'\ncat\n`);
		chmodSync(script, 0o755);
		appendGlobalConfig(`[filter "lfs"]\n\tclean = cat\n\tsmudge = ${gitConfigPath(script)}\n`);
		const { clone } = await sandbox.remoteWithClone("repo", {
			".gitattributes": "*.bin filter=lfs\n",
			"data.bin": "pointer-ish\n",
		});
		const blobs = new MemorySnapshotBlobStore();
		sandbox.write(join(clone, "data.bin"), "edited\n");
		const snapshot = await capture(clone, blobs);
		fakeLfs(0);
		await restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") });
		assert.equal(readFileSync(marker, "utf8"), "1");
	});
});

describe("Git LFS content on restore", () => {
	async function lfsSnapshot() {
		const { clone } = await sandbox.remoteWithClone("repo", {
			".gitattributes": "*.bin filter=lfs -text\n",
			"data.bin": lfsPointer("base\n"),
			"docs/readme.md": "docs\n",
			"docs/big.bin": lfsPointer("big base\n"),
			"notes.txt": "notes\n",
		});
		sandbox.write(join(clone, "data.bin"), lfsPointer("edited\n"));
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		assert.deepEqual(snapshot.filters?.drivers, ["lfs"]);
		return { clone, blobs, snapshot };
	}

	test("objects that cannot be fetched are reported with the pointer files, before the other notices", async () => {
		const { blobs, snapshot } = await lfsSnapshot();
		fakeLfs(1);
		const warnings: WorktreeRestoreWarning[] = [];
		const restored = await restoreWorktree(snapshot, {
			blobs,
			storeDir: sandbox.path("host"),
			onWarning: (warning) => warnings.push(warning),
		});
		assert.deepEqual(warnings, [
			{ code: "lfs-objects-unavailable", paths: ["data.bin", "docs/big.bin"] },
			{ code: "filters", filters: { autocrlf: null, eol: null, drivers: ["lfs"] } },
		]);
		assert.deepEqual(restored.warnings, warnings);
		assert.match(lfsCalls().join("\n"), /^pull -- file:\/\/\S+\|[^\n]+$/);
	});

	test("a snapshot whose repository never used LFS never runs it", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "data.bin": "x\n" });
		sandbox.write(join(clone, "extra.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		fakeLfs(1);
		await restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") });
		assert.deepEqual(lfsCalls(), []);
	});
});

describe("verifyWorktree", () => {
	test("returns exactly the four binding fields of the current checkout", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "package-lock.json": "{}\n" });
		sandbox.write(join(clone, "x.txt"), "x\n");
		const snapshot = await capture(clone, new MemorySnapshotBlobStore());
		const verified = await verifyWorktree(snapshot, clone);
		assert.deepEqual(Object.keys(verified).sort(), ["envHash", "head", "remotes", "tree"]);
		assert.deepEqual(verified, bindingOf(snapshot));
	});

	test("a moved HEAD with an identical tree is drift, naming both heads and no snapshot for a plain binding", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const snapshot = await capture(clone, new MemorySnapshotBlobStore());
		const moved = await sandbox.commitAll(clone, "commit the edit");
		await assert.rejects(verifyWorktree(bindingOf(snapshot), clone), (error: unknown) => {
			assert.ok(isWorkspaceDriftError(error));
			assert.equal(error.actualTree, snapshot.tree);
			assert.equal(error.expectedTree, snapshot.tree);
			assert.equal(error.expectedHead, snapshot.head);
			assert.equal(error.actualHead, moved);
			assert.equal(error.snapshotId, null);
			assert.equal(error.root, clone);
			return true;
		});
	});

	test("an identical HEAD with a different tree is drift too, and a missing repository or Git has its own reason", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const snapshot = await capture(clone, new MemorySnapshotBlobStore());
		sandbox.write(join(clone, "x.txt"), "x\n");
		await assert.rejects(
			verifyWorktree(bindingOf(snapshot), clone),
			(error: unknown) => isWorkspaceDriftError(error) && error.actualHead === snapshot.head,
		);
		mkdirSync(sandbox.path("plain"));
		await assert.rejects(
			verifyWorktree(bindingOf(snapshot), sandbox.path("plain")),
			(error: unknown) => (error as { code?: string }).code === "not-a-repository",
		);
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
		await assert.rejects(verifyWorktree(bindingOf(snapshot), clone), isGitUnavailableError);
	});

	test("a settings override that excludes untracked files is honoured when comparing", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = snapshotOf(
			await captureWorktreeSnapshot(clone, { blobs, settings: { includeUntracked: false } }),
		);
		sandbox.write(join(clone, "untracked.txt"), "x\n");
		await assert.rejects(verifyWorktree(bindingOf(snapshot), clone), isWorkspaceDriftError);
		assert.deepEqual(
			await verifyWorktree(bindingOf(snapshot), clone, { settings: { includeUntracked: false } }),
			bindingOf(snapshot),
		);
	});
});

describe("removeRestoredWorktree guards", () => {
	test("refuses the shared store itself, anything inside it, its parent and a missing git directory", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const storeDir = sandbox.path("host");
		const restored = await restoreWorktree(snapshot, { blobs, storeDir });
		const store = await sandbox.git(restored.path, "rev-parse", "--git-common-dir");
		const outside = mkdtempSync(join(sandbox.root, "outside-"));
		for (const path of [store, join(store, "objects"), join(storeDir, "repositories"), outside]) {
			await assert.rejects(removeRestoredWorktree(path, { storeDir }), (error: unknown) => {
				assert.ok(isWorkspaceRestoreError(error));
				assert.equal(error.code, "unsafe-target");
				assert.equal(error.reason, "not-restored");
				return true;
			});
		}
		assert.ok(existsSync(join(store, "HEAD")), "the shared store is intact");
		assert.ok(existsSync(restored.path));
		await removeRestoredWorktree(restored.path, { storeDir });
		assert.equal(existsSync(restored.path), false);
		assert.ok(existsSync(join(store, "HEAD")), "the store outlives its worktrees");
	});

	test("a worktree of a store under another storeDir is not ours to remove", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const restored = await restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host-a") });
		await assert.rejects(
			removeRestoredWorktree(restored.path, { storeDir: sandbox.path("host-b") }),
			(error: unknown) => isWorkspaceRestoreError(error) && error.code === "unsafe-target",
		);
		assert.ok(existsSync(restored.path));
	});
});
