import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { createStore, run, Type, workflow } from "./executor-shared.js";

const WORKFLOW_ID = "wf-cached-stage-usage";

function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

test("durable checkpoint replay emits persisted stage usage", async () => {
	const backend = new InMemoryDurableBackend();
	const replayKey = "stage:cached:1";
	backend.registerWorkflow({ workflowId: WORKFLOW_ID, name: "cached-usage", inputs: {}, createdAt: Date.now(), status: "running" });
	backend.recordCheckpoint({
		kind: "stage",
		workflowId: WORKFLOW_ID,
		checkpointId: `stage:${replayKey}`,
		name: "cached",
		replayKey,
		output: "cached output",
		completedAt: Date.now(),
		sessionId: "cached-stage-session",
		sessionFile: "/tmp/cached-stage.jsonl",
		usage: usage(40, 4),
		usageComplete: true,
	});
	const def = workflow({
		name: "cached-usage",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => ({ result: await ctx.stage("cached").complete("ignored") }),
	});
	const emitted: Array<{ stageId: string; usage: Usage; settled?: boolean }> = [];
	const result = await run(def, {}, {
		runId: WORKFLOW_ID,
		store: createStore(),
		durableBackend: backend,
		usageRollup: {
			emitStageRollup(stageId, nextUsage, meta) {
				emitted.push({ stageId, usage: nextUsage, settled: meta.settled });
			},
		},
	});
	assert.equal(result.status, "completed");
	assert.equal(result.result?.["result"], "cached output");
	assert.equal(emitted.length, 1);
	assert.deepEqual(emitted[0]?.usage, usage(40, 4));
	assert.equal(emitted[0]?.settled, true);
});

test("durable task replay emits persisted stage usage", async () => {
	const workflowId = "wf-cached-task-usage";
	const replayKey = "stage:task:cached-task:1";
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId, name: "cached-task-usage", inputs: {}, createdAt: Date.now(), status: "running" });
	backend.recordCheckpoint({
		kind: "stage",
		workflowId,
		checkpointId: `task:${replayKey}`,
		name: "cached-task",
		replayKey,
		output: { name: "cached-task", stageName: "cached-task", text: "cached task output" },
		completedAt: Date.now(),
		sessionId: "cached-task-session",
		sessionFile: "/tmp/cached-task.jsonl",
		usage: usage(50, 5),
		usageComplete: false,
	});
	const def = workflow({
		name: "cached-task-usage",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => ({ result: (await ctx.task("cached-task", { prompt: "ignored" })).text }),
	});
	const emitted: Array<{ usage: Usage; settled?: boolean }> = [];
	const result = await run(def, {}, {
		runId: workflowId,
		store: createStore(),
		durableBackend: backend,
		usageRollup: {
			emitStageRollup(_stageId, nextUsage, meta) { emitted.push({ usage: nextUsage, settled: meta.settled }); },
		},
	});
	assert.equal(result.status, "completed");
	assert.equal(result.result?.["result"], "cached task output");
	assert.deepEqual(emitted, [{ usage: usage(50, 5), settled: false }]);
});

test("durable child-workflow replay restores scoped stage usage", async () => {
	const workflowId = "wf-cached-child-usage";
	const boundaryKey = "workflow:workflow:child:1";
	const childStageKey = `${boundaryKey}:stage:child-stage:1`;
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId, name: "cached-child-usage", inputs: {}, createdAt: Date.now(), status: "running" });
	backend.recordCheckpoint({
		kind: "stage",
		workflowId,
		checkpointId: `workflow:${boundaryKey}`,
		name: "workflow:child",
		replayKey: boundaryKey,
		output: { workflow: "child", runId: "old-child-run", status: "completed", outputs: { value: "cached child output" } },
		completedAt: Date.now(),
	});
	backend.recordCheckpoint({
		kind: "stage",
		workflowId,
		checkpointId: `stage:${childStageKey}`,
		name: "child-stage",
		replayKey: childStageKey,
		output: "child stage output",
		completedAt: Date.now(),
		sessionId: "cached-child-stage-session",
		sessionFile: "/tmp/cached-child-stage.jsonl",
		usage: usage(60, 6),
		usageComplete: true,
	});
	backend.recordCheckpoint({
		kind: "stage",
		workflowId,
		checkpointId: "stage:unrelated-nested-child",
		name: "unrelated-nested-child",
		replayKey: `workflow:workflow:other:1:${boundaryKey}:stage:unrelated:1`,
		output: "unrelated output",
		completedAt: Date.now(),
		sessionId: "unrelated-stage-session",
		usage: usage(90, 9),
		usageComplete: true,
	});
	const child = workflow({
		name: "child",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async () => { throw new Error("cached child must not execute"); },
	});
	const parent = workflow({
		name: "cached-child-usage",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			const result = await ctx.workflow(child);
			return { result: String(result.outputs["value"]) };
		},
	});
	const emitted: Usage[] = [];
	const result = await run(parent, {}, {
		runId: workflowId,
		store: createStore(),
		durableBackend: backend,
		usageRollup: { emitStageRollup: (_stageId, nextUsage) => { emitted.push(nextUsage); } },
	});
	assert.equal(result.status, "completed");
	assert.equal(result.result?.["result"], "cached child output");
	assert.deepEqual(emitted, [usage(60, 6)]);
});
