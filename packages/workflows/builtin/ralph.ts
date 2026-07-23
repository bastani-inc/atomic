/** Builtin workflow: ralph */

import { Type } from "typebox";
import { workflow } from "../src/authoring/workflow.js";
import {
  DEFAULT_MAX_LOOPS,
  normalizeBranchInput,
  positiveInteger,
} from "./ralph-core.js";
import { runRalphWorkflow } from "./ralph-runner.js";

export default workflow({
  name: "ralph",
  description: "Raw prompt → research-prompt-refinement → research → orchestrate → multi-model parallel review loop with bounded iteration and immutable acceptance criteria. When launching follow-up ralph runs from review findings, pass the ORIGINAL task text as acceptance_criteria so deltas cannot drift from the literal contract. If the task includes submitting a pull request (or MR/review), remove that final action from the prompt text and set create_pr=true instead when preparing the workflow inputs.",
  inputs: {
    prompt: Type.String({ description: "The task or goal to research, execute, and refine. Do not include PR/MR submission instructions here; strip them from the task text and request them via create_pr=true instead." }),
    acceptance_criteria: Type.Optional(Type.String({ description: "Original immutable task contract this run must remain consistent with. Defaults to prompt. Orchestrators launching follow-up runs from reviewer findings should pass the ORIGINAL task text here." })),
    max_loops: Type.Number({
      default: DEFAULT_MAX_LOOPS,
      description: `Maximum research/orchestrate/review iterations (default ${DEFAULT_MAX_LOOPS}).`,
    }),
    base_branch: Type.String({
      default: "origin/main",
      description: "Branch reviewers compare the current code delta against (default origin/main).",
    }),
    git_worktree_dir: Type.String({
      default: "",
      description:
        "Optional Git worktree path. Leave at the default unless the user explicitly requested worktree isolation — stages never create git worktrees on their own. Must start inside a Git repo; absolute paths are used as-is, relative paths resolve from the repo root, existing Git worktrees from the invoking repository are reused/shared as-is, and missing paths are created from base_branch.",
    }),
    create_pr: Type.Boolean({
      default: false,
      description:
        "Whether to run the final pull-request creation stage. Defaults to false; prompt text alone does not opt in. If the task asks to submit a PR/MR/review, remove that from the prompt text and set this to true — only the final stage then attempts provider-appropriate PR/MR/review creation.",
    }),
  },
  outputs: {
    result: Type.Optional(Type.String({ description: "Final implementation report from the orchestrator stage." })),
    plan: Type.Optional(Type.String({ description: "Latest transformed research question." })),
    plan_path: Type.Optional(Type.String({ description: "Backward-compatible alias for research_path." })),
    research: Type.Optional(Type.String({ description: "Latest research report text or artifact reference." })),
    research_path: Type.Optional(Type.String({ description: "Path to the latest generated research artifact under research/." })),
    implementation_notes_path: Type.Optional(Type.String({ description: "OS-temp notes file containing decisions, deviations, blockers, and validation notes." })),
    qa_video_path: Type.Optional(Type.String({ description: "Absolute path to the reviewable QA end-to-end proof video recorded with playwright-cli for UI-applicable changes, when one was produced." })),
    pr_report: Type.Optional(Type.String({ description: "Pull-request report emitted only when create_pr=true and the final pull-request stage runs." })),
    approved: Type.Optional(Type.Boolean({ description: "Whether the reviewer loop approved before completion or optional final handoff." })),
    iterations_completed: Type.Optional(Type.Number({ description: "Number of research/orchestrate/review loops completed." })),
    review_report: Type.Optional(Type.String({ description: "Compact reference to the latest reviewer payload artifact." })),
    review_report_path: Type.Optional(Type.String({ description: "JSON artifact path for the latest review round." })),
  },
  worktreeFromInputs: {
    gitWorktreeDir: "git_worktree_dir",
    baseBranch: "base_branch",
  },
  run: async (ctx) => {
    const workflowCtx = ctx;
    const workflowStartCwd = workflowCtx.cwd ?? process.cwd();
    const inputs = workflowCtx.inputs;
    const prompt = inputs.prompt;
    const acceptanceCriteria = inputs.acceptance_criteria?.trim() || prompt;
    const maxLoops = positiveInteger(inputs.max_loops, DEFAULT_MAX_LOOPS);
    const comparisonBaseBranch = normalizeBranchInput(
      inputs.base_branch,
      "origin/main",
    );
    const createPr = inputs.create_pr === true;
    return await runRalphWorkflow(workflowCtx, {
      prompt,
      acceptanceCriteria,
      maxLoops,
      comparisonBaseBranch,
      workflowStartCwd,
      createPr,
    });
  },
});
