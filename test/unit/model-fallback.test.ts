import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildModelCandidates,
  buildModelCandidateIds,
  buildModelCandidatesFromCatalog,
  splitReasoningSuffix,
  isRetryableModelFailure,
  shouldSuppressExpectedAuthFallbackWarning,
  validateWorkflowModels,
  WorkflowModelValidationError,
} from "../../packages/workflows/src/runs/shared/model-fallback.js";
import type { WorkflowModelInfo } from "../../packages/workflows/src/shared/types.js";

const models: readonly WorkflowModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
  { provider: "github-copilot", id: "claude-sonnet-4", fullId: "github-copilot/claude-sonnet-4" },
  { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
  { provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5" },
  { provider: "local", id: "fallback", fullId: "local/fallback" },
];

describe("model fallback helpers", () => {

  test("splitReasoningSuffix parses canonical suffixes and stays lenient for non-canonical suffixes", () => {
    assert.deepEqual(splitReasoningSuffix("anthropic/claude-haiku-4-5:off"), {
      baseModel: "anthropic/claude-haiku-4-5",
      level: "off",
    });
    assert.deepEqual(splitReasoningSuffix("openai/gpt-5-mini"), { baseModel: "openai/gpt-5-mini" });
    // Non-canonical colon-tagged ids are no longer rejected; the whole string is the base model.
    assert.deepEqual(splitReasoningSuffix("gpt-5-mini:ultra"), { baseModel: "gpt-5-mini:ultra" });
  });

  test("splitReasoningSuffix is lenient and never throws for legitimate colon-tagged ids (#1199)", () => {
    // Provider/model ids that legitimately use a trailing colon tag must pass through untouched.
    const lenientIds = [
      "ollama/llama3:latest",
      "openrouter/meta-llama/llama-3-8b-instruct:free",
      "mistral:instruct",
      "qwen:chat",
      // OpenRouter routing/variant tags.
      "openrouter/anthropic/claude-3.5-sonnet:exacto",
      "openrouter/meta-llama/llama-3-8b-instruct:nitro",
      "openrouter/perplexity/sonar:online",
      "openrouter/anthropic/claude-3.5-sonnet:beta",
    ];
    for (const id of lenientIds) {
      assert.doesNotThrow(() => splitReasoningSuffix(id));
      assert.deepEqual(splitReasoningSuffix(id), { baseModel: id }, `expected ${id} to stay intact with no level`);
    }
  });

  test("splitReasoningSuffix still extracts canonical reasoning levels (#1199)", () => {
    assert.deepEqual(splitReasoningSuffix("claude-sonnet-4:high"), {
      baseModel: "claude-sonnet-4",
      level: "high",
    });
  });

  test("buildModelCandidates resolves a catalog fullId that ends in a colon tag (#1199)", () => {
    const catalogModels: readonly WorkflowModelInfo[] = [
      {
        provider: "openrouter",
        id: "meta-llama/llama-3-8b-instruct:free",
        fullId: "openrouter/meta-llama/llama-3-8b-instruct:free",
      },
    ];
    assert.deepEqual(
      buildModelCandidates({
        primaryModel: "openrouter/meta-llama/llama-3-8b-instruct:free",
        availableModels: catalogModels,
      }).map((candidate) => ({ id: candidate.id, reasoningLevel: candidate.reasoningLevel })),
      [{ id: "openrouter/meta-llama/llama-3-8b-instruct:free", reasoningLevel: undefined }],
    );
  });

  test("buildModelCandidates surfaces generic 'not available' for unknown colon-tagged ids (#1199)", () => {
    assert.throws(
      () => buildModelCandidates({ primaryModel: "gpt-5:ultra", availableModels: models }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowModelValidationError);
        assert.match(err.message, /gpt-5:ultra \(not available\)/);
        assert.doesNotMatch(err.message, /invalid reasoning level suffix/);
        return true;
      },
    );
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

  test("buildModelCandidates throws WorkflowModelValidationError for an invalid fallbackThinkingLevels entry (#1199)", () => {
    assert.throws(
      () =>
        buildModelCandidates({
          primaryModel: "openai/gpt-5-mini",
          fallbackModels: ["anthropic/claude-sonnet-4"],
          fallbackThinkingLevels: ["bogus"],
          availableModels: models,
        }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowModelValidationError);
        assert.match(err.message, /invalid fallbackThinkingLevels\[0\] "bogus"/);
        assert.equal(err.failures[0]?.input, "anthropic/claude-sonnet-4");
        return true;
      },
    );
  });

  test("fallbackThinkingLevels trims surrounding whitespace before applying the compat level (#1199)", () => {
    assert.deepEqual(
      buildModelCandidates({
        primaryModel: "openai/gpt-5-mini",
        fallbackModels: ["  anthropic/claude-sonnet-4  "],
        fallbackThinkingLevels: ["low"],
        availableModels: models,
      }).map((candidate) => ({ id: candidate.id, reasoningLevel: candidate.reasoningLevel })),
      [
        { id: "openai/gpt-5-mini", reasoningLevel: undefined },
        { id: "anthropic/claude-sonnet-4", reasoningLevel: "low" },
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

  test("buildModelCandidates trusts a provider-qualified id absent from the catalog instead of failing", () => {
    // Regression: a fully-qualified provider/id that the live catalog does not
    // list must be trusted (passed through), mirroring the subagent resolver.
    // Previously it returned a "not available" failure, which made
    // buildModelCandidates throw and (via buildModelCandidatesFromCatalog)
    // collapse the whole ordered list to just the user's currentModel.
    assert.deepEqual(
      buildModelCandidates({
        primaryModel: "openai/gpt-5-mini:high",
        fallbackModels: ["some-provider/brand-new-model:medium"],
        currentModel: "anthropic/claude-sonnet-4",
        availableModels: models,
        preferredProvider: "anthropic",
      }).map((candidate) => ({ id: candidate.id, reasoningLevel: candidate.reasoningLevel })),
      [
        { id: "openai/gpt-5-mini", reasoningLevel: "high" },
        { id: "some-provider/brand-new-model", reasoningLevel: "medium" },
        { id: "anthropic/claude-sonnet-4", reasoningLevel: undefined },
      ],
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
        "API key is not configured for anthropic.",
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
        "429 rate limit exceeded",
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

  test("buildModelCandidatesFromCatalog keeps the defined primary when a fallback provider is absent (regression)", async () => {
    // The builtin workflows list cross-provider fallbacks. On a partial catalog
    // (the user only has anthropic configured) the defined primary + fallbacks
    // must survive ordered, not collapse down to the user's selected model.
    const recorded: string[] = [];
    const candidates = await buildModelCandidatesFromCatalog({
      primaryModel: "openai/gpt-5.5:medium",
      fallbackModels: [
        "openai-codex/gpt-5.5:medium",
        "github-copilot/gpt-5.5:medium",
        "anthropic/claude-sonnet-4:xhigh",
      ],
      catalog: {
        currentModel: "anthropic/claude-opus-4",
        preferredProvider: "anthropic",
        recordWarning: (warning: string) => recorded.push(warning),
        listModels: async () => [
          { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
          { provider: "anthropic", id: "claude-opus-4", fullId: "anthropic/claude-opus-4" },
        ],
      },
    });

    assert.equal(candidates[0]?.id, "openai/gpt-5.5");
    assert.equal(candidates[0]?.reasoningLevel, "medium");
    assert.deepEqual(
      candidates.map((candidate) => candidate.id),
      [
        "openai/gpt-5.5",
        "openai-codex/gpt-5.5",
        "github-copilot/gpt-5.5",
        "anthropic/claude-sonnet-4",
        "anthropic/claude-opus-4",
      ],
    );
    // No catalog-unavailable warning: the catalog resolved fine, the absent
    // provider-qualified fallbacks were simply trusted rather than collapsed.
    assert.deepEqual(recorded, []);
  });

  test("validateWorkflowModels reports unavailable bare ids and ambiguous models", async () => {
    await assert.rejects(
      validateWorkflowModels({
        catalog: { listModels: async () => models },
        requests: [
          { model: "claude-sonnet-4", fallbackModels: ["missing-model"] },
        ],
      }),
      (err: Error) => {
        assert.ok(err instanceof WorkflowModelValidationError);
        assert.match(err.message, /claude-sonnet-4 \(ambiguous:/);
        assert.match(err.message, /missing-model \(not available\)/);
        return true;
      },
    );
  });

  test("validateWorkflowModels trusts provider-qualified ids that are absent from the catalog", async () => {
    // A fully-qualified id is no longer an authoring error just because the
    // current catalog does not list it (provider/auth gating, new models).
    const warnings = await validateWorkflowModels({
      catalog: { listModels: async () => models },
      requests: [
        { model: "anthropic/claude-sonnet-4", fallbackModels: ["openai/gpt-7-preview:high"] },
      ],
    });
    assert.deepEqual(warnings, []);
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
