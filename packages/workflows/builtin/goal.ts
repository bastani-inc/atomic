/**
 * Builtin workflow: goal
 *
 * Goal Runner workflow: persist an objective ledger, run bounded LM work turns,
 * gate completion through independent reviewers, and let plain TypeScript
 * reduce the final state.
 */

import { Type } from "typebox";
import { workflow } from "../src/authoring/workflow.js";
import { runGoalWorkflow } from "./goal-runner.js";
import { DEFAULT_MAX_TURNS } from "./goal-types.js";

export default workflow({
  name: "goal",
  description: "Goal Runner workflow with bounded LM turns, ledger artifacts, parallel reviewers, and reducer-gated completion.",
  inputs: {
    objective: Type.String({ description: "The objective for the Goal Runner workflow." }),
    max_turns: Type.Number({
      default: DEFAULT_MAX_TURNS,
      description: "Maximum worker/review turns before Goal Runner stops as needs_human.",
    }),
    base_branch: Type.String({
      default: "origin/main",
      description: "Optional branch reviewers compare the current code delta against (default origin/main).",
    }),
  },
  outputs: {
    result: Type.Optional(Type.String({ description: "Final report with objective, status, receipts, turns, and remaining work." })),
    status: Type.Optional(Type.Union(
      [Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("needs_human"), Type.Literal("active")],
      { description: "Final reducer status: complete, blocked, needs_human, or active if externally interrupted." },
    )),
    approved: Type.Optional(Type.Boolean({ description: "Whether the reducer reached complete." })),
    goal_id: Type.Optional(Type.String({ description: "Per-run goal identifier stored in the ledger." })),
    objective: Type.Optional(Type.String({ description: "Normalized goal objective used by the run." })),
    ledger_path: Type.Optional(Type.String({ description: "OS-temp path to goal-ledger.json with receipts, reviewer decisions, blockers, and lifecycle events." })),
    turns_completed: Type.Optional(Type.Number({ description: "Worker/review turns completed." })),
    iterations_completed: Type.Optional(Type.Number({ description: "Worker/review turns completed, retained for status summaries." })),
    receipts: Type.Optional(Type.Array(Type.Object({
      turn: Type.Number(),
      stage: Type.String(),
      artifact_path: Type.String(),
      summary: Type.String(),
    }), { description: "Ledger receipt summaries and worker artifact paths." })),
    remaining_work: Type.Optional(Type.String({ description: "Remaining gaps or blockers when incomplete, or none." })),
    review_report: Type.Optional(Type.String({ description: "Compact report pointing to the latest reviewer decision artifacts used by the reducer." })),
    review_report_path: Type.Optional(Type.String({ description: "JSON artifact path for the latest reviewer decision round." })),
  },
  run: async (ctx) => await runGoalWorkflow(ctx as never),
});
