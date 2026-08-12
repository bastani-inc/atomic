import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
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

describe("workflow send — answering without naming a stage", () => {
	for (const delivery of ["answer", undefined] as const) {
		test(`${delivery ?? "default auto"} delivery targets the only pending prompt`, async () => {
			const runId = runWithStages(`sole-prompt-${delivery ?? "auto"}`, ["review"]);
			assert.equal(store.recordStagePendingPrompt(runId, "stage-review", prompt("prompt-1")), true);

			const result = await workflowSendAction({
				runId,
				text: "fix-p0-and-p1",
				...(delivery === undefined ? {} : { delivery }),
			});

			assert.equal(result.status, "ok");
			assert.equal(result.delivery, "answer");
			assert.equal(result.stageId, "stage-review");
			assert.equal(result.message, "Answered prompt prompt-1.");
		});
	}

	test("names the candidates when more than one prompt is pending", async () => {
		const runId = runWithStages("two-prompts", ["select", "approve-release"]);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-select", prompt("prompt-1")), true);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-approve-release", prompt("prompt-2")), true);

		const result = await workflowSendAction({ runId, text: "yes", delivery: "answer" });

		assert.equal(result.status, "noop");
		// Recovery has to be possible from this message alone; the previous one
		// forced a second `stages` call to discover the same two ids.
		assert.match(result.message, /^2 prompts pending; pass stageId: /);
		assert.match(result.message, /select \(.+stage-select\)/);
		assert.match(result.message, /approve-release \(.+stage-approve-release\)/);
	});

	test("still requires a stage when nothing is pending", async () => {
		const runId = runWithStages("no-prompt", ["review"]);

		const result = await workflowSendAction({ runId, text: "hello", delivery: "answer" });

		assert.equal(result.status, "noop");
		assert.equal(result.message, "Stage id or name is required.");
	});

	test("does not redirect a steer at a pending prompt", async () => {
		const runId = runWithStages("steer-untouched", ["review"]);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-review", prompt("prompt-1")), true);

		const result = await workflowSendAction({ runId, text: "change direction", delivery: "steer" });

		// A steer names a live stage as its destination, so a pending prompt is
		// not evidence of where it was meant to go.
		assert.equal(result.status, "noop");
		assert.equal(result.message, "Stage id or name is required.");
	});

	test("a named promptId selects among several pending prompts", async () => {
		const runId = runWithStages("prompt-id-selects", ["select", "approve-release"]);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-select", prompt("prompt-1")), true);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-approve-release", prompt("prompt-2")), true);

		// The id already identifies its stage, so this is not ambiguous even
		// though two prompts are waiting.
		const result = await workflowSendAction({ runId, promptId: "prompt-2", text: "ship it" });

		assert.equal(result.status, "ok");
		assert.equal(result.stageId, "stage-approve-release");
		assert.equal(result.message, "Answered prompt prompt-2.");
	});

	test("an unknown promptId does not fall through to an unrelated stage", async () => {
		const runId = runWithStages("prompt-id-unknown", ["review"]);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-review", prompt("prompt-1")), true);

		const result = await workflowSendAction({ runId, promptId: "prompt-missing", text: "yes" });

		assert.equal(result.status, "noop");
		assert.equal(result.stageId, "");
		assert.equal(result.message, `No pending prompt prompt-missing in run ${runId}.`);
	});

	test("an explicit stageId still selects among several pending prompts", async () => {
		const runId = runWithStages("explicit-wins", ["select", "approve-release"]);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-select", prompt("prompt-1")), true);
		assert.equal(store.recordStagePendingPrompt(runId, "stage-approve-release", prompt("prompt-2")), true);

		const result = await workflowSendAction({
			runId,
			stageId: "stage-approve-release",
			text: "ship it",
			delivery: "answer",
		});

		assert.equal(result.status, "ok");
		assert.equal(result.stageId, "stage-approve-release");
		assert.equal(result.message, "Answered prompt prompt-2.");
	});
});
