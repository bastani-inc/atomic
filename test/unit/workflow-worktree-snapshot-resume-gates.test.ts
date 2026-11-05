import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { isWorkspaceConfigError } from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import type { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	crossProjectResumeMessage,
	resumeDurableWorkflow,
} from "../../packages/workflows/src/durable/resume-runtime.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import {
	closeSnapshotJournals,
	openSqlSnapshotJournal,
	openSqlSnapshotJournalBackend,
} from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
let priorAgentDir: string | undefined;
beforeEach(() => {
	sandbox = new GitSandbox();
	priorAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = sandbox.path("agent");
});
afterEach(async () => {
	await closeSnapshotJournals();
	if (priorAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = priorAgentDir;
	sandbox.dispose();
});

const interrupted = (name = "interrupted") =>
	workflow({
		name,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => "done");
			throw new Error("interrupted");
		},
	});

test("resume rejects invalid snapshot settings before it touches the journal (#4245)", async () => {
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	await assert.rejects(
		resumeDurableWorkflow("no-such-run", {
			registry: createRegistry(),
			durableBackend: fixture.backend,
			baseRunOpts: { snapshots: { maxFileBytes: 0 } },
			jobs: createJobTracker(),
		}),
		(error: unknown) =>
			isWorkspaceConfigError(error) &&
			error.code === "invalid-setting" &&
			error.source === "sdk" &&
			error.field === "snapshots.maxFileBytes",
	);
	await fixture.close();
});

/** A run recorded in `recorded` with snapshots turned off, so nothing in its journal can restore a checkout. */
async function runWithoutSnapshots(backend: DurableWorkflowBackend, recorded: string, definition = interrupted()) {
	const first = await run(
		definition,
		{},
		{ cwd: recorded, durableBackend: backend, store: createStore(), snapshots: { enabled: false } },
	);
	assert.equal(first.status, "failed");
	return { definition, first };
}

test("a run with no snapshots still refuses to resume from another project, naming where it was recorded (#4245)", async () => {
	const recorded = (await sandbox.remoteWithClone("recorded")).clone;
	const elsewhere = (await sandbox.remoteWithClone("elsewhere")).clone;
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const { definition, first } = await runWithoutSnapshots(fixture.backend, recorded);
	const result = await resumeDurableWorkflow(first.runId, {
		registry: createRegistry().register(definition),
		durableBackend: fixture.backend,
		baseRunOpts: { cwd: elsewhere, store: createStore(), durableBackend: fixture.backend },
		jobs: createJobTracker(),
	});
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.reason, "different_project");
	assert.equal(result.message, crossProjectResumeMessage(first.runId, recorded));
	await fixture.close();
});

test("a backend with no snapshot journal resumes without looking for snapshots (#4245)", async () => {
	const recorded = (await sandbox.remoteWithClone("recorded")).clone;
	const elsewhere = (await sandbox.remoteWithClone("elsewhere")).clone;
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const { definition, first } = await runWithoutSnapshots(fixture.backend, recorded);
	const withoutJournal = new Proxy(fixture.backend, {
		get(target, key) {
			if (key === "snapshotJournal") return undefined;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as JournalDurableBackend;
	const result = await resumeDurableWorkflow(first.runId, {
		registry: createRegistry().register(definition),
		durableBackend: withoutJournal,
		baseRunOpts: { cwd: elsewhere, store: createStore(), durableBackend: withoutJournal },
		jobs: createJobTracker(),
	});
	assert.equal(result.ok === false && result.reason, "different_project");
	await fixture.close();
});

test("resuming an unknown run reads no journal history (#4245)", async () => {
	const fixture = await openSqlSnapshotJournal(sandbox.path("journal.sqlite"));
	let reads = 0;
	const counting = new Proxy(fixture.journal, {
		get(target, key) {
			if (key === "read")
				return (...args: Parameters<SqlRunJournal["read"]>) => {
					reads++;
					return target.read(...args);
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as SqlRunJournal;
	const backend = await JournalDurableBackend.open(counting, { runs: [] });
	const result = await resumeDurableWorkflow("11111111-2222-4333-8444-555555555555", {
		registry: createRegistry(),
		durableBackend: backend,
		baseRunOpts: { store: createStore(), durableBackend: backend },
		jobs: createJobTracker(),
	});
	assert.equal(result.ok, false);
	assert.equal(reads, 0);
	await backend.close();
	await fixture.database.close();
});

test("a resume whose startup fails for a reason other than drift reports it instead of throwing (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	writeFileSync(sandbox.path("partial-wt"), "not a directory\n");
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const definition = workflow({
		name: "worktree-setup-fails",
		description: "",
		inputs: { git_worktree_dir: Type.String() },
		outputs: {},
		worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir" },
		run: async (ctx) => {
			await ctx.tool("unreached", {}, async () => "done");
			return {};
		},
	}) as unknown as WorkflowDefinition;
	await fixture.backend.commitWorkflowRegistration({
		workflowId: testRunId("setup-fails"),
		name: "worktree-setup-fails",
		inputs: { git_worktree_dir: "../partial-wt" },
		createdAt: 1,
		status: "failed",
		completedCheckpoints: 1,
		invocationCwd: clone,
		resumable: true,
	});
	const result = await resumeDurableWorkflow(testRunId("setup-fails"), {
		registry: createRegistry().register(definition),
		durableBackend: fixture.backend,
		baseRunOpts: { cwd: clone, store: createStore(), durableBackend: fixture.backend },
		jobs: createJobTracker(),
	});
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.reason, "startup_failed");
	assert.match(result.message, /already exists but is not a directory/);
	await fixture.close();
});
