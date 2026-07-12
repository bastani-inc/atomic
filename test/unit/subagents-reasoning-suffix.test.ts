import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { buildModelCandidates, resolveModelCandidate } from "../../packages/subagents/src/runs/shared/model-fallback.js";
import { applyThinkingSuffix, buildPiArgs } from "../../packages/subagents/src/runs/shared/pi-args.js";
import { getSupportedThinkingLevels, resolveEffectiveThinking, splitKnownThinkingSuffix, THINKING_LEVELS } from "../../packages/subagents/src/shared/model-info.js";
import type { AvailableModelInfo } from "../../packages/subagents/src/runs/shared/model-fallback.js";
import { parseFrontmatter } from "../../packages/subagents/src/agents/frontmatter.js";

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
    assert.deepEqual(splitKnownThinkingSuffix("openai/gpt-5:max"), { baseModel: "openai/gpt-5", thinkingSuffix: ":max" });
  });

  test("applyThinkingSuffix preserves valid suffix over legacy thinking", () => {
    assert.equal(applyThinkingSuffix("claude-sonnet-4:medium", "high"), "claude-sonnet-4:medium");
    assert.equal(applyThinkingSuffix("claude-sonnet-4", "low"), "claude-sonnet-4:low");
    assert.equal(applyThinkingSuffix("provider:model:ultra", "high"), "provider:model:ultra:high");
  });

  test("accepts every pi 0.80.6 thinking level and preserves unknown-level rejection", () => {
    assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

    for (const level of THINKING_LEVELS) {
      assert.equal(resolveEffectiveThinking("openai/gpt-5", level), level);
      const expectedModel = level === "off" ? "openai/gpt-5" : `openai/gpt-5:${level}`;
      assert.equal(applyThinkingSuffix("openai/gpt-5", level), expectedModel);
    }

    assert.equal(resolveEffectiveThinking("openai/gpt-5", "ultra"), undefined);
    assert.deepEqual(splitKnownThinkingSuffix("openai/gpt-5:ultra"), {
      baseModel: "openai/gpt-5:ultra",
      thinkingSuffix: "",
    });
  });

  test("forwards max thinking to the child Atomic CLI model argument", () => {
    const model = "openai/gpt-5.6-sol";
    const result = buildPiArgs({
      baseArgs: [],
      task: "reason deeply",
      sessionEnabled: false,
      model,
      thinking: "max",
      inheritProjectContext: true,
      inheritSkills: true,
    });

    const modelIndex = result.args.indexOf("--model");
    assert.notEqual(modelIndex, -1);
    assert.equal(result.args[modelIndex + 1], `${model}:max`);
  });


  test("offers max only when a model explicitly maps the new extended level", () => {
    assert.equal(getSupportedThinkingLevels({
      provider: "openai",
      id: "gpt-5",
      fullId: "openai/gpt-5",
      reasoning: true,
      thinkingLevelMap: { xhigh: "high" },
    }).includes("max"), false);

    assert.equal(getSupportedThinkingLevels({
      provider: "openai",
      id: "gpt-5.6-sol",
      fullId: "openai/gpt-5.6-sol",
      reasoning: true,
      thinkingLevelMap: { max: "max" },
    }).includes("max"), true);
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

  test("provider-qualified config models with ':' separators survive frontmatter parsing and resolution", () => {
    // The user-facing principle: a subagent config `model:`/`fallbackModels:`
    // entry may carry a reasoning suffix (and the provider/model id may itself
    // contain a colon). Frontmatter parsing must keep the full value, and the
    // resolver must split the reasoning level off the LAST colon while trusting
    // a fully-qualified id even when it is absent from the live catalog.
    const { frontmatter } = parseFrontmatter(
      [
        "---",
        "name: custom",
        "description: custom agent",
        "model: provider:with-colon/model:off",
        "fallbackModels: openai/gpt-7-preview:high, anthropic/claude-sonnet-4:medium",
        "---",
        "body",
      ].join("\n"),
    );
    // The first ':' splits key from value; every later colon stays in the value.
    assert.equal(frontmatter.model, "provider:with-colon/model:off");
    assert.equal(frontmatter.fallbackModels, "openai/gpt-7-preview:high, anthropic/claude-sonnet-4:medium");

    const fallbackModels = frontmatter.fallbackModels.split(",").map((entry) => entry.trim());
    // openai/gpt-7-preview is absent from `models` but is trusted (pass-through),
    // not dropped/collapsed; the catalog only disambiguates and rewrites matches.
    assert.deepEqual(
      buildModelCandidates(frontmatter.model, fallbackModels, models, "anthropic", "anthropic/claude-sonnet-4:medium"),
      [
        "provider:with-colon/model:off",
        "openai/gpt-7-preview:high",
        "anthropic/claude-sonnet-4:medium",
      ],
    );
    // A fully-qualified id absent from the catalog resolves to itself.
    assert.equal(resolveModelCandidate("openai/gpt-7-preview:high", models, "anthropic"), "openai/gpt-7-preview:high");
    assert.deepEqual(splitKnownThinkingSuffix(frontmatter.model), { baseModel: "provider:with-colon/model", thinkingSuffix: ":off" });
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
