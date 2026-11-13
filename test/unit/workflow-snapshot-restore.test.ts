import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	captureWorktreeSnapshot,
	GitUnavailableError,
	isGitUnavailableError,
	MemorySnapshotBlobStore,
	type RestoreWorktreeSnapshotOptions,
	WorkspaceRestoreError,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/index.js";
import {
	isWorkspaceRestoreUnavailableError,
	rehydrateWorkerPlacementError,
	serializeWorkerPlacementError,
	type WorkspaceRestoreUnavailableError,
} from "../../packages/workflows/src/workers/placement-errors.js";
import { snapshotRestore } from "../../packages/workflows/src/workers/snapshot-restore.js";
import type { WorkspaceBinding } from "../../packages/workflows/src/workers/workspace-binding.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

const binding: WorkspaceBinding = {
	remotes: ["https://user:secret@example.invalid/r.git"],
	head: "1111111111111111111111111111111111111111",
	tree: "2222222222222222222222222222222222222222",
	envHash: "e",
};
const recorded = [{ id: "s1" }, { id: "s2" }] as unknown as readonly WorktreeSnapshot[];
const blobs = new MemorySnapshotBlobStore();
const signal = new AbortController().signal;
const hostGit = { path: "/usr/bin/git", env: { GIT_EXEC_PATH: "/usr/libexec/git-core" } };

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

/** A snapshot restore whose snapshot reads and restores are counted, each restore resolving its own path. */
function counted(restore?: (options: RestoreWorktreeSnapshotOptions) => Promise<{ path: string }>) {
	const lookups: string[] = [];
	const restores: RestoreWorktreeSnapshotOptions[] = [];
	const targets: (WorkspaceBinding | WorktreeSnapshot)[] = [];
	const port = snapshotRestore({
		recorded: async (requested) => {
			lookups.push(`${requested.head}:${requested.tree}`);
			return recorded;
		},
		blobs,
		storeDir: "/host/agent/worktree-snapshots",
		git: hostGit,
		restore: async (target, options) => {
			targets.push(target);
			restores.push(options);
			return restore === undefined ? { path: `/host/restored-${restores.length}` } : restore(options);
		},
	});
	return { port, lookups, restores, targets };
}

test("the snapshot restore restores a binding from the snapshots recorded with it, read once per binding (#4416)", async () => {
	const { port, lookups, restores, targets } = counted();
	for (const index of [1, 2, 3]) assert.equal(await port(binding, { signal }), `/host/restored-${index}`);
	assert.deepEqual(targets, [binding, binding, binding], "each restore is of the binding itself");
	assert.deepEqual(
		lookups,
		[`${binding.head}:${binding.tree}`],
		"three children of one binding read the journal once",
	);
	for (const options of restores) {
		assert.deepEqual(options, {
			snapshots: recorded,
			blobs,
			storeDir: "/host/agent/worktree-snapshots",
			signal,
			git: hostGit,
		});
		assert.equal(options.snapshots, recorded);
		assert.equal(options.blobs, blobs);
	}
	await port({ ...binding, head: "3" }, { signal });
	await port({ ...binding, tree: "4" }, { signal });
	assert.equal(lookups.length, 3, "a binding of another head or tree reads its own snapshots");
});

test("a failed restore keeps its own error and reads the binding's snapshots again next time (#4416)", async () => {
	const unreachable = new WorkspaceRestoreError("commits-unavailable", {
		snapshotId: null,
		head: binding.head,
		commits: [binding.head],
	});
	let fail = true;
	const { port, lookups } = counted(async () => {
		if (fail) throw unreachable;
		return { path: "/host/restored" };
	});
	await assert.rejects(port(binding, { signal }), (error) => error === unreachable);
	await assert.rejects(port(binding, { signal }), (error) => error === unreachable);
	fail = false;
	assert.equal(await port(binding, { signal }), "/host/restored");
	assert.equal(await port(binding, { signal }), "/host/restored");
	assert.equal(lookups.length, 3, "each failed restore read the snapshots, and so did the first that succeeded");
	fail = true;
	await assert.rejects(port(binding, { signal }), (error) => error === unreachable);
	fail = false;
	await port(binding, { signal });
	assert.equal(lookups.length, 4, "a binding that failed after it restored reads its snapshots again");
});

test("the snapshot restore remembers a bounded number of bindings (#4416)", async () => {
	const { port, lookups } = counted();
	const nth = (index: number): WorkspaceBinding => ({ ...binding, tree: String(index) });
	for (let index = 1; index <= 256; index++) await port(nth(index), { signal });
	await port(nth(1), { signal });
	await port(nth(2), { signal });
	assert.equal(lookups.length, 256, "every binding it restored is remembered, up to 256");
	await port(nth(257), { signal });
	assert.equal(lookups.length, 257);
	await port(nth(256), { signal });
	assert.equal(lookups.length, 258, "the 257th binding made it forget the others");
	await port(nth(257), { signal });
	assert.equal(lookups.length, 258, "and remember it");
});

test("a restore that cannot run because the host's git does not run is refused typed, with its cause (#4416)", async () => {
	// A binding whose remote holds credentials is refused as `invalid-snapshot` before any Git runs (#4733).
	const safe = { ...binding, remotes: ["https://example.invalid/r.git"] };
	const port = snapshotRestore({
		recorded: async () => [],
		blobs: undefined,
		storeDir: sandbox.path("host"),
		git: { path: sandbox.path("no-such-git"), env: {} },
	});
	const refused = (await port(safe, { signal }).then(
		() => undefined,
		(error: unknown) => error,
	)) as WorkspaceRestoreUnavailableError;
	assert.ok(isWorkspaceRestoreUnavailableError(refused), String(refused));
	assert.deepEqual(
		[refused.code, refused.reason, refused.retryable, refused.childRunId, refused.claimWindowMs],
		["workspace-restore-unavailable", "no-restore-port", false, undefined, undefined],
	);
	assert.deepEqual(refused.binding, safe);
	assert.ok(isGitUnavailableError(refused.cause), String(refused.cause));
	assert.equal(
		refused.message,
		`Workspace restore unavailable: tree ${safe.tree} at ${safe.head} of https://example.invalid/r.git (workspace-restore-unavailable): this host cannot run a restore. ${refused.hint}`,
	);
	assert.match(refused.hint ?? "", /git: \{ path \}/);
	const crossed = rehydrateWorkerPlacementError(JSON.parse(JSON.stringify(serializeWorkerPlacementError(refused))));
	assert.ok(isWorkspaceRestoreUnavailableError(crossed));
	assert.deepEqual([crossed.reason, crossed.binding], [refused.reason, refused.binding]);
	assert.equal((crossed.cause as Error).name, "GitUnavailableError");
});

test("a cancelled restore rejects with its own error, never a refusal (#4416)", async () => {
	const controller = new AbortController();
	const missing = new GitUnavailableError({
		code: "not-installed",
		platform: "linux",
		arch: "x64",
		installDir: join("/home/user", ".atomic", "bin", "git"),
		installCommand: "sudo apt-get install -y git",
	});
	const { port } = counted(async () => {
		controller.abort();
		throw missing;
	});
	await assert.rejects(port(binding, { signal: controller.signal }), (error) => error === missing);
	const uncancelled = counted(async () => {
		throw missing;
	});
	await assert.rejects(uncancelled.port(binding, { signal }), (error) => isWorkspaceRestoreUnavailableError(error));
});

/** A carried snapshot as the root captures one: of a dirty clone, with its blobs in `store`. */
async function capturedSnapshot(store: MemorySnapshotBlobStore): Promise<WorktreeSnapshot> {
	const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "committed\n" });
	sandbox.write(join(clone, "a.txt"), "uncommitted\n");
	const capture = await captureWorktreeSnapshot(clone, { blobs: store });
	assert.equal(capture.status, "captured");
	return (capture as { readonly snapshot: WorktreeSnapshot }).snapshot;
}

test("work that carries its root's snapshot restores that snapshot, without reading the journal's snapshots (#4492)", async () => {
	const { port, lookups, restores, targets } = counted();
	const carried = { id: "carried" } as unknown as WorktreeSnapshot;
	assert.equal(await port(binding, { signal, snapshot: carried }), "/host/restored-1");
	assert.equal(await port(binding, { signal, snapshot: carried }), "/host/restored-2");
	assert.deepEqual(lookups, [], "no read of the snapshots the journal recorded");
	assert.deepEqual(targets, [carried, carried], "the carried snapshot is what is restored, each time");
	for (const options of restores)
		assert.deepEqual(options, { blobs, storeDir: "/host/agent/worktree-snapshots", signal, git: hostGit });
	assert.equal(await port(binding, { signal }), "/host/restored-3");
	assert.deepEqual(lookups, [`${binding.head}:${binding.tree}`], "work without one restores from the journal's");
	assert.equal(targets.at(-1), binding);
	assert.equal(restores.at(-1)?.snapshots, recorded);
});

test("a carried snapshot that fails to restore keeps its own error and leaves the binding's recorded snapshots alone (#4492)", async () => {
	const missing = new WorkspaceRestoreError("blob-missing", { snapshotId: "carried", blob: "b", role: "patch" });
	let fail = false;
	const { port, lookups } = counted(async () => {
		if (fail) throw missing;
		return { path: "/host/restored" };
	});
	await port(binding, { signal });
	fail = true;
	const carried = { id: "carried" } as unknown as WorktreeSnapshot;
	await assert.rejects(port(binding, { signal, snapshot: carried }), (error) => error === missing);
	fail = false;
	await port(binding, { signal });
	assert.equal(lookups.length, 1, "the binding restored from its recorded snapshots once, and is still remembered");
});

test("a carried snapshot that cannot restore because the host's git does not run is refused typed, as the binding's (#4492)", async () => {
	const store = new MemorySnapshotBlobStore();
	const snapshot = await capturedSnapshot(store);
	const port = snapshotRestore({
		recorded: async () => {
			throw new Error("work that carries a snapshot reads no recorded snapshot");
		},
		blobs: store,
		storeDir: sandbox.path("host"),
		git: { path: sandbox.path("no-such-git"), env: {} },
	});
	const refused = (await port(binding, { signal, snapshot }).then(
		() => undefined,
		(error: unknown) => error,
	)) as WorkspaceRestoreUnavailableError;
	assert.ok(isWorkspaceRestoreUnavailableError(refused), String(refused));
	assert.deepEqual([refused.reason, refused.binding.tree], ["no-restore-port", binding.tree]);
	assert.ok(isGitUnavailableError(refused.cause), String(refused.cause));
});

test("a carried snapshot restores on a cold host into a verified worktree with its uncommitted content (#4492)", async () => {
	const store = new MemorySnapshotBlobStore();
	const snapshot = await capturedSnapshot(store);
	const port = snapshotRestore({
		recorded: async () => {
			throw new Error("work that carries a snapshot reads no recorded snapshot");
		},
		blobs: store,
		storeDir: sandbox.path("host", "worktree-snapshots"),
		git: { path: sandbox.executable.path, env: { ...sandbox.executable.env } as Record<string, string> },
	});
	const path = await port(
		{ remotes: [...snapshot.remotes], head: snapshot.head, tree: "other", envHash: "e" },
		{
			signal,
			snapshot,
		},
	);
	assert.ok(path.startsWith(sandbox.path("host", "worktree-snapshots", "worktrees")), path);
	assert.equal(await sandbox.git(path, "rev-parse", "HEAD"), snapshot.head);
	assert.equal(readFileSync(join(path, "a.txt"), "utf8"), "uncommitted\n");
});
