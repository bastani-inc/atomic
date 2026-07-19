// @ts-nocheck
import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

describe("builtin reviewer intercom groups", () => {
  let tempCwd: string | undefined;
  afterEach(() => {
    if (tempCwd !== undefined) {
      rmSync(tempCwd, { recursive: true, force: true });
      tempCwd = undefined;
    }
  });

  test("goal reviewers of a turn share a per-turn isolated group", async () => {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { objective: "Finish documentation", max_turns: 1 },
      {
        parallel: () => {
          throw new AggregateError(
            [new Error("reviewer model fallbacks exhausted")],
            "atomic-workflows: reviewer model fallbacks exhausted",
          );
        },
      },
    );

    await d.run(ctx);

    assert.equal(ctx.calls.parallel.length, 1);
    assert.equal(ctx.calls.parallelOptions[0]?.group, "goal-reviewers-turn-1");
  });

  test("ralph reviewers of an iteration share a per-iteration isolated group", async () => {
    tempCwd = mkdtempSync(join(tmpdir(), "ralph-group-"));
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const approvingReview = JSON.stringify({
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "all requirements proven",
      overall_confidence_score: 0.9,
      requirements_traceability: [
        { requirement: "complete requested task", status: "proven", evidence: "state proves the task" },
      ],
      stop_review_loop: true,
      reviewer_error: null,
    });
    const ctx = makeMockCtx(
      { prompt: "Add a small feature", max_loops: 1, base_branch: "main", git_worktree_dir: "", create_pr: false },
      {
        parallel: (steps) =>
          steps.map((step) => ({ name: step.name, stageName: step.name, text: approvingReview })),
      },
    );

    await mod.default.run({ ...ctx, cwd: tempCwd });

    assert.equal(ctx.calls.parallel.length >= 1, true);
    assert.equal(ctx.calls.parallelOptions[0]?.group, "ralph-reviewers-iter-1");
  });
});
