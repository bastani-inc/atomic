import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableHash, InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import * as toolPrimitives from "../../packages/workflows/src/durable/tool-primitive.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

test("resumes interrupted current root tool work without repeating its callback", async () => {
	const runId = "current-root-replay";
	let callbackCalls = 0;
	let interrupt = true;
	const definition = workflow({
		name: "current-root-replay",
		description: "",
		inputs: {},
		outputs: { value: Type.Number() },
		run: async (ctx) => {
			const value = await ctx.tool("workflow-run-timing", { public: true }, async () => {
				callbackCalls += 1;
				return 23;
			});
			if (interrupt) throw new Error("interrupted after checkpoint");
			return { value };
		},
	});
	const backend = new InMemoryDurableBackend();
	const first = await run(definition, {}, { runId, store: createStore(), durableBackend: backend });
	assert.equal(first.status, "failed");
	const checkpoints = backend.listCheckpoints(runId);
	const tool = checkpoints.find(
		(checkpoint): checkpoint is DurableToolCheckpoint =>
			checkpoint.kind === "tool" &&
			checkpoint.name === "workflow-run-timing" &&
			checkpoint.argsHash !== "workflow-run-timing",
	)!;
	assert.ok(tool.topology);
	assert.equal(tool.topology.run?.runId, runId);
	interrupt = false;
	const resumed = await run(definition, {}, { runId, store: createStore(), durableBackend: backend });
	assert.equal(resumed.status, "completed");
	assert.deepEqual(resumed.result, { value: 23 });
	assert.equal(callbackCalls, 1);
});

test("rejects a cached tool without topology instead of replaying or upgrading it", async () => {
	const backend = new InMemoryDurableBackend();
	const workflowId = "missing-topology";
	const argsHash = durableHash({ name: "effect", args: {}, ordinal: 1 });
	backend.registerWorkflow({ workflowId, name: "missing-topology", inputs: {}, createdAt: 1, status: "paused" });
	backend.recordCheckpoint({
		kind: "tool",
		workflowId,
		checkpointId: `tool:${argsHash}`,
		name: "effect",
		argsHash,
		output: 23,
		completedAt: 1,
	});
	let calls = 0;
	const tool = toolPrimitives.createToolPrimitive({
		workflowId,
		backend,
		nextCheckpointId: () => "next",
		throwIfCancelled: () => {},
		runTopology: { runId: workflowId, runName: "missing-topology" },
	});
	await assert.rejects(
		tool("effect", {}, async () => {
			calls += 1;
			return 23;
		}),
		(error: Error) => {
			assert.ok(error instanceof toolPrimitives.DurableToolTopologyError);
			assert.equal(error.workflowId, workflowId);
			assert.equal(error.argsHash, argsHash);
			return true;
		},
	);
	assert.equal(calls, 0);
	assert.equal(backend.listCheckpoints(workflowId).length, 1);
});
