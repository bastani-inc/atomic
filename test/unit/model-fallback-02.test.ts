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
