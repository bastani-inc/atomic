import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	captureWorktreeSnapshot,
	GitUnavailableError,
	isWorkspaceDriftError,
	isWorkspaceRestoreError,
	isWorkspaceSnapshotError,
	MemorySnapshotBlobStore,
	removeRestoredWorktree,
	restoreWorktree,
	restoreWorktreeSnapshot,
	type SnapshotBlobStore,
	SqlSnapshotBlobStore,
	setWorktreeSnapshotGit,
	verifyWorktree,
	WorkspaceConfigError,
	WorkspaceDriftError,
	WorkspaceRestoreError,
	type WorktreeRestoreWarning,
	type WorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

async function capture(dir: string, blobs: SnapshotBlobStore, previous?: WorktreeSnapshot): Promise<WorktreeSnapshot> {
	const result: WorktreeSnapshotCapture = await captureWorktreeSnapshot(dir, { blobs, previous });
	assert.ok(result.status === "captured" || result.status === "unchanged");
	return result.snapshot;
}

function filesUnder(root: string): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.set(relative(root, path).split("\\").join("/"), readFileSync(path));
		}
	};
	walk(root);
	return files;
}

async function dirtyClone(name = "repo") {
	const { remote, clone } = await sandbox.remoteWithClone(name, {
		"a.txt": "one\n",
		"gone.txt": "bye\n",
		"bin/data.bin": new Uint8Array([0, 1, 2, 3]),
	});
	sandbox.write(join(clone, "feature.txt"), "unpushed\n");
	await sandbox.commitAll(clone, "unpushed work");
	sandbox.write(join(clone, "a.txt"), "staged\n");
	await sandbox.git(clone, "add", "a.txt");
	sandbox.write(join(clone, "a.txt"), "staged\nunstaged\n");
	sandbox.write(join(clone, "untracked", "u.txt"), "untracked\n");
	sandbox.write(join(clone, "bin", "data.bin"), new Uint8Array([9, 0, 255, 0, 7]));
	await sandbox.git(clone, "rm", "-q", "gone.txt");
	return { remote, clone };
}

describe("restoreWorktreeSnapshot", () => {
	test("rebuilds the captured tree from blobs and remotes alone, in a new worktree over a shared store (#4245)", async () => {
		const { clone } = await dirtyClone();
		const database = await openNodeSqliteDatabase(sandbox.path("machine-a.sqlite"));
		try {
			const blobs = await SqlSnapshotBlobStore.open(database);
			const snapshot = await capture(clone, blobs);
			assert.ok(snapshot.bundle, "the unpushed commit travels in a bundle");
			const restored = await restoreWorktree(snapshot, {
				blobs,
				storeDir: sandbox.path("machine-b"),
				into: sandbox.path("restored"),
			});
			assert.equal(restored.path, sandbox.path("restored"));
			assert.equal(await sandbox.git(restored.path, "rev-parse", "HEAD"), snapshot.head);
			assert.deepEqual(filesUnder(restored.path), filesUnder(clone));
			assert.deepEqual(restored.binding, {
				remotes: snapshot.remotes,
				head: snapshot.head,
				tree: snapshot.tree,
				envHash: snapshot.envHash,
			});
			assert.deepEqual(restored.warnings, []);
			assert.equal(
				resolve(await sandbox.git(restored.path, "rev-parse", "--git-common-dir")).startsWith(
					sandbox.path("machine-b", "repositories"),
				),
				true,
			);
			assert.deepEqual((await sandbox.git(restored.path, "status", "--porcelain")).split("\n").sort(), [
				" D gone.txt",
				" M a.txt",
				" M bin/data.bin",
				"?? untracked/",
			]);
		} finally {
			await database.close();
		}
	});

	test("rebuilds an incremental chain and keeps the tree warm for a binding", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		let snapshot: WorktreeSnapshot | undefined;
		for (const content of ["1\n", "2\n", "3\n"]) {
			sandbox.write(join(clone, "n.txt"), content);
			snapshot = await capture(clone, blobs, snapshot);
		}
		assert.equal(snapshot!.chain.length, 3);
		const storeDir = sandbox.path("host");
		const first = await restoreWorktreeSnapshot(snapshot!, { blobs, storeDir });
		assert.equal(readFileSync(join(first, "n.txt"), "utf8"), "3\n");
		const binding = {
			remotes: [...snapshot!.remotes],
			head: snapshot!.head,
			tree: snapshot!.tree,
			envHash: snapshot!.envHash,
		};
		const warm = await restoreWorktreeSnapshot(binding, { storeDir });
		assert.notEqual(warm, first);
		assert.equal(readFileSync(join(warm, "n.txt"), "utf8"), "3\n");
		const fromList = await restoreWorktreeSnapshot(binding, {
			blobs,
			snapshots: [snapshot!],
			storeDir: sandbox.path("cold-host"),
		});
		assert.equal(readFileSync(join(fromList, "n.txt"), "utf8"), "3\n");
	});

	test("a binding with no retained snapshot or warm tree fails with snapshot-not-found", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const head = await sandbox.git(clone, "rev-parse", "HEAD");
		const tree = "0".repeat(40);
		await assert.rejects(
			restoreWorktreeSnapshot(
				{ remotes: [sandbox.path("repo.git")], head, tree, envHash: "" },
				{
					storeDir: sandbox.path("host"),
				},
			),
			(error: unknown) => {
				assert.ok(error instanceof WorkspaceRestoreError);
				assert.equal(error.code, "snapshot-not-found");
				assert.equal(error.tree, tree);
				assert.equal(error.head, head);
				return true;
			},
		);
	});

	test("refuses a non-empty target before touching it", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const before = filesUnder(clone);
		for (const into of [clone, join(clone, "x.txt")]) {
			await assert.rejects(
				restoreWorktreeSnapshot(snapshot, { blobs, into, storeDir: sandbox.path("host") }),
				(error: unknown) => {
					assert.ok(isWorkspaceRestoreError(error));
					assert.equal(error.code, "unsafe-target");
					assert.equal(error.target, into);
					assert.equal(error.reason, "not-empty");
					return true;
				},
			);
		}
		assert.deepEqual(filesUnder(clone), before);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("missing and corrupt blobs fail before any Git work", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const patch = snapshot.chain[0]!.patch!;
		await assert.rejects(
			restoreWorktreeSnapshot(snapshot, { blobs: new MemorySnapshotBlobStore(), storeDir: sandbox.path("host") }),
			(error: unknown) =>
				isWorkspaceRestoreError(error) &&
				error.code === "blob-missing" &&
				error.blob === patch &&
				error.role === "patch" &&
				error.deltaIndex === 0 &&
				error.snapshotId === snapshot.id,
		);
		const corrupt: SnapshotBlobStore = {
			...blobs,
			getBlob: async () => new Uint8Array([1, 2, 3]),
			putBlobs: blobs.putBlobs,
			refreshBlobs: blobs.refreshBlobs,
			listBlobHashes: blobs.listBlobHashes,
		};
		await assert.rejects(
			restoreWorktreeSnapshot(snapshot, { blobs: corrupt, storeDir: sandbox.path("host") }),
			(error: unknown) => isWorkspaceRestoreError(error) && error.code === "blob-corrupt" && error.blob === patch,
		);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("names the delta that fails to reproduce its tree (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		sandbox.write(join(clone, "n.txt"), "1\n");
		const first = await capture(clone, blobs);
		sandbox.write(join(clone, "n.txt"), "2\n");
		const second = await capture(clone, blobs, first);
		const tampered: WorktreeSnapshot = {
			...second,
			chain: [second.chain[0]!, { ...second.chain[1]!, tree: "f".repeat(40) }],
			tree: "f".repeat(40),
		};
		const into = sandbox.path("restored");
		await assert.rejects(
			restoreWorktreeSnapshot(tampered, { blobs, into, storeDir: sandbox.path("host") }),
			(error: unknown) => {
				assert.ok(error instanceof WorkspaceRestoreError);
				assert.equal(error.code, "delta-failed");
				assert.equal(error.deltaIndex, 1);
				assert.equal(error.blob, second.chain[1]!.patch);
				assert.equal(error.expectedTree, "f".repeat(40));
				assert.equal(error.actualTree, second.tree);
				return true;
			},
		);
		const unappliable: WorktreeSnapshot = { ...second, chain: [second.chain[1]!] };
		await assert.rejects(
			restoreWorktreeSnapshot(unappliable, { blobs, into, storeDir: sandbox.path("host-2") }),
			(error: unknown) =>
				isWorkspaceRestoreError(error) &&
				error.code === "delta-failed" &&
				error.deltaIndex === 0 &&
				error.actualTree === null,
		);
		assert.equal(existsSync(into), false);
	});

	test("fails closed and removes the worktree when the materialized tree differs (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { ".gitattributes": "*.txt filter=mangle\n" });
		sandbox.write(join(clone, "note.txt"), "alpha\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		writeFileSync(
			sandbox.globalConfig,
			`${readFileSync(sandbox.globalConfig, "utf8")}[filter "mangle"]\n\tsmudge = sed s/alpha/omega/\n`,
		);
		const into = sandbox.path("restored");
		await assert.rejects(
			restoreWorktreeSnapshot(snapshot, { blobs, into, storeDir: sandbox.path("host") }),
			(error: unknown) => {
				assert.ok(error instanceof WorkspaceRestoreError);
				assert.equal(error.code, "tree-mismatch");
				assert.equal(error.target, into);
				assert.equal(error.expectedTree, snapshot.tree);
				assert.notEqual(error.actualTree, snapshot.tree);
				return true;
			},
		);
		assert.equal(existsSync(into), false);
	});

	test("unpushed history with denied paths fails closed naming its commits until they are pushed (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "server.pem"), "PRIVATE\n");
		const leaking = await sandbox.commitAll(clone, "pem");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const warnings: WorktreeRestoreWarning[] = [];
		await assert.rejects(
			restoreWorktreeSnapshot(snapshot, {
				blobs,
				storeDir: sandbox.path("host"),
				onWarning: (w) => warnings.push(w),
			}),
			(error: unknown) => {
				assert.ok(error instanceof WorkspaceRestoreError);
				assert.equal(error.code, "commits-unavailable");
				assert.equal(error.reason, "denied-history");
				assert.deepEqual(error.commits, [leaking]);
				assert.deepEqual(error.paths, ["server.pem"]);
				assert.equal(error.head, leaking);
				return true;
			},
		);
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		const path = await restoreWorktreeSnapshot(snapshot, {
			blobs,
			storeDir: sandbox.path("host"),
			onWarning: (w) => warnings.push(w),
		});
		assert.equal(readFileSync(join(path, "server.pem"), "utf8"), "PRIVATE\n");
		assert.deepEqual(warnings, [{ code: "omitted-content", omitted: snapshot.omitted }]);
	});

	test("the denied-history hint names the head to push: pushing only the denied commit is not enough (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "server.pem"), "PRIVATE\n");
		const leaking = await sandbox.commitAll(clone, "pem");
		sandbox.write(join(clone, "notes.txt"), "later\n");
		const head = await sandbox.commitAll(clone, "later");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const restore = () => restoreWorktreeSnapshot(snapshot, { blobs, storeDir: sandbox.path("host") });
		const failsNamingHead = (error: unknown) => {
			assert.ok(error instanceof WorkspaceRestoreError);
			assert.equal(error.reason, "denied-history");
			assert.equal(error.head, head);
			assert.deepEqual(error.commits, [leaking]);
			assert.equal(
				error.hint,
				`Push commit ${head} (with its history) to a recorded remote, then retry. Commits ${leaking} add or change denied paths server.pem, so pushing publishes those files.`,
			);
			return true;
		};
		await assert.rejects(restore(), failsNamingHead);
		await sandbox.git(clone, "push", "-q", "origin", `${leaking}:refs/heads/main`);
		await assert.rejects(restore(), failsNamingHead);
		await sandbox.git(clone, "push", "-q", "origin", `${head}:refs/heads/main`);
		const path = await restore();
		assert.equal(readFileSync(join(path, "notes.txt"), "utf8"), "later\n");
	});

	test("an unreachable remote reports the commit as not fetched with the Git failure as cause", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = { ...(await capture(clone, blobs)), remotes: [sandbox.path("nowhere.git")] };
		await assert.rejects(
			restoreWorktreeSnapshot(snapshot, { blobs, storeDir: sandbox.path("host") }),
			(error: unknown) => {
				assert.ok(error instanceof WorkspaceRestoreError);
				assert.equal(error.code, "commits-unavailable");
				assert.equal(error.reason, "not-fetched");
				assert.deepEqual(error.commits, [snapshot.head]);
				assert.equal((error.cause as { name?: string }).name, "WorkspaceGitError");
				return true;
			},
		);
	});

	test("source CRLF under core.autocrlf restores as Git content with LF files and a filters warning (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "one\ntwo\n" });
		await sandbox.git(clone, "config", "core.autocrlf", "true");
		sandbox.write(join(clone, "a.txt"), "one\r\ntwo\r\nthree\r\n");
		sandbox.write(join(clone, "b.txt"), "new\r\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		assert.equal(await sandbox.git(clone, "cat-file", "-p", `${snapshot.tree}:a.txt`), "one\ntwo\nthree");
		writeFileSync(sandbox.globalConfig, `${readFileSync(sandbox.globalConfig, "utf8")}[core]\n\tautocrlf = true\n`);
		const warnings: WorktreeRestoreWarning[] = [];
		const restored = await restoreWorktree(snapshot, {
			blobs,
			storeDir: sandbox.path("host"),
			onWarning: (warning) => warnings.push(warning),
		});
		assert.equal(readFileSync(join(restored.path, "a.txt"), "utf8"), "one\ntwo\nthree\n");
		assert.equal(readFileSync(join(restored.path, "b.txt"), "utf8"), "new\n");
		assert.equal(restored.binding.tree, snapshot.tree);
		assert.deepEqual(warnings, [{ code: "filters", filters: { autocrlf: "true", eol: null, drivers: [] } }]);
		assert.deepEqual(restored.warnings, warnings);
	});

	test("reports Git as unavailable instead of a spawn error", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
		await assert.rejects(
			restoreWorktreeSnapshot(snapshot, { blobs, storeDir: sandbox.path("host") }),
			(error: unknown) =>
				error instanceof GitUnavailableError && error.fields.systemGit?.path === sandbox.path("no-git"),
		);
		await assert.rejects(verifyWorktree(snapshot, clone), (error: unknown) => error instanceof GitUnavailableError);
	});

	test("rejects malformed targets and options before any side effect", async () => {
		await assert.rejects(
			restoreWorktreeSnapshot({ head: "x" } as never, { storeDir: sandbox.path("host") }),
			(error: unknown) =>
				error instanceof WorkspaceConfigError && error.field === "target" && error.source === "sdk",
		);
		await assert.rejects(
			restoreWorktreeSnapshot(
				{ remotes: [], head: "x", tree: "y", envHash: "" },
				{ into: "", storeDir: sandbox.path("host") },
			),
			(error: unknown) => error instanceof WorkspaceConfigError && error.field === "into",
		);
		assert.equal(existsSync(sandbox.path("host")), false);
	});
});

describe("verifyWorktree", () => {
	test("resolves with the current binding when HEAD and tree match, and fails with typed drift otherwise", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "package-lock.json": "{}\n" });
		sandbox.write(join(clone, "x.txt"), "x\n");
		const snapshot = await capture(clone, new MemorySnapshotBlobStore());
		const binding = {
			remotes: [...snapshot.remotes],
			head: snapshot.head,
			tree: snapshot.tree,
			envHash: snapshot.envHash,
		};
		assert.deepEqual(await verifyWorktree(binding, clone), binding);
		sandbox.write(join(clone, ".env"), "ignored secret\n");
		assert.deepEqual(await verifyWorktree(binding, clone), binding);
		sandbox.write(join(clone, "x.txt"), "drift\n");
		await assert.rejects(verifyWorktree(snapshot, clone), (error: unknown) => {
			assert.ok(error instanceof WorkspaceDriftError);
			assert.ok(isWorkspaceDriftError(error));
			assert.equal(error.code, "tree-drift");
			assert.equal(error.root, clone);
			assert.equal(error.expectedTree, snapshot.tree);
			assert.equal(error.expectedHead, snapshot.head);
			assert.equal(error.actualHead, snapshot.head);
			assert.notEqual(error.actualTree, snapshot.tree);
			assert.equal(error.snapshotId, snapshot.id);
			return true;
		});
	});

	test("reports a missing repository with its typed reason", async () => {
		mkdirSync(sandbox.path("plain"));
		await assert.rejects(
			verifyWorktree(
				{ remotes: [], head: "a".repeat(40), tree: "b".repeat(40), envHash: "" },
				sandbox.path("plain"),
			),
			(error: unknown) => isWorkspaceSnapshotError(error) && error.code === "not-a-repository",
		);
	});
});

describe("removeRestoredWorktree", () => {
	test("removes a worktree a restore created and refuses anything else", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const storeDir = sandbox.path("host");
		const restored = await restoreWorktreeSnapshot(snapshot, { blobs, storeDir });
		for (const path of [clone, join(clone, "missing-dir-parent"), sandbox.root]) {
			mkdirSync(path, { recursive: true });
			await assert.rejects(removeRestoredWorktree(path, { storeDir }), (error: unknown) => {
				assert.ok(isWorkspaceRestoreError(error));
				assert.equal(error.code, "unsafe-target");
				assert.equal(error.reason, "not-restored");
				assert.equal(error.target, path);
				return true;
			});
		}
		assert.ok(existsSync(join(clone, "x.txt")));
		await removeRestoredWorktree(restored, { storeDir });
		assert.equal(existsSync(restored), false);
		await removeRestoredWorktree(restored, { storeDir });
		const again = await restoreWorktreeSnapshot(snapshot, { blobs, storeDir, into: restored });
		assert.equal(again, restored);
	});
});
