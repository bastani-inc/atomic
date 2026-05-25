/**
 * Unit tests for workflow-local failure classification.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  NON_BLOCKING_MCP_OAUTH_INIT_MESSAGE,
  WORKFLOW_AUTH_FAILURE_MESSAGE,
  classifyWorkflowFailure,
  sanitizeWorkflowVisibleError,
} from "../../packages/workflows/src/shared/workflow-failures.js";

describe("sanitizeWorkflowVisibleError", () => {
  test("removes the benign MCP OAuth initialization line with LF or CRLF", () => {
    assert.equal(
      sanitizeWorkflowVisibleError(`${NON_BLOCKING_MCP_OAUTH_INIT_MESSAGE}\nNo API key found for openai.`),
      "No API key found for openai.",
    );
    assert.equal(
      sanitizeWorkflowVisibleError(`${NON_BLOCKING_MCP_OAUTH_INIT_MESSAGE}\r\nNo API key found for openai.`),
      "No API key found for openai.",
    );
  });

  test("does not suppress blocking MCP or explicit OAuth authentication errors", () => {
    for (const message of [
      "MCP initialization failed: connection refused",
      'OAuth authentication failed for "github": callback server unavailable',
      `${NON_BLOCKING_MCP_OAUTH_INIT_MESSAGE}: callback server unavailable`,
    ]) {
      assert.equal(sanitizeWorkflowVisibleError(message), message);
    }
  });
});

describe("classifyWorkflowFailure", () => {
  test("preserves diagnostic message while sanitizing benign MCP OAuth noise for users", () => {
    const message = `${NON_BLOCKING_MCP_OAUTH_INIT_MESSAGE}\nA later stage failed unexpectedly.`;
    const failure = classifyWorkflowFailure(new Error(message));
    assert.equal(failure.kind, "unknown");
    assert.equal(failure.message, message);
    assert.equal(failure.userMessage, "A later stage failed unexpectedly.");
  });

  test("normalizes auth/no-key failures to workflow login guidance", () => {
    const failure = classifyWorkflowFailure(new Error("No API key found for provider"));
    assert.equal(failure.kind, "auth");
    assert.equal(failure.userMessage, WORKFLOW_AUTH_FAILURE_MESSAGE);
    assert.equal(failure.message, "No API key found for provider");
    assert.equal(failure.retryable, true);
    assert.equal(failure.resumable, true);
  });

  test("classifies 429/quota failures as resumable rate limits", () => {
    const failure = classifyWorkflowFailure(new Error("HTTP 429 quota exceeded"));
    assert.equal(failure.kind, "rate_limit");
    assert.equal(failure.userMessage, "HTTP 429 quota exceeded");
    assert.equal(failure.retryable, true);
    assert.equal(failure.resumable, true);
  });

  test("classifies abort errors as non-resumable cancellation", () => {
    const failure = classifyWorkflowFailure(new DOMException("workflow killed", "AbortError"));
    assert.equal(failure.kind, "cancelled");
    assert.equal(failure.retryable, false);
    assert.equal(failure.resumable, false);
  });

  test("classifies provider/model outages separately from auth", () => {
    const failure = classifyWorkflowFailure(new Error("model provider service unavailable"));
    assert.equal(failure.kind, "provider");
    assert.equal(failure.retryable, true);
    assert.equal(failure.resumable, true);
  });

  test("uses structured HTTP statuses before message fallback", () => {
    const auth = classifyWorkflowFailure({ message: "request failed", status: 401 });
    assert.equal(auth.kind, "auth");
    assert.equal(auth.userMessage, WORKFLOW_AUTH_FAILURE_MESSAGE);

    const rateLimit = classifyWorkflowFailure({ message: "request failed", statusCode: 429 });
    assert.equal(rateLimit.kind, "rate_limit");
    assert.equal(rateLimit.retryable, true);

    const provider = classifyWorkflowFailure({ message: "request failed", status: 503 });
    assert.equal(provider.kind, "provider");
    assert.equal(provider.retryable, true);
  });

  test("uses structured codes and causes before message fallback", () => {
    const auth = classifyWorkflowFailure({ message: "provider error", code: "AUTH_REQUIRED" });
    assert.equal(auth.kind, "auth");

    const rateLimit = classifyWorkflowFailure(new Error("outer failure", {
      cause: { message: "inner failure", code: "rate_limit_exceeded" },
    }));
    assert.equal(rateLimit.kind, "rate_limit");

    const cancelled = classifyWorkflowFailure({ message: "stopped", code: "AbortError" });
    assert.equal(cancelled.kind, "cancelled");
  });

  test("uses SDK assistant error shapes", () => {
    const failure = classifyWorkflowFailure({
      role: "assistant",
      stopReason: "error",
      errorMessage: "provider request failed",
      diagnostics: [{ error: { code: 429, message: "quota exceeded" } }],
    });
    assert.equal(failure.kind, "rate_limit");
    assert.equal(failure.message, "provider request failed");

    const cancelled = classifyWorkflowFailure({
      role: "assistant",
      stopReason: "aborted",
      errorMessage: "stream aborted",
    });
    assert.equal(cancelled.kind, "cancelled");
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
    }
  });

  test("still treats bounded log in guidance as auth failure", () => {
    const failure = classifyWorkflowFailure(new Error("Please log in to continue"));
    assert.equal(failure.kind, "auth");
    assert.equal(failure.userMessage, WORKFLOW_AUTH_FAILURE_MESSAGE);
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

  test("still treats unavailable or missing model errors as provider outages", () => {
    for (const message of ["model unavailable", "model not found"]) {
      const failure = classifyWorkflowFailure(new Error(message));
      assert.equal(failure.kind, "provider");
      assert.equal(failure.retryable, true);
    }
  });

  test("does not treat generic OAuth metadata errors as auth failures", () => {
    const failure = classifyWorkflowFailure(new Error("OAuth callback metadata parse failed"));
    assert.equal(failure.kind, "unknown");
    assert.equal(failure.userMessage, "OAuth callback metadata parse failed");
  });

  test("still treats OAuth token errors as auth failures", () => {
    const failure = classifyWorkflowFailure(new Error("OAuth token expired"));
    assert.equal(failure.kind, "auth");
    assert.equal(failure.userMessage, WORKFLOW_AUTH_FAILURE_MESSAGE);
  });
});
