/**
 * Unit tests for workflow-local failure classification.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  WORKFLOW_AUTH_FAILURE_MESSAGE,
  WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE,
  WORKFLOW_MISSING_API_KEY_FAILURE_MESSAGE,
  WORKFLOW_UNKNOWN_MODEL_MESSAGE,
  classifyWorkflowFailure,
} from "../../packages/workflows/src/shared/workflow-failures.js";

describe("classifyWorkflowFailure", () => {
  test("normalizes missing provider key failures to recoverable active-blocked auth", () => {
    const failure = classifyWorkflowFailure(new Error("No API key found for provider"));
    assert.equal(failure.kind, "auth");
    assert.equal(failure.code, "missing_api_key");
    assert.equal(failure.userMessage, WORKFLOW_MISSING_API_KEY_FAILURE_MESSAGE);
    assert.equal(failure.message, "No API key found for provider");
    assert.equal(failure.retryable, true);
    assert.equal(failure.resumable, true);
    assert.equal(failure.recoverability, "recoverable");
    assert.equal(failure.disposition, "active_blocked");
  });

  test("classifies 429/quota failures as recoverable active-blocked rate limits", () => {
    const failure = classifyWorkflowFailure(new Error("HTTP 429 quota exceeded"));
    assert.equal(failure.kind, "rate_limit");
    assert.equal(failure.code, "rate_limited");
    assert.equal(failure.userMessage, "HTTP 429 quota exceeded");
    assert.equal(failure.retryable, true);
    assert.equal(failure.resumable, true);
    assert.equal(failure.recoverability, "recoverable");
    assert.equal(failure.disposition, "active_blocked");
  });

  test("classifies quota-only fallback text as recoverable active-blocked", () => {
    const failure = classifyWorkflowFailure(new Error("quota exceeded"));
    assert.equal(failure.kind, "rate_limit");
    assert.equal(failure.code, "quota_limited");
    assert.equal(failure.disposition, "active_blocked");
    assert.equal(failure.resumable, true);
  });

  test("classifies abort errors as non-resumable terminal cancellation", () => {
    const failure = classifyWorkflowFailure(new DOMException("workflow killed", "AbortError"));
    assert.equal(failure.kind, "cancelled");
    assert.equal(failure.code, "cancelled");
    assert.equal(failure.retryable, false);
    assert.equal(failure.resumable, false);
    assert.equal(failure.recoverability, "non_recoverable");
    assert.equal(failure.disposition, "terminal_killed");
  });

  test("classifies provider/model outages separately from auth", () => {
    const failure = classifyWorkflowFailure(new Error("model provider service unavailable"));
    assert.equal(failure.kind, "provider");
    assert.equal(failure.code, "provider_unavailable");
    assert.equal(failure.retryable, true);
    assert.equal(failure.resumable, true);
    assert.equal(failure.disposition, "active_blocked");
  });

  test("uses structured HTTP statuses before message fallback", () => {
    const auth = classifyWorkflowFailure({ message: "request failed", status: 401 });
    assert.equal(auth.kind, "auth");
    assert.equal(auth.code, "invalid_api_key");
    assert.equal(auth.userMessage, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);

    const rateLimit = classifyWorkflowFailure({ message: "request failed", statusCode: 429 });
    assert.equal(rateLimit.kind, "rate_limit");
    assert.equal(rateLimit.code, "rate_limited");
    assert.equal(rateLimit.retryable, true);

    const provider = classifyWorkflowFailure({ message: "request failed", status: 503 });
    assert.equal(provider.kind, "provider");
    assert.equal(provider.code, "provider_unavailable");
    assert.equal(provider.retryable, true);
  });

  test("keeps provider 401 auth text classified as invalid provider credentials", () => {
    for (const message of ["Unauthorized", "authentication required"]) {
      const failure = classifyWorkflowFailure({ status: 401, message });
      assert.equal(failure.kind, "auth");
      assert.equal(failure.code, "invalid_api_key");
      assert.equal(failure.recoverability, "non_recoverable");
      assert.equal(failure.disposition, "terminal_killed");
      assert.equal(failure.userMessage, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
    }
  });

  test("uses missing API key diagnostics before generic wrapper 401 defaults", () => {
    const failure = classifyWorkflowFailure({
      status: 401,
      message: "provider request failed",
      diagnostics: [{ error: { code: "missing_api_key", message: "No API key found" } }],
    });

    assert.equal(failure.kind, "auth");
    assert.equal(failure.code, "missing_api_key");
    assert.equal(failure.recoverability, "recoverable");
    assert.equal(failure.disposition, "active_blocked");
    assert.equal(failure.resumable, true);
    assert.equal(failure.message, "No API key found");
    assert.equal(failure.userMessage, WORKFLOW_MISSING_API_KEY_FAILURE_MESSAGE);
  });

  test("uses structured codes and causes before message fallback", () => {
    const auth = classifyWorkflowFailure({ message: "provider error", code: "AUTH_REQUIRED" });
    assert.equal(auth.kind, "auth");
    assert.equal(auth.code, "login_required");

    const rateLimit = classifyWorkflowFailure(new Error("outer failure", {
      cause: { message: "inner failure", code: "rate_limit_exceeded" },
    }));
    assert.equal(rateLimit.kind, "rate_limit");
    assert.equal(rateLimit.code, "rate_limited");

    const cancelled = classifyWorkflowFailure({ message: "stopped", code: "AbortError" });
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(cancelled.disposition, "terminal_killed");
  });

  test("treats broad auth wrapper codes as weak when the message names provider credentials", () => {
    const failure = classifyWorkflowFailure({
      code: "auth",
      message: "Incorrect API key provided",
    });
    assert.equal(failure.kind, "auth");
    assert.equal(failure.code, "invalid_api_key");
    assert.equal(failure.recoverability, "non_recoverable");
    assert.equal(failure.disposition, "terminal_killed");
    assert.equal(failure.userMessage, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
  });

  test("uses SDK assistant error shapes", () => {
    const failure = classifyWorkflowFailure({
      role: "assistant",
      stopReason: "error",
      errorMessage: "provider request failed",
      diagnostics: [{ error: { code: 429, message: "quota exceeded" } }],
    });
    assert.equal(failure.kind, "rate_limit");
    assert.equal(failure.code, "rate_limited");
    assert.equal(failure.message, "quota exceeded");

    const cancelled = classifyWorkflowFailure({
      role: "assistant",
      stopReason: "aborted",
      errorMessage: "stream aborted",
    });
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(cancelled.disposition, "terminal_killed");
  });

  test("classifies OpenAI-style invalid API key diagnostics as terminal killed", () => {
    const failure = classifyWorkflowFailure({
      role: "assistant",
      stopReason: "error",
      errorMessage: "provider request failed",
      diagnostics: [{
        error: {
          status: 401,
          code: "invalid_api_key",
          message: "Incorrect API key provided: sk-testsecret123456789",
        },
      }],
    });

    assert.equal(failure.kind, "auth");
    assert.equal(failure.code, "invalid_api_key");
    assert.equal(failure.recoverability, "non_recoverable");
    assert.equal(failure.disposition, "terminal_killed");
    assert.equal(failure.retryable, false);
    assert.equal(failure.resumable, false);
    assert.equal(failure.userMessage, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
    assert.doesNotMatch(failure.message, /sk-testsecret123456789/);
    assert.doesNotMatch(failure.userMessage, /sk-testsecret/);
  });

  test("uses diagnostic-only invalid key messages as the decisive failure message", () => {
    const failure = classifyWorkflowFailure({
      role: "assistant",
      stopReason: "error",
      errorMessage: "provider request failed",
      diagnostics: [{
        error: {
          message: "Incorrect API key provided",
        },
      }],
    });

    assert.equal(failure.kind, "auth");
    assert.equal(failure.code, "invalid_api_key");
    assert.equal(failure.message, "Incorrect API key provided");
    assert.equal(failure.userMessage, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
  });

  test("classifies AggregateError inner provider failures before wrapper text", () => {
    const rateLimited = classifyWorkflowFailure(new AggregateError([
      { status: 429, message: "too many requests" },
    ], "atomic-workflows: 1 parallel step failed"));
    assert.equal(rateLimited.kind, "rate_limit");
    assert.equal(rateLimited.code, "rate_limited");
    assert.equal(rateLimited.disposition, "active_blocked");

    const invalidKey = classifyWorkflowFailure(new AggregateError([
      { status: 401, message: "Unauthorized" },
    ], "atomic-workflows: 1 parallel step failed"));
    assert.equal(invalidKey.kind, "auth");
    assert.equal(invalidKey.code, "invalid_api_key");
    assert.equal(invalidKey.disposition, "terminal_killed");
  });

  test("extracts retry-after metadata from structured rate limits", () => {
    const failure = classifyWorkflowFailure({
      message: "slow down",
      status: 429,
      headers: { "retry-after": "3" },
    });
    assert.equal(failure.kind, "rate_limit");
    assert.equal(failure.disposition, "active_blocked");
    assert.equal(failure.retryAfterMs, 3000);
  });

  test("structured 429 wins over misleading auth text", () => {
    const failure = classifyWorkflowFailure({
      message: "Incorrect API key mentioned in provider retry body",
      status: 429,
    });
    assert.equal(failure.kind, "rate_limit");
    assert.equal(failure.code, "rate_limited");
    assert.equal(failure.disposition, "active_blocked");
  });

  test("redacts sensitive fallback user messages", () => {
    const failure = classifyWorkflowFailure(new Error("tool failed with api_key=super-secret-value"));
    assert.equal(failure.kind, "unknown");
    assert.equal(failure.message, "tool failed with api_key=super-secret-value");
    assert.equal(failure.userMessage, "tool failed with api_key=[redacted]");
  });

  test("does not treat log information/input errors as auth failures", () => {
    for (const message of [
      "failed to log information about request",
      "failed to log input before validation",
    ]) {
      const failure = classifyWorkflowFailure(new Error(message));
      assert.equal(failure.kind, "unknown");
      assert.equal(failure.userMessage, message);
      assert.equal(failure.retryable, false);
      assert.equal(failure.disposition, "terminal_failed");
    }
  });

  test("still treats bounded log in guidance as auth failure", () => {
    const failure = classifyWorkflowFailure(new Error("Please log in to continue"));
    assert.equal(failure.kind, "auth");
    assert.equal(failure.code, "login_required");
    assert.equal(failure.userMessage, WORKFLOW_AUTH_FAILURE_MESSAGE);
    assert.equal(failure.disposition, "active_blocked");
  });

  test("does not treat generic domain/tool model errors as provider outages", () => {
    for (const message of [
      "domain model validation failed",
      "invalid model parameter passed to tool",
    ]) {
      const failure = classifyWorkflowFailure(new Error(message));
      assert.equal(failure.kind, "unknown");
      assert.equal(failure.retryable, false);
    }
  });

  test("distinguishes unavailable providers from unknown models", () => {
    const unavailable = classifyWorkflowFailure(new Error("model unavailable"));
    assert.equal(unavailable.kind, "provider");
    assert.equal(unavailable.code, "provider_unavailable");
    assert.equal(unavailable.retryable, true);

    const missing = classifyWorkflowFailure(new Error("model not found"));
    assert.equal(missing.kind, "provider");
    assert.equal(missing.code, "unknown_model");
    assert.equal(missing.userMessage, WORKFLOW_UNKNOWN_MODEL_MESSAGE);
    assert.equal(missing.retryable, false);
    assert.equal(missing.resumable, false);
    assert.equal(missing.disposition, "terminal_killed");
  });

  test("does not treat generic OAuth metadata errors as auth failures", () => {
    const failure = classifyWorkflowFailure(new Error("OAuth callback metadata parse failed"));
    assert.equal(failure.kind, "unknown");
    assert.equal(failure.userMessage, "OAuth callback metadata parse failed");
  });

  test("still treats OAuth token errors as auth failures", () => {
    const failure = classifyWorkflowFailure(new Error("OAuth token expired"));
    assert.equal(failure.kind, "auth");
    assert.equal(failure.code, "login_required");
    assert.equal(failure.userMessage, WORKFLOW_AUTH_FAILURE_MESSAGE);
  });
});
