import assert from "node:assert/strict";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, isWorkspaceConfigError } from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { listWorkflowSnapshotBoundaries } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run as sdkRun } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { openSqlSnapshotJournalBackend } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
let priorAgentDir: string | undefined;
beforeEach(() => {
	sandbox = new GitSandbox();
	priorAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = sandbox.path("agent");
});
afterEach(() => {
	if (priorAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = priorAgentDir;
	sandbox.dispose();
});

const threeTools = workflow({
	name: "three-tools",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		for (const value of ["one", "two", "three"]) {
			await ctx.tool(value, {}, async () => {
				sandbox.write(`${ctx.cwd}/state.txt`, `${value}\n`);
				return value;
			});
		}
		return {};
	},
});

test("an SDK run takes snapshot settings from the project's settings, and its own options override them (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone("repo", {
		".atomic/settings.json": JSON.stringify({ snapshots: { includeUntracked: false, fullEvery: 5 } }),
		"state.txt": "base\n",
	});
	sandbox.write(`${clone}/scratch.txt`, "untracked\n");
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const result = await sdkRun(
		threeTools,
		{},
		{ cwd: clone, durableBackend: fixture.backend, store: createStore(), snapshots: { fullEvery: 2 } },
	);
	assert.equal(result.status, "completed", result.error);
	const boundaries = await listWorkflowSnapshotBoundaries(fixture.journal, result.runId);
	assert.deepEqual(
		boundaries.map((boundary) => boundary.snapshot.chain.length),
		[1, 2, 1],
		"fullEvery from the run's own options, not the project's",
	);
	assert.ok(
		boundaries[0]!.snapshot.omitted.some(
			(entry) => entry.reason === "untracked-excluded" && entry.path === "scratch.txt",
		),
		"includeUntracked from the project's settings",
	);
	assert.deepEqual(fixture.backend.getWorkflow(result.runId)!.snapshots, {
		...DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		includeUntracked: false,
		fullEvery: 2,
	});
	await fixture.close();
});

test("an SDK run rejects invalid snapshot options before it records anything (#4245)", async () => {
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	await assert.rejects(
		sdkRun(threeTools, {}, { cwd: sandbox.root, durableBackend: fixture.backend, snapshots: { fullEvery: 0 } }),
		(error: unknown) =>
			isWorkspaceConfigError(error) &&
			error.code === "invalid-setting" &&
			error.source === "sdk" &&
			error.field === "snapshots.fullEvery",
	);
	assert.deepEqual(await fixture.journal.listRuns(), []);
	await fixture.close();
});
