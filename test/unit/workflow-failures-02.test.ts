// @ts-nocheck
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
  test("lets invalid credentials win over rate limits in aggregate failures", () => {
    const failure = classifyWorkflowFailure(new AggregateError([
      { status: 429, message: "too many requests" },
      { status: 401, message: "Unauthorized" },
    ], "atomic-workflows: 2 parallel steps failed"));

    assert.equal(failure.kind, "auth");
    assert.equal(failure.code, "invalid_api_key");
    assert.equal(failure.recoverability, "non_recoverable");
    assert.equal(failure.disposition, "terminal_killed");
    assert.equal(failure.resumable, false);
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
  test("treats bare retryAfter as seconds while explicit retryAfterMs remains milliseconds", () => {
    const explicitMs = classifyWorkflowFailure({
      message: "slow down",
      status: 429,
      retryAfterMs: 2500,
    });
    assert.equal(explicitMs.kind, "rate_limit");
    assert.equal(explicitMs.retryAfterMs, 2500);

    const direct = classifyWorkflowFailure({
      message: "slow down",
      status: 429,
      retryAfter: 3,
    });
    assert.equal(direct.kind, "rate_limit");
    assert.equal(direct.retryAfterMs, 3000);

    const seconds = classifyWorkflowFailure({
      message: "slow down",
      status: 429,
      retryAfterSeconds: 3,
    });
    assert.equal(seconds.kind, "rate_limit");
    assert.equal(seconds.retryAfterMs, 3000);

    const header = classifyWorkflowFailure({
      message: "slow down",
      status: 429,
      "retry-after": "3",
    });
    assert.equal(header.kind, "rate_limit");
    assert.equal(header.retryAfterMs, 3000);
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
  test("redacts top-level structured invalid provider credential messages", () => {
    for (const secret of [
      "sk-testsecret1234567890",
      "api_key=super-secret-value",
      "token=super-secret-value",
      "credential=super-secret-value",
      "secret=super-secret-value",
      "Authorization: Bearer secret-token-value",
      "Bearer secret-token-value",
    ] as const) {
      const failure = classifyWorkflowFailure({
        status: 401,
        code: "invalid_api_key",
        message: `Incorrect API key provided: ${secret}`,
      });

      assert.equal(failure.kind, "auth");
      assert.equal(failure.code, "invalid_api_key");
      assert.equal(failure.userMessage, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
      assert.equal(failure.message.includes(secret), false);
      assert.equal(failure.userMessage.includes(secret), false);
      assert.match(failure.message, /\[redacted\]/);
    }
  });
  test("redacts string-only invalid provider key fallback messages", () => {
    const secret = "sk-testsecret1234567890";
    const failure = classifyWorkflowFailure(new Error(`Incorrect API key provided: ${secret}`));

    assert.equal(failure.kind, "auth");
    assert.equal(failure.code, "invalid_api_key");
    assert.equal(failure.userMessage, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
    assert.equal(failure.message.includes(secret), false);
    assert.match(failure.message, /\[redacted\]/);
  });
  test("redacts sensitive fallback unknown messages", () => {
    for (const secret of [
      "api_key=super-secret-value",
      "token=super-secret-value",
      "credential=super-secret-value",
      "secret=super-secret-value",
      "Authorization: Bearer secret-token-value",
      "Bearer secret-token-value",
    ] as const) {
      const failure = classifyWorkflowFailure(new Error(`tool failed with ${secret}`));
      assert.equal(failure.kind, "unknown");
      assert.equal(failure.code, "unknown");
      assert.equal(failure.message.includes(secret), false);
      assert.equal(failure.userMessage.includes(secret), false);
      assert.match(failure.message, /\[redacted\]/);
      assert.match(failure.userMessage, /\[redacted\]/);
    }
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

  test("classifies git subprocess timeouts without treating them as repository setup errors", () => {
    const failure = classifyWorkflowFailure(new Error("Timed out while checking the Git repository for gitWorktreeDir from /repo. Git reported: git command timed out after 60000ms (ETIMEDOUT): spawnSync git ETIMEDOUT"));
    assert.equal(failure.kind, "provider");
    assert.equal(failure.code, "provider_unavailable");
    assert.equal(failure.retryable, true);
    assert.equal(failure.disposition, "active_blocked");
    assert.doesNotMatch(failure.userMessage, /not inside a Git repository/);
  });

  test("does not treat unrelated local timeout messages as provider outages", () => {
    for (const message of ["local database timeout while acquiring lock", "unit test timeout exceeded"]) {
      const failure = classifyWorkflowFailure(new Error(message));
      assert.equal(failure.kind, "unknown");
      assert.equal(failure.retryable, false);
      assert.equal(failure.disposition, "terminal_failed");
    }
  });
  test("still treats OAuth token errors as auth failures", () => {
    const failure = classifyWorkflowFailure(new Error("OAuth token expired"));
    assert.equal(failure.kind, "auth");
    assert.equal(failure.code, "login_required");
    assert.equal(failure.userMessage, WORKFLOW_AUTH_FAILURE_MESSAGE);
  });
});
