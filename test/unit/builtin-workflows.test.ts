/**
 * Smoke tests for the three builtin workflows.
 * Validates: definition shape, sentinel, input schema, run function executes
 * against a mock WorkflowRunContext.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
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
  } as StageContext;
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
    task: async (name, options) => ({
      name,
      stageName: name,
      text: await makeStageContext(name).prompt(options.prompt ?? options.task ?? ""),
    }),
    chain: async () => [],
    parallel: async () => [],
    ui,
  };
}

/** Assert a value is a valid WorkflowDefinition with the sentinel. */
function assertWorkflowDefinition(def: unknown): asserts def is WorkflowDefinition {
  assert.notEqual(def, undefined);
  assert.equal(typeof def, "object");
  const d = def as WorkflowDefinition;
  assert.equal(d.__piWorkflow, true);
  assert.equal(typeof d.name, "string");
  assert.ok(d.name.length > 0);
  assert.equal(typeof d.normalizedName, "string");
  assert.equal(typeof d.description, "string");
  assert.equal(typeof d.run, "function");
  assert.equal(typeof d.inputs, "object");
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
    assert.equal(def.name, "deep-research-codebase");
    assert.equal(def.normalizedName, "deep-research-codebase");
  });

  test("has required 'prompt' input", async () => {
    const mod = await import("../../workflows/deep-research-codebase.js");
    const d = mod.default;
    assert.notEqual(d.inputs["prompt"], undefined);
    assert.equal(d.inputs["prompt"].required, true);
    assert.match(d.inputs["prompt"].type, /^(text|string)$/);
  });

  test("has 'max_partitions' input with default 4", async () => {
    const mod = await import("../../workflows/deep-research-codebase.js");
    const d = mod.default;
    assert.notEqual(d.inputs["max_partitions"], undefined);
    assert.equal(d.inputs["max_partitions"].type, "number");
    assert.equal((d.inputs["max_partitions"] as { default?: number }).default, 4);
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
    assert.notEqual(result, undefined);
    assert.equal(typeof result["findings"], "string");
    assert.equal(Array.isArray(result["partitions"]), true);
    assert.ok((result["partitions"] as string[]).length <= 2);
  });
});

// ---------------------------------------------------------------------------
// ralph
// ---------------------------------------------------------------------------

describe("ralph", () => {
  test("loads and has correct shape", async () => {
    const mod = await import("../../workflows/ralph.js");
    assertWorkflowDefinition(mod.default);
    assert.equal(mod.default.name, "ralph");
  });

  test("has required 'prompt' input", async () => {
    const mod = await import("../../workflows/ralph.js");
    assert.notEqual(mod.default.inputs["prompt"], undefined);
    assert.equal(mod.default.inputs["prompt"].required, true);
  });

  test("has 'max_iterations' input with numeric default", async () => {
    const mod = await import("../../workflows/ralph.js");
    const schema = mod.default.inputs["max_iterations"];
    assert.notEqual(schema, undefined);
    assert.equal(schema.type, "number");
    const def = (schema as { default?: number }).default;
    assert.equal(typeof def, "number");
    assert.ok(def! > 0);
  });

  test("run completes one iteration when confirm returns false", async () => {
    const mod = await import("../../workflows/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;

    const ctx = makeMockCtx({ prompt: "Build a REST API", max_iterations: 3 });
    // confirm defaults to false → loop exits after first iteration
    const result = await d.run(ctx);

    assert.notEqual(result, undefined);
    assert.equal(typeof result["result"], "string");
    assert.equal(typeof result["plan"], "string");
    assert.equal(typeof result["approved"], "boolean");
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
            prompt: async (_: string) => "APPROVED — task is complete.",
          };
        }
        return sc;
      },
    };

    const result = await d.run(patchedCtx);
    assert.equal(result["approved"], true);
  });

  test("orchestrator prompt receives edited plan and original task context", async () => {
    const mod = await import("../../workflows/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;

    const orchestratorPrompts: string[] = [];
    const ctx = makeMockCtx({ prompt: "test task", max_iterations: 1 });
    const patchedCtx: WorkflowRunContext<Record<string, unknown>> = {
      ...ctx,
      ui: {
        ...ctx.ui,
        editor: async (_initial?: string) => "Edited execution plan",
      },
      stage: (name: string) => {
        const sc = makeStageContext(name);
        return {
          ...sc,
          prompt: async (text: string) => {
            if (name === "plan") return "Initial generated plan";
            if (name.startsWith("orchestrate-")) {
              orchestratorPrompts.push(text);
              return "orchestrated result";
            }
            if (name.startsWith("review-")) return "APPROVED";
            return `[mock-prompt:${name}]`;
          },
        } as StageContext;
      },
    };

    const result = await d.run(patchedCtx);

    assert.equal(orchestratorPrompts.length, 1);
    assert.ok(orchestratorPrompts[0]!.includes("You are an orchestrator agent."));
    assert.ok(
      orchestratorPrompts[0]!.includes(
        "Plan:\nEdited execution plan\n\nTask context: test task",
      ),
    );
    assert.equal(result["approved"], true);
    assert.equal(result["iterations_completed"], 1);
  });

  test("revision feedback can replan and execute the next iteration", async () => {
    const mod = await import("../../workflows/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;

    const orchestratorPrompts: string[] = [];
    const confirmPrompts: string[] = [];
    let replanPrompt = "";

    const ctx = makeMockCtx({ prompt: "test task", max_iterations: 2 });
    const patchedCtx: WorkflowRunContext<Record<string, unknown>> = {
      ...ctx,
      ui: {
        ...ctx.ui,
        editor: async (_initial?: string) => "",
        confirm: async (message: string) => {
          confirmPrompts.push(message);
          return true;
        },
      },
      stage: (name: string) => {
        const sc = makeStageContext(name);
        return {
          ...sc,
          prompt: async (text: string) => {
            if (name === "plan") return "Plan v1";
            if (name === "orchestrate-1") {
              orchestratorPrompts.push(text);
              return "first execution result";
            }
            if (name === "review-1") return "REVISE: cover edge cases";
            if (name === "replan-1") {
              replanPrompt = text;
              return "Plan v2 with edge cases";
            }
            if (name === "orchestrate-2") {
              orchestratorPrompts.push(text);
              return "second execution result";
            }
            if (name === "review-2") return "APPROVED";
            return `[mock-prompt:${name}]`;
          },
        } as StageContext;
      },
    };

    const result = await d.run(patchedCtx);

    assert.equal(orchestratorPrompts.length, 2);
    assert.ok(orchestratorPrompts[0]!.includes("Plan:\nPlan v1\n\nTask context: test task"));
    assert.ok(
      orchestratorPrompts[1]!.includes(
        "Plan:\nPlan v2 with edge cases\n\nTask context: test task",
      ),
    );
    assert.equal(confirmPrompts.length, 1);
    assert.ok(confirmPrompts[0]!.includes("cover edge cases"));
    assert.ok(replanPrompt.includes("Reviewer feedback:\ncover edge cases"));
    assert.equal(result["approved"], true);
    assert.equal(result["iterations_completed"], 2);
    assert.equal(result["plan"], "Plan v2 with edge cases");
  });
});

// ---------------------------------------------------------------------------
// open-claude-design
// ---------------------------------------------------------------------------

describe("open-claude-design", () => {
  test("loads and has correct shape", async () => {
    const mod = await import("../../workflows/open-claude-design.js");
    assertWorkflowDefinition(mod.default);
    assert.equal(mod.default.name, "open-claude-design");
  });

  test("has 'reference', 'output_type', 'design_system' inputs", async () => {
    const mod = await import("../../workflows/open-claude-design.js");
    const d = mod.default;
    assert.notEqual(d.inputs["reference"], undefined);
    assert.notEqual(d.inputs["output_type"], undefined);
    assert.notEqual(d.inputs["design_system"], undefined);
  });

  test("output_type is a select with expected choices", async () => {
    const mod = await import("../../workflows/open-claude-design.js");
    const schema = mod.default.inputs["output_type"];
    assert.equal(schema.type, "select");
    const choices = (schema as { choices: readonly string[] }).choices;
    assert.ok(choices.includes("component"));
    assert.ok(choices.includes("page"));
    assert.ok(choices.includes("theme"));
    assert.ok(choices.includes("tokens"));
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
    assert.notEqual(result, undefined);
    assert.equal(typeof result["artifact"], "string");
    assert.equal(typeof result["handoff"], "string");
    assert.equal(result["output_type"], "component");
  });

  test("run uses default output_type 'component' when not provided", async () => {
    const mod = await import("../../workflows/open-claude-design.js");
    const d = mod.default as unknown as WorkflowDefinition;

    const ctx = makeMockCtx({});
    const result = await d.run(ctx);
    assert.equal(result["output_type"], "component");
  });

  test("definition is frozen (immutable)", async () => {
    const mod = await import("../../workflows/open-claude-design.js");
    const d = mod.default;
    assert.equal(Object.isFrozen(d), true);
    assert.equal(Object.isFrozen(d.inputs), true);
  });
});

// ---------------------------------------------------------------------------
// workflows/index manifest
// ---------------------------------------------------------------------------

describe("workflows/index manifest", () => {
  test("exports all three builtins by name", async () => {
    const mod = await import("../../workflows/index.js");
    assert.notEqual(mod.deepResearchCodebase, undefined);
    assert.notEqual(mod.ralph, undefined);
    assert.notEqual(mod.openClaudeDesign, undefined);

    // Each export is a valid definition
    assertWorkflowDefinition(mod.deepResearchCodebase);
    assertWorkflowDefinition(mod.ralph);
    assertWorkflowDefinition(mod.openClaudeDesign);
  });
});
