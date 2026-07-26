import type { GoalLedger } from "./goal-types.js";
import {
  RECEIPT_EXPECTATIONS,
  renderGoalContinuationPrompt,
  renderLatestReviewArtifacts,
  renderReceiptHistory,
  taggedPrompt,
} from "./goal-prompts.js";
import { WORKER_PREFLIGHT_CONTRACT } from "./shared-prompts.js";

export const GOAL_ORCHESTRATOR_RECEIPT_CONTRACT = [
  "Complete the objective before claiming readiness. Leave work only at a true blocker or impossibility; do not redefine success around a partial state.",
  "Map every explicit requirement, artifact, command, test, gate, invariant, and deliverable to authoritative current evidence whose scope matches the claim.",
  "Unless the objective/criteria forbid committing, have an implementation agent commit in this checkout with a descriptive message, confirm a clean tree with `git status --porcelain`, and include the commit identifier. Do not defer committing.",
  "Return delegations, files changed, commands and outcomes, evidence, blockers, residual risks, readiness, and verification remaining.",
].join("\n");

export const GOAL_ORCHESTRATION_GUIDANCE = [
  "You supervise implementation, investigation, edits, and validation through the `subagent` tool rather than implementing directly.",
  "Delegate only work that is genuinely independent and too large to finish in a handful of tool calls. Do not assign subagents as a check on work you already own. Prefer one subagent over several.",
  "Delegate implementation with its relevant objective, cwd, files, constraints, findings, and validation. Use focused locator/analyzer/pattern or shell-heavy delegation when that work meets the delegation threshold.",
  "Keep overlapping work with one owner; parallelize only independent tasks. While an agent runs, prepare dependent follow-up work rather than duplicating its assignment.",
  "Coordinate follow-ups for all required implementation, tests, docs, validation, and cleanup before reporting readiness.",
].join("\n");

export const GOAL_ORCHESTRATOR_BEST_PRACTICES = [
  "The output is an orchestrator receipt produced after reading current goal/review artifacts and incorporating delegated results.",
  "Distinguish completed, evidenced changes from recommendations and blockers. If goal context or required subagent capability is unavailable, report the blocker rather than success.",
  "If the final paragraph would be a plan, a question, or a promise to act next, make the appropriate tool calls instead of ending the turn.",
].join("\n");

export const GOAL_SUBAGENT_TRACKING_GUIDANCE = [
  "Use `todo` as the active delegation ledger when work is meaningfully multi-step: record owner, purpose, and expected output; mark starts, append results, and close only after incorporation or explicit rejection.",
  "Before the receipt, resolve each pending/in_progress item as completed, blocked, or deferred with a reason so parallel work and follow-ups remain visible.",
].join("\n");

type GoalOrchestratorPromptArgs = {
  readonly ledger: GoalLedger;
  readonly ledgerPath: string;
  readonly blockerThreshold: number;
  readonly latestReviewArtifactPaths: readonly string[];
  readonly workflowStartCwd: string;
};

export function renderGoalOrchestratorPrompt(
  args: GoalOrchestratorPromptArgs,
): string {
  return [
    renderGoalContinuationPrompt(
      args.ledger,
      args.ledgerPath,
      args.blockerThreshold,
      args.latestReviewArtifactPaths,
    ),
    taggedPrompt([
      ["context", [`Current working directory: ${args.workflowStartCwd}`, "Use it for repository work and relative paths unless an explicit cwd is intentional; pass it to delegated agents."].join("\n")],
      ["project_setup", WORKER_PREFLIGHT_CONTRACT],
      ["orchestration_guidance", GOAL_ORCHESTRATION_GUIDANCE],
      ["subagent_tracking", GOAL_SUBAGENT_TRACKING_GUIDANCE],
      ["receipt_contract", [GOAL_ORCHESTRATOR_RECEIPT_CONTRACT, RECEIPT_EXPECTATIONS].join("\n")],
      ["constraints", [
        "Do not submit a PR; a later authorized PR/MR/review action handles that external write after approval.",
        "For the requested change/build/fix, make in-scope local edits and non-destructive validation through subagents without asking. Confirm destructive actions, other external writes, and scope expansion first.",
        "Preserve repository architecture and conventions unless the literal contract and repository evidence justify changing them; add no features or abstractions beyond the task.",
      ].join("\n")],
      ["output", "Return readable Markdown headed: Delegations performed, Progress made, Files changed, Commands run, Evidence, Blockers, Ready for review, Remaining work."],
      ["role", "You are the sub-agent orchestrator; supervise the complete objective through the `subagent` tool rather than implementing directly."],
      ["objective", [
        `Read the goal ledger at ${args.ledgerPath} and latest review artifacts from the workflow read hint.`,
        "Perform the initialization preflight, then delegate the smallest coherent work that satisfies the literal objective, acceptance criteria, current state, and consolidated findings.",
        "Run or delegate repository-relevant validation, including end-to-end playwright-cli or tmux validation for executable user scenarios. Incorporate results and follow-ups through completion; report a true blocker and safest partial state without inventing success.",
        GOAL_ORCHESTRATOR_BEST_PRACTICES,
      ].join("\n")],
    ]),
  ].join("\n\n");
}

export function renderForkedGoalOrchestratorPrompt(
  ledger: GoalLedger,
  ledgerPath: string,
  latestReviewArtifactPaths: readonly string[],
): string {
  return taggedPrompt([
    ["receipts", [`Goal ledger artifact: ${ledgerPath}`, renderReceiptHistory(ledger), renderLatestReviewArtifacts(latestReviewArtifactPaths)].join("\n\n")],
    ["orchestration_guidance", GOAL_ORCHESTRATION_GUIDANCE],
    ["subagent_tracking", GOAL_SUBAGENT_TRACKING_GUIDANCE],
    ["receipt_contract", [GOAL_ORCHESTRATOR_RECEIPT_CONTRACT, RECEIPT_EXPECTATIONS].join("\n")],
    ["constraints", "The established literal contract, acceptance matrix, contract-fidelity audit, findings batch, regression evidence, closure, worktree, PR handoff, setup, E2E, and blocked-threshold rules remain in force. Do not shrink the ledger objective."],
    ["objective", [
      "Continue the same goal-runner orchestrator thread as supervisor, using the `subagent` tool for implementation and validation through completion.",
      "Read the current ledger and latest artifacts, coordinate the smallest coherent remaining delegation, incorporate results, and return the established readable receipt. If the ending would only promise or plan more work, make the tool calls instead.",
    ].join("\n")],
  ]);
}
