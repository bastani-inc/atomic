/**
 * Smoke tests for the three builtin workflows.
 * Validates definition shape, input schema, and that builtins are authored with
 * the high-level ctx.task / ctx.parallel / ctx.chain primitives.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type {
  WorkflowChainOptions,
  WorkflowDefinition,
  WorkflowParallelOptions,
  WorkflowRunContext,
  WorkflowTaskOptions,
  WorkflowTaskResult,
  WorkflowTaskStep,
  WorkflowUIContext,
} from "../../packages/workflows/src/shared/types.js";

interface MockCalls {
  readonly stage: string[];
  readonly task: string[];
  readonly parallel: string[][];
  readonly chain: string[][];
  readonly prompts: Record<string, string[]>;
}

interface MockResponders {
  task?: (name: string, options: WorkflowTaskOptions, calls: MockCalls) => string | undefined;
}

function promptText(options: WorkflowTaskOptions): string {
  return options.prompt ?? options.task ?? "";
}

function makeTaskResult(name: string, text: string): WorkflowTaskResult {
  return { name, stageName: name, text };
}

/** Mock WorkflowRunContext factory that records high-level SDK calls. */
function makeMockCtx<TInputs extends Record<string, unknown>>(
  inputs: TInputs,
  responders: MockResponders = {},
): WorkflowRunContext<TInputs> & { calls: MockCalls } {
  const calls: MockCalls = {
    stage: [],
    task: [],
    parallel: [],
    chain: [],
    prompts: {},
  };

  const ui: WorkflowUIContext = {
    input: async (prompt: string) => `mock-input:${prompt.slice(0, 20)}`,
    confirm: async () => false,
    select: async <T extends string>(_message: string, options: readonly T[]) => options[0]!,
    editor: async (initial?: string) => initial ?? "mock-editor-content",
  };

  const runTask = async (name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult> => {
    calls.task.push(name);
    const text = promptText(options);
    calls.prompts[name] = [...(calls.prompts[name] ?? []), text];
    const override = responders.task?.(name, options, calls);
    return makeTaskResult(name, override ?? `[mock-task:${name}] ${text.slice(0, 80)}`);
  };

  const ctx: WorkflowRunContext<TInputs> & { calls: MockCalls } = {
    inputs,
    calls,
    stage: (name: string) => {
      calls.stage.push(name);
      throw new Error(`ctx.stage should not be used by builtin workflow ${name}`);
    },
    task: runTask,
    chain: async (
      steps: readonly WorkflowTaskStep[],
      _options?: WorkflowChainOptions,
    ): Promise<WorkflowTaskResult[]> => {
      calls.chain.push(steps.map((step) => step.name));
      const results: WorkflowTaskResult[] = [];
      for (const step of steps) {
        results.push(await runTask(step.name, step));
      }
      return results;
    },
    parallel: async (
      steps: readonly WorkflowTaskStep[],
      _options?: WorkflowParallelOptions,
    ): Promise<WorkflowTaskResult[]> => {
      calls.parallel.push(steps.map((step) => step.name));
      return Promise.all(steps.map((step) => runTask(step.name, step)));
    },
    ui,
  };

  return ctx;
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
  test("loads and has correct shape", async () => {
    const mod = await import("../../packages/workflows/builtin/deep-research-codebase.js");
    const def = mod.default as unknown as WorkflowDefinition;
    assertWorkflowDefinition(def);
    assert.equal(def.name, "deep-research-codebase");
    assert.equal(def.normalizedName, "deep-research-codebase");
  });

  test("has prompt and max_partitions inputs", async () => {
    const mod = await import("../../packages/workflows/builtin/deep-research-codebase.js");
    const d = mod.default;
    assert.equal(d.inputs["prompt"]?.required, true);
    assert.match(d.inputs["prompt"]?.type ?? "", /^(text|string)$/);
    assert.equal(d.inputs["max_partitions"]?.type, "number");
    assert.equal((d.inputs["max_partitions"] as { default?: number }).default, 100);
  });

  test("runs scout/history, specialist waves, and aggregator via task primitives", async () => {
    const mod = await import("../../packages/workflows/builtin/deep-research-codebase.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { prompt: "What does the auth module do?", max_partitions: 2 },
      {
        task: (name) => {
          if (name === "partition") return "auth logic\ntoken validation";
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);

    assert.deepEqual(ctx.calls.stage, []);
    assert.ok(ctx.calls.parallel.some((names) => names.includes("codebase-scout") && names.includes("history-locator")));
    assert.deepEqual(ctx.calls.chain[0], ["history-analyzer"]);
    assert.ok(ctx.calls.parallel.some((names) => names.includes("locator-1") && names.includes("pattern-finder-2")));
    assert.ok(ctx.calls.parallel.some((names) => names.includes("analyzer-1") && names.includes("online-researcher-2")));
    assert.ok(ctx.calls.task.includes("aggregator"));
    assert.equal(typeof result["findings"], "string");
    assert.deepEqual(result["partitions"], ["auth logic", "token validation"]);
    assert.equal(result["specialist_count"], 8);
  });
});

// ---------------------------------------------------------------------------
// ralph
// ---------------------------------------------------------------------------

describe("ralph", () => {
  test("loads and has correct shape", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    assertWorkflowDefinition(mod.default);
    assert.equal(mod.default.name, "ralph");
  });

  test("has prompt and max_loops inputs", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    assert.equal(mod.default.inputs["prompt"]?.required, true);
    assert.equal(mod.default.inputs["max_iterations"], undefined);
    assert.equal(mod.default.inputs["max_loops"]?.type, "number");
    assert.equal((mod.default.inputs["max_loops"] as { default?: number }).default, 10);
  });

  test("terminates after one iteration when both reviewers approve", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { prompt: "Refactor tests", max_loops: 5 },
      {
        task: (name) => {
          if (name.startsWith("reviewer-")) return "overall_correctness: patch is correct";
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);

    assert.deepEqual(ctx.calls.stage, []);
    assert.ok(ctx.calls.task.includes("planner-1"));
    assert.ok(ctx.calls.task.includes("orchestrator-1"));
    assert.ok(ctx.calls.task.includes("code-simplifier-1"));
    assert.ok(ctx.calls.parallel.some((names) => names.includes("infra-locate-1") && names.includes("infra-patterns-1")));
    assert.ok(ctx.calls.parallel.some((names) => names.includes("reviewer-1-a") && names.includes("reviewer-1-b")));
    assert.equal(result["approved"], true);
    assert.equal(result["iterations_completed"], 1);
  });

  test("feeds actionable review findings into the next planner iteration", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { prompt: "test task", max_loops: 2 },
      {
        task: (name) => {
          if (name === "reviewer-1-a" || name === "reviewer-1-b") return "ACTIONABLE: cover edge cases";
          if (name === "reviewer-2-a" || name === "reviewer-2-b") return "overall_correctness: patch is correct";
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);

    assert.ok(ctx.calls.task.includes("planner-2"));
    assert.ok(ctx.calls.prompts["planner-2"]?.[0]?.includes("Previous review findings"));
    assert.equal(result["approved"], true);
    assert.equal(result["iterations_completed"], 2);
    assert.match(String(result["review_report"]), /patch is correct/);
  });
});

// ---------------------------------------------------------------------------
// open-claude-design
// ---------------------------------------------------------------------------

describe("open-claude-design", () => {
  test("loads and has correct shape", async () => {
    const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
    assertWorkflowDefinition(mod.default);
    assert.equal(mod.default.name, "open-claude-design");
  });

  test("has design workflow inputs without compatibility aliases", async () => {
    const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
    const d = mod.default;
    for (const inputName of ["prompt", "reference", "output_type", "design_system", "max_refinements"]) {
      assert.notEqual(d.inputs[inputName], undefined, inputName);
    }
    assert.equal(d.inputs["output-type"], undefined);
    assert.equal(d.inputs["design-system"], undefined);
    assert.equal(d.inputs["prompt"]?.required, true);
  });

  test("output_type supports canonical underscore choices", async () => {
    const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
    const schema = mod.default.inputs["output_type"];
    assert.equal(schema.type, "select");
    const choices = (schema as { choices: readonly string[] }).choices;
    for (const choice of ["prototype", "wireframe", "page", "component", "theme", "tokens"]) {
      assert.ok(choices.includes(choice), choice);
    }
    assert.equal((schema as { default?: string }).default, "prototype");
  });

  test("runs onboarding, import, generation, refinement, scan, and export", async () => {
    const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      {
        prompt: "Design a kanban board",
        reference: "https://example.com/reference",
        output_type: "component",
        max_refinements: 2,
      },
      {
        task: (name) => {
          if (name.startsWith("user-feedback-")) return "refinement complete";
          if (name === "pre-export-scan") return "no blocking findings";
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);

    assert.deepEqual(ctx.calls.stage, []);
    assert.ok(ctx.calls.parallel.some((names) => names.includes("ds-locator") && names.includes("ds-patterns")));
    assert.ok(ctx.calls.parallel.some((names) => names.includes("web-capture")));
    assert.ok(ctx.calls.task.includes("design-system-builder"));
    assert.ok(ctx.calls.task.includes("generator"));
    assert.ok(ctx.calls.task.includes("user-feedback-1"));
    assert.ok(ctx.calls.task.includes("pre-export-scan"));
    assert.ok(ctx.calls.task.includes("exporter"));
    assert.equal(result["output_type"], "component");
    assert.equal(typeof result["artifact"], "string");
    assert.equal(typeof result["handoff"], "string");
  });

  test("uses default output_type 'prototype' when not provided", async () => {
    const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { prompt: "Design a dashboard" },
      {
        task: (name) => {
          if (name.startsWith("user-feedback-")) return "refinement complete";
          if (name === "pre-export-scan") return "no blocking findings";
          return undefined;
        },
      },
    );
    const result = await d.run(ctx);
    assert.equal(result["output_type"], "prototype");
  });

  test("browser display prompts bootstrap a missing Playwright browser", async () => {
    const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      {
        prompt: "Design a dashboard",
        reference: "https://example.com/reference",
        design_system: "Use the existing app design system.",
        max_refinements: 1,
      },
      {
        task: (name) => {
          if (name.startsWith("user-feedback-")) return "refinement complete";
          if (name === "pre-export-scan") return "no blocking findings";
          return undefined;
        },
      },
    );

    await d.run(ctx);

    const webCapturePrompt = ctx.calls.prompts["web-capture"]?.[0] ?? "";
    const previewPrompt = ctx.calls.prompts["preview-display-initial"]?.[0] ?? "";
    const finalPrompt = ctx.calls.prompts["final-display"]?.[0] ?? "";
    for (const displayPrompt of [webCapturePrompt, previewPrompt, finalPrompt]) {
      assert.match(displayPrompt, /playwright-cli install-browser chrome-for-testing/);
      assert.match(displayPrompt, /Do not install playwright-cli itself/);
      assert.match(displayPrompt, /missing browser executable/);
    }
  });

  test("definition is frozen (immutable)", async () => {
    const mod = await import("../../packages/workflows/builtin/open-claude-design.js");
    const d = mod.default;
    assert.equal(Object.isFrozen(d), true);
    assert.equal(Object.isFrozen(d.inputs), true);
  });
});

// ---------------------------------------------------------------------------
// builtin/index manifest
// ---------------------------------------------------------------------------

describe("builtin/index manifest", () => {
  test("exports all three builtins by name", async () => {
    const mod = await import("../../packages/workflows/builtin/index.js");
    assert.notEqual(mod.deepResearchCodebase, undefined);
    assert.notEqual(mod.ralph, undefined);
    assert.notEqual(mod.openClaudeDesign, undefined);

    assertWorkflowDefinition(mod.deepResearchCodebase);
    assertWorkflowDefinition(mod.ralph);
    assertWorkflowDefinition(mod.openClaudeDesign);
  });
});
