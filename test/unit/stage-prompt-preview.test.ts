/**
 * A stage's ask_user_question answered headlessly (`workflow answer`) reports the chosen option's
 * preview, as the interactive form does (#3996).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.js";

test("a headless answer to an option with a preview reports that preview (#3996)", () => {
	const adapter = buildStagePromptAdapter(
		"call-1",
		"ask_user_question",
		{
			questions: [
				{
					question: "Ship it?",
					header: "Ship",
					options: [
						{ label: "alpha", description: "first", preview: "PREVIEW-ALPHA" },
						{ label: "beta", description: "second", preview: "PREVIEW-BETA" },
					],
				},
			],
		},
		1,
	);
	assert.ok(adapter !== undefined);
	assert.deepEqual(adapter.buildResult({ optionLabels: ["beta"] }), {
		answers: [{ questionIndex: 0, question: "Ship it?", kind: "option", answer: "beta", preview: "PREVIEW-BETA" }],
		cancelled: false,
	});
	assert.deepEqual(adapter.buildResult({ text: "something else" }), {
		answers: [{ questionIndex: 0, question: "Ship it?", kind: "custom", answer: "something else" }],
		cancelled: false,
	});
});
