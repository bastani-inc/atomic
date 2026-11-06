import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import {
	collectSnapshotGarbage,
	isWorkspaceRestoreError,
	isWorkspaceSnapshotError,
	rehydrateWorkspaceError,
	SqlSnapshotBlobStore,
	snapshotBlobHashes,
	type WorktreeSnapshot,
	workspace,
} from "../../packages/coding-agent/src/index.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { DispatchSnapshots } from "../../packages/workflows/src/workers/dispatch-snapshot.js";
import {
	isWorkspaceRestoreUnavailableError,
	type WorkspaceRestoreUnavailableError,
} from "../../packages/workflows/src/workers/placement-errors.js";
import { recordedPlacement } from "../../packages/workflows/src/workers/public-pool.js";
import type { startWorkflowWorkerHost } from "../../packages/workflows/src/workers/worker-host.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	type Fixture,
	fanOut,
	fixture,
	libsql,
	PREFIX,
	stubWorker,
} from "../helpers/workflow-shared-pool-coordinator.js";
import { commitFile, createRepository, git, workspaceSandbox } from "../helpers/workspace-repos.js";
import { GitSandbox, loseSnapshotBlobs } from "../helpers/worktree-snapshot.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

/**
 * Bound work whose worktree the root captures as it dispatches it, so a cold worker host restores uncommitted and
 * unpushed content no checkpoint recorded (#4492).
 */
useTemporaryAgentDir();

type WorkerHost = Awaited<ReturnType<typeof startWorkflowWorkerHost>>;

/** A worker host on its own agent directory that restores by default: it has none of the root's trees warm. */
async function coldHost(f: Fixture): Promise<{ readonly host: WorkerHost; readonly agentDir: string }> {
	const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
	const agentDir = join(f.directory, "host-c", "agent");
	const host = await startWorkflowWorkerHost({
		journal: {
			adapter: libsql,
			options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
			prefix: PREFIX,
		},
		agentDir,
		maxWorkers: 1,
		hostId: "host-c",
		workerEntry: stubWorker,
	});
	assert.equal((await host.stats()).restore, true, "a host with git restores by default");
	return { host, agentDir };
}

async function boundChild() {
	return loadWorkerDefinition({
		path: childPath,
		exportName: "boundChild",
		digest: await definitionDigest(childPath),
	});
}

/** The worktree snapshots the root's queued children carry, once `count` of them are queued. */
async function carriedSnapshots(f: Fixture, count: number): Promise<WorktreeSnapshot[]> {
	for (;;) {
		const rows = await sqlPoolStorage(f.hostJournal)!.read((executor) =>
			executor.all<{ snapshot: string | null }>(
				`SELECT json_extract(descriptor, '$.execution.workspaceSnapshot') AS snapshot FROM ${PREFIX}wf_runs_work WHERE root = 'root'`,
			),
		);
		if (rows.length >= count)
			return rows.flatMap((row) => (row.snapshot === null ? [] : [JSON.parse(row.snapshot) as WorktreeSnapshot]));
		await sleep(25);
	}
}

/** The root journal's snapshot blobs, where the root stores what it captures. */
function rootBlobs(f: Fixture): SqlSnapshotBlobStore {
	const blobs = f.backend.snapshotJournal.snapshotBlobs;
	assert.ok(blobs instanceof SqlSnapshotBlobStore);
	return blobs;
}

test.skipIf(process.platform === "win32")(
	"a child bound with ctx.workflow(child, { workspace }) to a worktree with uncommitted, untracked and unpushed content no checkpoint captured runs on a cold host that restores it (#4492)",
	async () => {
		const dirs = workspaceSandbox("shared-dispatch-snapshot-child-");
		const sandbox = new GitSandbox();
		const repo = createRepository(dirs.root, "child-repo");
		const worktree = join(dirs.root, "child-worktree");
		git(repo, "worktree", "add", "-q", "-b", "feat/child", worktree);
		const unpushed = commitFile(worktree, "committed.txt", "unpushed\n");
		sandbox.write(join(worktree, "README.md"), "uncommitted\n");
		sandbox.write(join(worktree, "notes", "new.txt"), "untracked\n");
		const f = await fixture("shared-dispatch-snapshot-child", {});
		const lookups = vi.spyOn(SqlSharedPool.prototype, "recordedSnapshots");
		const captures = vi.spyOn(DispatchSnapshots.prototype, "capture");
		const child = await boundChild();
		const outcomes: string[] = [];
		const parent = workflow({
			name: "shared-dispatch-snapshot-child-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const result = await ctx.workflow(child as never, {
					inputs: {},
					workspace: workspace({ repo, branch: "feat/child", worktree }),
				});
				outcomes.push(result.status);
				return {};
			},
		});
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		let cold: Awaited<ReturnType<typeof coldHost>> | undefined;
		try {
			await f.root();
			const [snapshot] = await carriedSnapshots(f, 1);
			assert.ok(snapshot, "the child carries the snapshot its root captured as it dispatched it");
			assert.deepEqual([snapshot.root, snapshot.head], [worktree, unpushed]);
			cold = await coldHost(f);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			const claims = f.claims();
			assert.equal(claims.length, 1);
			const [claimer, , cwd, bound] = claims[0]!;
			assert.equal(claimer, "host-c");
			assert.ok(cwd?.startsWith(join(cold.agentDir, "worktree-snapshots", "worktrees")), cwd);
			assert.equal(bound, cwd, "its workspace is bound to the restored worktree");
			assert.equal(readFileSync(join(cwd!, "README.md"), "utf8"), "uncommitted\n", "uncommitted content restored");
			assert.equal(readFileSync(join(cwd!, "notes", "new.txt"), "utf8"), "untracked\n");
			assert.equal(readFileSync(join(cwd!, "committed.txt"), "utf8"), "unpushed\n", "an unpushed commit too");
			assert.equal(await sandbox.git(cwd!, "rev-parse", "HEAD"), unpushed);
			assert.equal(lookups.mock.calls.length, 0, "the host never read the journal's recorded snapshots");
			assert.deepEqual(
				captures.mock.calls.map(([captured]) => captured),
				[worktree],
				"one capture, of the child's worktree, as it was dispatched",
			);
			const [record] = await f.shared.stageWorkspaces("root");
			assert.deepEqual([record?.host, record?.worktree], ["host-c", cwd]);
			assert.deepEqual(
				[record?.binding?.head, record?.binding?.remotes],
				[unpushed, []],
				"placed by the child's own binding",
			);
			assert.equal((await cold.host.stats()).lastPlacementFailure, undefined);
		} finally {
			lookups.mockRestore();
			captures.mockRestore();
			await cold?.host.stop();
			await execution.catch(() => {});
			await f.close();
			sandbox.dispose();
			dirs.cleanup();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a root bound to a dirty worktree captures it once as it starts, and its unbound children restore it on a cold host after its blobs outlived their grace window (#4492)",
	async () => {
		const sandbox = new GitSandbox();
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "committed\n" });
		sandbox.write(join(clone, "a.txt"), "uncommitted\n");
		sandbox.write(join(clone, "notes", "new.txt"), "untracked\n");
		const placed = await recordedPlacement({
			placement: "shared",
			workspace: workspace({ repo: clone, branch: "main", base: "main", worktree: clone }),
		});
		assert.equal(placed.worktree, clone, "the root's binding has a worktree on this host");
		const binding = placed.placement.workspace!;
		const captures = vi.spyOn(DispatchSnapshots.prototype, "capture");
		const refreshes = vi.spyOn(SqlSnapshotBlobStore.prototype, "refreshBlobs");
		const lookups = vi.spyOn(SqlSharedPool.prototype, "recordedSnapshots");
		const f = await fixture("shared-dispatch-snapshot-root", {
			workspace: binding,
			workspaceWorktree: placed.worktree,
			snapshotRefreshMs: 0,
		});
		const { parent, outcomes } = await fanOut(3)((await boundChild()) as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		let cold: Awaited<ReturnType<typeof coldHost>> | undefined;
		try {
			await f.root();
			const carried = await carriedSnapshots(f, 3);
			assert.equal(carried.length, 3, "every unbound child carries the root's snapshot");
			assert.deepEqual(new Set(carried.map((snapshot) => snapshot.id)).size, 1);
			const [snapshot] = carried;
			assert.deepEqual([snapshot!.root, snapshot!.head], [clone, binding.head]);
			assert.deepEqual(
				captures.mock.calls.map(([captured]) => captured),
				[clone],
				"captured once, when the root started, and not again per child",
			);
			// The blobs outlive a grace window while the children wait, as a backlog of children can.
			const hashes = snapshotBlobHashes(snapshot!);
			assert.ok(hashes.length > 0);
			const blobs = rootBlobs(f);
			const { database } = blobs as unknown as { readonly database: SqliteDatabase };
			await database.run(`UPDATE ${blobs.table} SET created_at = created_at - 7200`);
			const before = refreshes.mock.calls.length;
			while (
				!refreshes.mock.calls.slice(before).some(([refreshed]) => hashes.every((hash) => refreshed.includes(hash)))
			)
				await sleep(25);
			const { deleted } = await collectSnapshotGarbage(blobs, { graceSeconds: 3600 });
			assert.deepEqual(
				deleted.filter((hash) => hashes.includes(hash)),
				[],
				"the root kept the carried snapshot's blobs from collection",
			);
			refreshes.mockRejectedValueOnce(new Error("storage unavailable"));
			const failed = "keeping the worktree snapshots of waiting children failed: storage unavailable";
			while (!f.pool.health.includes(failed)) await sleep(25);
			cold = await coldHost(f);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed", "completed", "completed"]);
			const claims = f.claims();
			assert.equal(claims.length, 3);
			for (const [claimer, , cwd] of claims) {
				assert.equal(claimer, "host-c");
				assert.ok(cwd?.startsWith(join(cold.agentDir, "worktree-snapshots", "worktrees")), cwd);
				assert.equal(readFileSync(join(cwd!, "a.txt"), "utf8"), "uncommitted\n", "uncommitted content restored");
				assert.equal(readFileSync(join(cwd!, "notes", "new.txt"), "utf8"), "untracked\n");
			}
			assert.equal(lookups.mock.calls.length, 0, "no child read the journal's recorded snapshots");
			assert.equal(captures.mock.calls.length, 1);
			const records = await f.shared.stageWorkspaces("root");
			assert.deepEqual(
				records.map((record) => [record.host, record.binding]),
				claims.map(() => ["host-c", binding]),
			);
		} finally {
			captures.mockRestore();
			refreshes.mockRestore();
			lookups.mockRestore();
			await cold?.host.stop();
			await execution.catch(() => {});
			await f.close();
			sandbox.dispose();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a root that works past the grace window before its first child keeps its snapshot's blobs, and the child restores it on a cold host (#4492)",
	async () => {
		const sandbox = new GitSandbox();
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "committed\n" });
		sandbox.write(join(clone, "a.txt"), "uncommitted\n");
		const placed = await recordedPlacement({
			placement: "shared",
			workspace: workspace({ repo: clone, branch: "main", base: "main", worktree: clone }),
		});
		const binding = placed.placement.workspace!;
		const captures = vi.spyOn(DispatchSnapshots.prototype, "capture");
		const refreshes = vi.spyOn(SqlSnapshotBlobStore.prototype, "refreshBlobs");
		const f = await fixture("shared-dispatch-snapshot-idle-root", {
			workspace: binding,
			workspaceWorktree: placed.worktree,
			snapshotRefreshMs: 0,
		});
		const child = await boundChild();
		const working = Promise.withResolvers<void>();
		const outcomes: string[] = [];
		const parent = workflow({
			name: "shared-dispatch-snapshot-idle-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				// The root's own work, before it dispatches anything.
				await working.promise;
				outcomes.push((await ctx.workflow(child as never, { inputs: {} })).status);
				return {};
			},
		});
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		let cold: Awaited<ReturnType<typeof coldHost>> | undefined;
		try {
			while (captures.mock.results.length === 0) await sleep(25);
			const snapshot = (await captures.mock.results[0]!.value) as WorktreeSnapshot | undefined;
			assert.ok(snapshot !== undefined, "the root captured its binding as it started");
			// No child waits yet; the snapshot's blobs outlive a grace window meanwhile.
			const hashes = snapshotBlobHashes(snapshot);
			const blobs = rootBlobs(f);
			const { database } = blobs as unknown as { readonly database: SqliteDatabase };
			await database.run(`UPDATE ${blobs.table} SET created_at = created_at - 7200`);
			const before = refreshes.mock.calls.length;
			const deadline = Date.now() + 10_000;
			while (
				Date.now() < deadline &&
				!refreshes.mock.calls.slice(before).some(([refreshed]) => hashes.every((hash) => refreshed.includes(hash)))
			)
				await sleep(25);
			const { deleted } = await collectSnapshotGarbage(blobs, { graceSeconds: 3600 });
			assert.deepEqual(
				deleted.filter((hash) => hashes.includes(hash)),
				[],
				"the root kept its snapshot's blobs from collection before any child carried it",
			);
			working.resolve();
			cold = await coldHost(f);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			const [[claimer, , cwd]] = f.claims() as [[string, unknown, string | undefined]];
			assert.equal(claimer, "host-c");
			assert.equal(readFileSync(join(cwd!, "a.txt"), "utf8"), "uncommitted\n", "uncommitted content restored");
		} finally {
			working.resolve();
			captures.mockRestore();
			refreshes.mockRestore();
			await cold?.host.stop();
			await execution.catch(() => {});
			await f.close();
			sandbox.dispose();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a pool closed while its root's binding is still being captured keeps nothing from collection afterwards (#4492)",
	async () => {
		const sandbox = new GitSandbox();
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "committed\n" });
		const placed = await recordedPlacement({
			placement: "shared",
			workspace: workspace({ repo: clone, branch: "main", base: "main", worktree: clone }),
		});
		const captured = Promise.withResolvers<WorktreeSnapshot | undefined>();
		const captures = vi.spyOn(DispatchSnapshots.prototype, "capture").mockReturnValue(captured.promise);
		const carries = vi.spyOn(DispatchSnapshots.prototype, "carry");
		const f = await fixture("shared-dispatch-snapshot-closed-root", {
			workspace: placed.placement.workspace!,
			workspaceWorktree: placed.worktree,
			snapshotRefreshMs: 0,
		});
		const { parent } = await fanOut(1)((await boundChild()) as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			while (captures.mock.calls.length === 0) await sleep(25);
			await f.pool.close();
			captured.resolve(carried("closed-root", ["p-closed"], "b-closed"));
			await execution.catch(() => {});
			await sleep(500);
			assert.deepEqual(
				carries.mock.calls.filter(([snapshot]) => snapshot?.id === "closed-root"),
				[],
				"the closed pool does not carry the late snapshot, so nothing refreshes it",
			);
		} finally {
			captured.resolve(undefined);
			captures.mockRestore();
			carries.mockRestore();
			await execution.catch(() => {});
			await f.close();
			sandbox.dispose();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

/** A snapshot record carrying only an id and the blob hashes of its chain and bundle. */
function carried(id: string, patches: readonly string[], bundle: string): WorktreeSnapshot {
	return {
		id,
		chain: patches.map((patch) => ({ tree: "t", patch, bytes: 0 })),
		bundle: { blob: bundle, bytes: 0, commits: [] },
	} as unknown as WorktreeSnapshot;
}

/** The failure of the one child of a root bound to `options`' worktree, run while a cold host serves it. */
async function unrestorable(
	label: string,
	options: Parameters<typeof fixture>[1],
	beforeHost: (f: Fixture) => Promise<void> = async () => {},
): Promise<{ readonly failure: WorkspaceRestoreUnavailableError; readonly unavailable: Error | undefined }> {
	const f = await fixture(label, { claimWindowMs: 1_500, ...options });
	const { parent, outcomes } = await fanOut(1)((await boundChild()) as never);
	const store = createStore();
	// The root records no snapshot of its own directory, so the only degrade reason is its binding's.
	const execution = run(
		parent,
		{},
		{ runId: "root", cwd: f.directory, store, durableBackend: f.backend, snapshots: { enabled: false } },
	);
	let cold: Awaited<ReturnType<typeof coldHost>> | undefined;
	try {
		await f.root();
		await beforeHost(f);
		cold = await coldHost(f);
		const result = await execution;
		assert.equal(result.status, "completed", JSON.stringify(result));
		const [failure] = outcomes;
		assert.ok(isWorkspaceRestoreUnavailableError(failure), String(failure));
		assert.deepEqual(f.claims(), [], "no worker ran it");
		const reason = store.run("root")?.snapshotUnavailable;
		return { failure, unavailable: reason === undefined ? undefined : rehydrateWorkspaceError(reason) };
	} finally {
		await cold?.host.stop();
		await execution.catch(() => {});
		await f.close();
	}
}

test.skipIf(process.platform === "win32")(
	"a child of a dirty root binding the root could not snapshot still fails typed once no host restores it (#4492)",
	async () => {
		const sandbox = new GitSandbox();
		try {
			const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "committed\n" });
			sandbox.write(join(clone, "a.txt"), "uncommitted\n");
			const { placement, worktree } = await recordedPlacement({
				placement: "shared",
				workspace: workspace({ repo: clone, branch: "main", base: "main", worktree: clone }),
			});
			const disabled = await unrestorable("shared-dispatch-snapshot-disabled", {
				workspace: placement.workspace!,
				workspaceWorktree: worktree,
				snapshots: { enabled: false },
			});
			assert.deepEqual(
				[disabled.failure.reason, disabled.failure.claimWindowMs, disabled.failure.binding.tree],
				["no-capable-host", 1_500, placement.workspace!.tree],
			);
			const cause = disabled.failure.cause;
			assert.ok(isWorkspaceRestoreError(cause), String(cause));
			assert.equal(cause.code, "snapshot-not-found", "the binding's uncommitted tree was recorded nowhere");
			assert.equal(disabled.unavailable, undefined, "snapshots turned off is no degrade");

			const elsewhere = sandbox.path("not-a-repository");
			mkdirSync(elsewhere);
			const missing = await unrestorable("shared-dispatch-snapshot-unavailable", {
				workspace: placement.workspace!,
				workspaceWorktree: elsewhere,
			});
			assert.equal(missing.failure.reason, "no-capable-host");
			assert.ok(isWorkspaceRestoreError(missing.failure.cause), String(missing.failure.cause));
			assert.equal(missing.failure.cause.code, "snapshot-not-found");
			assert.ok(isWorkspaceSnapshotError(missing.unavailable), String(missing.unavailable));
			assert.deepEqual(
				[missing.unavailable.code, missing.unavailable.subject],
				["not-a-repository", elsewhere],
				"why the root has no snapshot is recorded on the root run",
			);
		} finally {
			sandbox.dispose();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a child whose carried snapshot lost its blobs fails typed with the restore's own failure as the cause (#4492)",
	async () => {
		const sandbox = new GitSandbox();
		try {
			const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "committed\n" });
			sandbox.write(join(clone, "a.txt"), "uncommitted\n");
			const { placement, worktree } = await recordedPlacement({
				placement: "shared",
				workspace: workspace({ repo: clone, branch: "main", base: "main", worktree: clone }),
			});
			const lost = await unrestorable(
				"shared-dispatch-snapshot-blob-missing",
				{ workspace: placement.workspace!, workspaceWorktree: worktree },
				async (f) => {
					const [snapshot] = await carriedSnapshots(f, 1);
					assert.ok(snapshot);
					await loseSnapshotBlobs(rootBlobs(f), snapshotBlobHashes(snapshot));
				},
			);
			assert.equal(lost.failure.reason, "no-capable-host");
			const cause = lost.failure.cause;
			assert.ok(isWorkspaceRestoreError(cause), String(cause));
			assert.deepEqual([cause.code, cause.fields.role], ["blob-missing", "patch"]);
			assert.equal(lost.unavailable, undefined);
		} finally {
			sandbox.dispose();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a root whose snapshot settings are invalid fails as it starts, before it queues a child (#4492)",
	async () => {
		const sandbox = new GitSandbox();
		const { clone } = await sandbox.remoteWithClone();
		const { placement, worktree } = await recordedPlacement({
			placement: "shared",
			workspace: workspace({ repo: clone, branch: "main", base: "main", worktree: clone }),
		});
		const f = await fixture("shared-dispatch-snapshot-settings", {
			workspace: placement.workspace!,
			workspaceWorktree: worktree,
			snapshots: { maxFileBytes: -1 },
		});
		try {
			const { parent, outcomes } = await fanOut(1)((await boundChild()) as never);
			const result = await run(
				parent,
				{},
				{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
			);
			assert.equal(result.status, "failed", JSON.stringify(result));
			assert.equal(result.failureDetail?.name, "WorkspaceConfigError", JSON.stringify(result));
			assert.deepEqual(outcomes, [], "the root never ran its body");
			const rows = await sqlPoolStorage(f.hostJournal)!.read((executor) =>
				executor.all(`SELECT id FROM ${PREFIX}wf_runs_work WHERE root = 'root'`),
			);
			assert.deepEqual(rows, [], "and queued nothing");
		} finally {
			await f.close();
			sandbox.dispose();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
