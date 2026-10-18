import assert from "node:assert/strict";
import { test } from "vitest";
import { durableRunResult, recordRunResultCheckpointAsync } from "../../packages/workflows/src/durable/run-result.js";
import { testRunId } from "../helpers/run-id.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

test("a resumed run that returns to earlier outputs records them as its latest result (#3744)", async () => {
	const backend = await createMemoryTestBackend();
	const runId = testRunId("run-result-recurrence");
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "flow",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	await backend.commitCheckpoint({
		kind: "tool",
		workflowId: runId,
		checkpointId: "effect",
		name: "effect",
		argsHash: "effect",
		output: "done",
		completedAt: 2,
	});
	const record = (answer: string) => recordRunResultCheckpointAsync(backend, { id: runId, result: { answer } });

	assert.equal(await record("A"), true);
	assert.equal(await record("B"), true);
	assert.equal(await record("A"), true);
	assert.deepEqual(durableRunResult(backend, runId), { answer: "A" });

	assert.equal(await record("A"), false);
	assert.deepEqual(durableRunResult(backend, runId), { answer: "A" });
});
