import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { _isRetryableError } from "../../packages/coding-agent/src/core/agent-session-retry.js";
import {
  isRetryableModelFailure as subagentsIsRetryable,
  normalizeModelFailureSignal as subagentsNormalize,
} from "../../packages/subagents/src/runs/shared/model-fallback.js";
import {
  isRetryableModelFailure as workflowsIsRetryable,
  normalizeModelFailureSignal as workflowsNormalize,
} from "../../packages/workflows/src/runs/shared/model-fallback.js";

const USAGE_LIMIT_MESSAGE = "Codex error: The usage limit has been reached";

describe("provider usage-limit exhaustion is a retryable quota/rate-limit failure", () => {
  test("plain thrown error text classifies as rate_limit in both classifier copies", () => {
    const failure = new Error(USAGE_LIMIT_MESSAGE);
    assert.equal(workflowsNormalize(failure).kind, "rate_limit");
    assert.equal(subagentsNormalize(failure).kind, "rate_limit");
    assert.equal(workflowsIsRetryable(failure), true);
    assert.equal(subagentsIsRetryable(failure), true);
  });

  test("session-shaped assistant error message classifies as rate_limit", () => {
    const failure = { stopReason: "error", errorMessage: USAGE_LIMIT_MESSAGE };
    assert.equal(workflowsNormalize(failure).kind, "rate_limit");
    assert.equal(subagentsNormalize(failure).kind, "rate_limit");
    assert.equal(workflowsIsRetryable(failure), true);
    assert.equal(subagentsIsRetryable(failure), true);
  });

  test("nested cause and diagnostic shapes classify as rate_limit", () => {
    const nestedCause = {
      message: "stage session failed",
      cause: { message: USAGE_LIMIT_MESSAGE },
    };
    const nestedDiagnostic = {
      stopReason: "error",
      diagnostics: [{ error: { message: USAGE_LIMIT_MESSAGE } }],
    };
    for (const failure of [nestedCause, nestedDiagnostic]) {
      assert.equal(workflowsNormalize(failure).kind, "rate_limit");
      assert.equal(subagentsNormalize(failure).kind, "rate_limit");
      assert.equal(workflowsIsRetryable(failure), true);
      assert.equal(subagentsIsRetryable(failure), true);
    }
  });

  test("usage-limit provider codes classify as rate_limit", () => {
    for (const code of ["usage_limit_reached", "usage_limit_exceeded", "usage_limit", "insufficient_quota"]) {
      const failure = { code, message: "localized provider text" };
      assert.equal(workflowsNormalize(failure).kind, "rate_limit", code);
      assert.equal(subagentsNormalize(failure).kind, "rate_limit", code);
      assert.equal(workflowsIsRetryable(failure), true, code);
      assert.equal(subagentsIsRetryable(failure), true, code);
    }
  });

  test("cancellation nested under a usage-limit wrapper stays non-retryable", () => {
    const failure = {
      errorMessage: USAGE_LIMIT_MESSAGE,
      cause: { name: "AbortError", message: "aborted by user" },
    };
    assert.equal(workflowsNormalize(failure).kind, "cancelled");
    assert.equal(subagentsNormalize(failure).kind, "cancelled");
    assert.equal(workflowsIsRetryable(failure), false);
    assert.equal(subagentsIsRetryable(failure), false);
  });

  test("safety refusals, task/tool failures, and unrelated errors remain non-retryable", () => {
    const fixtures: readonly { failure: unknown; kind: string }[] = [
      { failure: new Error("request blocked by safety policy"), kind: "task_failure" },
      { failure: new Error("tool call refused by provider"), kind: "task_failure" },
      { failure: new Error("command failed: exit 1"), kind: "task_failure" },
      { failure: new Error("tests failed: 3 failures"), kind: "task_failure" },
      { failure: new Error("interrupted by user"), kind: "cancelled" },
      { failure: { message: "something inexplicable happened" }, kind: "unknown" },
    ];
    for (const fixture of fixtures) {
      assert.equal(workflowsNormalize(fixture.failure).kind, fixture.kind);
      assert.equal(subagentsNormalize(fixture.failure).kind, fixture.kind);
      assert.equal(workflowsIsRetryable(fixture.failure), false);
      assert.equal(subagentsIsRetryable(fixture.failure), false);
    }
  });
});

describe("main-chat retry classifies usage-limit exhaustion as retryable", () => {
  function model(provider: string, id: string): Model<Api> {
    return {
      provider,
      id,
      api: provider as Api,
      contextWindow: 200_000,
      defaultContextWindow: 200_000,
      reasoning: true,
    } as Model<Api>;
  }

  function errorMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: USAGE_LIMIT_MESSAGE,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...overrides,
    } as AssistantMessage;
  }

  const session = { model: model("openai-codex", "gpt-5.5") };

  test("usage-limit and quota error messages are retryable so fallbackModels can advance", () => {
    assert.equal(_isRetryableError.call(session as never, errorMessage()), true);
    assert.equal(
      _isRetryableError.call(session as never, errorMessage({ errorMessage: "quota exceeded for this billing period" })),
      true,
    );
  });

  test("aborted turns and non-error stops are not retryable", () => {
    assert.equal(
      _isRetryableError.call(session as never, errorMessage({ stopReason: "aborted" } as Partial<AssistantMessage>)),
      false,
    );
    assert.equal(
      _isRetryableError.call(session as never, errorMessage({ errorMessage: "Tool not found" })),
      false,
    );
  });
});
