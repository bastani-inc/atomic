import assert from "node:assert/strict";
import { test } from "vitest";
import { JournalTestBackend as InMemoryDurableBackend } from "../helpers/journal-backend.js";
import { createStore, run, Type, workflow } from "./executor-shared.js";

test("ctx.task replay prefers task-shaped checkpoint and hydrates lifecycle metadata", async () => {
	const backend = await InMemoryDurableBackend.create();
	const workflowId = "wf-task-selector";
	const replayKey = "stage:task:review:1";
	await backend.registerWorkflow({ workflowId, name: "task-selector", inputs: {}, createdAt: 1, status: "running" });
	await backend.recordCheckpoint({
		kind: "stage",
		workflowId,
		checkpointId: `stage:${replayKey}`,
		name: "review",
		replayKey,
		output: "generic lifecycle text",
		completedAt: 20,
		startedAt: 10,
		endedAt: 20,
		durationMs: 10,
		result: "generic lifecycle text",
		sessionId: "session-task",
		sessionFile: "/tmp/task.jsonl",
		model: "model-task",
	});
	await backend.recordCheckpoint({
		kind: "stage",
		workflowId,
		checkpointId: `task:${replayKey}`,
		name: "review",
		replayKey,
		output: { name: "review", stageName: "review", text: "task replay text" },
		completedAt: 30,
	});
	const def = workflow({
		name: "task-selector",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => ({ result: (await ctx.task("review", { prompt: "ignored" })).text }),
	});

	const store = createStore();
	const result = await run(
		def,
		{},
		{
			runId: workflowId,
			store,
			durableBackend: backend,
			adapters: {
				prompt: {
					prompt: async () => {
						throw new Error("task should not re-execute");
					},
				},
			},
		},
	);

	const stage = store.runs()[0]?.stages[0];
	assert.equal(result.status, "completed");
	assert.equal(result.result?.result, "task replay text");
	assert.equal(stage?.replayed, true);
	assert.equal(stage?.startedAt, 10);
	assert.equal(stage?.endedAt, 20);
	assert.equal(stage?.durationMs, 10);
	assert.equal(stage?.result, "generic lifecycle text");
	assert.equal(stage?.sessionId, "session-task");
	assert.equal(stage?.sessionFile, "/tmp/task.jsonl");
	assert.equal(stage?.model, "model-task");
});
