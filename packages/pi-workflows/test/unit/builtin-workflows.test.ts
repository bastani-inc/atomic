/**
 * Smoke tests for the three builtin workflows.
 * Validates: definition shape, sentinel, input schema, run function executes
 * against a mock WorkflowRunContext.
 */

import { test, expect, describe } from "bun:test";
import type { WorkflowRunContext, StageContext, WorkflowUIContext } from "../../src/shared/types.js";
import type { WorkflowDefinition } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Minimal mock StageContext that records calls and returns deterministic strings. */
function makeStageContext(name: string): StageContext {
  return {
    name,
    prompt: async (text: string) => `[mock-prompt:${name}] ${text.slice(0, 40)}`,
    complete: async (text: string) => `[mock-complete:${name}] ${text.slice(0, 40)}`,
    subagent: async (opts) => `[mock-subagent:${name}] agent=${opts.agent}`,
  };
}

/** Mock WorkflowRunContext factory. */
function makeMockCtx<TInputs extends Record<string, unknown>>(
  inputs: TInputs,
): WorkflowRunContext<TInputs> {
  const ui: WorkflowUIContext = {
    input: async (prompt: string) => `mock-input:${prompt.slice(0, 20)}`,
    confirm: async (_message: string) => false, // default: don't continue loop
    select: async <T extends string>(_message: string, options: readonly T[]) => options[0],
    editor: async (initial?: string) => initial ?? "mock-editor-content",
  };

  return {
    inputs,
    stage: (name: string) => makeStageContext(name),
    ui,
  };
}

/** Assert a value is a valid WorkflowDefinition with the sentinel. */
function assertWorkflowDefinition(def: unknown): asserts def is WorkflowDefinition {
  expect(def).toBeDefined();
  expect(typeof def).toBe("object");
  const d = def as WorkflowDefinition;
  expect(d.__piWorkflow).toBe(true);
  expect(typeof d.name).toBe("string");
  expect(d.name.length).toBeGreaterThan(0);
  expect(typeof d.normalizedName).toBe("string");
  expect(typeof d.description).toBe("string");
  expect(typeof d.run).toBe("function");
  expect(typeof d.inputs).toBe("object");
}

// ---------------------------------------------------------------------------
// deep-research-codebase
// ---------------------------------------------------------------------------

describe("deep-research-codebase", () => {
  let def: WorkflowDefinition;

  // Dynamic import to avoid top-level static import issues with relative paths.
  test("loads and has correct shape", async () => {
    const mod = await import("../../workflows/deep-research-codebase.js");
    def = mod.default as unknown as WorkflowDefinition;
    assertWorkflowDefinition(def);
    expect(def.name).toBe("deep-research-codebase");
    expect(def.normalizedName).toBe("deep-research-codebase");
  });

  test("has required 'prompt' input", async () => {
    const mod = await import("../../workflows/deep-research-codebase.js");
    const d = mod.default;
    expect(d.inputs["prompt"]).toBeDefined();
    expect(d.inputs["prompt"].required).toBe(true);
    expect(d.inputs["prompt"].type).toMatch(/^(text|string)$/);
  });

  test("has 'max_partitions' input with default 4", async () => {
    const mod = await import("../../workflows/deep-research-codebase.js");
    const d = mod.default;
    expect(d.inputs["max_partitions"]).toBeDefined();
    expect(d.inputs["max_partitions"].type).toBe("number");
    expect((d.inputs["max_partitions"] as { default?: number }).default).toBe(4);
  });

  test("run executes without throwing (mock ctx, 2 partitions)", async () => {
    const mod = await import("../../workflows/deep-research-codebase.js");
    const d = mod.default as unknown as WorkflowDefinition;

    // The mock prompt returns a short string; partition stage will split by \n
    // giving us 1 non-empty line. Override ctx.stage to control partition output.
    let callCount = 0;
    const ctx = makeMockCtx({ prompt: "What does the auth module do?", max_partitions: 2 });
    const origStage = ctx.stage.bind(ctx);
    const patchedCtx: WorkflowRunContext<Record<string, unknown>> = {
      ...ctx,
      stage: (name: string) => {
        const sc = origStage(name);
        if (name === "partition") {
          return {
            ...sc,
            complete: async (_text: string) => "auth logic\ntoken validation",
          };
        }
        callCount++;
        return sc;
      },
    };

    const result = await d.run(patchedCtx);
    expect(result).toBeDefined();
    expect(typeof result["findings"]).toBe("string");
    expect(Array.isArray(result["partitions"])).toBe(true);
    expect((result["partitions"] as string[]).length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// ralph
// ---------------------------------------------------------------------------

describe("ralph", () => {
  test("loads and has correct shape", async () => {
    const mod = await import("../../workflows/ralph.js");
    assertWorkflowDefinition(mod.default);
    expect(mod.default.name).toBe("ralph");
  });

  test("has required 'prompt' input", async () => {
    const mod = await import("../../workflows/ralph.js");
    expect(mod.default.inputs["prompt"]).toBeDefined();
    expect(mod.default.inputs["prompt"].required).toBe(true);
  });

  test("has 'max_iterations' input with numeric default", async () => {
    const mod = await import("../../workflows/ralph.js");
    const schema = mod.default.inputs["max_iterations"];
    expect(schema).toBeDefined();
    expect(schema.type).toBe("number");
    const def = (schema as { default?: number }).default;
    expect(typeof def).toBe("number");
    expect(def).toBeGreaterThan(0);
  });

  test("run completes one iteration when confirm returns false", async () => {
    const mod = await import("../../workflows/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;

    const ctx = makeMockCtx({ prompt: "Build a REST API", max_iterations: 3 });
    // confirm defaults to false → loop exits after first iteration
    const result = await d.run(ctx);

    expect(result).toBeDefined();
    expect(typeof result["result"]).toBe("string");
    expect(typeof result["plan"]).toBe("string");
    expect(typeof result["approved"]).toBe("boolean");
  });

  test("run terminates early when approved", async () => {
    const mod = await import("../../workflows/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;

    // Patch stage to return APPROVED from review stage
    const ctx = makeMockCtx({ prompt: "Refactor tests", max_iterations: 5 });
    const origStage = ctx.stage.bind(ctx);
    const patchedCtx: WorkflowRunContext<Record<string, unknown>> = {
      ...ctx,
      stage: (name: string) => {
        const sc = origStage(name);
        if (name.startsWith("review-")) {
          return {
            ...sc,
            complete: async (_: string) => "APPROVED — task is complete.",
          };
        }
        return sc;
      },
    };

    const result = await d.run(patchedCtx);
    expect(result["approved"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// open-claude-design
// ---------------------------------------------------------------------------

describe("open-claude-design", () => {
  test("loads and has correct shape", async () => {
    const mod = await import("../../workflows/open-claude-design.js");
    assertWorkflowDefinition(mod.default);
    expect(mod.default.name).toBe("open-claude-design");
  });

  test("has 'reference', 'output_type', 'design_system' inputs", async () => {
    const mod = await import("../../workflows/open-claude-design.js");
    const d = mod.default;
    expect(d.inputs["reference"]).toBeDefined();
    expect(d.inputs["output_type"]).toBeDefined();
    expect(d.inputs["design_system"]).toBeDefined();
  });

  test("output_type is a select with expected choices", async () => {
    const mod = await import("../../workflows/open-claude-design.js");
    const schema = mod.default.inputs["output_type"];
    expect(schema.type).toBe("select");
    const choices = (schema as { choices: readonly string[] }).choices;
    expect(choices).toContain("component");
    expect(choices).toContain("page");
    expect(choices).toContain("theme");
    expect(choices).toContain("tokens");
  });

  test("run executes without throwing (mock ctx, all inputs provided)", async () => {
    const mod = await import("../../workflows/open-claude-design.js");
    const d = mod.default as unknown as WorkflowDefinition;

    const ctx = makeMockCtx({
      reference: "https://figma.com/file/abc",
      output_type: "component",
      design_system: "shadcn/ui",
    });

    const result = await d.run(ctx);
    expect(result).toBeDefined();
    expect(typeof result["artifact"]).toBe("string");
    expect(typeof result["handoff"]).toBe("string");
    expect(result["output_type"]).toBe("component");
  });

  test("run uses default output_type 'component' when not provided", async () => {
    const mod = await import("../../workflows/open-claude-design.js");
    const d = mod.default as unknown as WorkflowDefinition;

    const ctx = makeMockCtx({});
    const result = await d.run(ctx);
    expect(result["output_type"]).toBe("component");
  });

  test("definition is frozen (immutable)", async () => {
    const mod = await import("../../workflows/open-claude-design.js");
    const d = mod.default;
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.inputs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// workflows/index manifest
// ---------------------------------------------------------------------------

describe("workflows/index manifest", () => {
  test("exports all three builtins by name", async () => {
    const mod = await import("../../workflows/index.js");
    expect(mod.deepResearchCodebase).toBeDefined();
    expect(mod.ralph).toBeDefined();
    expect(mod.openClaudeDesign).toBeDefined();

    // Each export is a valid definition
    assertWorkflowDefinition(mod.deepResearchCodebase);
    assertWorkflowDefinition(mod.ralph);
    assertWorkflowDefinition(mod.openClaudeDesign);
  });
});
