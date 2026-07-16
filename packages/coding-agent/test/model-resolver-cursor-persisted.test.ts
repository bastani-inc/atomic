import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import {
  recoverDeferredCursorModel,
  selectDeferredCursorModelReference,
} from "../src/core/model-resolver-cursor-persisted.ts";
import { registerTrustedCursorProvider } from "./cursor-test-provider-source.ts";

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
    ...(provider === "cursor" ? {
      compat: { cursorRouting: { [id]: { modelId: id, maxMode: false, supportsImages: false, catalogOccurrence: 0 } } },
    } : {}),
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
            registerTrustedCursorProvider(registry, {
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

  for (const kind of ["session", "default"] as const) {
    test(`rejects an id-only persisted ${kind} reference when live occurrences are duplicated`, async () => {
      const registry = registryWithOtherModel();
      const id = "duplicate-route";
      const first = { ...model("cursor", id), name: "first", compat: {
        cursorRouting: { [id]: { modelId: id, maxMode: false, supportsImages: false, catalogOccurrence: 0 } },
      } } as Model<Api>;
      const second = { ...model("cursor", id), name: "second", input: ["text", "image"], compat: {
        cursorRouting: { [id]: { modelId: id, maxMode: true, supportsImages: true, catalogOccurrence: 1 } },
      } } as Model<Api>;
      let selected: Model<Api> | undefined;
      const message = await recoverDeferredCursorModel({
        reference: { kind, id },
        modelRegistry: registry,
        session: {
          async discoverExtensionModels() {
            registerTrustedCursorProvider(registry, {
              baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent", models: [first, second],
            });
          },
          async setModel(value) { selected = value; },
        },
      });
      expect(selected).toBeUndefined();
      expect(message).toContain(`cursor/${id}`);
      expect(message).toContain("reselect an exact model");
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

  test("a present blank Cursor default remains an exact deferred reference", () => {
    expect(selectDeferredCursorModelReference({
      explicitModel: undefined,
      sessionModel: undefined,
      defaultProvider: "cursor",
      defaultModelId: "",
    })).toEqual({ kind: "default", id: "" });
    expect(selectDeferredCursorModelReference({
      explicitModel: undefined,
      sessionModel: undefined,
      defaultProvider: "cursor",
      defaultModelId: undefined,
    })).toBeUndefined();
  });

  test("a restored non-Cursor session identity suppresses a Cursor settings default", () => {
    expect(selectDeferredCursorModelReference({
      explicitModel: undefined,
      sessionModel: { provider: "anthropic", modelId: "restored-session" },
      defaultProvider: "cursor",
      defaultModelId: "default-exact",
    })).toBeUndefined();
  });

  test("provider identity variants never activate deferred Cursor recovery", () => {
    for (const provider of ["Cursor", "CURSOR", " cursor", "cursor "]) {
      expect(selectDeferredCursorModelReference({
        explicitModel: undefined,
        sessionModel: { provider, modelId: "session-route" },
        defaultProvider: "cursor",
        defaultModelId: "default-route",
      }), provider).toBeUndefined();
      expect(selectDeferredCursorModelReference({
        explicitModel: undefined,
        sessionModel: undefined,
        defaultProvider: provider,
        defaultModelId: "default-route",
      }), provider).toBeUndefined();
    }
  });
});
