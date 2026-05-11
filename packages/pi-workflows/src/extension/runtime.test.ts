/**
 * Extension runtime dispatcher tests.
 * Covers: list, inputs (found/not-found), run (success/not-found/failure), renderResult.
 */

import { test, expect, describe } from "bun:test";
import { dispatch } from "./dispatcher.js";
import { createExtensionRuntime } from "./runtime.js";
import { createRegistry } from "../workflows/registry.js";
import { defineWorkflow } from "../workflows/define-workflow.js";
import { createStore } from "../store.js";
import { renderResult } from "./render-result.js";
import type { WorkflowDefinition, WorkflowUIAdapter } from "../shared/types.js";
import type { StageAdapters } from "../runs/sync/stage-runner.js";
import type {
  WorkflowToolResult,
  WorkflowInputEntry,
  WorkflowRunEntry,
} from "./render-result.js";

// ---------------------------------------------------------------------------
// Type-safe result narrowers
// ---------------------------------------------------------------------------

type ListResult   = Extract<WorkflowToolResult, { action: "list" }>;
type InputsResult = Extract<WorkflowToolResult, { action: "inputs" }>;
type RunResult    = Extract<WorkflowToolResult, { action: "run"; runId: string }>;

function asList(r: WorkflowToolResult): ListResult {
  if (r.action !== "list") throw new Error(`expected list, got ${r.action}`);
  return r as ListResult;
}
function asInputs(r: WorkflowToolResult): InputsResult {
  if (r.action !== "inputs") throw new Error(`expected inputs, got ${r.action}`);
  return r as InputsResult;
}
function asRun(r: WorkflowToolResult): RunResult {
  if (r.action !== "run" || !("runId" in r)) throw new Error(`expected run, got ${r.action}`);
  return r as RunResult;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const noopAdapters: StageAdapters = {
  prompt: { prompt: async (text) => `echo:${text}` },
  complete: { complete: async (text) => `echo:${text}` },
};

// Cast to base WorkflowDefinition to avoid contravariant TInputs error in arrays.
const helloWorkflow = defineWorkflow("hello-world")
  .description("Simple greeting")
  .input("name", { type: "text", required: true })
  .run(async (ctx) => {
    const stage = ctx.stage("greet");
    const out = await stage.prompt(`Hello ${String(ctx.inputs["name"])}`);
    return { greeting: out };
  })
  .compile() as WorkflowDefinition;

const schemaWorkflow = defineWorkflow("schema-test")
  .description("Multi-input schema")
  .input("text", { type: "text", default: "hi" })
  .input("count", { type: "number", required: false })
  .input("flag", { type: "boolean", required: true })
  .run(async (_ctx) => ({ ok: true }))
  .compile() as WorkflowDefinition;

// ---------------------------------------------------------------------------
// dispatch: list
// ---------------------------------------------------------------------------

describe("dispatch — list", () => {
  test("returns empty when registry is empty", async () => {
    const registry = createRegistry();
    const result = await dispatch({ name: "", inputs: {}, action: "list" }, { registry });
    const list = asList(result);
    expect(list.workflows).toEqual([]);
  });

  test("returns all registered names", async () => {
    const registry = createRegistry([helloWorkflow, schemaWorkflow]);
    const result = await dispatch({ name: "", inputs: {}, action: "list" }, { registry });
    const list = asList(result);
    expect(list.workflows).toContain("hello-world");
    expect(list.workflows).toContain("schema-test");
    expect(list.workflows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// dispatch: inputs
// ---------------------------------------------------------------------------

describe("dispatch — inputs", () => {
  test("returns not-found result (not throw) for unknown workflow", async () => {
    const registry = createRegistry();
    const result = await dispatch(
      { name: "no-such-workflow", inputs: {}, action: "inputs" },
      { registry },
    );
    const inp = asInputs(result);
    expect(inp.inputs).toEqual([]);
    expect(inp.error).toContain("no-such-workflow");
  });

  test("returns schema entries for known workflow", async () => {
    const registry = createRegistry([schemaWorkflow]);
    const result = await dispatch(
      { name: "schema-test", inputs: {}, action: "inputs" },
      { registry },
    );
    const inp = asInputs(result);
    expect(inp.error).toBeUndefined();
    const byName = Object.fromEntries(inp.inputs.map((i: WorkflowInputEntry) => [i.name, i]));
    expect(byName["text"]?.type).toBe("text");
    expect(byName["text"]?.default).toBe("hi");
    expect(byName["count"]?.required).toBeFalsy();
    expect(byName["flag"]?.required).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dispatch: run
// ---------------------------------------------------------------------------

describe("dispatch — run", () => {
  test("returns structured failed result when workflow not found", async () => {
    const registry = createRegistry();
    const result = await dispatch({ name: "ghost", inputs: {}, action: "run" }, { registry });
    const run = asRun(result);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("ghost");
    expect(run.runId).toBe("");
  });

  test("runs workflow and returns real RunResult fields", async () => {
    const registry = createRegistry([helloWorkflow]);
    const activeStore = createStore();
    const result = await dispatch(
      { name: "hello-world", inputs: { name: "Alice" }, action: "run" },
      { registry, adapters: noopAdapters, store: activeStore },
    );
    const run = asRun(result);
    expect(run.name).toBe("hello-world");
    expect(run.runId).toBeString();
    expect(run.runId.length).toBeGreaterThan(0);
    expect(run.status).toBe("completed");
    expect(run.result?.["greeting"]).toContain("Hello Alice");
    expect(run.error).toBeUndefined();
    expect(Array.isArray(run.stages)).toBe(true);
    expect(run.stages!.length).toBe(1);
  });

  test("propagates execution errors as failed status — no success-shaped swallow", async () => {
    const failingWorkflow = defineWorkflow("fail-me")
      .run(async (_ctx) => {
        throw new Error("intentional failure");
      })
      .compile() as WorkflowDefinition;
    const registry = createRegistry([failingWorkflow]);
    const activeStore = createStore();
    const result = await dispatch(
      { name: "fail-me", inputs: {}, action: "run" },
      { registry, adapters: noopAdapters, store: activeStore },
    );
    const run = asRun(result);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("intentional failure");
  });

  test("propagates input validation errors (missing required input)", async () => {
    const registry = createRegistry([helloWorkflow]);
    await expect(
      dispatch(
        { name: "hello-world", inputs: {}, action: "run" }, // missing required `name`
        { registry, adapters: noopAdapters },
      ),
    ).rejects.toThrow('required input "name"');
  });
});

// ---------------------------------------------------------------------------
// dispatch: unknown action throws
// ---------------------------------------------------------------------------

describe("dispatch — unknown action", () => {
  test("throws for unrecognised action", async () => {
    const registry = createRegistry();
    await expect(
      dispatch(
        { name: "", inputs: {}, action: "status" as "list" },
        { registry },
      ),
    ).rejects.toThrow("unknown action");
  });
});

// ---------------------------------------------------------------------------
// createExtensionRuntime
// ---------------------------------------------------------------------------

describe("createExtensionRuntime", () => {
  test("empty registry by default", () => {
    const runtime = createExtensionRuntime();
    expect(runtime.registry.names()).toEqual([]);
  });

  test("seeds registry from definitions array", () => {
    const runtime = createExtensionRuntime({ definitions: [helloWorkflow] });
    expect(runtime.registry.names()).toContain("hello-world");
  });

  test("accepts external registry", () => {
    const external = createRegistry([helloWorkflow, schemaWorkflow]);
    const runtime = createExtensionRuntime({ registry: external });
    expect(runtime.registry.names()).toHaveLength(2);
  });

  test("dispatch delegates to registry", async () => {
    const runtime = createExtensionRuntime({ definitions: [helloWorkflow] });
    const result = await runtime.dispatch({ name: "", inputs: {}, action: "list" });
    const list = asList(result);
    expect(list.workflows).toContain("hello-world");
  });
});

// ---------------------------------------------------------------------------
// renderResult — new run variant
// ---------------------------------------------------------------------------

describe("renderResult — run variant", () => {
  test("completed run with result", () => {
    const out = renderResult({
      action: "run",
      name: "hello-world",
      runId: "abc-123",
      status: "completed",
      result: { greeting: "Hello Alice" },
      stages: [],
    });
    expect(out).toContain("abc-123");
    expect(out).toContain("hello-world");
    expect(out).toContain("completed");
  });

  test("failed run shows error", () => {
    const out = renderResult({
      action: "run",
      name: "hello-world",
      runId: "abc-123",
      status: "failed",
      error: "intentional failure",
      stages: [],
    });
    expect(out).toContain("failed");
    expect(out).toContain("intentional failure");
  });

  test("partial run shows in-progress", () => {
    const out = renderResult(
      {
        action: "run",
        name: "hello-world",
        runId: "abc-123",
        status: "running",
        stages: [],
      },
      { isPartial: true },
    );
    expect(out).toContain("in progress");
  });

  test("inputs not-found carries error field in result", async () => {
    const registry = createRegistry();
    const result = await dispatch(
      { name: "ghost", inputs: {}, action: "inputs" },
      { registry },
    );
    const inp = asInputs(result);
    expect(inp.error).toContain("ghost");
  });

  test("status list uses WorkflowRunEntry shape", () => {
    const runs: WorkflowRunEntry[] = [
      { runId: "r1", name: "wf", status: "running" },
    ];
    const out = renderResult({ action: "status", runs });
    expect(out).toContain("r1");
    expect(out).toContain("wf");
  });
});

// ---------------------------------------------------------------------------
// WorkflowUIAdapter — forwarding through createExtensionRuntime → dispatch → run
// ---------------------------------------------------------------------------

describe("WorkflowUIAdapter — runtime forwarding", () => {
  const uiWorkflow = defineWorkflow("ui-test")
    .description("Tests HIL ui forwarding")
    .run(async (ctx) => {
      const answer = await ctx.ui.input("What is your name?");
      return { answer };
    })
    .compile() as WorkflowDefinition;

  test("ui adapter is called when provided via createExtensionRuntime", async () => {
    let captured: string | undefined;
    const mockUI: WorkflowUIAdapter = {
      input: async (prompt) => { captured = prompt; return "Alice"; },
      confirm: async () => false,
      select: async <T extends string>(_msg: string, options: readonly T[]): Promise<T> => options[0]!,
      editor: async () => "",
    };

    const runtime = createExtensionRuntime({
      definitions: [uiWorkflow],
      ui: mockUI,
      store: createStore(),
    });

    const result = await runtime.dispatch({ name: "ui-test", inputs: {}, action: "run" });
    const run = asRun(result);
    expect(run.status).toBe("completed");
    expect(run.result?.["answer"]).toBe("Alice");
    expect(captured).toBe("What is your name?");
  });

  test("ui adapter is called when provided via dispatch directly", async () => {
    let called = false;
    const mockUI: WorkflowUIAdapter = {
      input: async () => { called = true; return "Bob"; },
      confirm: async () => false,
      select: async <T extends string>(_msg: string, options: readonly T[]): Promise<T> => options[0]!,
      editor: async () => "",
    };

    const registry = createRegistry([uiWorkflow]);
    const result = await dispatch(
      { name: "ui-test", inputs: {}, action: "run" },
      { registry, ui: mockUI, store: createStore() },
    );
    const run = asRun(result);
    expect(run.status).toBe("completed");
    expect(called).toBe(true);
  });

  test("omitting ui causes HIL call to reject with unavailable error", async () => {
    const runtime = createExtensionRuntime({
      definitions: [uiWorkflow],
      store: createStore(),
    });

    const result = await runtime.dispatch({ name: "ui-test", inputs: {}, action: "run" });
    const run = asRun(result);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("ui.input is unavailable");
  });
});
