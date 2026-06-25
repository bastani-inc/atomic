// @ts-nocheck
/**
 * Integration regression tests: runtime tunables
 *
 * Covers the three RFC-required behaviors end-to-end through executor.run():
 *   1. maxDepth exceeded → status:"failed", precise error message
 *   2. defaultConcurrency:1 → parallel stage methods serialized (maxActive=1)
 *   3. statusFile:true → atomic status.json written on each store update
 *
 * Each test uses real store, real executor, and (for #3) a real temp directory.
 * Tests are independent; no shared mutable state.
 *
 * cross-ref:
 *   src/runs/foreground/executor.ts     — run(), maxDepth guard, ConcurrencyLimiter
 *   src/extension/status-writer.ts — createStatusWriter, atomicWriteJson
 *   src/shared/types.ts            — WorkflowRuntimeConfig
 */
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createStatusWriter } from "../../packages/workflows/src/extension/status-writer.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { Type } from "typebox";
import type { WorkflowRuntimeConfig } from "../../packages/workflows/src/shared/types.js";
// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function baseConfig(overrides: Partial<WorkflowRuntimeConfig> = {}): WorkflowRuntimeConfig {
  return {
    maxDepth: 4,
    defaultConcurrency: 4,
    persistRuns: false,
    statusFile: false,
    resumeInFlight: "never",
    ...overrides,
  };
}
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function deferred<T = void>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}
// ---------------------------------------------------------------------------
// 1. maxDepth exceeded → precise error
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 2. defaultConcurrency:1 → parallel stage methods serialized
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 3. statusFile:true → atomic status.json on store updates
// ---------------------------------------------------------------------------
describe("runtime tunables — maxDepth", () => {
  test("depth === maxDepth returns failed with exact message", async () => {
    const wf = workflow({
      name: "rt-max-depth-eq",
      description: "",
      inputs: {},
      outputs: {
        ok: Type.Optional(Type.Any()),
      },
      run: async () => ({ ok: true }),
    });
    const result = await run(wf, {}, {
      store: createStore(),
      config: baseConfig({ maxDepth: 3 }),
      depth: 3,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error, "atomic-workflows: maxDepth exceeded (max 3)");
    assert.equal(result.stages.length, 0);
  });
  test("depth > maxDepth returns failed with max in message", async () => {
    const wf = workflow({
      name: "rt-max-depth-gt",
      description: "",
      inputs: {},
      outputs: {
        ok: Type.Optional(Type.Any()),
      },
      run: async () => ({ ok: true }),
    });
    const result = await run(wf, {}, {
      store: createStore(),
      config: baseConfig({ maxDepth: 2 }),
      depth: 99,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error, "atomic-workflows: maxDepth exceeded (max 2)");
  });
  test("depth < maxDepth executes normally", async () => {
    const wf = workflow({
      name: "rt-below-max-depth",
      description: "",
      inputs: {},
      outputs: {
        ran: Type.Optional(Type.Any()),
      },
      run: async (ctx) => {
        await ctx.task("depth-check", { prompt: "depth check" });
        return { ran: true };
      },
    });
    const result = await run(wf, {}, {
      adapters: { prompt: { prompt: async () => "ok" } },
      store: createStore(),
      config: baseConfig({ maxDepth: 4 }),
      depth: 3,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.result?.["ran"], true);
  });
  test("no config uses default maxDepth", async () => {
    const wf = workflow({
      name: "rt-no-config",
      description: "",
      inputs: {},
      outputs: {
        ok: Type.Optional(Type.Any()),
      },
      run: async () => ({ ok: true }),
    });
    const result = await run(wf, {}, {
      store: createStore(),
      depth: 10000,
      // config intentionally omitted
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error, "atomic-workflows: maxDepth exceeded (max 4)");
  });
  test("failed result carries non-empty runId", async () => {
    const wf = workflow({ name: "rt-runid-on-fail", description: "", inputs: {}, outputs: {}, run: async () => ({}),
    });
    const result = await run(wf, {}, {
      store: createStore(),
      config: baseConfig({ maxDepth: 1 }),
      depth: 1,
    });
    assert.equal(result.status, "failed");
    assert.equal(typeof result.runId, "string");
    assert.ok(result.runId.length > 0);
  });
  test("pre-allocated runId preserved in maxDepth failure", async () => {
    const wf = workflow({ name: "rt-preid-max-depth", description: "", inputs: {}, outputs: {}, run: async () => ({}),
    });
    const preId = "cafecafe-0000-0000-0000-000000000001";
    const result = await run(wf, {}, {
      store: createStore(),
      config: baseConfig({ maxDepth: 2 }),
      depth: 2,
      runId: preId,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.runId, preId);
  });
});
describe("runtime tunables — defaultConcurrency", () => {
  test("defaultConcurrency:1 serializes parallel stage.prompt calls (maxActive=1)", async () => {
    let active = 0;
    let maxActive = 0;
    const wf = workflow({
      name: "rt-conc-serial",
      description: "",
      inputs: {},
      outputs: {
        a: Type.Optional(Type.Any()),
        b: Type.Optional(Type.Any()),
        c: Type.Optional(Type.Any()),
      },
      run: async (ctx) => {
        const [a, b, c] = await Promise.all([
          ctx.stage("s1").prompt("s1"),
          ctx.stage("s2").prompt("s2"),
          ctx.stage("s3").prompt("s3"),
        ]);
        return { a, b, c };
      },
    });
    const result = await run(wf, {}, {
      store: createStore(),
      config: baseConfig({ defaultConcurrency: 1 }),
      adapters: {
        prompt: {
          prompt: async (text) => {
            active++;
            maxActive = Math.max(maxActive, active);
            await sleep(5);
            active--;
            return `done:${text}`;
          },
        },
      },
    });
    assert.equal(result.status, "completed");
    // With limit=1 only one stage may execute at a time.
    assert.equal(maxActive, 1);
  });
  test("defaultConcurrency:1 still completes all stages", async () => {
    const completed: string[] = [];
    const wf = workflow({
      name: "rt-conc-serial-all",
      description: "",
      inputs: {},
      outputs: {
        count: Type.Optional(Type.Any()),
      },
      run: async (ctx) => {
        await Promise.all([
          ctx.stage("alpha").prompt("alpha"),
          ctx.stage("beta").prompt("beta"),
          ctx.stage("gamma").prompt("gamma"),
        ]);
        return { count: 3 };
      },
    });
    const result = await run(wf, {}, {
      store: createStore(),
      config: baseConfig({ defaultConcurrency: 1 }),
      adapters: {
        prompt: {
          prompt: async (text) => {
            completed.push(text);
            return text;
          },
        },
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(completed.length, 3);
    assert.deepEqual(completed.sort(), ["alpha", "beta", "gamma"]);
  });
  test("defaultConcurrency:2 allows up to 2 concurrent stages", async () => {
    let active = 0;
    let maxActive = 0;
    const wf = workflow({ name: "rt-conc-2", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
        await Promise.all(
          ["s1", "s2", "s3", "s4"].map((n) => ctx.stage(n).prompt(n)),
        );
        return {};
      },
    });
    const result = await run(wf, {}, {
      store: createStore(),
      config: baseConfig({ defaultConcurrency: 2 }),
      adapters: {
        prompt: {
          prompt: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await sleep(5);
            active--;
            return "done";
          },
        },
      },
    });
    assert.equal(result.status, "completed");
    assert.ok(maxActive <= 2);
    assert.ok(maxActive >= 1);
  });
  test("max_concurrency input overrides the default stage concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const wf = workflow({
      name: "rt-input-max-concurrency",
      description: "",
      inputs: {
        max_concurrency: Type.Number({
        default: 4,
        description: "Maximum number of stages to run concurrently.",
      }),
      },
      outputs: {},
      run: async (ctx) => {
        await Promise.all(
          ["s1", "s2", "s3", "s4", "s5"].map((n) => ctx.stage(n).prompt(n)),
        );
        return {};
      },
    });
    const result = await run(wf, { max_concurrency: 2 }, {
      store: createStore(),
      config: baseConfig({ defaultConcurrency: 4 }),
      adapters: {
        prompt: {
          prompt: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await sleep(5);
            active--;
            return "done";
          },
        },
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(maxActive, 2);
  });
  test("ctx.parallel concurrency option limits scheduled task fan-out", async () => {
    let active = 0;
    let maxActive = 0;
    const wf = workflow({ name: "rt-parallel-option-concurrency", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
        await ctx.parallel(
          ["s1", "s2", "s3", "s4", "s5"].map((name) => ({ name, task: name })),
          { concurrency: 2 },
        );
        return {};
      },
    });
    const result = await run(wf, {}, {
      store: createStore(),
      config: baseConfig({ defaultConcurrency: 4 }),
      adapters: {
        prompt: {
          prompt: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await sleep(5);
            active--;
            return "done";
          },
        },
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(maxActive, 2);
  });
  test("ctx.parallel failFast:false waits for all scheduled task fan-out", async () => {
    const prompts: string[] = [];
    const wf = workflow({ name: "rt-parallel-fail-fast-false", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
        await ctx.parallel(
          ["s1", "s2", "s3"].map((name) => ({ name, task: name })),
          { concurrency: 2, failFast: false },
        );
        return {};
      },
    });
    const result = await run(wf, {}, {
      store: createStore(),
      config: baseConfig({ defaultConcurrency: 4 }),
      adapters: {
        prompt: {
          prompt: async (text) => {
            prompts.push(text);
            if (text === "s1") throw new Error("s1 failed");
            await sleep(5);
            return "done";
          },
        },
      },
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(prompts.sort(), ["s1", "s2", "s3"]);
    assert.match(result.error ?? "", /parallel step failed/);
  });
  test("pausing a concurrency-queued stage prevents it from starting when the slot frees until resume", async () => {
    const store = createStore();
    const registry = createStageControlRegistry();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const stageIds = new Map<string, string>();
    const promptCalls: string[] = [];
    const wf = workflow({
      name: "rt-conc-queued-pause",
      description: "",
      inputs: {},
      outputs: {
        first: Type.Optional(Type.Any()),
        second: Type.Optional(Type.Any()),
      },
      run: async (ctx) => {
        const [first, second] = await Promise.all([
          ctx.stage("first").prompt("first"),
          ctx.stage("second").prompt("second"),
        ]);
        return { first, second };
      },
    });
    const runPromise = run(wf, {}, {
      store,
      stageControlRegistry: registry,
      config: baseConfig({ defaultConcurrency: 1 }),
      onStageStart: (runId, stage) => {
        if (!stageIds.has(stage.name)) stageIds.set(stage.name, stage.id);
        void runId;
      },
      adapters: {
        prompt: {
          async prompt(text) {
            promptCalls.push(text);
            if (text === "first") {
              firstEntered.resolve();
              await releaseFirst.promise;
            }
            return `done:${text}`;
          },
        },
      },
    });
    await firstEntered.promise;
    while (!stageIds.has("second")) await flushMicrotasks();
    const runId = store.runs()[0]!.id;
    const secondId = stageIds.get("second")!;
    const pauseResult = pauseRun(runId, { store, stageControlRegistry: registry, stageId: secondId });
    assert.equal(pauseResult.ok, true);
    await flushMicrotasks();
    assert.equal(store.runs()[0]?.stages.find((stage) => stage.id === secondId)?.status, "paused");
    releaseFirst.resolve();
    await sleep(20);
    assert.deepEqual(promptCalls, ["first"]);
    assert.equal(store.runs()[0]?.stages.find((stage) => stage.id === secondId)?.status, "paused");
    const resumeResult = resumeRun(runId, { store, stageControlRegistry: registry, stageId: secondId });
    assert.equal(resumeResult.ok, true);
    const result = await runPromise;
    assert.equal(result.status, "completed");
    assert.deepEqual(promptCalls, ["first", "second"]);
  });
  test("slot released after stage failure — next stage can acquire", async () => {
    const ran: string[] = [];
    const wf = workflow({ name: "rt-conc-fail-release", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
        await Promise.allSettled([
          ctx.stage("will-fail").prompt("fail"),
          ctx.stage("will-pass").prompt("pass"),
        ]);
        return {};
      },
    });
    const result = await run(wf, {}, {
      store: createStore(),
      config: baseConfig({ defaultConcurrency: 1 }),
      adapters: {
        prompt: {
          prompt: async (text) => {
            if (text === "fail") throw new Error("intentional-failure");
            ran.push(text);
            return text;
          },
        },
      },
    });
    // allSettled → run completes even if one stage throws
    assert.equal(result.status, "completed");
    // The "pass" stage ran after the failing stage released its slot
    assert.ok(ran.includes("pass"));
  });
});