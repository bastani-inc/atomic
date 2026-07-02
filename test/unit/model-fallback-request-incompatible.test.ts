import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  isRetryableModelFailure,
  normalizeModelFailureSignal,
} from "../../packages/workflows/src/runs/shared/model-fallback.js";

describe("request/context incompatibility fallback (#1580)", () => {
  test("retry classifier treats request/context incompatibility as fallbackable", () => {
    // HTTP 400 / 413 / 422 indicate the candidate cannot serve this request (bad
    // request body, payload too large, unsupported tools, context-window
    // overflow). These must be fallbackable so the loop advances to the next
    // candidate / current model.
    assert.equal(normalizeModelFailureSignal({ status: 400, message: "bad request" }).kind, "request_incompatible");
    assert.equal(isRetryableModelFailure({ status: 400, message: "bad request" }), true);
    assert.equal(normalizeModelFailureSignal({ statusCode: 422, message: "unprocessable" }).kind, "request_incompatible");
    assert.equal(isRetryableModelFailure({ statusCode: 422, message: "unprocessable" }), true);
    assert.equal(normalizeModelFailureSignal({ code: "422", message: "unprocessable" }).kind, "request_incompatible");
    assert.equal(normalizeModelFailureSignal({ httpStatus: 400, message: "bad" }).kind, "request_incompatible");
  });

  test("HTTP 413 payload/request-too-large is classified as fallbackable (#1580)", () => {
    // HTTP 413 Payload Too Large means the request exceeds what this candidate
    // can accept. It must be fallbackable so the loop advances. Covers all
    // status-bearing fields plus numeric/string codes.
    assert.equal(normalizeModelFailureSignal({ status: 413, message: "payload too large" }).kind, "request_incompatible");
    assert.equal(isRetryableModelFailure({ status: 413, message: "payload too large" }), true);
    assert.equal(normalizeModelFailureSignal({ statusCode: 413, message: "request entity too large" }).kind, "request_incompatible");
    assert.equal(isRetryableModelFailure({ statusCode: 413, message: "request entity too large" }), true);
    assert.equal(normalizeModelFailureSignal({ httpStatus: 413, message: "too large" }).kind, "request_incompatible");
    assert.equal(isRetryableModelFailure({ httpStatus: 413, message: "too large" }), true);
    assert.equal(normalizeModelFailureSignal({ code: 413, message: "payload too large" }).kind, "request_incompatible");
    assert.equal(isRetryableModelFailure({ code: 413, message: "payload too large" }), true);
    assert.equal(normalizeModelFailureSignal({ code: "413", message: "too large" }).kind, "request_incompatible");
    assert.equal(isRetryableModelFailure({ code: "413", message: "too large" }), true);
  });

  test("retry classifier classifies request-incompatible codes as fallbackable", () => {
    const codes: readonly (string | number)[] = [
      "invalid_request_error",
      "invalid_request",
      "bad_request",
      "context_length_exceeded",
      "request_too_large",
      "too_large",
      "max_tokens",
    ];
    for (const code of codes) {
      const signal = normalizeModelFailureSignal({ code, message: "localized" });
      assert.equal(signal.kind, "request_incompatible", `code ${code}`);
      assert.equal(isRetryableModelFailure({ code, message: "localized" }), true, `code ${code}`);
    }
  });

  test("retry classifier classifies request-incompatible messages as fallbackable", () => {
    const messages = [
      "This model's context length exceeded",
      "request too large for this model",
      "unsupported tool: computer-use",
      "parameter not supported by this model",
      "invalid_request_error: bad input",
      "bad request body",
    ];
    for (const message of messages) {
      assert.equal(isRetryableModelFailure(new Error(message)), true, `message "${message}"`);
      assert.equal(normalizeModelFailureSignal(new Error(message)).kind, "request_incompatible", `message "${message}"`);
    }
  });

  test("request incompatibility does not outrank refusals or cancellations", () => {
    // A 400/413/422 wrapper hiding a refusal/cancel must still stop the fallback.
    assert.equal(isRetryableModelFailure({ status: 400, stopReason: "aborted", errorMessage: "aborted" }), false);
    assert.equal(isRetryableModelFailure({ statusCode: 422, name: "AbortError", message: "aborted by user" }), false);
    assert.equal(isRetryableModelFailure({ httpStatus: 400, message: "content_filter" }), false);
    assert.equal(isRetryableModelFailure({ status: 422, diagnostics: [{ error: { message: "command failed" } }] }), false);
    assert.equal(isRetryableModelFailure({ status: 413, stopReason: "aborted", errorMessage: "aborted" }), false);
  });

  test("non-retryable nested causes win over retryable wrapper messages", () => {
    // A generic request-incompatible wrapper that hides a non-retryable nested
    // cause/diagnostic must classify as non-retryable, not request_incompatible.
    const abortCause = new Error("aborted by user");
    abortCause.name = "AbortError";
    const wrapperWithAbortCause = new Error("invalid request", { cause: abortCause });
    assert.equal(isRetryableModelFailure(wrapperWithAbortCause), false);
    assert.equal(normalizeModelFailureSignal(wrapperWithAbortCause).kind, "cancelled");

    const wrapperWithCancelCause = { message: "400 bad request", cause: { message: "request was cancelled" } };
    assert.equal(isRetryableModelFailure(wrapperWithCancelCause), false);
    assert.equal(normalizeModelFailureSignal(wrapperWithCancelCause).kind, "cancelled");

    const wrapperWithTaskFailureCause = { errorMessage: "bad request", cause: { message: "command failed: exit 1" } };
    assert.equal(isRetryableModelFailure(wrapperWithTaskFailureCause), false);
    assert.equal(normalizeModelFailureSignal(wrapperWithTaskFailureCause).kind, "task_failure");

    const wrapperWithContentFilterDiagnostic = {
      message: "invalid_request_error",
      diagnostics: [{ error: { finish_reason: "content_filter" } }],
    };
    assert.equal(isRetryableModelFailure(wrapperWithContentFilterDiagnostic), false);
    assert.equal(normalizeModelFailureSignal(wrapperWithContentFilterDiagnostic).kind, "task_failure");

    const wrapperWithSafetyDiagnostic = {
      errorMessage: "400 bad request",
      diagnostics: [{ error: { message: "blocked by safety policy" } }],
    };
    assert.equal(isRetryableModelFailure(wrapperWithSafetyDiagnostic), false);
    assert.equal(normalizeModelFailureSignal(wrapperWithSafetyDiagnostic).kind, "task_failure");
  });

  test("genuine request-incompatible wrappers still classify as fallbackable", () => {
    // Wrappers with no non-retryable nested signal must remain request_incompatible.
    assert.equal(
      normalizeModelFailureSignal(new Error("invalid request")).kind,
      "request_incompatible",
    );
    assert.equal(isRetryableModelFailure(new Error("invalid request")), true);

    assert.equal(
      normalizeModelFailureSignal({ message: "400 bad request" }).kind,
      "request_incompatible",
    );
    assert.equal(isRetryableModelFailure({ message: "400 bad request" }), true);

    // A retryable nested cause should not turn a retryable wrapper non-retryable.
    const wrapperWithRetryableCause = { errorMessage: "bad request", cause: { message: "rate limit exceeded" } };
    assert.equal(isRetryableModelFailure(wrapperWithRetryableCause), true);
  });
});
