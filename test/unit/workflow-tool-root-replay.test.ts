import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { completedWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

describe("root tool replay", () => {
	test("keeps topology-less root fallback unchanged and preserves the reserved public name", async () => {
		const runId = "legacy-root-fallback";
		let callbackCalls = 0;
		const definition = workflow({
			name: "legacy-root-fallback",
			description: "",
			inputs: {},
			outputs: { value: Type.Number() },
			run: async (ctx) => ({
				value: await ctx.tool("workflow-run-timing", { public: true }, async () => {
					callbackCalls += 1;
					return 23;
				}),
			}),
		});
		const seedBackend = new InMemoryDurableBackend();
		await run(definition, {}, { runId, store: createStore(), durableBackend: seedBackend });
		const seeded = seedBackend
			.listCheckpoints(runId)
			.find(
				(checkpoint): checkpoint is DurableToolCheckpoint =>
					checkpoint.kind === "tool" && checkpoint.argsHash !== "workflow-run-timing",
			)!;
		callbackCalls = 0;
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: runId,
			name: definition.name,
			inputs: {},
			createdAt: 1,
			status: "paused",
			resumable: true,
		});
		backend.recordCheckpoint({
			kind: "tool",
			workflowId: runId,
			checkpointId: seeded.checkpointId,
			name: seeded.name,
			argsHash: seeded.argsHash,
			output: seeded.output,
			completedAt: 1,
		});

		const result = await run(definition, {}, { runId, store: createStore(), durableBackend: backend });
		assert.equal(result.status, "completed");
		assert.deepEqual(result.result, { value: 23 });
		assert.equal(callbackCalls, 0);
		const logicalRecords = backend
			.listCheckpoints(runId)
			.filter(
				(checkpoint): checkpoint is DurableToolCheckpoint =>
					checkpoint.kind === "tool" && checkpoint.argsHash === seeded.argsHash,
			);
		assert.equal(logicalRecords.length, 1, "legacy root replay must not invent topology metadata");
		assert.equal(logicalRecords[0]?.topology, undefined);
		const entry = backend.listCompletedWorkflows().find((candidate) => candidate.workflowId === runId)!;
		const catalogRoot = completedWorkflowRunSnapshots(backend, entry).find((candidate) => candidate.id === runId)!;
		assert.deepEqual(
			catalogRoot.toolNodes?.map((node) => node.name),
			["workflow-run-timing"],
		);
	});
});
