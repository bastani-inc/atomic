import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildModelCandidates,
  currentModelFullId,
  isRetryableModelFailure,
  modelFailureMessage,
  normalizeModelFailureSignal,
} from "../../packages/subagents/src/runs/shared/model-fallback.js";
import type { AvailableModelInfo } from "../../packages/subagents/src/runs/shared/model-fallback.js";

const models: AvailableModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
  { provider: "github-copilot", id: "claude-sonnet-4", fullId: "github-copilot/claude-sonnet-4" },
  { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
];

describe("subagent model fallback helpers", () => {
  test("appends the current selected model after configured fallbacks", () => {
    assert.deepEqual(
      buildModelCandidates(
        "anthropic/primary",
        ["openai/fallback"],
        models,
        "github-copilot",
        "github-copilot/claude-sonnet-4",
      ),
      ["anthropic/primary", "openai/fallback", "github-copilot/claude-sonnet-4"],
    );
  });

  test("de-duplicates the current selected model when already attempted", () => {
    assert.deepEqual(
      buildModelCandidates(
        "claude-sonnet-4",
        ["openai/gpt-5-mini"],
        models,
        "github-copilot",
        "github-copilot/claude-sonnet-4",
      ),
      ["github-copilot/claude-sonnet-4", "openai/gpt-5-mini"],
    );
  });

  test("formats the selected model from the runtime model object", () => {
    assert.equal(
      currentModelFullId({ provider: "openai", id: "gpt-5-mini" }),
      "openai/gpt-5-mini",
    );
  });

  test("retry classifier uses structured diagnostics before localized text", () => {
    const failure = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "プロバイダー エラー",
      diagnostics: [{ error: { code: 429, message: "quota exhausted" } }],
    };

    assert.equal(normalizeModelFailureSignal(failure).kind, "rate_limit");
    assert.equal(isRetryableModelFailure(failure), true);
    assert.equal(isRetryableModelFailure({
      message: "localized wrapper",
      diagnostics: [{ error: { message: "service unavailable" } }],
    }), true);
  });

  test("retry classifier uses status, code, name, and causes", () => {
    assert.equal(isRetryableModelFailure({ status: 503, message: "localized" }), true);
    assert.equal(isRetryableModelFailure({ statusCode: 401, message: "localized" }), true);
    assert.equal(isRetryableModelFailure({ httpStatus: 403, message: "localized" }), true);
    assert.equal(isRetryableModelFailure({ code: "invalid_api_key", message: "localized" }), true);
    assert.equal(normalizeModelFailureSignal({ status: 408, message: "localized" }).kind, "network_timeout");
    assert.equal(normalizeModelFailureSignal({ status: 404, message: "localized" }).kind, "model_unavailable");
    assert.equal(normalizeModelFailureSignal({ code: "429", message: "localized" }).kind, "rate_limit");
    assert.equal(isRetryableModelFailure(new Error("outer", { cause: { code: "overloaded" } })), true);
  });

  test("retry classifier treats every structured HTTP-like 5xx status/code as provider unavailable", () => {
    const cases: readonly unknown[] = [
      { status: 529, message: "localized" },
      { statusCode: 520, message: "localized" },
      { httpStatus: 599, message: "localized" },
      { code: 529, message: "localized" },
      { code: "520", message: "localized" },
      { diagnostics: [{ error: { code: "529", message: "localized" } }] },
    ];

    for (const failure of cases) {
      assert.equal(normalizeModelFailureSignal(failure).kind, "provider_unavailable");
      assert.equal(isRetryableModelFailure(failure), true);
    }
  });

  test("retry classifier preserves refusal precedence over structured 5xx", () => {
    assert.equal(isRetryableModelFailure({ stopReason: "aborted", status: 599, code: 529 }), false);
    assert.equal(isRetryableModelFailure({ name: "AbortError", statusCode: 520, message: "request aborted" }), false);
    assert.equal(isRetryableModelFailure({ httpStatus: 529, message: "shell command failed" }), false);
    assert.equal(isRetryableModelFailure("completion guard failed after 599"), false);
  });

  test("retry classifier lets nested refusals outrank wrapper structured provider signals", () => {
    const refusalCases: ReadonlyArray<{
      label: string;
      failure: unknown;
      expectedKind: "cancelled" | "task_failure";
      expectedSource?: "diagnostic";
    }> = [
      {
        label: "5xx wrapper with abort cause",
        failure: { status: 503, cause: { name: "AbortError", message: "aborted by user" } },
        expectedKind: "cancelled",
      },
      {
        label: "429 wrapper with abort cause",
        failure: { code: "429", cause: { name: "AbortError", message: "rate-limit wrapper hid abort" } },
        expectedKind: "cancelled",
      },
      {
        label: "auth wrapper with diagnostic task failure",
        failure: {
          statusCode: 401,
          diagnostics: [{ error: { message: "completion guard failed after provider wrapper" } }],
        },
        expectedKind: "task_failure",
        expectedSource: "diagnostic",
      },
      {
        label: "timeout wrapper with diagnostic task failure",
        failure: {
          status: 408,
          diagnostics: [{ error: { message: "shell command failed after timeout wrapper" } }],
        },
        expectedKind: "task_failure",
        expectedSource: "diagnostic",
      },
      {
        label: "model unavailable wrapper with task failure cause",
        failure: { status: 404, cause: { message: "command failed: bun test" } },
        expectedKind: "task_failure",
      },
      {
        label: "nested abort below diagnostic 5xx",
        failure: {
          code: 529,
          diagnostics: [{ error: { status: 503, cause: { name: "AbortError", message: "nested abort" } } }],
        },
        expectedKind: "cancelled",
      },
    ];

    for (const { label, failure, expectedKind, expectedSource } of refusalCases) {
      const signal = normalizeModelFailureSignal(failure);
      assert.equal(signal.kind, expectedKind, label);
      if (expectedSource !== undefined) assert.equal(signal.source, expectedSource, label);
      assert.equal(isRetryableModelFailure(failure), false, label);
    }
  });

  test("retry classifier refuses provider content filters and refusal signals", () => {
    const refusalCases: ReadonlyArray<{
      label: string;
      failure: unknown;
      expectedSource?: "diagnostic";
    }> = [
      {
        label: "assistant content_filter message",
        failure: { role: "assistant", stopReason: "error", errorMessage: "content_filter" },
      },
      {
        label: "assistant finish_reason content_filter field",
        failure: { role: "assistant", stopReason: "error", finish_reason: "content_filter" },
      },
      {
        label: "diagnostic content_filter code",
        failure: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "localized provider error",
          diagnostics: [{ error: { code: "content_filter", message: "blocked by provider" } }],
        },
        expectedSource: "diagnostic",
      },
      {
        label: "safety policy refusal",
        failure: { role: "assistant", stopReason: "error", errorMessage: "request blocked by safety policy" },
      },
      {
        label: "tool refusal",
        failure: { role: "assistant", stopReason: "error", errorMessage: "tool call refused by provider" },
      },
      {
        label: "provider refusal",
        failure: { role: "assistant", stopReason: "error", errorMessage: "provider refused this request" },
      },
    ];

    for (const { label, failure, expectedSource } of refusalCases) {
      const signal = normalizeModelFailureSignal(failure);
      assert.equal(signal.kind, "task_failure", label);
      if (expectedSource !== undefined) assert.equal(signal.source, expectedSource, label);
      assert.equal(isRetryableModelFailure(failure), false, label);
    }
  });

  test("assistant stopReason error without an errorMessage is fallbackable", () => {
    const failure = { role: "assistant", stopReason: "error", diagnostics: [] };

    assert.equal(modelFailureMessage(failure), "Assistant message ended with stopReason:error");
    assert.equal(normalizeModelFailureSignal(failure).kind, "provider_unavailable");
    assert.equal(isRetryableModelFailure(failure), true);
  });

  test("retry classifier refuses aborted and task failures", () => {
    assert.equal(isRetryableModelFailure({ stopReason: "aborted", status: 503 }), false);
    assert.equal(isRetryableModelFailure({ name: "AbortError", status: 503, message: "aborted" }), false);
    assert.equal(isRetryableModelFailure({ status: 503, message: "shell command failed" }), false);
    assert.equal(isRetryableModelFailure("completion guard failed after 429"), false);
    assert.equal(isRetryableModelFailure("command failed: bun test"), false);
  });
});
