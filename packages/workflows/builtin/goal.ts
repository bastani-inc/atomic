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
  description: "Goal Runner workflow with bounded LM turns, immutable acceptance criteria, ledger artifacts, parallel reviewers, and reducer-gated completion. When launching follow-up goal runs from review findings, pass the ORIGINAL task text as acceptance_criteria so deltas cannot drift from the literal contract.",
  inputs: {
    objective: Type.String({ description: "The objective or delta for this Goal Runner workflow run." }),
    acceptance_criteria: Type.Optional(Type.String({ description: "Original immutable task contract this run must remain consistent with. Defaults to objective. Orchestrators launching follow-up runs from reviewer findings should pass the ORIGINAL task text here." })),
    max_turns: Type.Number({
      default: DEFAULT_MAX_TURNS,
      description: "Maximum worker/review turns before Goal Runner stops as needs_human.",
    }),
    base_branch: Type.String({
      default: "origin/main",
      description: "Optional branch reviewers compare the current code delta against (default origin/main).",
    }),
    create_pr: Type.Boolean({
      default: false,
      description:
        "Whether to run the final pull-request creation stage after reviewer/reducer approval. Defaults to false; prompt text alone does not opt in. Set true to allow only the final stage to attempt provider-appropriate PR/MR/review creation after Goal completes."
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
    objective: Type.Optional(Type.String({ description: "Raw goal objective used by the run." })),
    acceptance_criteria: Type.Optional(Type.String({ description: "Immutable acceptance criteria used by the run." })),
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
    pr_report: Type.Optional(Type.String({ description: "Pull-request report emitted only when create_pr=true, Goal reaches complete, and the final pull-request stage runs." })),
  },
  run: async (ctx) => {
    const workflowCtx = ctx;
    const workflowStartCwd = workflowCtx.cwd ?? process.cwd();
    const createPr = workflowCtx.inputs.create_pr === true;
    return await runGoalWorkflow(workflowCtx, { createPr, workflowStartCwd });
  },
});
