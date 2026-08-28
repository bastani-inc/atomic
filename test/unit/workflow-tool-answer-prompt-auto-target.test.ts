import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { workflowAnswerAction } from "../../packages/workflows/src/extension/workflow-tool-answer.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";

const runIds = new Set<string>();

afterEach(() => {
	for (const runId of runIds) store.removeRun(runId);
	runIds.clear();
});

function prompt(id: string) {
	return { id, kind: "input" as const, message: `answer ${id}?`, createdAt: 1 };
}

/** A running run whose stages are named, so labels in errors stay readable. */
function runWithStages(seed: string, stageNames: readonly string[]): string {
	const runId = testRunId(seed);
	runIds.add(runId);
	store.recordRunStart({
		id: runId,
		name: "prompt-auto-target",
		inputs: {},
		status: "running",
		startedAt: 1,
		stages: stageNames.map((name) => ({
			id: `stage-${name}`,
			name,
			status: "running" as const,
			parentIds: [],
			toolEvents: [],
			attachable: true,
		})),
	});
	return runId;
}

describe("workflow answer — answering without naming a stage", () => {
	test("targets the only pending prompt", async () => {
		const runId = runWithStages("sole-prompt", ["review"]);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-review", prompt("prompt-1")), true);

		const result = await workflowAnswerAction({ runId, text: "fix-p0-and-p1" });

		assert.equal(result.status, "ok");
		assert.equal(result.stageId, "stage-review");
		assert.equal(result.message, "Answered prompt prompt-1.");
	});

	test("names the candidates when more than one prompt is pending", async () => {
		const runId = runWithStages("two-prompts", ["select", "approve-release"]);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-select", prompt("prompt-1")), true);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-approve-release", prompt("prompt-2")), true);

		const result = await workflowAnswerAction({ runId, text: "yes" });

		assert.equal(result.status, "noop");
		// Recovery has to be possible from this message alone; the previous one
		// forced a second `stages` call to discover the same two ids.
		assert.match(result.message, /^2 prompts pending; pass stageId: /);
		assert.match(result.message, /select \(.+stage-select\)/);
		assert.match(result.message, /approve-release \(.+stage-approve-release\)/);
	});

	test("still requires a stage when nothing is pending", async () => {
		const runId = runWithStages("no-prompt", ["review"]);

		const result = await workflowAnswerAction({ runId, text: "hello" });

		assert.equal(result.status, "noop");
		assert.equal(result.message, "Stage id or name is required.");
	});

	test("a named promptId selects among several pending prompts", async () => {
		const runId = runWithStages("prompt-id-selects", ["select", "approve-release"]);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-select", prompt("prompt-1")), true);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-approve-release", prompt("prompt-2")), true);

		// The id already identifies its stage, so this is not ambiguous even
		// though two prompts are waiting.
		const result = await workflowAnswerAction({ runId, promptId: "prompt-2", text: "ship it" });

		assert.equal(result.status, "ok");
		assert.equal(result.stageId, "stage-approve-release");
		assert.equal(result.message, "Answered prompt prompt-2.");
	});

	test("an unknown promptId does not fall through to an unrelated stage", async () => {
		const runId = runWithStages("prompt-id-unknown", ["review"]);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-review", prompt("prompt-1")), true);

		const result = await workflowAnswerAction({ runId, promptId: "prompt-missing", text: "yes" });

		assert.equal(result.status, "noop");
		assert.equal(result.stageId, "");
		assert.equal(result.message, `No pending prompt prompt-missing in run ${runId}.`);
	});

	test("an explicit stageId still selects among several pending prompts", async () => {
		const runId = runWithStages("explicit-wins", ["select", "approve-release"]);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-select", prompt("prompt-1")), true);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-approve-release", prompt("prompt-2")), true);

		const result = await workflowAnswerAction({
			runId,
			stageId: "stage-approve-release",
			text: "ship it",
		});

		assert.equal(result.status, "ok");
		assert.equal(result.stageId, "stage-approve-release");
		assert.equal(result.message, "Answered prompt prompt-2.");
	});
});

describe("workflow answer — stage inference composes with primitive answer coercion", () => {
	test("an uncoercible answer to the sole inferred prompt stays pending, with the same noop as an explicit stageId", async () => {
		const runId = runWithStages("inferred-uncoercible", ["approve"]);
		const confirm = { id: "prompt-1", kind: "confirm" as const, message: "ship it?", createdAt: 1 };
		assert.equal(store.recordStagePendingPrompt(runId, "stage-approve", confirm), true);

		const inferred = await workflowAnswerAction({ runId, text: "maybe" });

		assert.equal(inferred.status, "noop");
		assert.equal(inferred.stageId, "stage-approve");
		assert.match(inferred.message, /^Invalid answer for confirm prompt prompt-1\./);
		// The rejection left the prompt pending: the inferred path must not
		// resolve a prompt the coercion boundary refused.
		const stage = store.runs().find((run) => run.id === runId)?.stages[0];
		assert.equal(stage?.pendingPrompt?.id, "prompt-1");

		const explicit = await workflowAnswerAction({ runId, stageId: "stage-approve", text: "maybe" });

		// With or without a stageId, the same coercion boundary answers.
		assert.equal(explicit.status, "noop");
		assert.equal(explicit.message, inferred.message);
		assert.equal(store.runs().find((run) => run.id === runId)?.stages[0]?.pendingPrompt?.id, "prompt-1");
	});

	test("a coercible answer to the sole inferred prompt records the normalized value, not the raw payload", async () => {
		const runId = runWithStages("inferred-coerced", ["approve"]);
		const confirm = { id: "prompt-1", kind: "confirm" as const, message: "ship it?", createdAt: 1 };
		assert.equal(store.recordStagePendingPrompt(runId, "stage-approve", confirm), true);

		const result = await workflowAnswerAction({ runId, text: "yes" });

		assert.equal(result.status, "ok");
		assert.equal(result.stageId, "stage-approve");
		assert.equal(result.message, "Answered prompt prompt-1.");
		// "yes" reached the waiter as boolean true; raw passthrough on the
		// inferred path was the pre-fix bug this pins.
		assert.equal(store.getStagePromptAnswer(runId, "stage-approve")?.value, true);
	});

	test("a promptId-selected prompt among several still answers through coercion", async () => {
		const runId = runWithStages("prompt-id-coerced", ["pick", "approve"]);
		const select = {
			id: "prompt-1",
			kind: "select" as const,
			message: "which?",
			choices: ["alpha", "beta"],
			createdAt: 1,
		};
		assert.equal(store.recordStagePendingPrompt(runId, "stage-pick", select), true);
		const confirm = { id: "prompt-2", kind: "confirm" as const, message: "ship it?", createdAt: 1 };
		assert.equal(store.recordStagePendingPrompt(runId, "stage-approve", confirm), true);

		const rejectedAnswer = await workflowAnswerAction({ runId, promptId: "prompt-1", text: "gamma" });

		assert.equal(rejectedAnswer.status, "noop");
		assert.equal(rejectedAnswer.stageId, "stage-pick");
		assert.match(rejectedAnswer.message, /^Invalid answer for select prompt prompt-1\. .*alpha, beta/);
		assert.equal(store.runs().find((run) => run.id === runId)?.stages[0]?.pendingPrompt?.id, "prompt-1");

		const accepted = await workflowAnswerAction({ runId, promptId: "prompt-1", text: "2" });

		assert.equal(accepted.status, "ok");
		assert.equal(accepted.message, "Answered prompt prompt-1.");
		assert.equal(store.getStagePromptAnswer(runId, "stage-pick")?.value, "beta");
	});
});
