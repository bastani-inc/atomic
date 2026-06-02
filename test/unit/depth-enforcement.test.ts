/**
 * MaxDepth enforcement tests for the sync executor.
 *
 * Verifies:
 * - run() returns status:"failed" with "atomic-workflows: maxDepth exceeded (max N)"
 *   when depth >= config.maxDepth
 * - run() executes normally when depth < maxDepth
 * - run() without config enforces the default maxDepth
 * - exact-boundary: depth === maxDepth fails, depth === maxDepth - 1 passes
 * - runId is present even in the failed result
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import { Type } from "typebox";
import type { WorkflowRuntimeConfig } from "../../packages/workflows/src/shared/types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWf(name = "depth-test-wf"): WorkflowDefinition {
  return defineWorkflow(name)
    .output("ok", Type.Optional(Type.Any()))
    .run(async (ctx) => {
      await ctx.task("depth-check", { prompt: "depth check" });
      return { ok: true };
    })
    .compile() as WorkflowDefinition;
}

const promptAdapter = { prompt: async () => "ok" };

const configMaxDepth2: WorkflowRuntimeConfig = {
  maxDepth: 2,
  defaultConcurrency: 4,
  persistRuns: false,
  statusFile: false,
  resumeInFlight: "ask",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("maxDepth enforcement — executor.run", () => {
  test("depth >= maxDepth returns failed RunResult", async () => {
    const wf = makeWf("exceed-wf");
    const result = await run(wf, {}, {
      store: createStore(),
      config: configMaxDepth2,
      depth: 2, // equal to maxDepth → should fail
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "atomic-workflows: maxDepth exceeded (max 2)");
    assert.equal(result.stages.length, 0);
  });

  test("depth > maxDepth also returns failed RunResult", async () => {
    const wf = makeWf("deep-wf");
    const result = await run(wf, {}, {
      store: createStore(),
      config: configMaxDepth2,
      depth: 5,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "atomic-workflows: maxDepth exceeded (max 2)");
  });

  test("depth < maxDepth executes normally", async () => {
    const wf = makeWf("shallow-wf");
    const result = await run(wf, {}, {
      adapters: { prompt: promptAdapter },
      store: createStore(),
      config: configMaxDepth2,
      depth: 1, // one below maxDepth → should run
    });

    assert.equal(result.status, "completed");
    assert.equal(result.result?.["ok"], true);
  });

  test("depth 0 (default) executes normally with maxDepth 2", async () => {
    const wf = makeWf("top-level-wf");
    const result = await run(wf, {}, {
      adapters: { prompt: promptAdapter },
      store: createStore(),
      config: configMaxDepth2,
      // depth omitted → defaults to 0
    });

    assert.equal(result.status, "completed");
  });

  test("no config uses default maxDepth", async () => {
    const wf = makeWf("no-config-wf");
    const result = await run(wf, {}, {
      store: createStore(),
      depth: 9999,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "atomic-workflows: maxDepth exceeded (max 4)");
  });

  test("failed runId is non-empty string", async () => {
    const wf = makeWf("runid-wf");
    const result = await run(wf, {}, {
      store: createStore(),
      config: configMaxDepth2,
      depth: 2,
    });

    assert.equal(result.status, "failed");
    assert.equal(typeof result.runId, "string");
    assert.ok(result.runId.length > 0);
  });

  test("pre-allocated runId preserved in maxDepth failure", async () => {
    const wf = makeWf("preid-wf");
    const preId = "00000000-0000-0000-0000-000000000042";
    const result = await run(wf, {}, {
      store: createStore(),
      config: configMaxDepth2,
      depth: 2,
      runId: preId,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.runId, preId);
  });

  test("maxDepth 1 blocks depth=1, allows depth=0", async () => {
    const wf = makeWf("md1-wf");
    const config: WorkflowRuntimeConfig = { ...configMaxDepth2, maxDepth: 1 };

    const depthZero = await run(wf, {}, { adapters: { prompt: promptAdapter }, store: createStore(), config, depth: 0 });
    assert.equal(depthZero.status, "completed");

    const depthOne = await run(wf, {}, { store: createStore(), config, depth: 1 });
    assert.equal(depthOne.status, "failed");
    assert.equal(depthOne.error, "atomic-workflows: maxDepth exceeded (max 1)");
  });

  test("maxDepth 4 (default value) allows depth 3, blocks depth 4", async () => {
    const config: WorkflowRuntimeConfig = { ...configMaxDepth2, maxDepth: 4 };
    const wf = makeWf("md4-wf");

    const atBoundary = await run(wf, {}, { adapters: { prompt: promptAdapter }, store: createStore(), config, depth: 3 });
    assert.equal(atBoundary.status, "completed");

    const exceeded = await run(wf, {}, { store: createStore(), config, depth: 4 });
    assert.equal(exceeded.status, "failed");
    assert.equal(exceeded.error, "atomic-workflows: maxDepth exceeded (max 4)");
  });

  test("error message includes the configured max value", async () => {
    const config: WorkflowRuntimeConfig = { ...configMaxDepth2, maxDepth: 7 };
    const wf = makeWf("msg-wf");

    const result = await run(wf, {}, { store: createStore(), config, depth: 7 });
    assert.equal(result.error, "atomic-workflows: maxDepth exceeded (max 7)");
  });
});
