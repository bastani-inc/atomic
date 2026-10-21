import assert from "node:assert/strict";
import type { Api, JsonObject, Model } from "@bastani/pi-ai";
import { type TSchema, Type } from "typebox";
import { test, vi } from "vitest";
import type { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { generateStructuredOutput, routeModel } from "../../packages/coding-agent/src/core/structured-output/index.js";
import {
	formatStructuredOutputCorrectionPrompt,
	isStructuredOutputContractFailure,
} from "../../packages/workflows/src/runs/foreground/stage-runner-structured-output.js";
import { decisionMessage, decisionModel, decisionRequest, messageStream } from "../helpers/structured-output.js";

const REJECTED_SECRET = "private-rejected-value";
const REPAIR_ATTEMPTS = 4;
const ISSUE_MESSAGE_PREFIX = "Invalid structured output: response does not match the decision schema.";

const schema = Type.Object(
	{ summary: Type.String(), files: Type.Array(Type.String()), note: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);

type Stream = ModelRegistry["streamSimple"];

function replyWith(args: JsonObject, error?: string) {
	const message = decisionMessage(args);
	if (error !== undefined) {
		const [call] = message.content;
		if (call.type === "toolCall") call.argumentsError = error;
	}
	return messageStream(message);
}

function requestFor<T extends TSchema>(streamSimple: Stream, outputSchema: T) {
	return {
		model: "decision-test/chat",
		modelRegistry: { getAll: () => [decisionModel], streamSimple },
		schema: outputSchema,
		state: { task: "Report the stage result" },
		instructions: "Report the stage result.",
	};
}

async function rejection(error: Error | undefined): Promise<string> {
	assert.ok(error, "expected the request to be rejected");
	return error.message;
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
	return rejection(
		await promise.then(
			() => undefined,
			(error: Error) => error,
		),
	);
}

test("names the failing path and expected type when a property has the wrong type (#3802)", async () => {
	const stream = vi.fn(() => replyWith({ summary: "ok", files: REJECTED_SECRET }));

	const message = await messageOf(generateStructuredOutput(requestFor(stream, schema)));

	assert.ok(message.startsWith(ISSUE_MESSAGE_PREFIX), message);
	assert.match(message, /\/files: expected array, got string/);
	assert.doesNotMatch(message, new RegExp(REJECTED_SECRET));
	assert.match(message, /repair exhausted after 4 attempts\.$/);
	assert.equal(stream.mock.calls.length, REPAIR_ATTEMPTS);
});

test("names a missing required property (#3802)", async () => {
	const stream = vi.fn(() => replyWith({ summary: "ok" }));

	const message = await messageOf(generateStructuredOutput(requestFor(stream, schema)));

	assert.ok(message.startsWith(ISSUE_MESSAGE_PREFIX), message);
	assert.match(message, /\/files: required/);
	assert.doesNotMatch(message, /\/summary/);
});

test("names every failing nested path and unexpected property without echoing values (#3802)", async () => {
	const nested = Type.Object(
		{
			verdict: Type.Object({
				label: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
				score: Type.Integer(),
			}),
			items: Type.Array(Type.String()),
		},
		{ additionalProperties: false },
	);
	const stream = vi.fn(() =>
		messageStream(
			decisionMessage({
				verdict: { label: REJECTED_SECRET, score: 1.5 },
				items: ["a", 3],
				[`extra_${REJECTED_SECRET}`]: true,
			}),
		),
	);

	const message = await messageOf(generateStructuredOutput(requestFor(stream, nested)));

	assert.match(message, /\/verdict\/label: expected "pass" or "fail", got string/);
	assert.match(message, /\/verdict\/score: expected integer, got number/);
	assert.match(message, /\/items\/1: expected string, got number/);
	assert.match(message, /\/extra_private-rejected-value: not allowed/);
	assert.doesNotMatch(message.replace(/\/extra_private-rejected-value/g, ""), new RegExp(REJECTED_SECRET));
});

test("caps the listed errors and reports how many were omitted (#3802)", async () => {
	const wide = Type.Object(
		Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field_${index}`, Type.String()])),
	);
	const stream = vi.fn(() => replyWith({}));

	const message = await messageOf(generateStructuredOutput(requestFor(stream, wide)));

	assert.match(message, /\/field_0: required/);
	assert.match(message, /and 35 more/);
	assert.doesNotMatch(message, /\/field_39/);
	assert.ok(message.length < 600, `message was ${message.length} characters`);
});

test("reports non-JSON tool arguments distinctly, with a bounded parser excerpt and no raw payload (#3802)", async () => {
	const parserMessage = `Unexpected token '}', ..."note": }" is not valid JSON${" overlong".repeat(60)}`;
	const stream = vi.fn(() =>
		replyWith({}, `${parserMessage}\n\nReceived arguments:\n{"summary":"${REJECTED_SECRET}","note": }`),
	);

	const message = await messageOf(generateStructuredOutput(requestFor(stream, schema)));

	assert.ok(message.startsWith("Invalid structured output: tool call arguments were not valid JSON."), message);
	assert.doesNotMatch(message, /does not match the decision schema/);
	assert.match(message, /Unexpected token '}', \.\.\."note": }" is not valid JSON/);
	assert.doesNotMatch(message, /Received arguments/);
	assert.doesNotMatch(message, new RegExp(REJECTED_SECRET));
	assert.ok(message.length < 450, `message was ${message.length} characters`);
	assert.match(message, /repair exhausted after 4 attempts\.$/);
	assert.equal(stream.mock.calls.length, REPAIR_ATTEMPTS);
});

test("non-JSON tool arguments take part in repair and usage accounting (#3802)", async () => {
	const request = decisionRequest();
	const stream = vi
		.fn<typeof request.modelRegistry.streamSimple>()
		.mockImplementationOnce(() => replyWith({}, "Unexpected token '}' at position 12\n\nReceived arguments:\n{}"))
		.mockImplementation(() => messageStream(decisionMessage()));
	request.modelRegistry.streamSimple = stream;

	const result = await routeModel(request);

	assert.equal(result.value.route, "review");
	assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 20 });
	assert.match(stream.mock.calls[1][1].systemPrompt!, /not valid JSON.*Unexpected token '}' at position 12/);
	assert.doesNotMatch(stream.mock.calls[1][1].systemPrompt!, /Received arguments/);
});

test("repair prompt names the failing paths from the previous attempt (#3802)", async () => {
	const systemPrompts: string[] = [];
	const stream = vi.fn((_model: Model<Api>, context: Parameters<Stream>[1]) => {
		systemPrompts.push(context.systemPrompt ?? "");
		return systemPrompts.length === 1
			? replyWith({ summary: "ok", files: REJECTED_SECRET })
			: replyWith({ summary: "ok", files: ["a.rs"] });
	});

	const result = await generateStructuredOutput(requestFor(stream, schema));

	assert.deepEqual(result.value, { summary: "ok", files: ["a.rs"] });
	assert.doesNotMatch(systemPrompts[0], /failed output validation/);
	assert.match(systemPrompts[1], /previous response failed output validation/);
	assert.match(systemPrompts[1], /\/files: expected array, got string/);
	assert.doesNotMatch(systemPrompts[1], new RegExp(REJECTED_SECRET));
});

test("routing rejects a correlated-validation failure with the schema-mismatch prefix (#3802)", async () => {
	const request = decisionRequest();
	request.modelRegistry.streamSimple = () => messageStream(decisionMessage({ route: "none" }));

	const message = await messageOf(routeModel(request, () => false));

	assert.ok(message.startsWith(ISSUE_MESSAGE_PREFIX), message);
	assert.match(message, /candidates and constraints/);
	assert.match(message, /Routing output repair exhausted after 4 attempts\.$/);
});

test("model attempts keep the value-free rejection detail of an exhausted candidate (#3802)", async () => {
	const second = { ...decisionModel, id: "chat-2" };
	const stream = vi.fn((model: Model<Api>) =>
		model.id === "chat"
			? replyWith({ summary: "ok", files: REJECTED_SECRET })
			: replyWith({ summary: "ok", files: [] }),
	);

	const result = await generateStructuredOutput({
		...requestFor(stream, schema),
		modelRegistry: { getAll: () => [decisionModel, second], streamSimple: stream },
		fallbackModels: ["decision-test/chat-2"],
	});

	const [attempt] = result.modelAttempts ?? [];
	assert.equal(attempt?.model, "decision-test/chat");
	assert.match(attempt?.error ?? "", /\/files: expected array, got string/);
	assert.doesNotMatch(JSON.stringify(result.modelAttempts), new RegExp(REJECTED_SECRET));
	assert.match(result.fallback?.reason ?? "", /\/files: expected array, got string/);
});

test("workflow corrective prompt carries the rejection detail and treats both messages as contract failures (#3802)", () => {
	const mismatch = `${ISSUE_MESSAGE_PREFIX} Failing paths: /files: expected array, got string; /summary: required. Structured output repair exhausted after 4 attempts.`;
	const notJson =
		"Invalid structured output: tool call arguments were not valid JSON. Parser stopped at: Unexpected token '}'. Structured output repair exhausted after 4 attempts.";

	for (const message of [mismatch, notJson]) {
		assert.equal(isStructuredOutputContractFailure(message), true, message);
		assert.ok(formatStructuredOutputCorrectionPrompt(message, 1).includes(message));
	}
});
