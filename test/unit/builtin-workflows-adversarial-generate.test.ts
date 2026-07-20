import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import adversarialVerification from "../../packages/workflows/builtin/adversarial-verification.js";
import generateAndFilter from "../../packages/workflows/builtin/generate-and-filter.js";
import { assertOutputTypes, assertWorkflowDefinition, fieldDefault, fieldKind, fieldRequired, makeMockCtx, readPaths } from "./builtin-workflows-helpers.js";

async function withTempCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "pattern-workflow-test-"));
  try { return await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

function assignCwd<T extends object>(ctx: T, cwd: string): T {
  Object.defineProperty(ctx, "cwd", { value: cwd, enumerable: true });
  return ctx;
}

test("adversarial-verification declares bounded composable contracts", () => {
  assertWorkflowDefinition(adversarialVerification);
  assert.equal(adversarialVerification.normalizedName, "adversarial-verification");
  assert.equal(fieldKind(adversarialVerification.inputs.task), "text");
  assert.equal(fieldRequired(adversarialVerification.inputs.task), true);
  assert.equal(fieldDefault(adversarialVerification.inputs.verifier_count), 3);
  assert.equal(fieldDefault(adversarialVerification.inputs.max_repairs), 2);
  assert.equal(Reflect.get(adversarialVerification.inputs.verifier_count, "minimum"), 1);
  assert.equal(Reflect.get(adversarialVerification.inputs.verifier_count, "maximum"), 5);
  assert.equal(Reflect.get(adversarialVerification.inputs.max_repairs, "maximum"), 5);
  assertOutputTypes(adversarialVerification.outputs, {
    result: "text", approved: "boolean", repairs_completed: "integer", candidate_path: "text",
    review_report_path: "text", verifier_artifact_paths: "array", artifact_dir: "text", remaining_work: "array",
  });
});

test("adversarial-verification uses fresh evidence verifiers and accepts only through reducer", async () => {
  await withTempCwd(async (cwd) => {
    const ctx = assignCwd(makeMockCtx({ task: "verify this", verifier_count: 2, max_repairs: 1 }, {
      task: (name) => name.startsWith("verifier-")
        ? JSON.stringify({ verdict: "pass", evidence: ["checked"], blocking_findings: [] })
        : name.startsWith("reducer-")
          ? JSON.stringify({ decision: "accept", rationale: "all evidence passed", remaining_work: [] })
          : undefined,
    }), cwd);
    const result = await adversarialVerification.run(ctx);
    assert.equal(result.approved, true);
    assert.equal(result.repairs_completed, 0);
    assert.deepEqual(ctx.calls.parallel, [["verifier-0-1", "verifier-0-2"]]);
    for (const name of ctx.calls.parallel[0]!) {
      const options = ctx.calls.taskOptions[name]?.[0];
      assert.equal(options?.context, "fresh");
      assert.ok(readPaths(options).some((path) => path.endsWith("candidate.md")));
      assert.ok(readPaths(options).some((path) => path.endsWith("rubric.md")));
      assert.notEqual(options?.schema, undefined);
    }
    assert.ok(readPaths(ctx.calls.taskOptions["reducer-0"]?.[0]).some((path) => path.includes("verification-0-1")));
  });
});

test("adversarial-verification bounds repair and returns inspectable rejection", async () => {
  await withTempCwd(async (cwd) => {
    const ctx = assignCwd(makeMockCtx({ task: "repair this", verifier_count: 1, max_repairs: 1 }, {
      task: (name) => name.startsWith("verifier-")
        ? JSON.stringify({ verdict: "fail", evidence: [], blocking_findings: ["missing test"] })
        : name.startsWith("reducer-")
          ? JSON.stringify({ decision: "repair", rationale: "repair required", remaining_work: ["missing test"] })
          : undefined,
    }), cwd);
    const result = await adversarialVerification.run(ctx);
    assert.equal(result.approved, false);
    assert.equal(result.repairs_completed, 1);
    assert.deepEqual(ctx.calls.parallel, [["verifier-0-1"], ["verifier-1-1"]]);
    assert.ok(ctx.calls.task.includes("repair-1"));
    assert.deepEqual(result.remaining_work, ["missing test"]);
  });
});

test("generate-and-filter declares bounded composable contracts", () => {
  assertWorkflowDefinition(generateAndFilter);
  assert.equal(generateAndFilter.normalizedName, "generate-and-filter");
  assert.equal(fieldKind(generateAndFilter.inputs.prompt), "text");
  assert.equal(fieldRequired(generateAndFilter.inputs.prompt), true);
  assert.equal(fieldDefault(generateAndFilter.inputs.num_candidates), 8);
  assert.equal(fieldDefault(generateAndFilter.inputs.shortlist_size), 3);
  assert.equal(fieldDefault(generateAndFilter.inputs.use_judge), true);
  assert.equal(fieldDefault(generateAndFilter.inputs.max_concurrency), 4);
  assert.equal(Reflect.get(generateAndFilter.inputs.num_candidates, "minimum"), 2);
  assert.equal(Reflect.get(generateAndFilter.inputs.num_candidates, "maximum"), 20);
  assert.equal(Reflect.get(generateAndFilter.inputs.shortlist_size, "maximum"), 10);
  assertOutputTypes(generateAndFilter.outputs, {
    result: "text", shortlist: "array", candidate_artifact_paths: "array", filter_path: "text",
    judge_path: "unknown", final_path: "text", artifact_dir: "text", manifest_path: "text",
  });
});

test("generate-and-filter fans out, dedupes, optionally judges, and finalizes artifact shortlist", async () => {
  await withTempCwd(async (cwd) => {
    const ctx = assignCwd(makeMockCtx({ prompt: "generate options", num_candidates: 3, shortlist_size: 2, use_judge: true, max_concurrency: 2 }, {
      task: (name, options) => name === "dedupe-and-filter"
        ? JSON.stringify({ shortlist: readPaths(options).filter((path) => path.endsWith(".md")).slice(0, 2), discarded: [] })
        : name === "judge"
          ? JSON.stringify({ shortlist: readPaths(options).filter((path) => path.includes("candidate-")), rationale: "ranked" })
          : undefined,
    }), cwd);
    const originalTask = ctx.task.bind(ctx);
    Object.defineProperty(ctx, "task", {
      value: async (name: string, options: Parameters<typeof ctx.task>[1]) => {
        const taskResult = await originalTask(name, options);
        return name === "final-shortlist"
          ? { ...taskResult, text: `Saved output to ${String(options.output)}` }
          : taskResult;
      },
    });
    const result = await generateAndFilter.run(ctx);
    assert.deepEqual(ctx.calls.parallel, [["generate-1", "generate-2", "generate-3"]]);
    assert.equal(ctx.calls.parallelOptions[0]?.concurrency, 2);
    assert.deepEqual(ctx.calls.task.slice(-3), ["dedupe-and-filter", "judge", "final-shortlist"]);
    assert.equal(result.shortlist.length, 2);
    assert.match(result.result, /\[mock-task:final-shortlist\]/);
    assert.doesNotMatch(result.result, /Saved output to/);
    assert.ok(readPaths(ctx.calls.taskOptions["dedupe-and-filter"]?.[0]).some((path) => path.endsWith("manifest.json")));
    assert.ok(readPaths(ctx.calls.taskOptions.judge?.[0]).some((path) => path.endsWith("filter.json")));
    assert.ok(readPaths(ctx.calls.taskOptions["final-shortlist"]?.[0]).some((path) => path.endsWith("judge.json")));
  });
});

test("generate-and-filter skips judge when disabled", async () => {
  await withTempCwd(async (cwd) => {
    const ctx = assignCwd(makeMockCtx({ prompt: "generate options", num_candidates: 2, shortlist_size: 1, use_judge: false, max_concurrency: 1 }), cwd);
    const result = await generateAndFilter.run(ctx);
    assert.equal(result.judge_path, null);
    assert.equal(ctx.calls.task.includes("judge"), false);
    assert.ok(readPaths(ctx.calls.taskOptions["final-shortlist"]?.[0]).some((path) => path.endsWith("filter.json")));
  });
});
