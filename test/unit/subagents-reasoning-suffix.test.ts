import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { buildModelCandidates } from "../../packages/subagents/src/runs/shared/model-fallback.js";
import { applyThinkingSuffix } from "../../packages/subagents/src/runs/shared/pi-args.js";
import { resolveEffectiveThinking, splitKnownThinkingSuffix } from "../../packages/subagents/src/shared/model-info.js";
import type { AvailableModelInfo } from "../../packages/subagents/src/runs/shared/model-fallback.js";

const models: AvailableModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
  { provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" },
  { provider: "provider:with-colon", id: "model", fullId: "provider:with-colon/model" },
];

describe("subagent suffix-first reasoning helpers", () => {
  test("splitKnownThinkingSuffix only recognizes canonical levels", () => {
    assert.deepEqual(splitKnownThinkingSuffix("claude-sonnet-4:high"), { baseModel: "claude-sonnet-4", thinkingSuffix: ":high" });
    assert.deepEqual(splitKnownThinkingSuffix("claude-sonnet-4"), { baseModel: "claude-sonnet-4", thinkingSuffix: "" });
    assert.deepEqual(splitKnownThinkingSuffix("provider:model:ultra"), { baseModel: "provider:model:ultra", thinkingSuffix: "" });
    assert.deepEqual(splitKnownThinkingSuffix("provider:with-colon/model:off"), { baseModel: "provider:with-colon/model", thinkingSuffix: ":off" });
  });

  test("applyThinkingSuffix preserves valid suffix over legacy thinking", () => {
    assert.equal(applyThinkingSuffix("claude-sonnet-4:medium", "high"), "claude-sonnet-4:medium");
    assert.equal(applyThinkingSuffix("claude-sonnet-4", "low"), "claude-sonnet-4:low");
    assert.equal(applyThinkingSuffix("provider:model:ultra", "high"), "provider:model:ultra:high");
  });

  test("resolveEffectiveThinking uses suffix, then legacy thinking, then undefined", () => {
    assert.equal(resolveEffectiveThinking("gpt-5:low", "high"), "low");
    assert.equal(resolveEffectiveThinking("gpt-5", "high"), "high");
    assert.equal(resolveEffectiveThinking("gpt-5", "ultra"), undefined);
  });

  test("buildModelCandidates is ordered and de-dupes by resolved model plus level", () => {
    assert.deepEqual(
      buildModelCandidates(
        "claude-sonnet-4:high",
        ["anthropic/claude-sonnet-4:high", "claude-sonnet-4:medium", "gpt-5:low", "gpt-5:low"],
        models,
        "anthropic",
        "anthropic/claude-sonnet-4:medium",
      ),
      ["anthropic/claude-sonnet-4:high", "anthropic/claude-sonnet-4:medium", "openai/gpt-5:low"],
    );
  });

  test("fallbackThinkingLevels applies positionally only when fallback has no suffix", () => {
    assert.deepEqual(
      buildModelCandidates(
        "claude-sonnet-4",
        ["gpt-5", "claude-sonnet-4:low"],
        models,
        "anthropic",
        undefined,
        ["medium", "xhigh"],
      ),
      ["anthropic/claude-sonnet-4", "openai/gpt-5:medium", "anthropic/claude-sonnet-4:low"],
    );
  });
});


describe("subagent retry metadata reasoning seams", () => {
  test("foreground retry candidates resolve per-attempt model and reasoning with suffix precedence", () => {
    const agentThinking = "medium";
    const candidates = buildModelCandidates(
      "claude-sonnet-4:high",
      ["gpt-5:low"],
      models,
      "anthropic",
    );

    const attempts = candidates.map((candidate, index) => {
      const model = applyThinkingSuffix(candidate, agentThinking)!;
      return {
        model,
        reasoningLevel: resolveEffectiveThinking(model, agentThinking),
        success: index === 1,
      };
    });

    assert.deepEqual(candidates, [
      "anthropic/claude-sonnet-4:high",
      "openai/gpt-5:low",
    ]);
    assert.deepEqual(attempts, [
      { model: "anthropic/claude-sonnet-4:high", reasoningLevel: "high", success: false },
      { model: "openai/gpt-5:low", reasoningLevel: "low", success: true },
    ]);
  });

  test("async/background status mapping carries suffix level and falls back to legacy thinking", () => {
    const agentThinking = "xhigh";
    const candidates = buildModelCandidates(
      "claude-sonnet-4:high",
      ["gpt-5"],
      models,
      "anthropic",
    );

    const statusAttempts = candidates.map((candidate) => ({
      model: applyThinkingSuffix(candidate, agentThinking)!,
      thinking: resolveEffectiveThinking(applyThinkingSuffix(candidate, agentThinking), agentThinking),
    }));

    assert.deepEqual(statusAttempts, [
      { model: "anthropic/claude-sonnet-4:high", thinking: "high" },
      { model: "openai/gpt-5:xhigh", thinking: "xhigh" },
    ]);
  });

  test("legacy no-suffix retry candidates keep legacy thinking as the effective level", () => {
    const candidates = buildModelCandidates(
      "claude-sonnet-4",
      ["gpt-5"],
      models,
      "anthropic",
    );
    const attempts = candidates.map((candidate) => {
      const model = applyThinkingSuffix(candidate, "high")!;
      return { model, reasoningLevel: resolveEffectiveThinking(model, "high") };
    });

    assert.deepEqual(attempts, [
      { model: "anthropic/claude-sonnet-4:high", reasoningLevel: "high" },
      { model: "openai/gpt-5:high", reasoningLevel: "high" },
    ]);
  });
});

// Mirrors the foreground execution seam (execution.ts ~line 866):
//   const attemptModel = applyThinkingSuffix(candidate, agent.thinking) ?? result.model ?? agent.model ?? "default";
//   reasoningLevel: resolveEffectiveThinking(attemptModel, agent.thinking)
// Asserts the candidate-derived suffix wins even when legacy `thinking` is unset and
// the SDK echoes a suffix-stripped `result.model`.
describe("foreground attempt metadata derives reasoning level from candidate suffix (#1199)", () => {
  test("candidate suffix yields the reasoning level when agent.thinking is undefined", () => {
    const agentThinking: string | undefined = undefined;

    const lowModel = applyThinkingSuffix("openai/gpt-5:low", agentThinking);
    assert.equal(lowModel, "openai/gpt-5:low");
    assert.ok(lowModel?.endsWith(":low"));
    assert.equal(resolveEffectiveThinking(lowModel, agentThinking), "low");

    const highModel = applyThinkingSuffix("anthropic/claude-sonnet-4:high", agentThinking);
    assert.equal(highModel, "anthropic/claude-sonnet-4:high");
    assert.ok(highModel?.endsWith(":high"));
    assert.equal(resolveEffectiveThinking(highModel, agentThinking), "high");
  });

  test("candidate-derived suffix is preferred over the suffix-stripped result.model echo", () => {
    const candidate = "openai/gpt-5:low";
    const agentThinking: string | undefined = undefined;
    // The SDK echoes evt.message.model with the per-candidate suffix stripped.
    const resultModel = "openai/gpt-5";

    const attemptModel = applyThinkingSuffix(candidate, agentThinking) ?? resultModel ?? "default";
    assert.equal(attemptModel, "openai/gpt-5:low");
    assert.equal(resolveEffectiveThinking(attemptModel, agentThinking), "low");
  });

  test("falls back to result.model when there is no candidate (modelsToTry=[undefined])", () => {
    const candidate: string | undefined = undefined;
    const agentThinking: string | undefined = undefined;
    const resultModel = "openai/gpt-5";

    const attemptModel = applyThinkingSuffix(candidate, agentThinking) ?? resultModel ?? "default";
    assert.equal(attemptModel, "openai/gpt-5");
  });
});
