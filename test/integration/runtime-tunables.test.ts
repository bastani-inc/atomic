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
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
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

describe("runtime tunables — maxDepth", () => {
  test("depth === maxDepth returns failed with exact message", async () => {
    const wf = defineWorkflow("rt-max-depth-eq")
      .output("ok", Type.Optional(Type.Any()))
      .run(async () => ({ ok: true }))
      .compile();

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
    const wf = defineWorkflow("rt-max-depth-gt")
      .output("ok", Type.Optional(Type.Any()))
      .run(async () => ({ ok: true }))
      .compile();

    const result = await run(wf, {}, {
      store: createStore(),
      config: baseConfig({ maxDepth: 2 }),
      depth: 99,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "atomic-workflows: maxDepth exceeded (max 2)");
  });

  test("depth < maxDepth executes normally", async () => {
    const wf = defineWorkflow("rt-below-max-depth")
      .output("ran", Type.Optional(Type.Any()))
      .run(async (ctx) => {
        await ctx.task("depth-check", { prompt: "depth check" });
        return { ran: true };
      })
      .compile();

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
    const wf = defineWorkflow("rt-no-config")
      .output("ok", Type.Optional(Type.Any()))
      .run(async () => ({ ok: true }))
      .compile();

    const result = await run(wf, {}, {
      store: createStore(),
      depth: 10000,
      // config intentionally omitted
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "atomic-workflows: maxDepth exceeded (max 4)");
  });

  test("failed result carries non-empty runId", async () => {
    const wf = defineWorkflow("rt-runid-on-fail")
      .run(async () => ({}))
      .compile();

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
    const wf = defineWorkflow("rt-preid-max-depth")
      .run(async () => ({}))
      .compile();

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

// ---------------------------------------------------------------------------
// 2. defaultConcurrency:1 → parallel stage methods serialized
// ---------------------------------------------------------------------------

describe("runtime tunables — defaultConcurrency", () => {
  test("defaultConcurrency:1 serializes parallel stage.prompt calls (maxActive=1)", async () => {
    let active = 0;
    let maxActive = 0;

    const wf = defineWorkflow("rt-conc-serial")
      .output("a", Type.Optional(Type.Any()))
      .output("b", Type.Optional(Type.Any()))
      .output("c", Type.Optional(Type.Any()))
      .run(async (ctx) => {
        const [a, b, c] = await Promise.all([
          ctx.stage("s1").prompt("s1"),
          ctx.stage("s2").prompt("s2"),
          ctx.stage("s3").prompt("s3"),
        ]);
        return { a, b, c };
      })
      .compile();

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

    const wf = defineWorkflow("rt-conc-serial-all")
      .output("count", Type.Optional(Type.Any()))
      .run(async (ctx) => {
        await Promise.all([
          ctx.stage("alpha").prompt("alpha"),
          ctx.stage("beta").prompt("beta"),
          ctx.stage("gamma").prompt("gamma"),
        ]);
        return { count: 3 };
      })
      .compile();

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

    const wf = defineWorkflow("rt-conc-2")
      .run(async (ctx) => {
        await Promise.all(
          ["s1", "s2", "s3", "s4"].map((n) => ctx.stage(n).prompt(n)),
        );
        return {};
      })
      .compile();

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

    const wf = defineWorkflow("rt-input-max-concurrency")
      .input("max_concurrency", Type.Number({
        default: 4,
        description: "Maximum number of stages to run concurrently.",
      }))
      .run(async (ctx) => {
        await Promise.all(
          ["s1", "s2", "s3", "s4", "s5"].map((n) => ctx.stage(n).prompt(n)),
        );
        return {};
      })
      .compile();

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

    const wf = defineWorkflow("rt-parallel-option-concurrency")
      .run(async (ctx) => {
        await ctx.parallel(
          ["s1", "s2", "s3", "s4", "s5"].map((name) => ({ name, task: name })),
          { concurrency: 2 },
        );
        return {};
      })
      .compile();

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

    const wf = defineWorkflow("rt-parallel-fail-fast-false")
      .run(async (ctx) => {
        await ctx.parallel(
          ["s1", "s2", "s3"].map((name) => ({ name, task: name })),
          { concurrency: 2, failFast: false },
        );
        return {};
      })
      .compile();

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

    const wf = defineWorkflow("rt-conc-queued-pause")
      .output("first", Type.Optional(Type.Any()))
      .output("second", Type.Optional(Type.Any()))
      .run(async (ctx) => {
        const [first, second] = await Promise.all([
          ctx.stage("first").prompt("first"),
          ctx.stage("second").prompt("second"),
        ]);
        return { first, second };
      })
      .compile();

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

    const wf = defineWorkflow("rt-conc-fail-release")
      .run(async (ctx) => {
        await Promise.allSettled([
          ctx.stage("will-fail").prompt("fail"),
          ctx.stage("will-pass").prompt("pass"),
        ]);
        return {};
      })
      .compile();

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

// ---------------------------------------------------------------------------
// 3. statusFile:true → atomic status.json on store updates
// ---------------------------------------------------------------------------

describe("runtime tunables — statusFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "rt-status-writer-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("statusFile:true writes status.json after run start", async () => {
    const filePath = join(tmpDir, "status.json");
    const s = createStore();

    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: true, statusFilePath: filePath }),
    );

    s.recordRunStart({
      id: "rt-run-1",
      name: "my-wf",
      inputs: { x: 1 },
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await writer.flush();
    writer.unsubscribe();

    const raw = await readFile(filePath, "utf8");
    const snap = JSON.parse(raw) as { runs: Array<{ id: string; name: string }>; version: number };
    assert.equal(snap.runs.length, 1);
    assert.equal(snap.runs[0]?.id, "rt-run-1");
    assert.equal(snap.runs[0]?.name, "my-wf");
    assert.ok(snap.version > 0);
  });

  test("statusFile:true captures terminal status (completed)", async () => {
    const filePath = join(tmpDir, "terminal.json");
    const s = createStore();

    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: true, statusFilePath: filePath }),
    );

    s.recordRunStart({
      id: "rt-run-done",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });
    s.recordRunEnd("rt-run-done", "completed", { answer: 42 });

    await writer.flush();
    writer.unsubscribe();

    const snap = JSON.parse(await readFile(filePath, "utf8")) as {
      runs: Array<{ id: string; status: string }>;
    };
    assert.equal(snap.runs[0]?.status, "completed");
  });

  test("statusFile:true captures terminal status (failed)", async () => {
    const filePath = join(tmpDir, "failed.json");
    const s = createStore();

    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: true, statusFilePath: filePath }),
    );

    s.recordRunStart({
      id: "rt-run-fail",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });
    s.recordRunEnd("rt-run-fail", "failed", undefined, "something went wrong");

    await writer.flush();
    writer.unsubscribe();

    const snap = JSON.parse(await readFile(filePath, "utf8")) as {
      runs: Array<{ id: string; status: string; error?: string }>;
    };
    assert.equal(snap.runs[0]?.status, "failed");
  });

  test("statusFile:false writes no file", async () => {
    const filePath = join(tmpDir, "should-not-exist.json");
    const s = createStore();

    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: false, statusFilePath: filePath }),
    );

    s.recordRunStart({
      id: "rt-noop-run",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await writer.flush();
    writer.unsubscribe();

    await assert.rejects(readFile(filePath, "utf8"));
  });

  test("multiple store updates produce successive flushes", async () => {
    const filePath = join(tmpDir, "multi.json");
    const s = createStore();

    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: true, statusFilePath: filePath }),
    );

    s.recordRunStart({
      id: "rt-multi-1",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await writer.flush();

    s.recordRunStart({
      id: "rt-multi-2",
      name: "wf2",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await writer.flush();
    writer.unsubscribe();

    const snap = JSON.parse(await readFile(filePath, "utf8")) as { runs: Array<{ id: string }> };
    // Both runs should be present after the second flush.
    assert.deepEqual(snap.runs.map((r) => r.id).sort(), ["rt-multi-1", "rt-multi-2"]);
  });

  test("write uses projectRoot default path when statusFilePath not set", async () => {
    const projectRoot = join(tmpDir, "project");
    const expectedPath = join(projectRoot, ".atomic", "workflows", "status.json");

    const s = createStore();
    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: true, statusFilePath: undefined }),
      { projectRoot },
    );

    s.recordRunStart({
      id: "rt-default-path",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await writer.flush();
    writer.unsubscribe();

    const raw = await readFile(expectedPath, "utf8");
    assert.ok(JSON.parse(raw));
  });

  test("no flush after unsubscribe", async () => {
    const filePath = join(tmpDir, "no-flush.json");
    const s = createStore();

    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: true, statusFilePath: filePath }),
    );

    s.recordRunStart({
      id: "rt-unsub",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await writer.flush();
    writer.unsubscribe();

    const snapBefore = await readFile(filePath, "utf8");

    // Trigger more store updates after unsubscribe
    s.recordRunEnd("rt-unsub", "completed", {});

    await sleep(50);

    const snapAfter = await readFile(filePath, "utf8");
    // Content must be unchanged — no flush after unsubscribe
    assert.equal(snapAfter, snapBefore);
  });
});
