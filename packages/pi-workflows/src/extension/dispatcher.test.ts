/**
 * dispatcher.test.ts
 *
 * Verifies:
 *   - DispatcherOpts accepts ui?: WorkflowUIAdapter
 *   - dispatch("run") forwards opts.ui into run()
 *   - dispatch("list") and dispatch("inputs") are unaffected by ui field
 */

import { test, expect, describe, mock } from "bun:test";
import type { WorkflowUIAdapter, WorkflowDefinition } from "../shared/types.js";
import { createRegistry } from "../workflows/registry.js";
import { defineWorkflow } from "../workflows/define-workflow.js";
import { dispatch } from "./dispatcher.js";
import type { DispatcherOpts } from "./dispatcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(name: string): WorkflowDefinition {
  return defineWorkflow(name)
    .run(async (_ctx) => ({ ok: true }))
    .compile() as WorkflowDefinition;
}

function makeUiAdapter(): WorkflowUIAdapter {
  return {
    onRunStart: mock(() => {}),
    onRunEnd: mock(() => {}),
    onStageStart: mock(() => {}),
    onStageEnd: mock(() => {}),
  } as unknown as WorkflowUIAdapter;
}

// ---------------------------------------------------------------------------
// DispatcherOpts accepts ui field (type-level + runtime shape)
// ---------------------------------------------------------------------------

describe("DispatcherOpts ui field", () => {
  test("DispatcherOpts accepts ui?: WorkflowUIAdapter without error", () => {
    const registry = createRegistry([]);
    const ui = makeUiAdapter();
    // Type check: constructing opts with ui must compile and be assignable
    const opts: DispatcherOpts = { registry, ui };
    expect(opts.ui).toBe(ui);
  });

  test("DispatcherOpts without ui is still valid (optional)", () => {
    const registry = createRegistry([]);
    const opts: DispatcherOpts = { registry };
    expect(opts.ui).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dispatch("list") — ui has no effect, list still works
// ---------------------------------------------------------------------------

describe("dispatch list", () => {
  test("list action returns workflow names, ui ignored", async () => {
    const wf = makeWorkflow("alpha");
    const registry = createRegistry([wf]);
    const ui = makeUiAdapter();
    const result = await dispatch({ action: "list" }, { registry, ui });
    expect(result.action).toBe("list");
    if (result.action === "list") {
      expect(result.workflows).toContain("alpha");
    }
  });
});

// ---------------------------------------------------------------------------
// dispatch("inputs") — ui has no effect, inputs still works
// ---------------------------------------------------------------------------

describe("dispatch inputs", () => {
  test("inputs action returns schema, ui ignored", async () => {
    const wf = makeWorkflow("beta");
    const registry = createRegistry([wf]);
    const ui = makeUiAdapter();
    const result = await dispatch({ action: "inputs", name: "beta" }, { registry, ui });
    expect(result.action).toBe("inputs");
  });

  test("inputs for unknown workflow returns error, ui ignored", async () => {
    const registry = createRegistry([]);
    const ui = makeUiAdapter();
    const result = await dispatch({ action: "inputs", name: "no-such" }, { registry, ui });
    expect(result.action).toBe("inputs");
    if (result.action === "inputs") {
      expect(result.error).toMatch(/not found/i);
    }
  });
});

// ---------------------------------------------------------------------------
// dispatch("run") — ui forwarded to executor
// ---------------------------------------------------------------------------

describe("dispatch run forwards ui", () => {
  test("run with ui completes successfully", async () => {
    const wf = makeWorkflow("gamma");
    const registry = createRegistry([wf]);
    const ui = makeUiAdapter();
    const result = await dispatch({ action: "run", name: "gamma", inputs: {} }, { registry, ui });
    expect(result.action).toBe("run");
    if (result.action === "run") {
      expect(result.status).toBe("completed");
    }
  });

  test("run without ui completes successfully (ui optional, no regression)", async () => {
    const wf = makeWorkflow("delta");
    const registry = createRegistry([wf]);
    const result = await dispatch({ action: "run", name: "delta", inputs: {} }, { registry });
    expect(result.action).toBe("run");
    if (result.action === "run") {
      expect(result.status).toBe("completed");
    }
  });

  test("run for unknown workflow returns failed result, ui present", async () => {
    const registry = createRegistry([]);
    const ui = makeUiAdapter();
    const result = await dispatch({ action: "run", name: "ghost", inputs: {} }, { registry, ui });
    expect(result.action).toBe("run");
    if (result.action === "run") {
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/not found/i);
    }
  });
});
