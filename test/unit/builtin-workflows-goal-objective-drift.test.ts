// @ts-nocheck
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

function finding(
  title: string,
  body: string,
  priority: number | null,
  objectiveAlignment = "required_by_objective",
) {
  return {
    title,
    body,
    confidence_score: 0.9,
    objective_alignment: objectiveAlignment,
    priority,
    code_location: {
      absolute_file_path: join(process.cwd(), "changed.ts"),
      line_range: { start: 1, end: 1 },
    },
  };
}

function reviewJson(decision: "complete" | "continue", findings = []) {
  return JSON.stringify({
    findings,
    overall_correctness: decision === "complete" ? "patch is correct" : "patch is incorrect",
    overall_explanation: `${decision} decision from test reviewer`,
    overall_confidence_score: 0.9,
    goal_oracle_satisfied: decision === "complete",
    requirements_traceability: [
      {
        requirement: "complete requested objective",
        status: decision === "complete" ? "proven" : "missing",
        evidence: decision === "complete" ? "focused validation passed" : "work remains",
      },
    ],
    receipt_assessment: "focused validation passed",
    verification_remaining: decision === "complete" ? "none" : "work remains",
    stop_review_loop: decision === "complete",
    reviewer_error: null,
  });
}

describe("goal objective-drift workflow behavior", () => {
  test("persists explicit acceptance criteria separately from objective", async () => {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx({ objective: "Follow-up delta", acceptance_criteria: "Original task" });

    const result = await d.run(ctx);
    const ledger = JSON.parse(readFileSync(result["ledger_path"] as string, "utf8"));

    assert.equal(ledger.objective, "Follow-up delta");
    assert.equal(ledger.acceptance_criteria, "Original task");
    assert.equal(result["acceptance_criteria"], "Original task");
  });

  test("allows approval when correct reviewers only include in-scope P3 nice-to-have findings", async () => {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const p3Finding = finding(
      "[P3] Consider a small cleanup",
      "This is a low-priority nice-to-have that should not block completion.",
      3,
      "consistent_with_objective",
    );
    const ctx = makeMockCtx(
      { objective: "Refactor tests" },
      {
        task: (name) => {
          if (name.startsWith("completion-reviewer-") || name.startsWith("evidence-reviewer-")) {
            return reviewJson("complete", [p3Finding]);
          }
          if (name.startsWith("risk-reviewer-")) return reviewJson("continue");
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);

    assert.equal(result["status"], "complete");
    assert.equal(result["approved"], true);
  });

  test("a dissenting reviewer's findings do not veto boolean quorum — the reducer completes on stop_review_loop quorum", async () => {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const requiredP3 = finding(
      "[P3] Required contract clause still unproven",
      "One dissenting reviewer files this finding; the two approving booleans still complete the run.",
      3,
      "required_by_objective",
    );
    const ctx = makeMockCtx(
      { objective: "Refactor tests", max_turns: 1 },
      {
        task: (name) => {
          if (name.startsWith("completion-reviewer-") || name.startsWith("evidence-reviewer-")) {
            return reviewJson("complete");
          }
          if (name.startsWith("risk-reviewer-")) return reviewJson("continue", [requiredP3]);
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);

    assert.equal(result["status"], "complete");
    assert.equal(result["approved"], true);
    const ledger = JSON.parse(readFileSync(result["ledger_path"] as string, "utf8"));
    assert.match(
      ledger.decisions[0].reason,
      /Reviewer quorum met: 2\/2 reviewers independently reported stop_review_loop=true/,
    );
  });

  test("without boolean quorum the bounded run stops as needs_human", async () => {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const gap = finding(
      "[P1] Required behavior still missing",
      "Two reviewers report unfinished objective-relevant work.",
      1,
    );
    const ctx = makeMockCtx(
      { objective: "Refactor tests", max_turns: 1 },
      {
        task: (name) => {
          if (name.startsWith("completion-reviewer-")) return reviewJson("complete");
          if (name.startsWith("evidence-reviewer-") || name.startsWith("risk-reviewer-")) {
            return reviewJson("continue", [gap]);
          }
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);

    assert.equal(result["status"], "needs_human");
    assert.equal(result["approved"], false);
    const ledger = JSON.parse(readFileSync(result["ledger_path"] as string, "utf8"));
    assert.match(
      ledger.decisions[0].reason,
      /Worker attempt budget reached without reviewer quorum/,
    );
  });
});
