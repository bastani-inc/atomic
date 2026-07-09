import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  isValidResponsesFunctionCallId,
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
    assert.equal((sanitized as { max_output_tokens?: number }).max_output_tokens, 16);
  });

  test("preserves valid Responses max_output_tokens", () => {
    const payload = { max_output_tokens: 16, input: [{ type: "message", content: "hi" }] };

    const sanitized = sanitizeOpenAIResponsesPayload(payload, responsesModel);

    assert.equal(sanitized, payload);
  });

  test("raises Responses max_output_tokens even when input is absent", () => {
    const payload = { max_output_tokens: 1 };

    const sanitized = sanitizeOpenAIResponsesPayload(payload, responsesModel);

    assert.equal((sanitized as { max_output_tokens?: number }).max_output_tokens, 16);
  });
  test("does not change non-Responses payloads", () => {
    const payload = { input: [{ type: "function_call", id: "raw/invalid", call_id: "call_1" }] };

    const sanitized = sanitizeOpenAIResponsesPayload(payload, completionsModel);

    assert.equal(sanitized, payload);
  });
});
