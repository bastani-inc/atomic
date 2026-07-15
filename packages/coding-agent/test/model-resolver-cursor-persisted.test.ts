import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import {
  recoverDeferredCursorModel,
  selectDeferredCursorModelReference,
} from "../src/core/model-resolver-cursor-persisted.ts";

function model(provider: string, id: string): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: provider === "cursor" ? "cursor-agent" : "anthropic-messages",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  } as Model<Api>;
}

function registryWithOtherModel(): ModelRegistry {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  registry.registerProvider("anthropic", {
    baseUrl: "https://example.invalid",
    apiKey: "test-key",
    api: "anthropic-messages",
    models: [model("anthropic", "other")],
  });
  return registry;
}

describe("persisted Cursor model recovery", () => {
  for (const kind of ["session", "default"] as const) {
    test(`discovers and selects an exact cold ${kind} reference through the shared SDK path`, async () => {
      const registry = registryWithOtherModel();
      const exact = model("cursor", "cursor-grok-4.5-high");
      let selected: Model<Api> | undefined;
      let discoveries = 0;
      const message = await recoverDeferredCursorModel({
        reference: { kind, id: exact.id },
        modelRegistry: registry,
        session: {
          async discoverExtensionModels() {
            discoveries += 1;
            registry.registerProvider("cursor", {
              baseUrl: "https://api2.cursor.sh",
              apiKey: "cursor-test-key",
              api: "cursor-agent",
              models: [exact],
            });
          },
          async setModel(value) { selected = value; },
        },
      });
      expect(discoveries).toBe(1);
      expect(selected).toBe(registry.getAll().find((entry) => entry.provider === "cursor" && entry.id === exact.id));
      expect(message).toBeUndefined();
    });
  }

  test("stale persisted Cursor identity never substitutes another current model", async () => {
    const registry = registryWithOtherModel();
    let selected: Model<Api> | undefined;
    const message = await recoverDeferredCursorModel({
      reference: { kind: "session", id: "old-synthetic-high" },
      modelRegistry: registry,
      session: {
        async discoverExtensionModels() {},
        async setModel(value) { selected = value; },
      },
    });
    expect(selected).toBeUndefined();
    expect(message).toContain("cursor/old-synthetic-high");
    expect(message).toContain("reselect an exact model");
  });

  test("session identity takes precedence over a saved default without migration", () => {
    expect(selectDeferredCursorModelReference({
      explicitModel: undefined,
      sessionModel: { provider: "cursor", modelId: "session-exact" },
      defaultProvider: "cursor",
      defaultModelId: "default-exact",
    })).toEqual({ kind: "session", id: "session-exact" });
  });
});
