// @ts-nocheck
import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertOutputTypes,
  assertWorkflowDefinition,
  fieldDefault,
  fieldRequired,
  makeMockCtx,
  readPaths,
} from "./builtin-workflows-helpers.js";

const tempDirs: string[] = [];
function tempCwd(): string {
  const path = mkdtempSync(join(tmpdir(), "atomic-pattern-builtin-"));
  tempDirs.push(path);
  return path;
}
afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("classify-and-act builtin", () => {
  test("declares composable typed inputs and outputs", async () => {
    const { default: definition } = await import("../../packages/workflows/builtin/classify-and-act.js");
    assertWorkflowDefinition(definition);
    assert.equal(definition.name, "classify-and-act");
    assert.equal(fieldRequired(definition.inputs.prompt), true);
    assert.deepEqual(fieldDefault(definition.inputs.categories), ["analysis", "implementation", "research"]);
    assert.equal(fieldDefault(definition.inputs.confidence_threshold), 0.75);
    assertOutputTypes(definition.outputs, {
      result: "text", category: "text", confidence: "number", action: "text",
      classification_path: "text", action_path: "text", artifact_dir: "text",
    });
  });

  test("uses structured classification, low-confidence fallback, and an isolated artifact-backed action", async () => {
    const { default: definition } = await import("../../packages/workflows/builtin/classify-and-act.js");
    const ctx = makeMockCtx({
      prompt: "Investigate and maybe change the parser",
      categories: ["analysis", "implementation"],
      confidence_threshold: 0.8,
    }, {
      task: (name) => name === "classifier"
        ? JSON.stringify({ category: "implementation", confidence: 0.4, rationale: "ambiguous" })
        : undefined,
    });
    ctx.cwd = tempCwd();
    const result = await definition.run(ctx);
    assert.deepEqual(ctx.calls.task, ["classifier", "action-analysis"]);
    assert.ok(ctx.calls.taskOptions.classifier[0].schema);
    assert.equal(ctx.calls.taskOptions["action-analysis"][0].context, "fresh");
    assert.deepEqual(readPaths(ctx.calls.taskOptions["action-analysis"][0]), [result.classification_path]);
    const classification = JSON.parse(readFileSync(result.classification_path, "utf8"));
    assert.equal(classification.fallback_used, true);
    assert.equal(result.category, "analysis");
  });
});

describe("fan-out-and-synthesize builtin", () => {
  test("declares bounded defaulted inputs and parent-consumable outputs", async () => {
    const { default: definition } = await import("../../packages/workflows/builtin/fan-out-and-synthesize.js");
    assertWorkflowDefinition(definition);
    assert.equal(definition.name, "fan-out-and-synthesize");
    assert.equal(fieldRequired(definition.inputs.prompt), true);
    assert.equal(fieldDefault(definition.inputs.max_branches), 4);
    assert.equal(fieldDefault(definition.inputs.max_concurrency), 4);
    assertOutputTypes(definition.outputs, {
      result: "text", partitions: "array", branch_artifact_paths: "array",
      synthesis_path: "text", artifact_dir: "text", manifest_path: "text",
    });
  });

  test("partitions, fans out with separate artifacts, and synthesizes after a reads barrier", async () => {
    const { default: definition } = await import("../../packages/workflows/builtin/fan-out-and-synthesize.js");
    const ctx = makeMockCtx({ prompt: "Audit the subsystem", max_branches: 3, max_concurrency: 2 }, {
      task: (name) => name === "partition" ? JSON.stringify({ partitions: [
        { label: "runtime", objective: "Inspect runtime behavior" },
        { label: "tests", objective: "Inspect test coverage" },
      ] }) : undefined,
    });
    ctx.cwd = tempCwd();
    const result = await definition.run(ctx);
    assert.deepEqual(ctx.calls.parallel[0], ["branch-01-runtime", "branch-02-tests"]);
    assert.equal(ctx.calls.parallelOptions[0].concurrency, 2);
    assert.equal(ctx.calls.parallelOptions[0].failFast, false);
    assert.equal(new Set(result.branch_artifact_paths).size, 2);
    const synthesisOptions = ctx.calls.taskOptions.synthesize[0];
    assert.deepEqual(readPaths(synthesisOptions), [result.manifest_path, ...result.branch_artifact_paths]);
    const manifest = JSON.parse(readFileSync(result.manifest_path, "utf8"));
    assert.equal(manifest.branches.length, 2);
    assert.match(ctx.calls.prompts.synthesize[0], /Deduplicate|deduplicate/);
    assert.match(ctx.calls.prompts.synthesize[0], /conflict/i);
    assert.match(ctx.calls.prompts.synthesize[0], /cite/i);
  });
});
