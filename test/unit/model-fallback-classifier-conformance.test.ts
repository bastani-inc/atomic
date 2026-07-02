import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  isRetryableModelFailure as subagentsIsRetryable,
  normalizeModelFailureSignal as subagentsNormalize,
} from "../../packages/subagents/src/runs/shared/model-fallback.js";
import {
  isRetryableModelFailure as workflowsIsRetryable,
  normalizeModelFailureSignal as workflowsNormalize,
} from "../../packages/workflows/src/runs/shared/model-fallback.js";

// The subagents and workflows model-failure classifiers are maintained as parallel
// copies (packages/subagents/src/runs/shared/model-fallback.ts and
// packages/workflows/src/runs/shared/model-fallback-failures.ts). This conformance
// suite runs a shared corpus of failure fixtures through both and asserts they
// agree, so a change to one copy that silently diverges the other fails here.
//
// Known intentional difference (not covered by the shared corpus): the workflows
// classifier has an extra `transport_error` kind for bare "connection error." /
// "fetch failed." wrapper messages that the subagents classifier does not model.

type Fixture = { label: string; failure: unknown; kind: string; retryable: boolean };

function abortWrappedError(): Error {
  const abortCause = new Error("aborted by user");
  abortCause.name = "AbortError";
  return new Error("invalid request", { cause: abortCause });
}

const CONFORMANCE_FIXTURES: readonly Fixture[] = [
  // HTTP status classification.
  { label: "status 400", failure: { status: 400, message: "bad request" }, kind: "request_incompatible", retryable: true },
  { label: "status 413", failure: { statusCode: 413, message: "payload too large" }, kind: "request_incompatible", retryable: true },
  { label: "status 422", failure: { httpStatus: 422, message: "unprocessable" }, kind: "request_incompatible", retryable: true },
  { label: "status 401", failure: { status: 401, message: "unauthorized" }, kind: "auth_on_candidate_provider", retryable: true },
  { label: "status 403", failure: { status: 403, message: "forbidden" }, kind: "auth_on_candidate_provider", retryable: true },
  { label: "status 404", failure: { status: 404, message: "model missing" }, kind: "model_unavailable", retryable: true },
  { label: "status 408", failure: { status: 408, message: "request timeout" }, kind: "network_timeout", retryable: true },
  { label: "status 429", failure: { status: 429, message: "slow down" }, kind: "rate_limit", retryable: true },
  { label: "status 503", failure: { status: 503, message: "service unavailable" }, kind: "provider_unavailable", retryable: true },
  // Request-incompatible provider codes (numeric, string, and named).
  { label: "code 413 numeric", failure: { code: 413, message: "too big" }, kind: "request_incompatible", retryable: true },
  { label: "code 422 string", failure: { code: "422", message: "unprocessable" }, kind: "request_incompatible", retryable: true },
  { label: "code invalid_request_error", failure: { code: "invalid_request_error", message: "localized" }, kind: "request_incompatible", retryable: true },
  { label: "code bad_request", failure: { code: "bad_request", message: "localized" }, kind: "request_incompatible", retryable: true },
  { label: "code context_length_exceeded", failure: { code: "context_length_exceeded", message: "localized" }, kind: "request_incompatible", retryable: true },
  { label: "code request_too_large", failure: { code: "request_too_large", message: "localized" }, kind: "request_incompatible", retryable: true },
  { label: "code max_tokens", failure: { code: "max_tokens", message: "localized" }, kind: "request_incompatible", retryable: true },
  // Request-incompatible messages.
  { label: "message context length", failure: new Error("This model's context length exceeded"), kind: "request_incompatible", retryable: true },
  { label: "message context window", failure: new Error("context window exceeded for candidate"), kind: "request_incompatible", retryable: true },
  { label: "message request too large", failure: new Error("request too large for this model"), kind: "request_incompatible", retryable: true },
  { label: "message unsupported tool", failure: new Error("unsupported tool: computer-use"), kind: "request_incompatible", retryable: true },
  { label: "message parameter not supported", failure: new Error("parameter not supported by this model"), kind: "request_incompatible", retryable: true },
  { label: "message invalid request", failure: new Error("invalid request"), kind: "request_incompatible", retryable: true },
  { label: "message bad request", failure: { message: "400 bad request" }, kind: "request_incompatible", retryable: true },
  // Refusals/cancellations must win over request-incompatible wrappers.
  { label: "aborted stopReason wrapper", failure: { status: 400, stopReason: "aborted", errorMessage: "aborted" }, kind: "cancelled", retryable: false },
  { label: "AbortError name wrapper", failure: { statusCode: 422, name: "AbortError", message: "aborted by user" }, kind: "cancelled", retryable: false },
  { label: "content filter wrapper", failure: { httpStatus: 400, message: "content_filter" }, kind: "task_failure", retryable: false },
  { label: "abort cause under invalid request", failure: abortWrappedError(), kind: "cancelled", retryable: false },
  { label: "cancel cause under 400 wrapper", failure: { message: "400 bad request", cause: { message: "request was cancelled" } }, kind: "cancelled", retryable: false },
  { label: "task failure cause under bad request", failure: { errorMessage: "bad request", cause: { message: "command failed: exit 1" } }, kind: "task_failure", retryable: false },
  { label: "content filter diagnostic under invalid_request_error", failure: { message: "invalid_request_error", diagnostics: [{ error: { finish_reason: "content_filter" } }] }, kind: "task_failure", retryable: false },
  { label: "safety diagnostic under 400 wrapper", failure: { errorMessage: "400 bad request", diagnostics: [{ error: { message: "blocked by safety policy" } }] }, kind: "task_failure", retryable: false },
  { label: "task failure diagnostic under 422", failure: { status: 422, diagnostics: [{ error: { message: "command failed" } }] }, kind: "task_failure", retryable: false },
  // Retryable nested causes must not flip a retryable wrapper.
  { label: "rate limit cause under bad request", failure: { errorMessage: "bad request", cause: { message: "rate limit exceeded" } }, kind: "request_incompatible", retryable: true },
  // Common retryable classifications shared by both copies.
  { label: "message rate limit", failure: new Error("Rate limit exceeded, retry later"), kind: "rate_limit", retryable: true },
  { label: "message api key", failure: new Error("No API key found for provider"), kind: "auth_on_candidate_provider", retryable: true },
  { label: "message model not found", failure: new Error("model not found: foo/bar"), kind: "model_unavailable", retryable: true },
  { label: "code etimedout", failure: { code: "ETIMEDOUT", message: "socket timed out" }, kind: "network_timeout", retryable: true },
  { label: "message overloaded", failure: new Error("provider is overloaded (529)"), kind: "provider_unavailable", retryable: true },
  // Non-retryable terminal failures.
  { label: "message tests failed", failure: new Error("tests failed: 3 failures"), kind: "task_failure", retryable: false },
  { label: "message interrupted", failure: new Error("interrupted by user"), kind: "cancelled", retryable: false },
  { label: "unknown structured failure", failure: { message: "something inexplicable happened" }, kind: "unknown", retryable: false },
];

describe("model fallback classifier conformance (subagents vs workflows)", () => {
  test("both classifiers agree on the shared failure corpus", () => {
    for (const fixture of CONFORMANCE_FIXTURES) {
      const subagentsSignal = subagentsNormalize(fixture.failure);
      const workflowsSignal = workflowsNormalize(fixture.failure);
      assert.equal(subagentsSignal.kind, fixture.kind, `subagents kind for ${fixture.label}`);
      assert.equal(workflowsSignal.kind, fixture.kind, `workflows kind for ${fixture.label}`);
      assert.equal(subagentsIsRetryable(fixture.failure), fixture.retryable, `subagents retryable for ${fixture.label}`);
      assert.equal(workflowsIsRetryable(fixture.failure), fixture.retryable, `workflows retryable for ${fixture.label}`);
    }
  });

  test("classifiers agree on retryability for wrapper permutations", () => {
    const wrappers: readonly unknown[] = [
      { status: 400, cause: { name: "AbortError", message: "aborted" } },
      { status: 413, stopReason: "aborted", errorMessage: "aborted" },
      { code: "context_window_exceeded", message: "context window exceeded" },
      { code: "request_entity_too_large", message: "entity too large" },
      { message: "invalid_request_error: bad input" },
      { message: "bad request body" },
    ];
    for (const [index, wrapper] of wrappers.entries()) {
      assert.equal(
        subagentsIsRetryable(wrapper),
        workflowsIsRetryable(wrapper),
        `retryability parity for wrapper #${index}`,
      );
    }
  });
});
