import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	captureWorktreeSnapshot,
	isWorkspaceRestoreError,
	MemorySnapshotBlobStore,
	rehydrateWorkspaceError,
	restoreWorktree,
	type SnapshotBlobStore,
	serializeWorkspaceError,
	setWorktreeSnapshotGit,
	verifyWorktree,
	WorkspaceRestoreError,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

const HEX40 = "a".repeat(40);
const HEX64 = "b".repeat(64);

async function capture(dir: string, blobs: SnapshotBlobStore): Promise<WorktreeSnapshot> {
	const result = await captureWorktreeSnapshot(dir, { blobs });
	assert.ok(result.status === "captured");
	return result.snapshot;
}

/** Every Git command snapshot code runs from now on, as its argument list. */
function recordGitCommands(): string[][] {
	const commands: string[][] = [];
	const executable = sandbox.executable;
	setWorktreeSnapshotGit(async () => {
		commands.push([]);
		return executable;
	});
	return commands;
}

function assertInvalid(error: unknown, field: string, reason: string, snapshotId: string | null): true {
	assert.ok(error instanceof WorkspaceRestoreError, `expected invalid-snapshot, got ${String(error)}`);
	assert.equal(error.code, "invalid-snapshot");
	assert.equal(error.field, field);
	assert.equal(error.reason, reason);
	assert.equal(error.snapshotId, snapshotId);
	return true;
}

describe("records that could reach Git as an option or a path are refused before any work", () => {
	test("a remote that is a fetch option never runs: no Git command starts and no file appears (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const recorded = await capture(clone, blobs);
		const marker = sandbox.path("pwned");
		const snapshot = { ...recorded, head: HEX40, remotes: [`--upload-pack=touch ${marker};`] };
		const storeDir = sandbox.path("host");
		const commands = recordGitCommands();
		await assert.rejects(restoreWorktree(snapshot, { blobs, storeDir }), (error: unknown) =>
			assertInvalid(error, "remotes[0]", "unsafe-remote", recorded.id),
		);
		assert.equal(commands.length, 0);
		assert.equal(existsSync(marker), false);
		assert.equal(existsSync(storeDir), false);
	});

	const malformed: ReadonlyArray<readonly [string, (snapshot: WorktreeSnapshot) => object, string, string, boolean]> =
		[
			[
				"a remote with a control character",
				(s) => ({ ...s, remotes: ["https://example.com/\u001b[31m.git"] }),
				"remotes[0]",
				"unsafe-remote",
				true,
			],
			[
				"an empty remote",
				(s) => ({ ...s, remotes: ["https://example.com/r.git", ""] }),
				"remotes[1]",
				"unsafe-remote",
				true,
			],
			["a head that is a ref name", (s) => ({ ...s, head: "HEAD" }), "head", "invalid-object-id", true],
			["an uppercase tree id", (s) => ({ ...s, tree: s.tree.toUpperCase() }), "tree", "invalid-object-id", true],
			[
				"an id that climbs out of the store",
				(s) => ({ ...s, id: "../../../../x" }),
				"id",
				"invalid-snapshot-id",
				false,
			],
			[
				"a chain tree that is not an id",
				(s) => ({ ...s, chain: [{ tree: "x", patch: null, bytes: 0 }] }),
				"chain[0].tree",
				"invalid-object-id",
				true,
			],
			[
				"a chain entry that is not an object",
				(s) => ({ ...s, chain: [null] }),
				"chain[0].tree",
				"invalid-object-id",
				true,
			],
			[
				"a patch that is not a SHA-256",
				(s) => ({ ...s, chain: [{ tree: s.tree, patch: HEX40, bytes: 1 }] }),
				"chain[0].patch",
				"invalid-blob-hash",
				true,
			],
			[
				"a bundle blob that is not a SHA-256",
				(s) => ({ ...s, bundle: { blob: "-x", bytes: 1, commits: [HEX40] } }),
				"bundle.blob",
				"invalid-blob-hash",
				true,
			],
			[
				"a bundle commit that is not an id",
				(s) => ({ ...s, bundle: { blob: HEX64, bytes: 1, commits: [HEX40, "--all"] } }),
				"bundle.commits[1]",
				"invalid-object-id",
				true,
			],
			[
				"bundle commits that are not a list",
				(s) => ({ ...s, bundle: { blob: HEX64, bytes: 1, commits: "x" } }),
				"bundle.commits",
				"invalid-object-id",
				true,
			],
			[
				"an omitted commit that is not an id",
				(s) => ({ ...s, omitted: [{ reason: "bundle-over-cap", commits: ["main"], bytes: 1 }] }),
				"omitted[0].commits[0]",
				"invalid-object-id",
				true,
			],
		];

	test.each(malformed)(
		"%s is invalid-snapshot naming the field, before any Git command or write",
		async (_name, corrupt, field, reason, keepsId) => {
			const { clone } = await sandbox.remoteWithClone();
			const blobs = new MemorySnapshotBlobStore();
			const recorded = await capture(clone, blobs);
			const snapshot = corrupt(recorded) as WorktreeSnapshot;
			const storeDir = sandbox.path("host");
			const commands = recordGitCommands();
			await assert.rejects(restoreWorktree(snapshot, { blobs, storeDir }), (error: unknown) =>
				assertInvalid(error, field, reason, keepsId ? recorded.id : null),
			);
			await assert.rejects(verifyWorktree(snapshot, clone), (error: unknown) =>
				assertInvalid(error, field, reason, keepsId ? recorded.id : null),
			);
			assert.equal(commands.length, 0);
			assert.equal(existsSync(storeDir), false);
		},
	);

	test("a binding is checked the same way, and its message never echoes the refused value", async () => {
		const commands = recordGitCommands();
		const binding = { remotes: ["-oProxyCommand=\u001b]0;x\u0007"], head: HEX40, tree: HEX40, envHash: "" };
		await assert.rejects(restoreWorktree(binding, { storeDir: sandbox.path("host") }), (error: unknown) => {
			assertInvalid(error, "remotes[0]", "unsafe-remote", null);
			assert.equal((error as Error).message.includes("ProxyCommand"), false);
			assert.equal(
				(error as Error).message,
				"Invalid snapshot record: remotes[0] is not a remote URL Atomic can safely fetch from (invalid-snapshot). The record is malformed or was not written by Atomic. Restore only sessions and runs from storage you trust, or export the session again on the machine that recorded it.",
			);
			return true;
		});
		await assert.rejects(verifyWorktree({ ...binding, remotes: [], tree: "t" }, sandbox.root), (error: unknown) =>
			assertInvalid(error, "tree", "invalid-object-id", null),
		);
		assert.equal(commands.length, 0);
	});

	test("a recorded snapshot that matches a binding but is not a snapshot record is ignored, not read", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const recorded = await capture(clone, blobs);
		const binding = { remotes: [], head: HEX40, tree: recorded.tree, envHash: recorded.envHash };
		const malformed = { ...recorded, head: HEX40, chain: "not a chain" } as unknown as WorktreeSnapshot;
		await assert.rejects(
			restoreWorktree(binding, { blobs, snapshots: [malformed], storeDir: sandbox.path("host") }),
			(error: unknown) => {
				assert.ok(isWorkspaceRestoreError(error));
				assert.equal(error.code, "commits-unavailable");
				assert.equal(error.snapshotId, null);
				return true;
			},
		);
	});

	test("invalid-snapshot keeps its class, field and reason across a process boundary", () => {
		const original = new WorkspaceRestoreError("invalid-snapshot", {
			snapshotId: "0123abcd",
			field: "chain[1].patch",
			reason: "invalid-blob-hash",
		});
		const back = rehydrateWorkspaceError(JSON.parse(JSON.stringify(serializeWorkspaceError(original))));
		assert.ok(back instanceof WorkspaceRestoreError);
		assert.equal(back.code, "invalid-snapshot");
		assert.equal(back.field, "chain[1].patch");
		assert.equal(back.reason, "invalid-blob-hash");
		assert.equal(back.message, original.message);
		assert.equal(
			original.message,
			"Invalid snapshot record 0123abcd: chain[1].patch is not a SHA-256 blob hash (invalid-snapshot). The record is malformed or was not written by Atomic. Restore only sessions and runs from storage you trust, or export the session again on the machine that recorded it.",
		);
	});
});

describe("what a restore fetch may run", () => {
	test.each([
		["a remote helper", (marker: string) => `ext::sh -c touch% ${marker}`],
		["a custom transport", () => "atomic-test-transport::anything"],
	])(
		"%s is refused as an unsafe remote before any Git runs, so nothing is fetched and nothing runs (#4733)",
		async (_name, remote) => {
			const { clone } = await sandbox.remoteWithClone();
			const blobs = new MemorySnapshotBlobStore();
			const recorded = await capture(clone, blobs);
			const marker = sandbox.path("pwned");
			const snapshot = { ...recorded, head: HEX40, remotes: [remote(marker)] };
			await assert.rejects(restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") }), (error: unknown) =>
				assertInvalid(error, "remotes[0]", "unsafe-remote", recorded.id),
			);
			assert.equal(existsSync(marker), false);
			assert.equal(existsSync(sandbox.path("host", "repositories")), false);
		},
	);

	test("a bundle whose header lists a prerequisite that is not an object id is refused before fetching it", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const recorded = await capture(clone, blobs);
		const data = new TextEncoder().encode(`# v2 git bundle\n---upload-pack=touch x\n${HEX40} HEAD\n\n`);
		const hash = createHash("sha256").update(data).digest("hex");
		await blobs.putBlobs([{ hash, data }]);
		const snapshot: WorktreeSnapshot = {
			...recorded,
			head: HEX40,
			remotes: [sandbox.path("repo.git")],
			bundle: { blob: hash, bytes: data.byteLength, commits: [HEX40] },
		};
		await assert.rejects(restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") }), (error: unknown) =>
			assertInvalid(error, "bundle.prerequisites[0]", "invalid-object-id", recorded.id),
		);
	});

	test("a path remote still fetches: local mirrors and path remotes keep working", async () => {
		const { clone, remote } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "b.txt"), "b\n");
		const head = await sandbox.commitAll(clone, "b");
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = { ...(await capture(clone, blobs)), remotes: [remote] };
		const restored = await restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") });
		assert.equal(await sandbox.git(restored.path, "rev-parse", "HEAD"), head);
	});
});
