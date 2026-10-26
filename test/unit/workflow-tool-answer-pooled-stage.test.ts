/**
 * `workflow answer` reaches a stage's question when the stage runs on a local worker (#3996).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { workflowAnswerAction } from "../../packages/workflows/src/extension/workflow-tool-answer.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { registerPooledStageSource } from "../../packages/workflows/src/workers/pooled-stage-sources.js";
import type { PooledPromptAnswer } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { testRunId } from "../helpers/run-id.js";

const runId = testRunId("workflow-answer-pooled-stage");

afterEach(() => {
	store.removeRun(runId);
});

test("an ask_user_question from a stage on a local worker is answered through its pool, bound to its id (#3996)", async () => {
	store.recordRunStart({
		id: runId,
		name: "pooled-child",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [
			{
				id: "agent",
				name: "agent",
				status: "awaiting_input",
				parentIds: [],
				toolEvents: [],
				workerExecution: { worker: "worker-1", generation: 1, renewedAt: 1, expiresAt: 2 },
			},
		],
	});
	store.recordStageInputRequest(runId, "agent", {
		id: "question-1",
		kind: "ask_user_question",
		questions: [{ question: "Ship it?", options: [{ label: "yes" }, { label: "no" }] }],
		createdAt: 1,
	});
	const answers: { runId: string; stageId: string; answer: PooledPromptAnswer }[] = [];
	// The pool registers on the store its root publishes into: the owner's store.
	const unregister = registerPooledStageSource(captureWorkflowOwnerResources().store, {
		acquire: async () => undefined,
		async answer(answeredRunId, stageId, answer) {
			answers.push({ runId: answeredRunId, stageId, answer });
			return { ok: true };
		},
	});
	try {
		const result = await workflowAnswerAction({ runId, stageId: "agent", text: "yes" });
		assert.equal(result.status, "ok", result.message);
		assert.equal(result.message, "Answered input request question-1.");
		assert.deepEqual(answers, [
			{ runId, stageId: "agent", answer: { kind: "input", promptId: "question-1", answer: { text: "yes" } } },
		]);
	} finally {
		unregister();
	}
});
