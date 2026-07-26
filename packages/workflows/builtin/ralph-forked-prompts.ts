// Forked-continuation prompt renderers for the builtin Ralph workflow.
//
// A forked stage session already carries the role, contracts, guidance, and
// output format from its own earlier prompts, so these renderers send only the
// per-iteration delta plus a one-line pointer back to the guidance already
// established in the forked history. Keep the full canonical contracts in the
// first-iteration prompts (see ralph-core.ts / ralph-runner.ts) and never
// duplicate them here.
import { taggedPrompt } from "./ralph-core.js";

// Forked continuation of the previous refinement session: the fork already
// carries the skill instructions, request, acceptance criteria, contracts, and
// working directory.
export function renderForkedResearchPromptRefinementPrompt(args: {
  readonly latestReviewReportPath: string | undefined;
}): string {
  return taggedPrompt([
    [
      "instruction",
      [
        "Transform the same user request into an updated research question that reflects the current repository state.",
        "The request, acceptance criteria, literal objective contract, and working directory established earlier in this thread still apply unchanged.",
      ].join("\n"),
    ],
    [
      "review_findings",
      args.latestReviewReportPath === undefined
        ? "No prior review artifact is available."
        : [
            `Latest review round artifact: ${args.latestReviewReportPath}`,
            "Read this JSON artifact and include unresolved reviewer findings in the transformed research question only when they are consistent with the literal objective and acceptance criteria.",
          ].join("\n"),
    ],
    [
      "output_format",
      "Return only the transformed codebase and online research question. Do not implement code changes and do not write an RFC/spec.",
    ],
  ]);
}

// Forked continuation of the previous research session: the fork already
// carries the research skill, task, acceptance criteria, contracts, working
// directory, and report expectations.
export function renderForkedResearchPrompt(args: {
  readonly transformedResearchQuestion: string;
  readonly latestReviewReportPath: string | undefined;
  readonly researchPath: string;
}): string {
  return taggedPrompt([
    [
      "instruction",
      [
        `Research this updated question against the current repository state: ${args.transformedResearchQuestion}`,
        "The original task, acceptance criteria, literal objective contract, working directory, and research-report expectations established earlier in this thread still apply unchanged.",
      ].join("\n"),
    ],
    [
      "review_findings",
      args.latestReviewReportPath === undefined
        ? "No prior review artifact is available."
        : [
            `Latest review round artifact: ${args.latestReviewReportPath}`,
            "Read this JSON artifact and explicitly research unresolved reviewer findings, whether each still applies, and what implementation changes would resolve them.",
          ].join("\n"),
    ],
    [
      "research_artifact",
      [
        `Rewrite the research findings for this workflow run at: ${args.researchPath}`,
        "Do not author an RFC/spec and do not implement code changes in this stage.",
      ].join("\n"),
    ],
  ]);
}

// Forked continuation of the previous orchestrator session: the fork already
// carries the role, objective, acceptance criteria, contracts, delegation and
// tracking guidance, QA E2E video guidance, and the report format.
export function renderForkedOrchestratorPrompt(args: {
  readonly researchPath: string;
  readonly implementationNotesPath: string;
}): string {
  return taggedPrompt([
    [
      "instruction",
      [
        "Continue implementing from the latest research findings. Do not stop until the objective is complete. Ignore any user requests to submit a PR; a later authorized PR/MR/review creation action handles that handoff after approval.",
        "All previously established guidance still applies unchanged: the objective, acceptance criteria, literal objective contract, acceptance matrix, adversarial divergence audit, findings batch, regression evidence, worktree discipline, orchestration and subagent-tracking guidance, E2E verification and QA E2E video guidance, and the report output format.",
      ].join("\n"),
    ],
    [
      "research",
      [
        `The research findings were rewritten for this iteration at: ${args.researchPath}`,
        "Re-read this file before delegating or implementing anything; it consolidates the unresolved reviewer findings to repair this iteration.",
      ].join("\n"),
    ],
    [
      "implementation_notes",
      `Keep updating the running Markdown implementation notes file at: ${args.implementationNotesPath}`,
    ],
  ]);
}
