import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { type WorktreeSnapshot, workspace } from "../../packages/coding-agent/src/index.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { DispatchSnapshots } from "../../packages/workflows/src/workers/dispatch-snapshot.js";
import type { startWorkflowWorkerHost } from "../../packages/workflows/src/workers/worker-host.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	type Fixture,
	fixture,
	libsql,
	PREFIX,
	stubWorker,
} from "../helpers/workflow-shared-pool-coordinator.js";
import { commitFile, createRepository, git, workspaceSandbox } from "../helpers/workspace-repos.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

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
