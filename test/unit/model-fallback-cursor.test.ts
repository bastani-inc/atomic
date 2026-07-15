import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildModelCandidates,
  buildModelCandidatesFromCatalog,
  WorkflowModelValidationError,
} from "../../packages/workflows/src/runs/shared/model-fallback.js";
import type { WorkflowModelInfo } from "../../packages/workflows/src/shared/types.js";

const models: readonly WorkflowModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
  { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
];

function model(provider: string, id: string): Model<Api> {
  return {
    provider, id, name: id, api: provider === "cursor" ? "cursor-agent" : "anthropic-messages",
    baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000,
  } as Model<Api>;
}

describe("Cursor workflow model resolution", () => {
  test("unavailable route rejects before configured/current fallback", async () => {
    await assert.rejects(
      buildModelCandidatesFromCatalog({
        primaryModel: "cursor/grok-4.5-high",
        fallbackModels: ["openai/gpt-5-mini"],
        catalog: {
          currentModel: "anthropic/claude-sonnet-4",
          listModels: async () => models,
        },
      }),
      (err: Error) => {
        assert.ok(err instanceof WorkflowModelValidationError);
        assert.match(err.message, /cursor\/grok-4\.5-high/);
        assert.match(err.message, /reselect/);
        return true;
      },
    );
  });

  test("route rejects when the live catalog is unavailable", async () => {
    await assert.rejects(
      buildModelCandidatesFromCatalog({
        primaryModel: "cursor/cursor-grok-4.5-high",
        fallbackModels: ["openai/gpt-5-mini"],
        catalog: {
          currentModel: "openai/gpt-5-mini",
          listModels: async () => { throw new Error("registry unavailable"); },
        },
      }),
      /registry unavailable/,
    );
  });

  test("exact available flat route remains selectable", () => {
    const candidates = buildModelCandidates({
      primaryModel: "cursor/cursor-grok-4.5-high",
      availableModels: [
        ...models,
        { provider: "cursor", id: "cursor-grok-4.5-high", fullId: "cursor/cursor-grok-4.5-high" },
      ],
    });
    assert.deepEqual(candidates.map((candidate) => ({ id: candidate.id, level: candidate.reasoningLevel })), [
      { id: "cursor/cursor-grok-4.5-high", level: undefined },
    ]);
  });

  test("preserves every exact provider-qualified Cursor route shape byte-for-byte", () => {
    const ids = [" route ", "route:high", "route (1m)", "route/with/slashes", "CaseRoute"];
    const availableModels = ids.map((id) => ({ provider: "cursor", id, fullId: `cursor/${id}` }));
    for (const id of ids) {
      const [candidate] = buildModelCandidates({ primaryModel: `cursor/${id}`, availableModels });
      assert.equal(candidate?.id, `cursor/${id}`);
      assert.equal(candidate?.reasoningLevel, undefined);
      assert.equal(candidate?.contextWindow, undefined);
    }
  });

  test("preserves an exact Cursor fallback route without applying generic thinking metadata", () => {
    const [candidate] = buildModelCandidates({
      fallbackModels: ["cursor/ route:high (1m)/exact "],
      fallbackThinkingLevels: ["max"],
      availableModels: [{
        provider: "cursor", id: " route:high (1m)/exact ", fullId: "cursor/ route:high (1m)/exact ",
      }],
    });
    assert.equal(candidate?.id, "cursor/ route:high (1m)/exact ");
    assert.equal(candidate?.reasoningLevel, undefined);
    assert.equal(candidate?.contextWindow, undefined);
  });

  test("rejects nonexact Cursor route variants before fallback", () => {
    const availableModels = [
      { provider: "cursor", id: "CaseRoute", fullId: "cursor/CaseRoute" },
      { provider: "cursor", id: "route", fullId: "cursor/route" },
    ];
    for (const primaryModel of ["cursor/caseroute", "cursor/ route ", "cursor/route:high", "cursor/route (1m)"]) {
      assert.throws(
        () => buildModelCandidates({ primaryModel, fallbackModels: ["openai/gpt-5-mini"], availableModels }),
        (err: Error) => {
          assert.ok(err instanceof WorkflowModelValidationError);
          assert.match(err.message, /Cursor routes must match the authenticated catalog exactly/);
          return true;
        },
      );
    }
  });

  test("Cursor model objects are replaced by the exact live catalog object", () => {
    const supplied = model("cursor", "cursor-grok-4.5-high");
    const live = { ...supplied, name: "Live Catalog Row" };
    const [candidate] = buildModelCandidates({
      primaryModel: supplied,
      availableModels: [...models, {
        provider: "cursor", id: live.id, fullId: `cursor/${live.id}`, model: live,
      }],
    });
    assert.equal(candidate?.value, live);
    assert.notEqual(candidate?.value, supplied);
  });

  test("stale Cursor model objects reject before configured or current fallback", async () => {
    await assert.rejects(buildModelCandidatesFromCatalog({
      primaryModel: model("cursor", "old-synthetic-high"),
      fallbackModels: ["openai/gpt-5-mini"],
      catalog: { currentModel: "anthropic/claude-sonnet-4", listModels: async () => models },
    }), /cursor\/old-synthetic-high.*reselect/s);
  });

  test("Cursor model objects propagate catalog failure without current-model fallback", async () => {
    await assert.rejects(buildModelCandidatesFromCatalog({
      primaryModel: model("cursor", "cursor-grok-4.5-high"),
      catalog: { currentModel: "anthropic/claude-sonnet-4", listModels: async () => { throw new Error("catalog failed"); } },
    }), /catalog failed/);
  });

  test("non-Cursor model objects retain pass-through behavior", () => {
    const supplied = model("anthropic", "custom-object");
    const [candidate] = buildModelCandidates({ primaryModel: supplied });
    assert.equal(candidate?.value, supplied);
  });

  test("nonexact reasoning-like suffixes reject even when the base route exists", () => {
    assert.throws(
      () => buildModelCandidates({
        primaryModel: "cursor/cursor-grok-4.5-high:high",
        availableModels: [
          { provider: "cursor", id: "cursor-grok-4.5-high", fullId: "cursor/cursor-grok-4.5-high" },
        ],
      }),
      (err: Error) => {
        assert.ok(err instanceof WorkflowModelValidationError);
        assert.match(err.message, /Cursor routes must match the authenticated catalog exactly/);
        return true;
      },
    );
  });
});
