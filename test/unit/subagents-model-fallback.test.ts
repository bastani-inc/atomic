import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildModelCandidates,
  currentModelFullId,
  shouldSuppressExpectedAuthFallbackWarning,
} from "../../packages/subagents/src/runs/shared/model-fallback.js";
import type { AvailableModelInfo } from "../../packages/subagents/src/runs/shared/model-fallback.js";

const models: AvailableModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
  { provider: "github-copilot", id: "claude-sonnet-4", fullId: "github-copilot/claude-sonnet-4" },
  { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
  { provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5" },
  { provider: "local", id: "fallback", fullId: "local/fallback" },
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

  test("shouldSuppressExpectedAuthFallbackWarning suppresses expected missing-auth noise across providers", () => {
    assert.equal(
      shouldSuppressExpectedAuthFallbackWarning(
        "No API key found for openai.",
        "openai/gpt-5.5:high",
        "github-copilot/gpt-5.5:medium",
      ),
      true,
    );
    assert.equal(
      shouldSuppressExpectedAuthFallbackWarning(
        "missing API key",
        "anthropic/claude-sonnet-4",
        "github-copilot/claude-sonnet-4",
      ),
      true,
    );
    assert.equal(
      shouldSuppressExpectedAuthFallbackWarning(
        "No API key found for openai.",
        "openai/gpt-5.5",
        "openai-codex/gpt-5.5",
      ),
      true,
    );
    assert.equal(
      shouldSuppressExpectedAuthFallbackWarning(
        "Credentials are missing for anthropic.",
        "anthropic/claude-sonnet-4",
        "local/fallback",
      ),
      true,
    );
    assert.equal(
      shouldSuppressExpectedAuthFallbackWarning(
        "503 service unavailable",
        "openai/gpt-5.5",
        "github-copilot/claude-sonnet-4",
      ),
      false,
    );
    assert.equal(
      shouldSuppressExpectedAuthFallbackWarning(
        "Authentication failed for github-copilot. Credentials may have expired.",
        "openai/gpt-5.5",
        "github-copilot/claude-sonnet-4",
      ),
      false,
    );
    assert.equal(
      shouldSuppressExpectedAuthFallbackWarning(
        "No API key found for github-copilot.",
        "github-copilot/gpt-5.5",
        "github-copilot/claude-sonnet-4",
      ),
      false,
    );
  });
});
