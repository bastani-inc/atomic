import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import {
	bindingOf,
	setWorktreeSnapshotGit,
	WorkspaceRestoreError,
	workspace,
} from "../../packages/coding-agent/src/index.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { listWorkflowSnapshotBoundaries } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import {
	isWorkspaceRestoreUnavailableError,
	type WorkspaceRestoreUnavailableError,
} from "../../packages/workflows/src/workers/placement-errors.js";
import type { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { RestoreBackoff } from "../../packages/workflows/src/workers/restore-backoff.js";
import type { WorkspaceBinding } from "../../packages/workflows/src/workers/workspace-binding.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	binding,
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	fanOut,
	fixture,
	libsql,
	PREFIX,
	satellite,
	stubWorker,
} from "../helpers/workflow-shared-pool-coordinator.js";
import { createRepository, git, workspaceSandbox } from "../helpers/workspace-repos.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

/** Bound work a worker host restores by default from worktree snapshots, backs off from, or places by a child's own workspace (#4416). */
useTemporaryAgentDir();

test(
	"a host whose restore keeps failing backs off instead of claiming the child again, and the child fails typed once no host can restore it (#4416)",
	async () => {
		const f = await fixture("shared-coordinator-restore-backoff", { workspace: binding, claimWindowMs: 1_500 });
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			// Registered as a host that restores, as a worker host reports itself.
			await f.shared.reportHost({
				host: "host-b",
				labels: {},
				git: "system",
				restore: true,
				workers: 2,
				maxWorkers: 2,
				roots: ["root"],
			});
			const unreachable = new WorkspaceRestoreError("commits-unavailable", {
				snapshotId: null,
				head: binding.head,
				commits: [binding.head],
			});
			const failures: Error[] = [];
			let restores = 0;
			host = await satellite(
				f,
				root,
				{
					restore: async () => {
						restores++;
						throw unreachable;
					},
					// A first wait longer than the test: any second restore would be a claim the backoff let through.
					restoreBackoff: new RestoreBackoff(undefined, { firstMs: 600_000, maxMs: 600_000 }),
				},
				failures,
			);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			const [failure] = outcomes;
			assert.ok(isWorkspaceRestoreUnavailableError(failure), String(failure));
			const typed = failure as WorkspaceRestoreUnavailableError;
			assert.deepEqual(
				[typed.code, typed.reason, typed.claimWindowMs, typed.binding.tree],
				["workspace-restore-unavailable", "no-capable-host", 1_500, "t1"],
			);
			assert.equal(
				(typed.cause as Error | undefined)?.name,
				"WorkspaceRestoreError",
				"its cause is the host's failure",
			);
			assert.equal((typed.cause as Error).message, unreachable.message);
			assert.equal(restores, 1, "the host claimed the child once, and not again while it backed off");
			assert.deepEqual(failures, [unreachable], "and reported the failure once");
			assert.deepEqual(f.claims(), [], "no worker ran it");
			const rows = await sqlPoolStorage(f.hostJournal)!.read((executor) =>
				executor.all(`SELECT state, generation FROM ${PREFIX}wf_runs_work WHERE root = 'root'`),
			);
			assert.deepEqual(
				rows.map((row) => [row.state, Number(row.generation)]),
				[["failed", 0]],
				"the failed restore was no attempt: the child failed for its placement, not its retry limit",
			);
		} finally {
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host started without restore restores a bound child from the snapshot its binding names in the shared journal, uncommitted content included, and runs it there (#4416)",
	async () => {
		const sandbox = new GitSandbox();
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "committed\n" });
		sandbox.write(join(clone, "a.txt"), "uncommitted\n");
		sandbox.write(join(clone, "notes", "new.txt"), "untracked\n");
		let recorded: WorkspaceBinding | undefined;
		const f = await fixture("shared-coordinator-default-restore", {
			// Another run, on the root's host, recorded the snapshot of the dirty clone the root's children are bound to.
			bind: async (backend) => {
				const producer = workflow({
					name: "shared-pool-snapshot-producer",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						await ctx.tool("step", {}, async () => "done");
						return {};
					},
				});
				const produced = await run(
					producer,
					{},
					{ runId: "producer", cwd: clone, store: createStore(), durableBackend: backend },
				);
				assert.equal(produced.status, "completed", JSON.stringify(produced));
				const [boundary] = await listWorkflowSnapshotBoundaries(backend.snapshotJournal, "producer");
				assert.ok(boundary, "the producer recorded a snapshot");
				recorded = bindingOf(boundary.snapshot);
				return recorded;
			},
		});
		// The host restores with the git it was given: the git this process resolves for snapshots runs nowhere.
		setWorktreeSnapshotGit(async () => ({ path: join(f.directory, "no-such-git"), env: {} }));
		const lookups = vi.spyOn(SqlSharedPool.prototype, "recordedSnapshots");
		const clears = vi.spyOn(SqlSharedPool.prototype, "clearRestoreBackoff");
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(3)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			await f.root();
			const agentDir = join(f.directory, "host-c", "agent");
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir,
				maxWorkers: 1,
				hostId: "host-c",
				git: { path: sandbox.executable.path, env: { ...sandbox.executable.env } as Record<string, string> },
				workerEntry: stubWorker,
			});
			assert.equal((await host.stats()).restore, true, "a host with git restores by default");
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed", "completed", "completed"]);
			const claims = f.claims();
			assert.equal(claims.length, 3);
			for (const [claimer, , cwd] of claims) {
				assert.equal(claimer, "host-c");
				assert.ok(cwd?.startsWith(join(agentDir, "worktree-snapshots", "worktrees")), cwd);
				assert.equal(readFileSync(join(cwd!, "a.txt"), "utf8"), "uncommitted\n", "uncommitted content restored");
				assert.equal(readFileSync(join(cwd!, "notes", "new.txt"), "utf8"), "untracked\n");
			}
			assert.equal(lookups.mock.calls.length, 1, "three children of one binding read the journal's snapshots once");
			const records = await f.shared.stageWorkspaces("root");
			assert.deepEqual(
				records.map((record) => [record.host, record.binding]),
				claims.map(() => ["host-c", recorded]),
			);
			assert.deepEqual(records.map((record) => record.worktree).sort(), claims.map(([, , cwd]) => cwd).sort());
			assert.equal((await host.stats()).lastPlacementFailure, undefined);
			assert.equal(clears.mock.calls.length, 0, "a host that never failed to restore has no backoff to clear");
		} finally {
			lookups.mockRestore();
			clears.mockRestore();
			await host?.stop();
			await execution.catch(() => {});
			await f.close();
			sandbox.dispose();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a child bound with ctx.workflow(child, { workspace }) under a shared root runs only on a host that has its tree, bound to that host's worktree (#4416)",
	async () => {
		const dirs = workspaceSandbox("shared-coordinator-child-workspace-");
		const f = await fixture("shared-coordinator-child-workspace", {});
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const repo = createRepository(dirs.root, "child-repo");
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const outcomes: string[] = [];
		const parent = workflow({
			name: "shared-pool-child-workspace-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const result = await ctx.workflow(child as never, {
					inputs: {},
					workspace: workspace({ repo, branch: "feat/child" }),
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
		let cold: PoolCoordinator | undefined;
		let host: PoolCoordinator | undefined;
		try {
			const root = await f.root();
			cold = await satellite(f, root, {}, [], "host-c", 1);
			await sleep(1_500);
			assert.deepEqual(f.claims(), [], "neither the root's own worker nor a host without its tree takes the child");
			const asked: WorkspaceBinding[] = [];
			host = await satellite(
				f,
				root,
				{
					prefer: async (requested) => {
						asked.push(requested);
						return warm;
					},
				},
				[],
				"host-b",
				1,
			);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.deepEqual(
				f.claims().map(([claimer, , cwd, worktree]) => [claimer, cwd, worktree]),
				[["host-b", warm, warm]],
				"the child ran on the host with its tree, bound to that host's worktree",
			);
			const own = {
				remotes: [],
				head: git(repo, "rev-parse", "feat/child"),
				tree: git(repo, "rev-parse", "feat/child^{tree}"),
			};
			assert.deepEqual(
				asked.map(({ remotes, head, tree }) => ({ remotes, head, tree })),
				[own],
				"placement asked for the child's own binding",
			);
			const [record] = await f.shared.stageWorkspaces("root");
			assert.deepEqual([record?.host, record?.worktree], ["host-b", warm]);
			assert.deepEqual(Object.keys(record?.binding ?? {}).sort(), ["envHash", "head", "remotes", "tree"]);
			assert.deepEqual({ ...record?.binding, envHash: undefined }, { ...own, envHash: undefined });
		} finally {
			await cold?.stopSatellite();
			await cold?.shutdown();
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
			dirs.cleanup();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
