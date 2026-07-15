import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { test } from "bun:test";
import {
  assert,
  createStageContext,
  makeMockSession,
  makeOpts,
  type InternalStageContext,
} from "./stage-runner-helpers.js";

function staleCursorModel(): Model<Api> {
  return {
    provider: "cursor", id: "old-synthetic-high", name: "Old Cursor route", api: "cursor-agent",
    baseUrl: "https://api2.cursor.sh", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000,
  } as Model<Api>;
}

test("stale Cursor model objects fail before stage session creation, prompt, or fallback", async () => {
  let createCalls = 0;
  let promptCalls = 0;
  const ctx = createStageContext(makeOpts({
    adapters: { agentSession: { async create() {
      createCalls += 1;
      return makeMockSession({ async prompt() { promptCalls += 1; } }).session;
    } } },
    stageOptions: { model: staleCursorModel(), fallbackModels: ["openai/fallback"] },
    models: {
      currentModel: "anthropic/current",
      listModels: async () => [
        { provider: "openai", id: "fallback", fullId: "openai/fallback" },
        { provider: "anthropic", id: "current", fullId: "anthropic/current" },
      ],
    },
  })) as InternalStageContext;

  await assert.rejects(() => ctx.prompt("must not run"), /cursor\/old-synthetic-high.*reselect/s);
  assert.equal(createCalls, 0);
  assert.equal(promptCalls, 0);
  assert.equal(ctx.__modelFallbackMeta().attemptedModels, undefined);
});

test("Cursor discovery failure stops before stage session creation, prompt, or Run", async () => {
  let createCalls = 0;
  let promptCalls = 0;
  const ctx = createStageContext(makeOpts({
    adapters: { agentSession: { async create() {
      createCalls += 1;
      return makeMockSession({ async prompt() { promptCalls += 1; } }).session;
    } } },
    stageOptions: { model: "cursor/live-route", fallbackModels: ["openai/fallback"] },
    models: {
      discoverModels: async () => { throw new Error("GetUsable discovery failed"); },
      currentModel: "anthropic/current",
      listModels: async () => [
        { provider: "openai", id: "fallback", fullId: "openai/fallback" },
        { provider: "anthropic", id: "current", fullId: "anthropic/current" },
      ],
    },
  })) as InternalStageContext;

  await assert.rejects(() => ctx.prompt("must not run"), /GetUsable discovery failed/u);
  assert.equal(createCalls, 0);
  assert.equal(promptCalls, 0);
  assert.equal(ctx.__modelFallbackMeta().attemptedModels, undefined);
});
