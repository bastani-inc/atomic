import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	CHAT_CONTINUATION_MESSAGE,
	chatAnswerIntent,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/format-answer.ts";
import {
	buildQuestionnaireResponse,
	ENVELOPE_SUFFIX,
	hasChatAnswer,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/response-envelope.ts";
import {
	SENTINEL_LABELS,
	type QuestionParams,
	type QuestionnaireResult,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";

const params: QuestionParams = {
	questions: [
		{
			question: "Which option?",
			header: "Choice",
			options: [
				{ label: "Alpha", description: "First option" },
				{ label: "Beta", description: "Second option" },
			],
		},
	],
};

function chatResult(answer: string | null): QuestionnaireResult {
	return {
		answers: [
			{
				questionIndex: 0,
				question: params.questions[0]!.question,
				kind: "chat",
				answer,
			},
		],
		cancelled: false,
	};
}

describe("ask_user_question chat response envelope", () => {
	test("typed chat is exposed without legacy termination or generic continuation suffix", () => {
		const result = chatResult("Let's discuss another approach");
		const envelope = buildQuestionnaireResponse(result, params);
		const text = envelope.content[0]!.text;

		assert.equal(hasChatAnswer(result), true);
		assert.equal(chatAnswerIntent(result.answers[0]!), "Let's discuss another approach");
		assert.equal(envelope.terminate, undefined);
		assert.match(text, /Stop the structured-choice flow and respond to the user's message/);
		assert.match(text, /"Which option\?"="Let's discuss another approach"\./);
		assert.equal(text.includes(ENVELOPE_SUFFIX), false);
		assert.equal(text.includes(CHAT_CONTINUATION_MESSAGE), false);
	});

	test("sentinel chat keeps legacy stop/wait termination semantics", () => {
		const result = chatResult(SENTINEL_LABELS.chat);
		const envelope = buildQuestionnaireResponse(result, params);
		const text = envelope.content[0]!.text;

		assert.equal(chatAnswerIntent(result.answers[0]!), undefined);
		assert.equal(envelope.terminate, true);
		assert.match(text, /Stop the current task flow and wait for the user's next message/);
		assert.equal(text.includes(ENVELOPE_SUFFIX), false);
	});

	test("whitespace-only chat answers are treated as signal-only chat", () => {
		const result = chatResult("   ");
		const envelope = buildQuestionnaireResponse(result, params);
		const text = envelope.content[0]!.text;

		assert.equal(chatAnswerIntent(result.answers[0]!), undefined);
		assert.equal(envelope.terminate, true);
		assert.match(text, /Stop the current task flow and wait for the user's next message/);
	});
});
