// @ts-nocheck
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertOutputTypes,
  assertWorkflowDefinition,
  fieldDefault,
  fieldKind,
  fieldRequired,
  makeMockCtx,
} from "./builtin-workflows-helpers.js";

let tempCwd = "";
beforeEach(() => { tempCwd = mkdtempSync(join(tmpdir(), "atomic-pattern-builtins-")); });
afterEach(() => { rmSync(tempCwd, { recursive: true, force: true }); });

function withCwd<T extends object>(ctx: T): T & { cwd: string } {
  return Object.assign(ctx, { cwd: tempCwd });
}

describe("tournament builtin", () => {
  test("declares bounded defaulted inputs and parent-consumable outputs", async () => {
    const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
    assertWorkflowDefinition(definition);
    assert.equal(definition.name, "tournament");
    assert.equal(fieldRequired(definition.inputs.prompt), true);
    assert.equal(fieldKind(definition.inputs.num_attempts), "integer");
    assert.equal(fieldDefault(definition.inputs.num_attempts), 4);
    assert.equal(fieldDefault(definition.inputs.max_concurrency), 4);
    assert.equal(definition.inputs.num_attempts.minimum, 2);
    assert.equal(definition.inputs.num_attempts.maximum, 8);
    assertOutputTypes(definition.outputs, {
      result: "text", winner: "text", winner_artifact_path: "text", result_path: "text",
      attempt_artifact_paths: "array", judge_artifact_paths: "array", bracket_path: "text",
      artifact_dir: "text",
    });
  });

  test("runs attempts, balanced pairwise judges, and an auditable bracket reducer", async () => {
    const { default: definition } = await import("../../packages/workflows/builtin/tournament.js");
    const ctx = withCwd(makeMockCtx({ prompt: "Design a safe migration", num_attempts: 4, max_concurrency: 2 }, {
      task: (name) => name.startsWith("judge-")
        ? JSON.stringify({ winner: "first", rationale: `rubric ${name}`, evidence: ["observable evidence"] })
        : undefined,
    }));
    const output = await definition.run(ctx);
    assert.deepEqual(ctx.calls.parallel[0], ["attempt-1", "attempt-2", "attempt-3", "attempt-4"]);
    assert.ok(ctx.calls.parallel.some((names) => names.includes("judge-round-1-match-1")));
    assert.ok(ctx.calls.parallel.some((names) => names.includes("judge-round-2-match-1")));
    assert.ok(ctx.calls.task.includes("bracket-reducer"));
    const firstJudge = ctx.calls.taskOptions["judge-round-1-match-1"][0];
    const secondJudge = ctx.calls.taskOptions["judge-round-1-match-2"][0];
    assert.match(firstJudge.prompt, /First presentation: attempt-1/);
    assert.match(secondJudge.prompt, /First presentation: attempt-4/);
    assert.equal(firstJudge.context, "fresh");
    assert.equal(firstJudge.reads.length, 2);
    const bracket = JSON.parse(readFileSync(output.bracket_path, "utf8"));
    assert.equal(bracket.matches.length, 3);
    assert.equal(bracket.winner.label, output.winner);
    assert.equal(output.attempt_artifact_paths.length, 4);
    assert.equal(output.judge_artifact_paths.length, 3);
  });
});

describe("loop-until-done builtin", () => {
  test("declares a bounded loop and precise composable output contract", async () => {
    const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
    assertWorkflowDefinition(definition);
    assert.equal(definition.name, "loop-until-done");
    assert.equal(fieldRequired(definition.inputs.prompt), true);
    assert.equal(fieldDefault(definition.inputs.max_iterations), 5);
    assert.equal(definition.inputs.max_iterations.minimum, 1);
    assert.equal(definition.inputs.max_iterations.maximum, 20);
    assertOutputTypes(definition.outputs, {
      result: "text", status: "select", iterations_completed: "integer", ledger_path: "text",
      iteration_artifact_paths: "array", evaluation_artifact_paths: "array", result_path: "text",
      remaining_work: "text", artifact_dir: "text",
    });
  });

  test("persists progress and stops only after an evidence-backed done decision", async () => {
    const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
    const ctx = withCwd(makeMockCtx({ prompt: "Make every check pass", max_iterations: 3 }, {
      task: (name) => {
        if (name === "evaluate-1") return JSON.stringify({ done: false, summary: "one remains", new_findings: ["lint"], failures: ["lint failed"], validation_evidence: ["tests pass"], remaining_work: "fix lint" });
        if (name === "evaluate-2") return JSON.stringify({ done: true, summary: "all pass", new_findings: [], failures: [], validation_evidence: ["tests pass", "lint passes"], remaining_work: "" });
        return undefined;
      },
    }));
    const output = await definition.run(ctx);
    assert.equal(output.status, "complete");
    assert.equal(output.iterations_completed, 2);
    assert.deepEqual(ctx.calls.task.slice(0, 5), ["iteration-1", "evaluate-1", "iteration-2", "evaluate-2", "completion-summary"]);
    assert.equal(ctx.calls.taskOptions["evaluate-1"][0].context, "fresh");
    assert.ok(ctx.calls.taskOptions["iteration-2"][0].reads.includes(output.ledger_path));
    const ledger = JSON.parse(readFileSync(output.ledger_path, "utf8"));
    assert.equal(ledger.status, "complete");
    assert.equal(ledger.entries[0].failures[0], "lint failed");
    assert.deepEqual(ledger.entries[1].validation_evidence, ["tests pass", "lint passes"]);
  });

  test("returns inspectable failed exhaustion with ledger and remaining work", async () => {
    const { default: definition } = await import("../../packages/workflows/builtin/loop-until-done.js");
    const ctx = withCwd(makeMockCtx({ prompt: "Finish safely", max_iterations: 1 }, {
      task: (name) => name === "evaluate-1"
        ? JSON.stringify({ done: false, summary: "not done", new_findings: [], failures: ["check failed"], validation_evidence: [], remaining_work: "repair check" })
        : undefined,
    }));
    const output = await definition.run(ctx);
    assert.equal(output.status, "failed");
    assert.equal(output.remaining_work, "repair check");
    assert.equal(output.result_path, output.ledger_path);
    const ledger = JSON.parse(readFileSync(output.ledger_path, "utf8"));
    assert.equal(ledger.status, "failed");
    assert.equal(ledger.iterations_completed, 1);
  });
});
