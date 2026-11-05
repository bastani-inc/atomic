import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { captureWorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import { nulFields, redactUrlCredentials, runGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import { loadSnapshotPathPolicy } from "../../packages/coding-agent/src/core/worktree-snapshot/policy.ts";
import {
	collectSnapshotGarbage,
	computeEnvironmentHash,
	isGitUnavailableError,
	isWorkspaceConfigError,
	isWorkspaceGitError,
	MemorySnapshotBlobStore,
	setWorktreeSnapshotGit,
	snapshotBlob,
	snapshotBlobHashes,
	type WorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

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

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

describe("which directories can be captured", () => {
	test("a file, a path below a file and a missing path are not repositories, each with its own cause", async () => {
		const file = sandbox.path("plain-file");
		writeFileSync(file, "x");
		const onFile = await captureWorktreeSnapshot(file);
		assert.equal(onFile.status, "unavailable");
		assert.equal(onFile.status === "unavailable" && onFile.reason.code, "not-a-repository");
		assert.equal(onFile.status === "unavailable" && onFile.reason.fields.subject, file);
		assert.equal(onFile.status === "unavailable" && Object.hasOwn(onFile.reason, "cause"), false);

		const below = await captureWorktreeSnapshot(join(file, "child"));
		assert.equal(below.status === "unavailable" && below.reason.code, "not-a-repository");
		assert.equal(below.status === "unavailable" && (below.reason.cause as NodeJS.ErrnoException).code, "ENOTDIR");

		const missing = await captureWorktreeSnapshot(sandbox.path("absent"));
		assert.equal(missing.status === "unavailable" && (missing.reason.cause as NodeJS.ErrnoException).code, "ENOENT");
	});

	test("an argument that is not a path fails with a config error naming it, before any Git command", async () => {
		for (const dir of [5, undefined, null, ""]) {
			await assert.rejects(captureWorktreeSnapshot(dir as never), (error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.deepEqual(error.fields, { source: "sdk", field: "dir", expected: "a directory path" });
				return true;
			});
		}
	});

	test("a checkout whose directory name contains a newline keeps its whole root", async () => {
		const parent = mkdtempSync(join(sandbox.root, "nl-"));
		const root = join(parent, "line one\nline two");
		mkdirSync(root);
		await sandbox.git(root, "init", "-q");
		writeFileSync(join(root, "a.txt"), "a\n");
		await sandbox.git(root, "add", "-A");
		await sandbox.git(root, "commit", "-q", "-m", "init");
		writeFileSync(join(root, "b.txt"), "b\n");
		const result = captured(await captureWorktreeSnapshot(root));
		assert.equal(result.snapshot.root, root);
		assert.equal(await sandbox.git(root, "cat-file", "-p", `${result.snapshot.tree}:b.txt`), "b");
	});

	test("a clone made without a checkout has no index yet and snapshots as an empty working tree", async () => {
		const { remote } = await sandbox.remoteWithClone();
		const bare = sandbox.path("no-checkout");
		await sandbox.git(sandbox.root, "clone", "-q", "--no-checkout", remote, bare);
		const result = captured(await captureWorktreeSnapshot(bare));
		assert.equal(result.snapshot.tree, EMPTY_TREE);
		assert.equal(result.snapshot.head, await sandbox.git(bare, "rev-parse", "HEAD"));
	});

	test("an index that cannot be read is an error, not a silently empty snapshot", async () => {
		const { clone } = await sandbox.remoteWithClone();
		unlinkSync(join(clone, ".git", "index"));
		mkdirSync(join(clone, ".git", "index"));
		await assert.rejects(
			captureWorktreeSnapshot(clone),
			(error: unknown) => (error as NodeJS.ErrnoException).code === "EISDIR",
		);
	});
});

describe("an edit Git's own stat cache cannot tell from the committed file", () => {
	test("a same-size edit with the original timestamp, made in the instant the index was written, is still captured", async () => {
		sandbox.dispose();
		sandbox = new GitSandbox("[core]\n\ttrustctime = false\n\tcheckStat = minimal\n");
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "one\n" });
		const instant = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
		utimesSync(join(clone, "a.txt"), instant, instant);
		await sandbox.git(clone, "update-index", "--refresh");
		writeFileSync(join(clone, "a.txt"), "two\n");
		utimesSync(join(clone, "a.txt"), instant, instant);
		utimesSync(join(clone, ".git", "index"), instant, instant);
		assert.equal(await sandbox.git(clone, "status", "--porcelain"), " M a.txt");
		const result = captured(await captureWorktreeSnapshot(clone));
		assert.equal(await sandbox.git(clone, "cat-file", "-p", `${result.snapshot.tree}:a.txt`), "two");
		assert.notEqual(result.snapshot.tree, await sandbox.git(clone, "rev-parse", "HEAD^{tree}"));
	});
});

describe.skipIf(process.platform === "win32")("the Git runner", () => {
	test("an executable that exists but cannot be run is unavailable Git, not a failed command", async () => {
		const file = sandbox.path("not-executable");
		writeFileSync(file, "#!/bin/sh\n");
		chmodSync(file, 0o644);
		setWorktreeSnapshotGit(async () => ({ path: file, env: {} }));
		await assert.rejects(runGit(["status"], { cwd: sandbox.root }), (error: unknown) => {
			assert.ok(isGitUnavailableError(error));
			assert.equal(error.code, "not-installed");
			assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
			return true;
		});
	});

	test("an aborted signal kills a running command and rejects with the signal's reason", async () => {
		const controller = new AbortController();
		const reason = new Error("stop waiting");
		setTimeout(() => controller.abort(reason), 100);
		await assert.rejects(
			runGit(["-c", "alias.pause=!sleep 30", "pause"], { cwd: sandbox.root, signal: controller.signal }),
			(error: unknown) => error === reason,
		);
	});

	test("a failing command is a typed Git error with its first output line, credentials removed, and exit codes that are results pass", async () => {
		await assert.rejects(
			runGit(["rev-parse", "--verify", "no-such-ref"], { cwd: sandbox.root }),
			(error: unknown) => {
				assert.ok(isWorkspaceGitError(error));
				assert.equal(error.fields.operation, "rev-parse");
				assert.equal(error.fields.cwd, sandbox.root);
				assert.equal(typeof error.fields.exitCode, "number");
				return true;
			},
		);
		const result = await runGit(["rev-parse", "--verify", "no-such-ref"], {
			cwd: sandbox.root,
			allowExitCodes: [128],
		});
		assert.equal(result.exitCode, 128);
		assert.equal(
			redactUrlCredentials("fetch https://user:tok@host/x.git and ssh://u@h/y"),
			"fetch https://host/x.git and ssh://h/y",
		);
		assert.deepEqual(nulFields("a\0b\0"), ["a", "b"]);
		assert.deepEqual(nulFields(Buffer.from("a\0\0")), ["a", ""]);
		assert.deepEqual(nulFields(""), []);
	});

	test("the first line of a long or multi-line Git error is all a failure keeps, at most 300 characters", async () => {
		const longName = "x".repeat(400);
		await assert.rejects(
			runGit(["config", "--file", sandbox.path("missing.cfg"), "--get", `${longName}.y`], { cwd: sandbox.root }),
			(error: unknown) => {
				assert.ok(isWorkspaceGitError(error));
				assert.ok(error.fields.detail !== undefined);
				assert.ok(String(error.fields.detail).length <= 300);
				assert.equal(String(error.fields.detail).includes("\n"), false);
				return true;
			},
		);
	});
});

describe("size caps and omission order", () => {
	test("a file of exactly maxFileBytes is captured and one byte more is omitted with its size", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "exact.txt"), "x".repeat(10));
		sandbox.write(join(clone, "over.txt"), "y".repeat(11));
		const result = captured(await captureWorktreeSnapshot(clone, { settings: { maxFileBytes: 10 } }));
		assert.equal(await sandbox.git(clone, "cat-file", "-s", `${result.snapshot.tree}:exact.txt`), "10");
		assert.deepEqual(result.snapshot.omitted, [{ reason: "over-file-cap", path: "over.txt", bytes: 11 }]);
	});

	test("files adding up to exactly maxSnapshotBytes are all captured; the next one is omitted", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "a.txt"), "a".repeat(6));
		sandbox.write(join(clone, "b.txt"), "b".repeat(4));
		sandbox.write(join(clone, "c.txt"), "c");
		const result = captured(await captureWorktreeSnapshot(clone, { settings: { maxSnapshotBytes: 10 } }));
		const tree = await sandbox.git(clone, "ls-tree", "-r", "--name-only", result.snapshot.tree);
		assert.deepEqual(tree.split("\n"), ["README.md", "a.txt", "b.txt"]);
		assert.deepEqual(result.snapshot.omitted, [{ reason: "over-snapshot-cap", path: "c.txt", bytes: 1 }]);
	});

	test("omissions are listed in path order across tracked and untracked files", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "z.pem": "tracked\n" });
		sandbox.write(join(clone, "z.pem"), "changed\n");
		sandbox.write(join(clone, "a.pem"), "untracked\n");
		sandbox.write(join(clone, "m.key"), "untracked\n");
		const result = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(
			result.snapshot.omitted.map((omission) => ("path" in omission ? omission.path : "")),
			["a.pem", "m.key", "z.pem"],
		);
	});

	test("a directory replaced by a file is captured as that file and the old entries as deleted", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "d/x.txt": "x\n" });
		rmSync(join(clone, "d"), { recursive: true });
		writeFileSync(join(clone, "d"), "now a file\n");
		const result = captured(await captureWorktreeSnapshot(clone));
		assert.equal(await sandbox.git(clone, "cat-file", "-p", `${result.snapshot.tree}:d`), "now a file");
		assert.deepEqual(result.snapshot.omitted, []);
	});
});

describe("repository facts a snapshot records", () => {
	test("conversion drivers come from every .gitattributes, deduplicated and sorted", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", {
			".gitattributes": "*.bin filter=lfs -text\n*.dat filter=zeta\n*.big filter=lfs\n",
			"sub/.gitattributes": "*.x filter=alpha\n",
		});
		const result = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(result.snapshot.filters, { autocrlf: null, eol: null, drivers: ["alpha", "lfs", "zeta"] });
	});

	test("a tracked .gitattributes missing from the working tree contributes nothing", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { ".gitattributes": "*.bin filter=lfs\n" });
		unlinkSync(join(clone, ".gitattributes"));
		const result = captured(await captureWorktreeSnapshot(clone));
		assert.equal(result.snapshot.filters, null);
	});

	test("core.eol alone, and a valueless core.autocrlf, are recorded as the conversion settings", async () => {
		const { clone } = await sandbox.remoteWithClone();
		await sandbox.git(clone, "config", "core.eol", "crlf");
		const eolOnly = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(eolOnly.snapshot.filters, { autocrlf: null, eol: "crlf", drivers: [] });
		await sandbox.git(clone, "config", "--unset", "core.eol");
		const config = join(clone, ".git", "config");
		const text = (await import("node:fs")).readFileSync(config, "utf8");
		writeFileSync(config, `${text}[core]\n\tautocrlf\n`);
		const valueless = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(valueless.snapshot.filters, { autocrlf: "", eol: null, drivers: [] });
		await sandbox.git(clone, "config", "core.eol", "");
		const emptyEol = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(emptyEol.snapshot.filters, { autocrlf: "", eol: "", drivers: [] });
	});

	test("the snapshot commit is a parentless-of-user-history object on HEAD with a fixed identity and message", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const result = captured(await captureWorktreeSnapshot(clone));
		const commit = result.snapshot.snapshot;
		assert.equal(await sandbox.git(clone, "rev-parse", `${commit}^`), result.snapshot.head);
		assert.equal(await sandbox.git(clone, "rev-parse", `${commit}^{tree}`), result.snapshot.tree);
		assert.equal(
			await sandbox.git(clone, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%at|%ct|%B", commit),
			"Atomic <atomic@localhost>|Atomic <atomic@localhost>|0|0|Atomic worktree snapshot\n",
		);
	});

	test("the snapshot id is a 32-hex content hash that ignores capture time and follows the bundle", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "feature.txt"), "feature\n");
		await sandbox.commitAll(clone, "unpushed");
		const first = captured(await captureWorktreeSnapshot(clone)).snapshot;
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = captured(await captureWorktreeSnapshot(clone)).snapshot;
		assert.match(first.id, /^[0-9a-f]{32}$/);
		assert.notEqual(first.capturedAt, second.capturedAt);
		assert.equal(first.id, second.id);
		assert.ok(first.bundle);
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		const pushed = captured(await captureWorktreeSnapshot(clone)).snapshot;
		assert.equal(pushed.bundle, null);
		assert.equal(pushed.head, first.head);
		assert.equal(pushed.tree, first.tree);
		assert.notEqual(pushed.id, first.id);
	});
});

describe("when a previous snapshot is still usable", () => {
	test("a clone of the same commit is a different checkout even when its tree is identical", async () => {
		const { remote, clone } = await sandbox.remoteWithClone();
		const second = sandbox.path("second-clone");
		await sandbox.git(sandbox.root, "clone", "-q", remote, second);
		const first = captured(await captureWorktreeSnapshot(clone)).snapshot;
		const again = await captureWorktreeSnapshot(second, { previous: first });
		assert.equal(again.status, "captured");
		assert.equal(captured(again).snapshot.root, second);
		assert.equal(captured(again).snapshot.head, first.head);
	});

	test("a commit that records the working tree changes HEAD, so the next capture is new and starts a fresh chain", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const before = captured(await captureWorktreeSnapshot(clone)).snapshot;
		await sandbox.commitAll(clone, "commit the edit");
		const after = await captureWorktreeSnapshot(clone, { previous: before });
		assert.equal(after.status, "captured");
		const snapshot = captured(after).snapshot;
		assert.equal(snapshot.tree, before.tree);
		assert.notEqual(snapshot.head, before.head);
		assert.deepEqual(snapshot.chain, [{ tree: snapshot.tree, patch: null, bytes: 0 }]);
		assert.equal(snapshot.delta.base, "head");
	});

	test("a previous snapshot whose tree this repository does not have starts a fresh chain from HEAD", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const first = captured(await captureWorktreeSnapshot(clone)).snapshot;
		sandbox.write(join(clone, "x.txt"), "x2\n");
		for (const absentTree of ["0".repeat(40), "1234567890".repeat(4)]) {
			const forged: WorktreeSnapshot = {
				...first,
				tree: absentTree,
				chain: [{ ...first.chain[0]!, tree: absentTree }],
			};
			const next = captured(await captureWorktreeSnapshot(clone, { previous: forged })).snapshot;
			assert.equal(next.delta.base, "head");
			assert.equal(next.chain.length, 1);
		}
	});
});

describe("environment hash inputs", () => {
	test("an empty checkout hashes only the version prefix and each present file adds its path and content hash", async () => {
		const empty = mkdtempSync(join(sandbox.root, "env-"));
		assert.equal(await computeEnvironmentHash(empty), createHash("sha256").update("atomic-env-v1\n").digest("hex"));
		writeFileSync(join(empty, "package-lock.json"), "x");
		const contentHash = createHash("sha256").update("x").digest("hex");
		assert.equal(
			await computeEnvironmentHash(empty),
			createHash("sha256").update(`atomic-env-v1\npackage-lock.json\0${contentHash}\n`).digest("hex"),
		);
	});

	test("a directory or a file where a lockfile or setup directory is expected is not an input", async () => {
		const dir = mkdtempSync(join(sandbox.root, "env-"));
		mkdirSync(join(dir, "yarn.lock"));
		writeFileSync(join(dir, ".devcontainer"), "a file, so .devcontainer/Dockerfile is below a file");
		assert.equal(await computeEnvironmentHash(dir), createHash("sha256").update("atomic-env-v1\n").digest("hex"));
	});
});

describe("snapshot ignore policy file", () => {
	test("a missing file means no extra exclusions, an unreadable one is an error", async () => {
		const dir = mkdtempSync(join(sandbox.root, "policy-"));
		const policy = await loadSnapshotPathPolicy(dir);
		assert.equal(policy.exclusion("anything.txt"), undefined);
		assert.equal(policy.exclusion(".env"), "denied");
		mkdirSync(join(dir, ".atomic", "snapshot-ignore"), { recursive: true });
		await assert.rejects(
			loadSnapshotPathPolicy(dir),
			(error: unknown) => (error as NodeJS.ErrnoException).code === "EISDIR",
		);
	});
});

describe("snapshot blob store contract", () => {
	test("the blobs a snapshot needs are its patches and bundle, once each", () => {
		const snapshot = {
			chain: [
				{ tree: "t1", patch: null, bytes: 0 },
				{ tree: "t2", patch: "p1", bytes: 1 },
				{ tree: "t3", patch: "p1", bytes: 1 },
				{ tree: "t4", patch: "p2", bytes: 1 },
			],
			bundle: { blob: "b1", bytes: 1, commits: ["c"] },
		} as unknown as WorktreeSnapshot;
		assert.deepEqual(snapshotBlobHashes(snapshot), ["p1", "p2", "b1"]);
		assert.deepEqual(snapshotBlobHashes({ ...snapshot, bundle: null }), ["p1", "p2"]);
	});

	test("the memory store keeps the first bytes for a hash and hands out copies", async () => {
		const store = new MemorySnapshotBlobStore();
		const input = new Uint8Array([1, 2, 3]);
		await store.putBlobs([{ hash: "h", data: input }]);
		await store.putBlobs([{ hash: "h", data: new Uint8Array([9]) }]);
		input[0] = 7;
		const read = await store.getBlob("h");
		assert.deepEqual([...read!], [1, 2, 3]);
		read![0] = 8;
		assert.deepEqual([...(await store.getBlob("h"))!], [1, 2, 3]);
		assert.equal(await store.getBlob("absent"), undefined);
		assert.deepEqual(await store.listBlobHashes(), ["h"]);
		await store.deleteBlobs(["h", "never-stored"]);
		assert.deepEqual(await store.listBlobHashes(), []);
	});

	test("garbage collection deletes exactly the blobs no retained snapshot needs and says which", async () => {
		const store = new MemorySnapshotBlobStore();
		const blobs = [
			snapshotBlob(new Uint8Array([1])),
			snapshotBlob(new Uint8Array([2])),
			snapshotBlob(new Uint8Array([3])),
		];
		await store.putBlobs(blobs);
		const retained = {
			chain: [{ tree: "t", patch: blobs[0]!.hash, bytes: 1 }],
			bundle: null,
		} as unknown as WorktreeSnapshot;
		const result = await collectSnapshotGarbage(store, [retained]);
		assert.deepEqual([...result.deleted].sort(), [blobs[1]!.hash, blobs[2]!.hash].sort());
		assert.deepEqual(await store.listBlobHashes(), [blobs[0]!.hash]);
		assert.deepEqual((await collectSnapshotGarbage(store, [retained])).deleted, []);
		assert.deepEqual([...(await collectSnapshotGarbage(store, [])).deleted], [blobs[0]!.hash]);
		assert.deepEqual(await store.listBlobHashes(), []);
	});
});
