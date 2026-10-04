import assert from "node:assert/strict";
import { test } from "vitest";
import {
	DbosDurableBackend,
	type DbosSdkHandle,
	type DbosStepRecord,
} from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";

test("a retired callback cannot poison a successor's checkpoints, mirror, or availability (#3419)", async () => {
	const records = new Map<string, DbosStepRecord>();
	let lost = false;
	const nextId = "atomic-db-22222222-2222-4222-8222-222222222222";
	const createSdk = (executorId: string, generationLost: () => boolean): DbosSdkHandle => ({
		executorId,
		generationLost,
		forkGeneration: () => createSdk(nextId, () => false),
		launch: async () => {},
		shutdown: async () => {},
		startWorkflow: async () => {},
		retrieveWorkflow: async () => undefined,
		cancelWorkflow: async () => {},
		resumeWorkflow: async () => {},
		listAllWorkflows: async () => [],
		listStepRecords: async () => [...records.values()],
		recordStepOutput: async (_id, stepName, output) => {
			if (generationLost()) throw new Error("retired writer reached storage");
			records.set(stepName, { stepName, output });
		},
		deleteWorkflowData: async () => {},
	});
	const backend = new DbosDurableBackend(createSdk("atomic-db-11111111-1111-4111-8111-111111111111", () => lost));
	backend.registerWorkflow({ workflowId: "run", name: "recovery", inputs: {}, status: "running", createdAt: 1 });
	await backend.flush();
	const oldCallback = backend.executionView();
	lost = true;
	const checkpoint = (id: string): DurableToolCheckpoint => ({
		kind: "tool",
		workflowId: "run",
		checkpointId: id,
		name: id,
		argsHash: id,
		args: {},
		output: id,
		completedAt: 2,
	});
	await backend.recordCheckpointAsync(checkpoint("successor"));
	const before = [...records];
	await assert.rejects(oldCallback.recordCheckpointAsync(checkpoint("retired")), /generation changed/);
	assert.deepEqual([...records], before);
	assert.equal(backend.getWorkflow("run")?.completedCheckpoints, 1);
	assert.equal(backend.getToolOutput("run", "retired"), undefined);
	assert.equal(backend.isAdmissionUnavailable("run"), false);
	assert.equal(backend.isCheckpointUnavailable("run"), false);
	await backend.flush();
});
