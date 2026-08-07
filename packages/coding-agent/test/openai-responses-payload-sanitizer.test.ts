import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	isValidResponsesFunctionCallId,
	MIN_RESPONSES_MAX_OUTPUT_TOKENS,
	responsesFunctionCallIdForCallId,
	sanitizeOpenAIResponsesPayload,
} from "../src/core/openai-responses-payload-sanitizer.ts";

const responsesModel = { api: "openai-responses" } as const;
const completionsModel = { api: "openai-completions" } as const;

type PayloadItem = Record<string, unknown>;

function payloadInput(result: unknown): PayloadItem[] {
	assert.equal(typeof result, "object");
	assert.notEqual(result, null);
	const input = (result as { input?: unknown }).input;
	assert.ok(Array.isArray(input));
	return input as PayloadItem[];
}

describe("sanitizeOpenAIResponsesPayload", () => {
	test("synthesizes a valid Responses function_call id from call_id", () => {
		const payload = {
			input: [
				{
					type: "function_call",
					id: "raw/provider/item/id+with=invalid_chars",
					call_id: "call_abc123",
					name: "bash",
					arguments: "{}",
				},
				{ type: "function_call_output", call_id: "call_abc123", output: "ok" },
			],
		};

		const sanitized = sanitizeOpenAIResponsesPayload(payload, responsesModel);
		const input = payloadInput(sanitized);

		assert.equal(input[0]?.id, "fc_call_abc123");
		assert.equal(input[0]?.call_id, "call_abc123");
		assert.equal(input[1]?.call_id, "call_abc123");
		assert.notEqual(sanitized, payload);
	});

	test("preserves already-valid Responses function_call ids", () => {
		const payload = {
			input: [{ type: "function_call", id: "fc_call_abc123", call_id: "call_abc123" }],
		};

		const sanitized = sanitizeOpenAIResponsesPayload(payload, responsesModel);

		assert.equal(sanitized, payload);
	});

	test("hashes call_id when direct fc-prefixed id would be invalid", () => {
		const callId = "opaque/raw+call=id/that/is/too/long/".repeat(3);
		const id = responsesFunctionCallIdForCallId(callId);

		assert.ok(isValidResponsesFunctionCallId(id));
		assert.ok(id.length <= 64);
	});

	test("removes invalid id when no call_id is available", () => {
		const payload = { input: [{ type: "function_call", id: "raw/invalid" }] };

		const sanitized = sanitizeOpenAIResponsesPayload(payload, responsesModel);
		const input = payloadInput(sanitized);

		assert.equal("id" in input[0]!, false);
	});

	test("raises Responses max_output_tokens below the provider minimum", () => {
		const payload = { max_output_tokens: 1, input: [{ type: "message", content: "hi" }] };

		const sanitized = sanitizeOpenAIResponsesPayload(payload, responsesModel);

		assert.notEqual(sanitized, payload);
		assert.equal((sanitized as { max_output_tokens?: number }).max_output_tokens, MIN_RESPONSES_MAX_OUTPUT_TOKENS);
	});

	test("preserves valid Responses max_output_tokens", () => {
		const payload = {
			max_output_tokens: MIN_RESPONSES_MAX_OUTPUT_TOKENS,
			input: [{ type: "message", content: "hi" }],
		};

		const sanitized = sanitizeOpenAIResponsesPayload(payload, responsesModel);

		assert.equal(sanitized, payload);
	});

	test("raises Responses max_output_tokens even when input is absent", () => {
		const payload = { max_output_tokens: 1 };

		const sanitized = sanitizeOpenAIResponsesPayload(payload, responsesModel);

		assert.equal((sanitized as { max_output_tokens?: number }).max_output_tokens, MIN_RESPONSES_MAX_OUTPUT_TOKENS);
	});

	test("does not change non-Responses payloads", () => {
		const payload = { input: [{ type: "function_call", id: "raw/invalid", call_id: "call_1" }] };

		const sanitized = sanitizeOpenAIResponsesPayload(payload, completionsModel);

		assert.equal(sanitized, payload);
	});

	// Issue #2204. On the github-copilot + openai-responses path across a model-identity
	// mismatch, pi-ai flattens the composite `callId|itemId` tool-call identifier into one
	// truncated 64-character blob, so it emits the function_call item with `call_id` set to
	// that blob and `id` absent. Rebuild that fixture the way pi-ai's `normalizeIdPart` does.
	function copilotStyleSanitizedCallId(): string {
		const raw = `call_A1b2C3d4E5f6G7h8I9j0K1l2|${"PLACEHOLDER+OPAQUE/BASE64+BLOB/".repeat(20)}`;
		return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
	}

	test("leaves an absent function_call id absent instead of synthesizing one (#2204)", () => {
		const callId = copilotStyleSanitizedCallId();
		assert.equal(callId.length, 64);

		const payload = {
			input: [{ type: "function_call", call_id: callId, name: "bash", arguments: "{}" }],
		};

		const sanitized = sanitizeOpenAIResponsesPayload(payload, responsesModel);
		const input = payloadInput(sanitized);

		assert.equal("id" in input[0]!, false);
		assert.equal(JSON.stringify(sanitized).includes("fc_"), false);
		assert.equal(input[0]?.call_id, callId);
		// Nothing needed sanitizing, so the payload is returned by identity.
		assert.equal(sanitized, payload);
	});

	test("leaves an explicitly undefined function_call id unsynthesized (#2204)", () => {
		const payload = {
			input: [{ type: "function_call", id: undefined, call_id: "call_abc123" }],
		};

		const sanitized = sanitizeOpenAIResponsesPayload(payload, responsesModel);
		const input = payloadInput(sanitized);

		assert.equal(input[0]?.id, undefined);
		assert.equal(sanitized, payload);
	});

	test("treats a null function_call id as present and malformed", () => {
		const payload = { input: [{ type: "function_call", id: null, call_id: "call_abc123" }] };

		const sanitized = sanitizeOpenAIResponsesPayload(payload, responsesModel);
		const input = payloadInput(sanitized);

		assert.equal(input[0]?.id, "fc_call_abc123");
	});

	test("never emits a function_call id at or above the server-rejected 64-character bound", () => {
		const callIds = [
			"call_abc123",
			"opaque/raw+call=id/that/is/too/long/".repeat(5),
			"////++++////",
			"a".repeat(60),
			"a".repeat(61),
			"a".repeat(63),
			"a".repeat(64),
			"a".repeat(200),
			copilotStyleSanitizedCallId(),
		];

		for (const callId of callIds) {
			const id = responsesFunctionCallIdForCallId(callId);
			assert.ok(id !== undefined, `expected an id for ${callId}`);
			assert.ok(isValidResponsesFunctionCallId(id), `validator rejected its own output: ${id}`);
			assert.ok(id.length < 64, `${callId.slice(0, 24)}... produced a ${id.length}-character id`);
		}
	});

	test("validator and generator agree on one maximum below 64", () => {
		const longest = responsesFunctionCallIdForCallId("x".repeat(500));
		assert.ok(longest !== undefined);
		assert.ok(longest.length < 64, `generator budget is ${longest.length}`);

		// The validator must accept exactly the longest value the generator can build,
		// and reject one character more. That is the single shared maximum.
		assert.equal(isValidResponsesFunctionCallId(`fc_${"a".repeat(longest.length - 3)}`), true);
		assert.equal(isValidResponsesFunctionCallId(`fc_${"a".repeat(longest.length - 2)}`), false);
	});

	test("repairs a present 64-character fc_ id that the tightened bound rejects", () => {
		const malformed = `fc_${"a".repeat(61)}`;
		assert.equal(malformed.length, 64);

		const payload = { input: [{ type: "function_call", id: malformed, call_id: "call_abc123" }] };

		const sanitized = sanitizeOpenAIResponsesPayload(payload, responsesModel);
		const input = payloadInput(sanitized);

		assert.equal(input[0]?.id, "fc_call_abc123");
	});

	test("still repairs a present but malformed function_call id below the bound", () => {
		const payload = {
			input: [{ type: "function_call", id: "raw/provider/item+id", call_id: "opaque/raw+call=id/".repeat(6) }],
		};

		const sanitized = sanitizeOpenAIResponsesPayload(payload, responsesModel);
		const input = payloadInput(sanitized);
		const id = input[0]?.id;

		assert.ok(isValidResponsesFunctionCallId(id));
		assert.ok(id.length < 64, `repaired id was ${id.length} characters`);
		assert.notEqual(sanitized, payload);
	});
});
