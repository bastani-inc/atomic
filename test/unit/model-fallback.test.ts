import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildModelCandidates,
  buildModelCandidateIds,
  splitReasoningSuffix,
  isRetryableModelFailure,
  validateWorkflowModels,
  WorkflowModelValidationError,
} from "../../packages/workflows/src/runs/shared/model-fallback.js";
import type { WorkflowModelInfo } from "../../packages/workflows/src/shared/types.js";

const models: readonly WorkflowModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
  { provider: "github-copilot", id: "claude-sonnet-4", fullId: "github-copilot/claude-sonnet-4" },
  { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
];

describe("model fallback helpers", () => {

  test("splitReasoningSuffix parses canonical suffixes and rejects invalid suffixes", () => {
    assert.deepEqual(splitReasoningSuffix("anthropic/claude-haiku-4-5:off"), {
      baseModel: "anthropic/claude-haiku-4-5",
      level: "off",
    });
    assert.deepEqual(splitReasoningSuffix("openai/gpt-5-mini"), { baseModel: "openai/gpt-5-mini" });
    assert.throws(() => splitReasoningSuffix("gpt-5-mini:ultra"), WorkflowModelValidationError);
  });

  test("buildModelCandidates resolves suffixed full ids and bare ids with preferred provider", () => {
    assert.deepEqual(
      buildModelCandidates({
        primaryModel: "anthropic/claude-sonnet-4:high",
        fallbackModels: ["claude-sonnet-4:low", "gpt-5-mini:off"],
        availableModels: models,
        preferredProvider: "github-copilot",
      }).map((candidate) => ({ id: candidate.id, reasoningLevel: candidate.reasoningLevel })),
      [
        { id: "anthropic/claude-sonnet-4", reasoningLevel: "high" },
        { id: "github-copilot/claude-sonnet-4", reasoningLevel: "low" },
        { id: "openai/gpt-5-mini", reasoningLevel: "off" },
      ],
    );
  });

  test("buildModelCandidates de-duplicates by model id and reasoning level", () => {
    assert.deepEqual(
      buildModelCandidates({
        primaryModel: "openai/gpt-5-mini:high",
        fallbackModels: ["openai/gpt-5-mini:low", "openai/gpt-5-mini:high"],
        availableModels: models,
      }).map((candidate) => ({ id: candidate.id, reasoningLevel: candidate.reasoningLevel })),
      [
        { id: "openai/gpt-5-mini", reasoningLevel: "high" },
        { id: "openai/gpt-5-mini", reasoningLevel: "low" },
      ],
    );
  });

  test("fallbackThinkingLevels maps positionally only when fallback lacks suffix", () => {
    assert.deepEqual(
      buildModelCandidates({
        primaryModel: "openai/gpt-5-mini",
        fallbackModels: ["anthropic/claude-sonnet-4", "github-copilot/claude-sonnet-4:high"],
        fallbackThinkingLevels: ["low", "off"],
        availableModels: models,
      }).map((candidate) => ({ id: candidate.id, reasoningLevel: candidate.reasoningLevel })),
      [
        { id: "openai/gpt-5-mini", reasoningLevel: undefined },
        { id: "anthropic/claude-sonnet-4", reasoningLevel: "low" },
        { id: "github-copilot/claude-sonnet-4", reasoningLevel: "high" },
      ],
    );
  });
  test("buildModelCandidateIds preserves provider-qualified ids and de-duplicates", () => {
    assert.deepEqual(
      buildModelCandidateIds({
        primaryModel: "anthropic/claude-sonnet-4",
        fallbackModels: ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
        currentModel: "openai/gpt-5-mini",
        availableModels: models,
      }),
      ["anthropic/claude-sonnet-4", "openai/gpt-5-mini"],
    );
  });

  test("buildModelCandidateIds resolves bare ids through preferred provider", () => {
    assert.deepEqual(
      buildModelCandidateIds({
        primaryModel: "claude-sonnet-4",
        fallbackModels: ["gpt-5-mini"],
        currentModel: "openai/gpt-5-mini",
        availableModels: models,
        preferredProvider: "github-copilot",
      }),
      ["github-copilot/claude-sonnet-4", "openai/gpt-5-mini"],
    );
  });

  test("validateWorkflowModels reports all unavailable and ambiguous models", async () => {
    await assert.rejects(
      validateWorkflowModels({
        catalog: { listModels: async () => models },
        requests: [
          { model: "claude-sonnet-4", fallbackModels: ["openai/missing-model"] },
        ],
      }),
      (err: Error) => {
        assert.ok(err instanceof WorkflowModelValidationError);
        assert.match(err.message, /claude-sonnet-4 \(ambiguous:/);
        assert.match(err.message, /openai\/missing-model \(not available\)/);
        return true;
      },
    );
  });

  test("validateWorkflowModels warns and falls back to current model when catalog is unavailable", async () => {
    const warnings = await validateWorkflowModels({
      catalog: {
        currentModel: "openai/current",
        listModels: async () => { throw new Error("registry unavailable"); },
      },
      requests: [{ model: "anthropic/primary", fallbackModels: ["openai/fallback"] }],
    });

    assert.deepEqual(warnings, [
      "workflows: model catalog unavailable; using the current selected model for fallback validation.",
    ]);
  });

  test("retry classifier accepts provider failures but rejects task failures", () => {
    assert.equal(isRetryableModelFailure("429 rate limit exceeded"), true);
    assert.equal(isRetryableModelFailure("model not found"), true);
    assert.equal(isRetryableModelFailure("command failed: bun test"), false);
    assert.equal(isRetryableModelFailure("user cancelled"), false);
  });
});
