import assert from "node:assert/strict";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
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
	const reopened = await backend.reopen();
	assert.equal(reopened.getWorkflow(runId)?.status, "completed", "the run reads as completed after a restart");
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
