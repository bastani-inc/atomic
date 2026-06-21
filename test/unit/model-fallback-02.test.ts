// @ts-nocheck
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
  // Copilot gpt-5.5 today: 272K default tier + 1.05M full-context long tier (the
  // long tier sits ABOVE 1m, so a `(1m)` request must round up to reach it).
  const tieredGpt55 = [copilotOpus({ defaultWindow: 272_000, contextWindowOptions: [272_000, 1_050_000] })];

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

  test("(1m) rounds UP to a long tier that sits above 1m (gpt-5.5 1.05M)", () => {
    // The long tier (1_050_000) exceeds the 1_000_000 request, so the old
    // "largest window <= request" rule collapsed back to the 272K default.
    // Rounding up selects the long tier so `(1m)` actually opts into long context.
    const [candidate] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (1m):xhigh",
      availableModels: tieredGpt55,
    });
    assert.equal(candidate?.id, "github-copilot/claude-opus-4.8");
    assert.equal(candidate?.contextWindow, 1_050_000);
  });

  test("a sub-long request still rounds up to the long tier", () => {
    // 500K and 922K both sit above the 272K default and below the 1.05M long
    // tier; either request opts into long context.
    for (const token of ["(500k)", "(922k)", "(1050k)"]) {
      const [candidate] = buildModelCandidates({
        primaryModel: `github-copilot/claude-opus-4.8 ${token}:xhigh`,
        availableModels: tieredGpt55,
      });
      assert.equal(candidate?.contextWindow, 1_050_000, `token ${token}`);
    }
  });

  test("a request at or below the default keeps the default (no upgrade)", () => {
    const [exact] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (272k):xhigh",
      availableModels: tieredGpt55,
    });
    assert.equal(exact?.contextWindow, undefined);
    const [below] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (100k):xhigh",
      availableModels: tieredGpt55,
    });
    assert.equal(below?.contextWindow, undefined);
  });

  test("the (1m) token is honored whether it precedes or follows the reasoning suffix", () => {
    // Standard order: token before the suffix.
    const [before] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (1m):medium",
      availableModels: tieredGpt55,
    });
    assert.equal(before?.id, "github-copilot/claude-opus-4.8");
    assert.equal(before?.reasoningLevel, "medium");
    assert.equal(before?.contextWindow, 1_050_000);
    // Reversed order: token after the suffix (kept benign — the token must not
    // collide with the `:medium` reasoning suffix).
    const [after] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8:medium (1m)",
      availableModels: tieredGpt55,
    });
    assert.equal(after?.id, "github-copilot/claude-opus-4.8");
    assert.equal(after?.reasoningLevel, "medium");
    assert.equal(after?.contextWindow, 1_050_000);
  });

  test("(long) is a generic long-context marker that selects each model's long tier", () => {
    // `(long)` is size-agnostic, so the same token selects the long tier for
    // models with DIFFERENT long tiers (opus 936K vs gpt-5.5 1.05M) — proving
    // the marker is catalog-driven, not hardcoded to a single value.
    const [opus] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (long):xhigh",
      availableModels: tieredOpus,
    });
    assert.equal(opus?.contextWindow, 936_000);
    const [gpt55] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (long):xhigh",
      availableModels: tieredGpt55,
    });
    assert.equal(gpt55?.contextWindow, 1_050_000);
  });

  test("(long) is case-insensitive", () => {
    for (const token of ["(long)", "(LONG)", "( Long )"]) {
      const [candidate] = buildModelCandidates({
        primaryModel: `github-copilot/claude-opus-4.8 ${token}:xhigh`,
        availableModels: tieredOpus,
      });
      assert.equal(candidate?.contextWindow, 936_000, `token ${token}`);
    }
  });

  test("(1.1m) — the rounded long-tier label for gpt-5.5 — selects its long tier", () => {
    // gpt-5.5's long tier is 1_050_000, whose rounded display is "1.1m". The
    // marker should select that long tier (rounding UP past it), matching the
    // natural label a user reads off the chat footer.
    const [candidate] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (1.1m):xhigh",
      availableModels: tieredGpt55,
    });
    assert.equal(candidate?.id, "github-copilot/claude-opus-4.8");
    assert.equal(candidate?.contextWindow, 1_050_000);
    // The same 1.1m marker also reaches opus's lower 1M long tier.
    const [opus] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (1.1m):xhigh",
      availableModels: tieredOpus,
    });
    assert.equal(opus?.contextWindow, 936_000);
  });

  test("(long) keeps the default short window when no long tier is advertised", () => {
    const [candidate] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (long):xhigh",
      availableModels: [copilotOpus({ defaultWindow: 200_000 })],
    });
    assert.equal(candidate?.id, "github-copilot/claude-opus-4.8");
    assert.equal(candidate?.contextWindow, undefined);
  });

  test("(long) is honored in both token orders and stripped from the cleaned id", () => {
    const [before] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8 (long):medium",
      availableModels: tieredOpus,
    });
    assert.equal(before?.reasoningLevel, "medium");
    assert.equal(before?.contextWindow, 936_000);
    const [after] = buildModelCandidates({
      primaryModel: "github-copilot/claude-opus-4.8:medium (long)",
      availableModels: tieredOpus,
    });
    assert.equal(after?.reasoningLevel, "medium");
    assert.equal(after?.contextWindow, 936_000);
    assert.deepEqual(
      buildModelCandidateIds({
        primaryModel: "github-copilot/claude-opus-4.8 (long):xhigh",
        availableModels: tieredOpus,
      }),
      ["github-copilot/claude-opus-4.8"],
    );
  });
});
