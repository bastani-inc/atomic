import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildModelCandidates,
  buildModelCandidateIds,
  buildModelCandidatesFromCatalog,
  splitReasoningSuffix,
  isRetryableModelFailure,
  normalizeModelFailureSignal,
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

  test("retry classifier uses structured diagnostics before localized text", () => {
    const signal = normalizeModelFailureSignal({
      role: "assistant",
      stopReason: "error",
      errorMessage: "地域化されたプロバイダー エラー",
      diagnostics: [{ error: { code: 429, message: "quota exhausted" } }],
    });

    assert.equal(signal.kind, "rate_limit");
    assert.equal(signal.source, "diagnostic");
    assert.equal(isRetryableModelFailure({
      role: "assistant",
      stopReason: "error",
      errorMessage: "地域化されたプロバイダー エラー",
      diagnostics: [{ error: { code: 429, message: "quota exhausted" } }],
    }), true);
    assert.equal(isRetryableModelFailure({
      message: "localized wrapper",
      diagnostics: [{ error: { message: "service unavailable" } }],
    }), true);
  });

  test("retry classifier uses structured status and codes including auth failures", () => {
    assert.equal(isRetryableModelFailure({ status: 503, message: "localized" }), true);
    assert.equal(isRetryableModelFailure({ statusCode: 401, message: "localized" }), true);
    assert.equal(isRetryableModelFailure({ httpStatus: 403, message: "localized" }), true);
    assert.equal(isRetryableModelFailure({ code: "invalid_api_key", message: "localized" }), true);
    assert.equal(normalizeModelFailureSignal({ status: 408, message: "localized" }).kind, "network_timeout");
    assert.equal(normalizeModelFailureSignal({ status: 404, message: "localized" }).kind, "model_unavailable");
    assert.equal(normalizeModelFailureSignal({ code: "429", message: "localized" }).kind, "rate_limit");
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
          diagnostics: [{ error: { message: "command failed after provider wrapper" } }],
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

  test("retry classifier follows causes before regex fallback", () => {
    const err = new Error("outer localized failure", {
      cause: { diagnostics: [{ error: { code: "service_unavailable", message: "provider down" } }] },
    });

    assert.equal(isRetryableModelFailure(err), true);
    assert.equal(normalizeModelFailureSignal(err).kind, "provider_unavailable");
  });

  test("an auth-storage load failure stays retryable (not a hard task failure) (#1431)", () => {
    // Mirrors formatAuthStorageLoadFailedMessage(...) output. Fix #2 surfaces a
    // credential-store LOAD failure instead of "No API key found"; that message
    // must remain a recoverable/retryable auth failure so a transient store-read
    // failure can still fall back rather than hard-failing the stage.
    const message =
      "Could not load stored credentials for anthropic: the auth credential store could not be " +
      "read (Lock file is already being held). This is not a missing API key — stored credentials " +
      "may exist but the credential store could not be read (it may be temporarily locked by " +
      "another process). Retry shortly or run '/login anthropic' to re-authenticate.";
    assert.equal(isRetryableModelFailure(new Error(message)), true);
    assert.equal(normalizeModelFailureSignal(new Error(message)).kind, "auth_on_candidate_provider");
  });

  test("retry classifier refuses cancellation and task failures despite structured-looking text", () => {
    assert.equal(isRetryableModelFailure({ name: "AbortError", status: 503, message: "request aborted" }), false);
    assert.equal(isRetryableModelFailure({ status: 503, message: "request cancelled" }), false);
    assert.equal(isRetryableModelFailure({ stopReason: "aborted", status: 503, errorMessage: "aborted" }), false);
    assert.equal(isRetryableModelFailure({ status: 503, message: "shell command failed" }), false);
    assert.equal(isRetryableModelFailure("shell command failed with 503"), false);
  });
});

describe("context-window authoring token", () => {
  // Minimal Model<Api>-shaped fixtures: getSupportedContextWindows only reads
  // contextWindow / defaultContextWindow / contextWindowOptions.
  function copilotOpus(options: {
    readonly defaultWindow: number;
    readonly contextWindowOptions?: readonly number[];
  }): WorkflowModelInfo {
    return {
      provider: "github-copilot",
      id: "claude-opus-4.8",
      fullId: "github-copilot/claude-opus-4.8",
      model: {
        provider: "github-copilot",
        id: "claude-opus-4.8",
        contextWindow: options.defaultWindow,
        defaultContextWindow: options.defaultWindow,
        ...(options.contextWindowOptions !== undefined ? { contextWindowOptions: options.contextWindowOptions } : {}),
      } as unknown as NonNullable<WorkflowModelInfo["model"]>,
    };
  }

  // Copilot opus today: 200K default tier + ~936K long-context tier.
  const tieredOpus = [copilotOpus({ defaultWindow: 200_000, contextWindowOptions: [200_000, 936_000] })];

  test("(1m) selects the largest advertised window <= request and keeps the reasoning suffix", () => {
    const [candidate] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (1m):xhigh",
      availableModels: tieredOpus,
    });
    assert.equal(candidate?.id, "github-copilot/claude-opus-4.8");
    assert.equal(candidate?.reasoningLevel, "xhigh");
    assert.equal(candidate?.contextWindow, 936_000);
  });

  test("an exact supported window is honored verbatim", () => {
    const [candidate] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (936k):medium",
      availableModels: tieredOpus,
    });
    assert.equal(candidate?.contextWindow, 936_000);
    assert.equal(candidate?.reasoningLevel, "medium");
  });

  test("(1m) falls back to the default window when the model exposes no long tier", () => {
    const [candidate] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (1m):xhigh",
      availableModels: [copilotOpus({ defaultWindow: 200_000 })],
    });
    // No larger supported window -> leave unset so the session keeps 200K short.
    assert.equal(candidate?.id, "github-copilot/claude-opus-4.8");
    assert.equal(candidate?.contextWindow, undefined);
  });

  test("the token never collides with the reasoning suffix (split order)", () => {
    const [candidate] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (1m):high",
      availableModels: tieredOpus,
    });
    assert.equal(candidate?.id, "github-copilot/claude-opus-4.8");
    assert.equal(candidate?.reasoningLevel, "high");
    assert.equal(candidate?.contextWindow, 936_000);
  });

  test("a bare token with no reasoning suffix is parsed", () => {
    const [candidate] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (1m)",
      availableModels: tieredOpus,
    });
    assert.equal(candidate?.id, "github-copilot/claude-opus-4.8");
    assert.equal(candidate?.reasoningLevel, undefined);
    assert.equal(candidate?.contextWindow, 936_000);
  });

  test("only the tokened candidate carries a context window; siblings are untouched", () => {
    const catalog: readonly WorkflowModelInfo[] = [
      { provider: "anthropic", id: "claude-fable-5", fullId: "anthropic/claude-fable-5" },
      ...tieredOpus,
    ];
    const candidates = buildModelCandidates({
      primaryModel: "anthropic/claude-fable-5:xhigh",
      fallbackModels: ["github-copilot/claude-opus-4.8 (1m):xhigh"],
      availableModels: catalog,
    });
    const primary = candidates.find((c) => c.id === "anthropic/claude-fable-5");
    const opus = candidates.find((c) => c.id === "github-copilot/claude-opus-4.8");
    assert.equal(primary?.contextWindow, undefined);
    assert.equal(opus?.contextWindow, 936_000);
  });

  test("a non-size parenthesized token is left attached (no silent strip)", () => {
    // "(preview)" is not a context size, so it is NOT treated as a context
    // token. Because the id contains "/", it is trusted as a literal model id
    // passthrough (the runtime surfaces the bad id when it cannot create a
    // session) rather than being silently dropped.
    const [candidate] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (preview)",
      availableModels: tieredOpus,
    });
    assert.equal(candidate?.id, "github-copilot/claude-opus-4.8 (preview)");
    assert.equal(candidate?.contextWindow, undefined);
  });

  test("buildModelCandidateIds preserves the cleaned id without the token", () => {
    assert.deepEqual(
      buildModelCandidateIds({
        primaryModel: "github-copilot/claude-opus-4.8 (1m):xhigh",
        availableModels: tieredOpus,
      }),
      ["github-copilot/claude-opus-4.8"],
    );
  });
});
