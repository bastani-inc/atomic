/**
 * Builtin workflow: goal
 *
 * Goal Runner workflow: persist an objective ledger, run bounded LM work turns,
 * gate completion through independent reviewers, and let plain TypeScript
 * reduce the final state.
 */

import { Type } from "typebox";
import { defineWorkflow } from "../src/workflows/define-workflow.js";
import { runGoalWorkflow } from "./goal-runner.js";
import { DEFAULT_MAX_TURNS } from "./goal-types.js";

export default defineWorkflow("goal")
  .description(
    "Goal Runner workflow with bounded LM turns, ledger artifacts, parallel reviewers, and reducer-gated completion.",
  )
  .input("objective", Type.String({ description: "The objective for the Goal Runner workflow." }))
  .input("max_turns", Type.Number({
    default: DEFAULT_MAX_TURNS,
    description: "Maximum worker/review turns before Goal Runner stops as needs_human.",
  }))
  .input("base_branch", Type.String({
    default: "origin/main",
    description: "Optional branch reviewers compare the current code delta against (default origin/main).",
  }))
  .output("result", Type.Optional(Type.String({ description: "Final report with objective, status, receipts, turns, and remaining work." })))
  .output("status", Type.Optional(Type.Union(
    [Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("needs_human"), Type.Literal("active")],
    { description: "Final reducer status: complete, blocked, needs_human, or active if externally interrupted." },
  )))
  .output("approved", Type.Optional(Type.Boolean({ description: "Whether the reducer reached complete." })))
  .output("goal_id", Type.Optional(Type.String({ description: "Per-run goal identifier stored in the ledger." })))
  .output("objective", Type.Optional(Type.String({ description: "Normalized goal objective used by the run." })))
  .output("ledger_path", Type.Optional(Type.String({ description: "OS-temp path to goal-ledger.json with receipts, reviewer decisions, blockers, and lifecycle events." })))
  .output("turns_completed", Type.Optional(Type.Number({ description: "Worker/review turns completed." })))
  .output("iterations_completed", Type.Optional(Type.Number({ description: "Worker/review turns completed, retained for status summaries." })))
  .output(
    "receipts",
    Type.Optional(
      Type.Array(
        Type.Object({
          turn: Type.Number(),
          stage: Type.String(),
          artifact_path: Type.String(),
          summary: Type.String(),
        }),
        { description: "Ledger receipt summaries and worker artifact paths." },
      ),
    ),
  )
  .output("remaining_work", Type.Optional(Type.String({ description: "Remaining gaps or blockers when incomplete, or none." })))
  .output("review_report", Type.Optional(Type.String({ description: "Compact report pointing to the latest reviewer decision artifacts used by the reducer." })))
  .output("review_report_path", Type.Optional(Type.String({ description: "JSON artifact path for the latest reviewer decision round." })))
  .run(runGoalWorkflow)
  .compile();
