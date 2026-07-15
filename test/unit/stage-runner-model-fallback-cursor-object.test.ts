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

test("missing authenticated discovery rejects a stale exact Cursor object before catalog, session, or prompt", async () => {
  let createCalls = 0;
  let promptCalls = 0;
  let listCalls = 0;
  const stale = staleCursorModel();
  const ctx = createStageContext(makeOpts({
    adapters: { agentSession: { async create() {
      createCalls += 1;
      return makeMockSession({ async prompt() { promptCalls += 1; } }).session;
    } } },
    stageOptions: { model: stale, fallbackModels: ["openai/fallback"] },
    models: {
      currentModel: "anthropic/current",
      listModels: async () => {
        listCalls += 1;
        return [{ provider: "cursor", id: stale.id, fullId: `cursor/${stale.id}`, model: stale }];
      },
    },
  })) as InternalStageContext;

  await assert.rejects(() => ctx.prompt("must not run"), /authenticated Cursor model discovery is unavailable/u);
  assert.equal(listCalls, 0);
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
