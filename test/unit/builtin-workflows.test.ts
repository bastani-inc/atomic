/**
 * Smoke tests for the three builtin workflows.
 * Validates definition shape, input schema, and that builtins are authored with
 * the high-level ctx.task / ctx.parallel / ctx.chain primitives.
 */

import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  readonly parallelOptions: WorkflowParallelOptions[];
  readonly chain: string[][];
  readonly prompts: Record<string, string[]>;
  readonly taskOptions: Record<string, WorkflowTaskOptions[]>;
}

interface MockResponders {
  task?: (name: string, options: WorkflowTaskOptions, calls: MockCalls) => string | undefined;
  omitParallelResults?: readonly string[];
  skipOutputWrites?: readonly string[];
}

function promptText(options: WorkflowTaskOptions): string {
  return options.prompt ?? options.task ?? "";
}

function makeTaskResult(name: string, text: string): WorkflowTaskResult {
  return { name, stageName: name, text };
}

function readPaths(options: WorkflowTaskOptions | undefined): readonly string[] {
  return Array.isArray(options?.reads) ? options.reads : [];
}

function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

function readPathEndsWith(
  options: WorkflowTaskOptions | undefined,
  suffix: string,
): boolean {
  const normalizedSuffix = normalizePathSeparators(suffix);
  return readPaths(options).some((path) =>
    normalizePathSeparators(path).endsWith(normalizedSuffix),
  );
}

function expectedDeepResearchArtifactCount(partitions: readonly unknown[]): number {
  const fixedArtifacts = 3;
  const artifactsPerPartition = 4;
  const aggregateHandoffArtifacts = 1;
  return fixedArtifacts + partitions.length * artifactsPerPartition + aggregateHandoffArtifacts;
}

function assertStringOutput(
  output: WorkflowTaskOptions["output"] | undefined,
): asserts output is string {
  assert.equal(typeof output, "string");
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
    parallelOptions: [],
    chain: [],
    prompts: {},
    taskOptions: {},
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
    calls.taskOptions[name] = [...(calls.taskOptions[name] ?? []), options];
    const override = responders.task?.(name, options, calls);
    const resultText = override ?? `[mock-task:${name}] ${text.slice(0, 80)}`;
    if (
      typeof options.output === "string" &&
      responders.skipOutputWrites?.includes(name) !== true
    ) {
      mkdirSync(dirname(options.output), { recursive: true });
      writeFileSync(options.output, resultText);
    }
    return makeTaskResult(name, resultText);
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
      options: WorkflowParallelOptions = {},
    ): Promise<WorkflowTaskResult[]> => {
      calls.parallel.push(steps.map((step) => step.name));
      calls.parallelOptions.push(options);
      const results = await Promise.all(steps.map((step) => runTask(step.name, step)));
      const omitted = new Set(responders.omitParallelResults ?? []);
      return omitted.size === 0
        ? results
        : results.filter((result) => result.name === undefined || !omitted.has(result.name));
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
  let previousCwd = process.cwd();
  let tempCwd: string | undefined;

  beforeEach(() => {
    previousCwd = process.cwd();
    tempCwd = mkdtempSync(join(tmpdir(), "atomic-deep-research-test-"));
    process.chdir(tempCwd);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (tempCwd !== undefined) {
      rmSync(tempCwd, { recursive: true, force: true });
      tempCwd = undefined;
    }
  });
  test("loads and has correct shape", async () => {
    const mod = await import("../../packages/workflows/builtin/deep-research-codebase.js");
    const def = mod.default as unknown as WorkflowDefinition;
    assertWorkflowDefinition(def);
    assert.equal(def.name, "deep-research-codebase");
    assert.equal(def.normalizedName, "deep-research-codebase");
  });

  test("has prompt, max_partitions, and max_concurrency inputs", async () => {
    const mod = await import("../../packages/workflows/builtin/deep-research-codebase.js");
    const d = mod.default;
    assert.equal(d.inputs["prompt"]?.required, true);
    assert.match(d.inputs["prompt"]?.type ?? "", /^(text|string)$/);
    assert.equal(d.inputs["max_partitions"]?.type, "number");
    assert.equal((d.inputs["max_partitions"] as { default?: number }).default, 100);
    assert.equal(d.inputs["max_concurrency"]?.type, "number");
    assert.equal((d.inputs["max_concurrency"] as { default?: number }).default, 4);
    assert.match(d.inputs["output_path"]?.type ?? "", /^(text|string)$/);
  });

  test("runs scout/history, specialist waves, and aggregator via task primitives", async () => {
    const mod = await import("../../packages/workflows/builtin/deep-research-codebase.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { prompt: "What does the auth module do?", max_partitions: 2, max_concurrency: 2 },
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
    assert.ok(ctx.calls.parallelOptions.every((options) => options.concurrency === 2));
    assert.ok(ctx.calls.task.includes("aggregator"));
    assert.equal(typeof result["findings"], "string");
    assert.deepEqual(result["partitions"], ["auth logic", "token validation"]);
    assert.equal(result["specialist_count"], 8);
    assert.equal(result["max_concurrency"], 2);
    assert.equal("artifact_root" in result, false);
    assert.equal("artifact_count" in result, false);
    assert.equal(typeof result["research_doc_path"], "string");
  });

  test("uses artifact handoffs so aggregation stays bounded", async () => {
    const mod = await import("../../packages/workflows/builtin/deep-research-codebase.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const largeSentinel = "SPECIALIST_INLINE_SENTINEL".repeat(200);
    const ctx = makeMockCtx(
      { prompt: "Trace auth behavior", max_partitions: 2, max_concurrency: 2 },
      {
        task: (name) => {
          if (name === "partition") return "auth logic\ntoken validation";
          if (/^(locator|pattern-finder|analyzer|online-researcher)-/.test(name)) {
            return `${name}: ${largeSentinel}`;
          }
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);
    const aggregatorOptions = ctx.calls.taskOptions["aggregator"]?.[0];
    const aggregatorPrompt = ctx.calls.prompts["aggregator"]?.[0] ?? "";
    const normalizedAggregatorPrompt = normalizePathSeparators(aggregatorPrompt);
    const aggregatorReads = readPaths(aggregatorOptions);

    assert.deepEqual(result["partitions"], ["auth logic", "token validation"]);
    assert.equal(aggregatorOptions?.previous, undefined);
    assert.ok(Array.isArray(aggregatorOptions?.reads));
    assert.equal(
      aggregatorReads.length,
      expectedDeepResearchArtifactCount(result["partitions"] as readonly unknown[]),
    );
    assert.match(normalizedAggregatorPrompt, /specialist_reports/);
    assert.match(normalizedAggregatorPrompt, /03-specialist-reports\.md/);
    assert.match(normalizedAggregatorPrompt, /Read the complete specialist report artifact/);
    assert.doesNotMatch(normalizedAggregatorPrompt, /artifact_index/);
    assert.doesNotMatch(normalizedAggregatorPrompt, /SPECIALIST_INLINE_SENTINEL/);
    assert.doesNotMatch(normalizedAggregatorPrompt, /Context:/);
    assert.ok(aggregatorReads.some((path) => normalizePathSeparators(path).endsWith("03-specialist-reports.md")));

    const scoutOutput = ctx.calls.taskOptions["codebase-scout"]?.[0];
    const historyLocatorOutput = ctx.calls.taskOptions["history-locator"]?.[0];
    const historyAnalyzerOutput = ctx.calls.taskOptions["history-analyzer"]?.[0];
    assert.equal(scoutOutput?.outputMode, "file-only");
    assert.equal(historyLocatorOutput?.outputMode, "file-only");
    assert.equal(historyAnalyzerOutput?.outputMode, "file-only");
    assert.notEqual(scoutOutput?.output, historyLocatorOutput?.output);

    assert.equal(ctx.calls.taskOptions["partition"]?.[0]?.outputMode, undefined);
    assert.ok(readPathEndsWith(ctx.calls.taskOptions["partition"]?.[0], "00-codebase-scout.md"));
    assert.ok(readPathEndsWith(ctx.calls.taskOptions["locator-1"]?.[0], "00-codebase-scout.md"));
    assert.ok(readPathEndsWith(ctx.calls.taskOptions["analyzer-1"]?.[0], "00-codebase-scout.md"));
    assert.ok(readPathEndsWith(ctx.calls.taskOptions["analyzer-1"]?.[0], "wave1/locator-1.md"));
    assert.ok(readPathEndsWith(ctx.calls.taskOptions["online-researcher-1"]?.[0], "wave1/locator-1.md"));
    assert.equal(ctx.calls.taskOptions["locator-1"]?.[0]?.outputMode, "file-only");
    assert.equal(ctx.calls.taskOptions["analyzer-1"]?.[0]?.outputMode, "file-only");
  });

  test("does not use a saved-output reference when history artifact is unavailable", async () => {
    const mod = await import("../../packages/workflows/builtin/deep-research-codebase.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { prompt: "Trace auth behavior", max_partitions: 1, max_concurrency: 1 },
      {
        skipOutputWrites: ["history-analyzer"],
        task: (name) => {
          if (name === "partition") return "auth logic";
          if (name === "history-analyzer") {
            return "Output saved to: /tmp/history-analyzer.md (123 bytes). Read this file if needed.";
          }
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);
    const aggregatorPrompt = ctx.calls.prompts["aggregator"]?.[0] ?? "";

    assert.doesNotMatch(aggregatorPrompt, /Output saved to:/);
    assert.match(aggregatorPrompt, /\(no prior research found\)/);
    assert.equal(result["history"], "");
  });

  test("falls back to scout context when a wave1 locator result is missing", async () => {
    const mod = await import("../../packages/workflows/builtin/deep-research-codebase.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { prompt: "Trace auth behavior", max_partitions: 1, max_concurrency: 1 },
      {
        omitParallelResults: ["locator-1"],
        task: (name) => {
          if (name === "partition") return "auth logic";
          return undefined;
        },
      },
    );

    await d.run(ctx);

    const analyzerOptions = ctx.calls.taskOptions["analyzer-1"]?.[0];
    const onlineOptions = ctx.calls.taskOptions["online-researcher-1"]?.[0];
    const normalizedAnalyzerPrompt = normalizePathSeparators(ctx.calls.prompts["analyzer-1"]?.[0] ?? "");
    const normalizedOnlinePrompt = normalizePathSeparators(ctx.calls.prompts["online-researcher-1"]?.[0] ?? "");

    assert.equal(readPaths(analyzerOptions).length, 1);
    assert.ok(readPathEndsWith(analyzerOptions, "00-codebase-scout.md"));
    assert.equal(readPathEndsWith(analyzerOptions, "wave1/locator-1.md"), false);
    assert.doesNotMatch(normalizedAnalyzerPrompt, /wave1\/locator-1\.md/);

    assert.equal(readPaths(onlineOptions).length, 1);
    assert.ok(readPathEndsWith(onlineOptions, "00-codebase-scout.md"));
    assert.equal(readPathEndsWith(onlineOptions, "wave1/locator-1.md"), false);
    assert.match(normalizedOnlinePrompt, /Read scout context before researching/);
    assert.doesNotMatch(normalizedOnlinePrompt, /wave1\/locator-1\.md/);
  });

  test("keeps artifact handoffs available to the aggregator, then removes them", async () => {
    const mod = await import("../../packages/workflows/builtin/deep-research-codebase.js");
    const d = mod.default as unknown as WorkflowDefinition;
    let aggregatorReadPaths: readonly string[] = [];
    const ctx = makeMockCtx(
      { prompt: "Trace auth behavior", max_partitions: 1, max_concurrency: 1 },
      {
        task: (name, options) => {
          if (name === "partition") return "auth logic";
          if (name === "aggregator") {
            aggregatorReadPaths = readPaths(options);
            assert.ok(aggregatorReadPaths.length > 0);
            for (const path of aggregatorReadPaths) {
              assert.equal(existsSync(path), true, `expected aggregator read path to exist: ${path}`);
            }
            return "final synthesized findings";
          }
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);

    assert.equal(result["findings"], "final synthesized findings");
    assert.equal(typeof result["research_doc_path"], "string");
    assert.equal(readFileSync(result["research_doc_path"] as string, "utf8"), "final synthesized findings");
    assert.ok(aggregatorReadPaths.length > 0);
    for (const path of aggregatorReadPaths) {
      assert.equal(existsSync(path), false, `expected handoff artifact to be cleaned up: ${path}`);
    }

    const scoutOutput = ctx.calls.taskOptions["codebase-scout"]?.[0]?.output;
    assertStringOutput(scoutOutput);
    assert.equal(existsSync(dirname(scoutOutput)), false);
  });

  test("does not overwrite an existing default research document", async () => {
    const mod = await import("../../packages/workflows/builtin/deep-research-codebase.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const date = new Date().toISOString().slice(0, 10);
    const existingPath = join("research", "docs", `${date}-trace-auth-behavior.md`);
    mkdirSync(dirname(existingPath), { recursive: true });
    writeFileSync(existingPath, "existing research", "utf8");
    const ctx = makeMockCtx(
      { prompt: "Trace auth behavior", max_partitions: 1, max_concurrency: 1 },
      {
        task: (name) => {
          if (name === "partition") return "auth logic";
          if (name === "aggregator") return "final synthesized findings";
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);
    const researchDocPath = result["research_doc_path"];

    assert.equal(readFileSync(existingPath, "utf8"), "existing research");
    assert.ok(typeof researchDocPath === "string");
    assert.ok(normalizePathSeparators(researchDocPath).endsWith(`${date}-trace-auth-behavior-2.md`));
    assert.equal(readFileSync(researchDocPath, "utf8"), "final synthesized findings");
  });

  test("removes temporary artifact handoff directory after aggregation failure", async () => {
    const mod = await import("../../packages/workflows/builtin/deep-research-codebase.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { prompt: "Trace auth behavior", max_partitions: 1, max_concurrency: 1 },
      {
        task: (name) => {
          if (name === "partition") return "auth logic";
          if (name === "aggregator") throw new Error("aggregation failed");
          return undefined;
        },
      },
    );

    await assert.rejects(() => d.run(ctx), /aggregation failed/);

    const scoutOutput = ctx.calls.taskOptions["codebase-scout"]?.[0]?.output;
    assertStringOutput(scoutOutput);
    assert.equal(existsSync(dirname(scoutOutput)), false);
  });
});

// ---------------------------------------------------------------------------
// ralph
// ---------------------------------------------------------------------------

describe("ralph", () => {
  function approvedReviewJson(): string {
    return JSON.stringify({
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "No actionable findings remain.",
      overall_confidence_score: 0.9,
      stop_review_loop: true,
      reviewer_error: null,
    });
  }

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
          if (name.startsWith("reviewer-")) return approvedReviewJson();
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);

    assert.deepEqual(ctx.calls.stage, []);
    assert.ok(ctx.calls.task.includes("planner-1"));
    const plannerPrompt = ctx.calls.prompts["planner-1"]?.[0] ?? "";
    assert.match(plannerPrompt, /investigation-first RFC authoring/);
    assert.match(plannerPrompt, /report after investigation, not a substitute/);
    assert.ok(ctx.calls.task.includes("orchestrator-1"));
    const orchestratorPrompt = ctx.calls.prompts["orchestrator-1"]?.[0] ?? "";
    assert.match(orchestratorPrompt, /not the implementer/);
    assert.match(orchestratorPrompt, /completion report, not the task itself/);
    assert.match(orchestratorPrompt, /Use the `todo` tool as your active control ledger/);
    assert.match(orchestratorPrompt, /After subagents have done the work/);
    assert.ok(ctx.calls.task.includes("code-simplifier-1"));
    const simplifierPrompt = ctx.calls.prompts["code-simplifier-1"]?.[0] ?? "";
    assert.match(simplifierPrompt, /active code-refinement stage, not just a commentary stage/);
    assert.match(simplifierPrompt, /edits actually applied from observations only/);
    assert.ok(ctx.calls.parallel.some((names) => names.includes("infra-locate-1") && names.includes("infra-patterns-1")));
    const locatePrompt = ctx.calls.prompts["infra-locate-1"]?.[0] ?? "";
    assert.match(locatePrompt, /repository-discovery stage/);
    assert.match(locatePrompt, /not a substitute for discovery/);
    const analyzePrompt = ctx.calls.prompts["infra-analyze-1"]?.[0] ?? "";
    assert.match(analyzePrompt, /actual repository coupling, not generic integration risks/);
    assert.match(analyzePrompt, /Copy validation commands from actual repository scripts/);
    const patternsPrompt = ctx.calls.prompts["infra-patterns-1"]?.[0] ?? "";
    assert.match(patternsPrompt, /evidence-gathering stage for repository conventions/);
    assert.match(patternsPrompt, /Do not describe generic best practices/);
    assert.ok(ctx.calls.parallel.some((names) => names.includes("reviewer-1-a") && names.includes("reviewer-1-b")));
    const reviewerPrompt = ctx.calls.prompts["reviewer-1-a"]?.[0] ?? "";
    assert.match(reviewerPrompt, /grumpy senior developer/);
    assert.match(reviewerPrompt, /download or install them/);
    assert.match(reviewerPrompt, /only valid after you inspect the actual repository state/);
    assert.match(reviewerPrompt, /parsing the JSON object returned by this tool/);
    const reviewerOptions = ctx.calls.taskOptions["reviewer-1-a"]?.[0];
    assert.ok(reviewerOptions?.customTools?.some((tool) => tool.name === "review_decision"));
    assert.equal(ctx.calls.parallelOptions.at(-1)?.failFast, false);
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
          if (name === "reviewer-1-a" || name === "reviewer-1-b") {
            return JSON.stringify({
              findings: [
                {
                  title: "[P2] Cover edge cases",
                  body: "This scenario still lacks coverage for the changed behavior.",
                  confidence_score: 0.8,
                  priority: 2,
                  code_location: {
                    absolute_file_path: "/tmp/example.test.ts",
                    line_range: { start: 1, end: 1 },
                  },
                },
              ],
              overall_correctness: "patch is incorrect",
              overall_explanation: "Actionable findings remain.",
              overall_confidence_score: 0.8,
              stop_review_loop: false,
              reviewer_error: null,
            });
          }
          if (name === "reviewer-2-a" || name === "reviewer-2-b") return approvedReviewJson();
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

  test("does not approve reviewer output unless the structured object parses", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { prompt: "test task", max_loops: 1 },
      {
        task: (name) => {
          if (name.startsWith("reviewer-")) return "overall_correctness: patch is correct";
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);

    assert.equal(result["approved"], false);
    assert.equal(result["iterations_completed"], 1);
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
