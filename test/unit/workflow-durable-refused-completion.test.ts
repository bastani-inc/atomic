import assert from "node:assert/strict";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	completedRunAttempt,
	recordRunCompletedCheckpointAsync,
} from "../../packages/workflows/src/durable/attempt-identity.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { RUN_TIMING_CHECKPOINT_NAME } from "../../packages/workflows/src/durable/run-timing.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";

afterEach(() => setDurableBackend(undefined));

/**
 * A run whose "completed" status write, and its retry, the store refuses (#5133): its work is done, so the run reads as
 * completed, in the process that ran it and after the journal is opened again, not as a run still in flight.
 */
test("a run whose completed status write is refused twice reads as completed (#5133)", async () => {
	const backend = await JournalTestBackend.create();
	setDurableBackend(backend);
	const commitStatus = backend.commitWorkflowStatus.bind(backend);
	let refused = 0;
	backend.commitWorkflowStatus = ((...args: Parameters<typeof backend.commitWorkflowStatus>) => {
		if (args[1] === "completed" && refused < 2) {
			refused += 1;
			return Promise.reject(
				new StorageUnavailableError({ adapter: "test", location: "refused" }, new Error("refused") as never),
			);
		}
		return commitStatus(...args);
	}) as typeof backend.commitWorkflowStatus;
	let calls = 0;
	const def = workflow({
		name: "refused-completion",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("work", {}, async () => {
				calls += 1;
				return "done";
			});
			return {};
		},
	}) as WorkflowDefinition;
	const runId = `refused-completion-${Date.now()}`;
	// The run's work is done; its call reports that the ending could not be saved.
	await run(def, {}, { runId, store: createStore(), durableBackend: backend }).catch(() => undefined);
	assert.equal(refused, 2, "the status write and its retry were refused");
	assert.equal(calls, 1);
	assert.equal(backend.getWorkflow(runId)?.status, "completed", "the run reads as completed where it ran");
	// The record is one every release reads as run timing: it names no graph node.
	const record = backend.listCheckpoints(runId).find((checkpoint) => checkpoint.checkpointId.startsWith("run-end:"));
	assert.equal(record?.kind === "tool" ? record.name : undefined, RUN_TIMING_CHECKPOINT_NAME);
	const reopened = await backend.reopen();
	assert.equal(reopened.getWorkflow(runId)?.status, "completed", "the run reads as completed after a restart");
	// Opening it wrote the refused status: a reader of the journal's run rows alone sees it completed too.
	const journal = await openSqlRunJournal(reopened.databasePath);
	try {
		assert.equal((await journal.getRun(runId))?.status, "completed", "the run's own row says completed");
	} finally {
		await journal.close();
	}
	assert.equal(
		reopened.listResumableWorkflows().some((entry) => entry.workflowId === runId),
		false,
		"a completed run is not offered for resume",
	);
});

test("a run whose completed status the store never takes reads as completed when its journal is opened again (#5133)", async () => {
	const backend = await JournalTestBackend.create();
	setDurableBackend(backend);
	const commitStatus = backend.commitWorkflowStatus.bind(backend);
	backend.commitWorkflowStatus = ((...args: Parameters<typeof backend.commitWorkflowStatus>) =>
		args[1] === "completed"
			? Promise.reject(
					new StorageUnavailableError({ adapter: "test", location: "refused" }, new Error("refused") as never),
				)
			: commitStatus(...args)) as typeof backend.commitWorkflowStatus;
	const def = workflow({
		name: "never-completed",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("work", {}, async () => "done");
			return {};
		},
	}) as WorkflowDefinition;
	const runId = `never-completed-${Date.now()}`;
	await run(def, {}, { runId, store: createStore(), durableBackend: backend }).catch(() => undefined);
	const reopened = await backend.reopen();
	assert.equal(reopened.getWorkflow(runId)?.status, "completed");
});

test("a run that failed after an earlier attempt completed does not read as completed (#5133)", async () => {
	const backend = await JournalTestBackend.create();
	setDurableBackend(backend);
	let failing = false;
	const def = workflow({
		name: "completed-then-failed",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("work", {}, async () => "done");
			if (failing) throw new Error("planned failure");
			return {};
		},
	}) as WorkflowDefinition;
	const runId = `completed-then-failed-${Date.now()}`;
	assert.equal((await run(def, {}, { runId, store: createStore(), durableBackend: backend })).status, "completed");
	failing = true;
	assert.equal((await run(def, {}, { runId, store: createStore(), durableBackend: backend })).status, "failed");
	assert.equal(backend.getWorkflow(runId)?.status, "failed");
	const reopened = await backend.reopen();
	assert.equal(reopened.getWorkflow(runId)?.status, "failed");
});

test("a run that returned blocked does not read as completed when its status write is refused (#5133)", async () => {
	const backend = await JournalTestBackend.create();
	setDurableBackend(backend);
	const commitStatus = backend.commitWorkflowStatus.bind(backend);
	backend.commitWorkflowStatus = ((...args: Parameters<typeof backend.commitWorkflowStatus>) =>
		args[1] === "blocked"
			? Promise.reject(
					new StorageUnavailableError({ adapter: "test", location: "refused" }, new Error("refused") as never),
				)
			: commitStatus(...args)) as typeof backend.commitWorkflowStatus;
	const def = workflow({
		name: "returned-blocked",
		description: "",
		inputs: {},
		outputs: {
			status: Type.Union([Type.Literal("completed"), Type.Literal("blocked")]),
			summary: Type.String(),
		},
		run: async (ctx) => {
			await ctx.tool("work", {}, async () => "done");
			return { status: "blocked" as const, summary: "checks pending" };
		},
	}) as WorkflowDefinition;
	const runId = `returned-blocked-${Date.now()}`;
	await run(def, {}, { runId, store: createStore(), durableBackend: backend }).catch(() => undefined);
	assert.notEqual(backend.getWorkflow(runId)?.status, "completed");
	const reopened = await backend.reopen();
	assert.notEqual(reopened.getWorkflow(runId)?.status, "completed");
});

test("opening only some runs of a journal writes the refused completed status of those it opens (#5133)", async () => {
	const backend = await JournalTestBackend.create();
	setDurableBackend(backend);
	const commitStatus = backend.commitWorkflowStatus.bind(backend);
	backend.commitWorkflowStatus = ((...args: Parameters<typeof backend.commitWorkflowStatus>) =>
		args[1] === "completed"
			? Promise.reject(
					new StorageUnavailableError({ adapter: "test", location: "refused" }, new Error("refused") as never),
				)
			: commitStatus(...args)) as typeof backend.commitWorkflowStatus;
	const def = workflow({
		name: "opened-alone",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("work", {}, async () => "done");
			return {};
		},
	}) as WorkflowDefinition;
	const opened = `opened-alone-${Date.now()}`;
	const other = `${opened}-other`;
	for (const runId of [opened, other])
		await run(def, {}, { runId, store: createStore(), durableBackend: backend }).catch(() => undefined);
	await backend.close();
	const journal = await openSqlRunJournal(backend.databasePath);
	const partial = await JournalDurableBackend.open(journal, { runs: [opened, "no-such-run"] });
	try {
		assert.equal(partial.getWorkflow(opened)?.status, "completed");
		assert.equal((await journal.getRun(opened))?.status, "completed", "the run it opened is written");
		assert.equal((await journal.getRun(other))?.status, "running", "a run it did not open is left as it was");
	} finally {
		await partial.close();
	}
});

test("only a run-end record of a run's timing names the attempt that completed (#5133)", () => {
	const record = {
		kind: "tool" as const,
		workflowId: "w",
		checkpointId: "run-end:2",
		name: RUN_TIMING_CHECKPOINT_NAME,
		argsHash: RUN_TIMING_CHECKPOINT_NAME,
		output: { completedAttempt: 2 },
		completedAt: 1,
	};
	assert.equal(completedRunAttempt(record), 2);
	assert.equal(completedRunAttempt({ ...record, checkpointId: "run-timing:5" }), undefined, "another timing record");
	assert.equal(completedRunAttempt({ ...record, output: null }), undefined);
	assert.equal(completedRunAttempt({ ...record, output: { completedAttempt: "2" } }), undefined);
	assert.equal(
		completedRunAttempt({
			kind: "stage",
			workflowId: "w",
			checkpointId: "run-end:2",
			name: "s",
			replayKey: "s",
			completedAt: 1,
		} as DurableCheckpoint),
		undefined,
		"a stage record under the same id",
	);
});

test("a run-end record keeps the run's elapsed time and names its attempt (#5133)", async () => {
	const committed: DurableCheckpoint[] = [];
	const backend = (attempt: number | undefined, timing: unknown) =>
		({
			...(attempt === undefined ? {} : { workflowAttempt: () => attempt }),
			getToolOutput: (_workflowId: string, argsHash: string) =>
				argsHash === RUN_TIMING_CHECKPOINT_NAME ? timing : undefined,
			commitCheckpoint: async (checkpoint: DurableCheckpoint) => {
				committed.push(checkpoint);
			},
		}) as unknown as DurableWorkflowBackend;
	await recordRunCompletedCheckpointAsync(backend(2, { elapsedMs: 1234 }), "w");
	await recordRunCompletedCheckpointAsync(backend(undefined, { elapsedMs: "1234" }), "w");
	await recordRunCompletedCheckpointAsync(backend(0, null), "w");
	assert.deepEqual(
		committed.map((checkpoint) => [
			checkpoint.checkpointId,
			checkpoint.kind === "tool" ? [checkpoint.name, checkpoint.argsHash, checkpoint.output] : undefined,
		]),
		[
			[
				"run-end:2",
				[RUN_TIMING_CHECKPOINT_NAME, RUN_TIMING_CHECKPOINT_NAME, { elapsedMs: 1234, completedAttempt: 2 }],
			],
			["run-end:0", [RUN_TIMING_CHECKPOINT_NAME, RUN_TIMING_CHECKPOINT_NAME, { completedAttempt: 0 }]],
			["run-end:0", [RUN_TIMING_CHECKPOINT_NAME, RUN_TIMING_CHECKPOINT_NAME, { completedAttempt: 0 }]],
		],
	);
});
