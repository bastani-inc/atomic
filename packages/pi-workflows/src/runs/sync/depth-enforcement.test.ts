/**
 * MaxDepth enforcement tests for the sync executor.
 *
 * Verifies:
 * - run() returns status:"failed" with "pi-workflows: maxDepth exceeded (max N)"
 *   when depth >= config.maxDepth
 * - run() executes normally when depth < maxDepth
 * - run() without config has no depth limit (backward compat)
 * - exact-boundary: depth === maxDepth fails, depth === maxDepth - 1 passes
 * - runId is present even in the failed result
 */

import { test, expect, describe } from "bun:test";
import { run } from "./executor.js";
import { createStore } from "../../store.js";
import { defineWorkflow } from "../../workflows/define-workflow.js";
import type { WorkflowRuntimeConfig } from "../../shared/types.js";
import type { WorkflowDefinition } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWf(name = "depth-test-wf"): WorkflowDefinition {
  return defineWorkflow(name)
    .run(async (_ctx) => ({ ok: true }))
    .compile() as WorkflowDefinition;
}

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

    expect(result.status).toBe("failed");
    expect(result.error).toBe("pi-workflows: maxDepth exceeded (max 2)");
    expect(result.stages).toHaveLength(0);
  });

  test("depth > maxDepth also returns failed RunResult", async () => {
    const wf = makeWf("deep-wf");
    const result = await run(wf, {}, {
      store: createStore(),
      config: configMaxDepth2,
      depth: 5,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("pi-workflows: maxDepth exceeded (max 2)");
  });

  test("depth < maxDepth executes normally", async () => {
    const wf = makeWf("shallow-wf");
    const result = await run(wf, {}, {
      store: createStore(),
      config: configMaxDepth2,
      depth: 1, // one below maxDepth → should run
    });

    expect(result.status).toBe("completed");
    expect(result.result?.["ok"]).toBe(true);
  });

  test("depth 0 (default) executes normally with maxDepth 2", async () => {
    const wf = makeWf("top-level-wf");
    const result = await run(wf, {}, {
      store: createStore(),
      config: configMaxDepth2,
      // depth omitted → defaults to 0
    });

    expect(result.status).toBe("completed");
  });

  test("no config means no depth limit (backward compat)", async () => {
    const wf = makeWf("no-config-wf");
    // Pass an absurdly large depth — without config, no enforcement
    const result = await run(wf, {}, {
      store: createStore(),
      depth: 9999,
    });

    expect(result.status).toBe("completed");
  });

  test("failed runId is non-empty string", async () => {
    const wf = makeWf("runid-wf");
    const result = await run(wf, {}, {
      store: createStore(),
      config: configMaxDepth2,
      depth: 2,
    });

    expect(result.status).toBe("failed");
    expect(typeof result.runId).toBe("string");
    expect(result.runId.length).toBeGreaterThan(0);
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

    expect(result.status).toBe("failed");
    expect(result.runId).toBe(preId);
  });

  test("maxDepth 1 blocks depth=1, allows depth=0", async () => {
    const wf = makeWf("md1-wf");
    const config: WorkflowRuntimeConfig = { ...configMaxDepth2, maxDepth: 1 };

    const depthZero = await run(wf, {}, { store: createStore(), config, depth: 0 });
    expect(depthZero.status).toBe("completed");

    const depthOne = await run(wf, {}, { store: createStore(), config, depth: 1 });
    expect(depthOne.status).toBe("failed");
    expect(depthOne.error).toBe("pi-workflows: maxDepth exceeded (max 1)");
  });

  test("maxDepth 4 (default value) allows depth 3, blocks depth 4", async () => {
    const config: WorkflowRuntimeConfig = { ...configMaxDepth2, maxDepth: 4 };
    const wf = makeWf("md4-wf");

    const atBoundary = await run(wf, {}, { store: createStore(), config, depth: 3 });
    expect(atBoundary.status).toBe("completed");

    const exceeded = await run(wf, {}, { store: createStore(), config, depth: 4 });
    expect(exceeded.status).toBe("failed");
    expect(exceeded.error).toBe("pi-workflows: maxDepth exceeded (max 4)");
  });

  test("error message includes the configured max value", async () => {
    const config: WorkflowRuntimeConfig = { ...configMaxDepth2, maxDepth: 7 };
    const wf = makeWf("msg-wf");

    const result = await run(wf, {}, { store: createStore(), config, depth: 7 });
    expect(result.error).toBe("pi-workflows: maxDepth exceeded (max 7)");
  });
});
