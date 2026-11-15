import assert from "node:assert/strict";
import { test } from "vitest";
import type { DurableCheckpoint, DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { createDurablePromptAnswerResolver } from "../../packages/workflows/src/engine/run-durable-topology.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const RUN = "run-4941";
let sequence = 0;

function stageRecord(
	stageId: string,
	status: "running" | "completed",
	fields: Partial<DurableStageCheckpoint> = {},
	runId = RUN,
): DurableStageCheckpoint {
	sequence++;
	return {
		kind: "stage",
		workflowId: RUN,
		checkpointId: `stage-meta:${stageId}:${sequence}`,
		name: "input",
		replayKey: `prompt:${stageId}`,
		completedAt: sequence,
		topology: { version: 1, stageId, parentIds: [], status, run: { runId, runName: "child" } },
		...fields,
	};
}

function toolRecord(nodeId: string | undefined, runId = RUN): DurableCheckpoint {
	sequence++;
	return {
		kind: "tool",
		workflowId: RUN,
		checkpointId: `tool:${sequence}`,
		name: "use",
		argsHash: `args:${sequence}`,
		output: "used",
		completedAt: sequence,
		...(nodeId === undefined
			? {}
			: {
					topology: {
						version: 1,
						nodeId,
						ordinal: 0,
						order: sequence,
						parentIds: [],
						run: { runId, runName: "child" },
					},
				}),
	};
}

async function resolverOver(checkpoints: readonly DurableCheckpoint[]) {
	const backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: RUN,
		name: "child",
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	for (const checkpoint of checkpoints) await backend.commitCheckpoint(checkpoint);
	return createDurablePromptAnswerResolver(backend, RUN);
}

test("a completed prompt's answer is read from its completion record (#4941)", async () => {
	const resolve = await resolverOver([
		stageRecord("prompt", "running"),
		stageRecord("prompt", "completed", { promptAnswer: { response: "first-answer" } }),
		toolRecord("tool-after"),
	]);
	assert.deepEqual(resolve("prompt"), { kind: "answered", answer: { response: "first-answer" } });
});

test("a prompt recorded completed only by an answerless record, as its run's last step, is unanswered with nothing after it (#4941)", async () => {
	const resolve = await resolverOver([
		toolRecord("tool-before"),
		stageRecord("prompt", "running"),
		stageRecord("prompt", "completed"),
		// Neither its own later records, a run-level record, nor another run's steps used its answer.
		stageRecord("prompt", "completed", { result: "again" }),
		toolRecord(undefined),
		toolRecord("other-run-tool", "other-run"),
		stageRecord("other-run-stage", "completed", {}, "other-run"),
	]);
	assert.deepEqual(resolve("prompt"), { kind: "unanswered", laterRecorded: false });
});

test("an answerless completed prompt followed by a step of its run is unanswered with a later record (#4941)", async () => {
	const afterTool = await resolverOver([stageRecord("prompt", "completed"), toolRecord("tool-after")]);
	assert.deepEqual(afterTool("prompt"), { kind: "unanswered", laterRecorded: true });
	const afterStage = await resolverOver([stageRecord("prompt", "completed"), stageRecord("stage-after", "running")]);
	assert.deepEqual(afterStage("prompt"), { kind: "unanswered", laterRecorded: true });
});

test("a step recorded before the answerless completion is not a later record (#4941)", async () => {
	const resolve = await resolverOver([
		stageRecord("prompt", "running"),
		toolRecord("tool-before"),
		stageRecord("prompt", "completed"),
	]);
	assert.deepEqual(resolve("prompt"), { kind: "unanswered", laterRecorded: false });
});

test("an answer recorded with a later completion of the same prompt wins over an earlier answerless one (#4941)", async () => {
	const resolve = await resolverOver([
		stageRecord("prompt", "completed"),
		stageRecord("prompt", "completed", { promptAnswer: { response: "asked-again" } }),
	]);
	assert.deepEqual(resolve("prompt"), { kind: "answered", answer: { response: "asked-again" } });
});

test("a prompt with no completed record, or another run's completed prompt, resolves to nothing (#4941)", async () => {
	const resolve = await resolverOver([
		stageRecord("pending", "running"),
		stageRecord("foreign", "completed", { promptAnswer: { response: "theirs" } }, "other-run"),
		toolRecord("pending"),
	]);
	assert.equal(resolve("pending"), undefined);
	assert.equal(resolve("foreign"), undefined);
	assert.equal(resolve("missing"), undefined);
});
