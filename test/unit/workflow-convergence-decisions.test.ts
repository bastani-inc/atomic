// @ts-nocheck
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

function goalReview(decision: "complete" | "continue" = "complete"): string {
  return JSON.stringify({
    findings: decision === "complete" ? [] : [finding(1)],
    overall_correctness: decision === "complete" ? "patch is correct" : "patch is incorrect",
    overall_explanation: decision === "complete" ? "all requirements proven" : "blocking work remains",
    overall_confidence_score: 0.9,
    goal_oracle_satisfied: decision === "complete",
    requirements_traceability: [
      {
        requirement: "ship objective",
        status: decision === "complete" ? "proven" : "missing",
        evidence: decision === "complete" ? "ledger evidence" : "missing evidence",
      },
    ],
    receipt_assessment: "receipt inspected",
    verification_remaining: decision === "complete" ? "none" : "blocking work remains",
    stop_review_loop: decision === "complete",
    reviewer_error: null,
  });
}

function goalReviewWithOnlyFinalPrRemaining(): string {
  const payload = JSON.parse(goalReview("complete"));
  payload.requirements_traceability = [
    {
      requirement: "implementation acceptance criteria",
      status: "proven",
      evidence: "current state proves the implementation work",
    },
    {
      requirement: "create a pull request",
      status: "missing",
      evidence: "PR creation is reserved for the final pull-request stage",
    },
  ];
  payload.verification_remaining = "Only final pull-request handoff remains.";
  return JSON.stringify(payload);
}

function ralphReview(decision: "complete" | "continue" = "complete"): string {
  return JSON.stringify({
    findings: decision === "complete" ? [] : [finding(1)],
    overall_correctness: decision === "complete" ? "patch is correct" : "patch is incorrect",
    overall_explanation: decision === "complete" ? "all requirements proven" : "blocking work remains",
    overall_confidence_score: 0.9,
    requirements_traceability: [
      {
        requirement: "ship objective",
        status: decision === "complete" ? "proven" : "missing",
        evidence: decision === "complete" ? "current state proves it" : "missing evidence",
      },
    ],
    stop_review_loop: decision === "complete",
    reviewer_error: null,
  });
}

function ralphReviewWithOnlyFinalPrRemaining(): string {
  const payload = JSON.parse(ralphReview("complete"));
  payload.requirements_traceability = [
    {
      requirement: "implementation acceptance criteria",
      status: "proven",
      evidence: "current state proves the implementation work",
    },
    {
      requirement: "create a pull request",
      status: "missing",
      evidence: "PR creation is reserved for the final pull-request stage",
    },
  ];
  return JSON.stringify(payload);
}

function finding(priority: number) {
  return {
    title: `[P${priority}] blocking finding`,
    body: "objective-required work remains",
    confidence_score: 0.9,
    objective_alignment: "required_by_objective",
    priority,
    code_location: {
      absolute_file_path: join(process.cwd(), "changed.ts"),
      line_range: { start: 1, end: 1 },
    },
  };
}

function schemaFailure(): AggregateError {
  return new AggregateError(
    [new Error("atomic-workflows: stage configured with schema must finish by calling structured_output.")],
    "atomic-workflows: 1 parallel steps failed",
  );
}

describe("goal convergence decision artifacts", () => {
  test("records explicit success convergence and goes directly to PR handoff", async () => {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { objective: "Ship convergence", create_pr: true },
      { task: (name) => name.includes("reviewer") ? goalReview("complete") : undefined },
    );

    const result = await d.run(ctx);
    const ledger = JSON.parse(readFileSync(result["ledger_path"] as string, "utf8"));

    assert.equal(result["status"], "complete");
    assert.equal(ctx.calls.task.includes("orchestrator-2"), false);
    assert.equal(ctx.calls.task.includes("pull-request"), true);
    assert.deepEqual(ledger.decisions[0].diagnostics, []);
    assert.equal(ledger.decisions[0].parsed, true);
    assert.equal(ledger.decisions[0].approved, true);
    assert.equal(ledger.decisions[0].stopReviewLoop, true);
    assert.equal(ledger.decisions[0].nextAction, "pull-request");
  });

  test("treats PR-only remainder as final action after Goal approval", async () => {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { objective: "Ship convergence and create a pull request", create_pr: true, max_turns: 2 },
      { task: (name) => name.includes("reviewer") ? goalReviewWithOnlyFinalPrRemaining() : undefined },
    );

    const result = await d.run(ctx);
    const ledger = JSON.parse(readFileSync(result["ledger_path"] as string, "utf8"));

    assert.equal(result["status"], "complete");
    assert.equal(ctx.calls.task.includes("orchestrator-2"), false);
    assert.equal(ctx.calls.task.includes("pull-request"), true);
    assert.equal(ledger.reviews[0].convergence_decision.finalActionRemaining, true);
    assert.equal(ledger.reviews[0].convergence_decision.nextAction, "pull-request");
    assert.equal(ledger.decisions[0].approved, true);
    assert.equal(ledger.decisions[0].finalActionRemaining, true);
    assert.equal(ledger.decisions[0].nextAction, "pull-request");
  });

  test("records rejection as parsed and malformed reviewer output as parse failure", async () => {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { objective: "Ship convergence", max_turns: 1 },
      {
        task: (name) => {
          if (name.startsWith("completion-reviewer-")) return "not json";
          if (name.includes("reviewer")) return goalReview("continue");
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);
    const ledger = JSON.parse(readFileSync(result["ledger_path"] as string, "utf8"));
    const parseFailure = ledger.reviews.find((review) => review.parsed === false);
    const rejection = ledger.reviews.find((review) => review.parsed === true);

    assert.equal(result["status"], "needs_human");
    assert.match(parseFailure.parse_diagnostics[0], /parse failed/i);
    assert.match(parseFailure.reviewer_error.message, /parse failed/i);
    assert.equal(rejection.convergence_decision.approved, false);
    assert.deepEqual(rejection.parse_diagnostics, []);
    assert.equal(ledger.decisions[0].parsed, false);
    assert.equal(ledger.decisions[0].approved, false);
    assert.equal(ledger.decisions[0].nextAction, "needs_human");
  });

  test("records thrown schema-backed reviewer failure as parse failure", async () => {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { objective: "Ship convergence", max_turns: 1 },
      { parallel: () => { throw schemaFailure(); } },
    );

    const result = await d.run(ctx);
    const ledger = JSON.parse(readFileSync(result["ledger_path"] as string, "utf8"));
    const parseFailure = ledger.reviews[0];

    assert.equal(result["status"], "needs_human");
    assert.equal(parseFailure.parsed, false);
    assert.equal(parseFailure.convergence_decision.parsed, false);
    assert.match(parseFailure.parse_diagnostics.join("\n"), /structured_output/);
    assert.match(parseFailure.reviewer_error.message, /structured_output/);
    assert.equal(ledger.decisions[0].parsed, false);
    assert.match(ledger.decisions[0].diagnostics.join("\n"), /structured_output/);
  });
});

describe("ralph convergence decision artifacts", () => {
  test("records explicit success convergence and goes directly to PR handoff", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const ctx = makeMockCtx(
      { prompt: "Ship convergence", max_loops: 2, base_branch: "main", git_worktree_dir: "", create_pr: true },
      { task: (name) => name.startsWith("reviewer-") ? ralphReview("complete") : undefined },
    );

    const result = await mod.default.run(ctx);
    const round = JSON.parse(readFileSync(result["review_report_path"] as string, "utf8"));

    assert.equal(result["approved"], true);
    assert.equal(result["iterations_completed"], 1);
    assert.equal(ctx.calls.task.includes("pull-request"), true);
    assert.equal(round.convergence_decision.parsed, true);
    assert.equal(round.convergence_decision.approved, true);
    assert.equal(round.convergence_decision.stopReviewLoop, true);
    assert.equal(round.convergence_decision.nextAction, "pull-request");
    assert.equal(round.convergence_decision.finalActionRemaining, true);
  });

  test("distinguishes parsed rejection from malformed reviewer output", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const ctx = makeMockCtx(
      { prompt: "Ship convergence", max_loops: 1, base_branch: "main", git_worktree_dir: "", create_pr: false },
      {
        task: (name) => {
          if (name === "reviewer-a") return "not json";
          if (name === "reviewer-b") return ralphReview("continue");
          return undefined;
        },
      },
    );

    const result = await mod.default.run(ctx);
    const round = JSON.parse(readFileSync(result["review_report_path"] as string, "utf8"));
    const parseFailure = round.reviews.find((review) => review.convergence_decision.parsed === false);
    const rejection = round.reviews.find((review) => review.reviewer === "reviewer-b");

    assert.equal(result["approved"], false);
    assert.match(parseFailure.convergence_decision.diagnostics[0], /parse failed/i);
    assert.match(parseFailure.decision.reviewer_error.message, /parse failed/i);
    assert.equal(rejection.convergence_decision.parsed, true);
    assert.equal(rejection.convergence_decision.approved, false);
    assert.deepEqual(rejection.convergence_decision.diagnostics, []);
    assert.equal(round.convergence_decision.parsed, false);
    assert.equal(round.convergence_decision.nextAction, "implementation");
    assert.equal(round.convergence_decision.finalActionRemaining, false);
  });

  test("records thrown schema-backed reviewer failure as parse failure", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const ctx = makeMockCtx(
      { prompt: "Ship convergence", max_loops: 1, base_branch: "main", git_worktree_dir: "", create_pr: false },
      { parallel: () => { throw schemaFailure(); } },
    );

    const result = await mod.default.run(ctx);
    const round = JSON.parse(readFileSync(result["review_report_path"] as string, "utf8"));
    const parseFailure = round.reviews[0];

    assert.equal(result["approved"], false);
    assert.equal(parseFailure.convergence_decision.parsed, false);
    assert.match(parseFailure.convergence_decision.diagnostics.join("\n"), /structured_output/);
    assert.match(parseFailure.decision.reviewer_error.message, /structured_output/);
    assert.equal(round.convergence_decision.parsed, false);
    assert.match(round.convergence_decision.diagnostics.join("\n"), /structured_output/);
    assert.equal(round.convergence_decision.finalActionRemaining, false);
  });

  test("does not hand off Ralph PRs for unapproved final rounds", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const ctx = makeMockCtx(
      { prompt: "Ship convergence", max_loops: 1, base_branch: "main", git_worktree_dir: "", create_pr: true },
      { task: (name) => name.startsWith("reviewer-") ? ralphReview("continue") : undefined },
    );

    const result = await mod.default.run(ctx);
    const round = JSON.parse(readFileSync(result["review_report_path"] as string, "utf8"));

    assert.equal(result["approved"], false);
    assert.equal(ctx.calls.task.includes("pull-request"), false);
    assert.equal(round.convergence_decision.nextAction, "implementation");
    assert.equal(round.convergence_decision.finalActionRemaining, false);
  });

  test("treats PR-only remainder as final action after Ralph approval", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const ctx = makeMockCtx(
      { prompt: "Ship convergence and create a pull request", max_loops: 2, base_branch: "main", git_worktree_dir: "", create_pr: true },
      { task: (name) => name.startsWith("reviewer-") ? ralphReviewWithOnlyFinalPrRemaining() : undefined },
    );

    const result = await mod.default.run(ctx);
    const round = JSON.parse(readFileSync(result["review_report_path"] as string, "utf8"));

    assert.equal(result["approved"], true);
    assert.equal(result["iterations_completed"], 1);
    assert.equal(ctx.calls.task.includes("pull-request"), true);
    assert.equal(round.reviews[0].convergence_decision.finalActionRemaining, true);
    assert.equal(round.reviews[0].convergence_decision.nextAction, "pull-request");
    assert.equal(round.convergence_decision.approved, true);
    assert.equal(round.convergence_decision.finalActionRemaining, true);
    assert.equal(round.convergence_decision.nextAction, "pull-request");
  });
});
