/**
 * Shared prompt-refinement stage used by the ralph and goal workflows.
 *
 * Before the main work loop begins, both workflows run this single
 * `prompt-refinement` stage. It invokes the prompt-engineer skill
 * (`/skill:prompt-engineer`) to sharpen the raw user request into a clearer,
 * more actionable objective using the Workflow Best Practices prompt anatomy
 * documented in `packages/coding-agent/docs/workflows.md`. The refined request
 * replaces the original as the operative objective downstream; the original is
 * preserved by each workflow for reporting.
 */

import type { WorkflowModelValue, WorkflowTaskOptions, WorkflowTaskResult } from "../src/shared/types.js";

export type PromptSection = readonly [tag: string, content: string];

/**
 * Clarity rubric mirrored from the "## Workflow Best Practices" section of
 * `docs/workflows.md` (the user-facing docs under packages/coding-agent/docs).
 * The refinement stage makes each element explicit where it can be reasonably
 * inferred from the raw request.
 */
export const PROMPT_REFINEMENT_CRITERIA = [
  "Apply the workflow best practices documented in the `## Workflow Best Practices` section of `docs/workflows.md` (in the `packages/coding-agent/docs` user-facing docs). Treat that section as the authoritative prompt-anatomy rubric: use its Objective, Context, Scope, Non-goals, Done criteria, Validation command, Reporting requirements, and Stop conditions when refining the request.",
  "Objective — state what should be true when the work is complete.",
  "Context — note why it matters and where the relevant code or area likely lives.",
  "Scope — state what is allowed to change (the smallest correct change).",
  "Non-goals — state what to avoid (unrelated refactors, redesigns, or behavior changes outside this case).",
  "Done criteria — list verifiable completion signals: new behavior works, existing behavior is unchanged, and the validation command passes.",
  "Validation command — name the targeted check that proves the result.",
  "Reporting requirements — changed files, validation results, and remaining risks must be reported.",
  "Stop conditions — name the cases where the agent should stop and ask first (public API, security, data migration, etc.).",
].join("\n");

/**
 * Build the prompt sent to the prompt-refinement stage. The refined request is
 * returned verbatim (no fences or preamble) so it can replace the original
 * request as the operative objective for the rest of the workflow.
 */
export function renderPromptRefinementPrompt(args: {
  readonly request: string;
  readonly workflowLabel: string;
  readonly workflowCwdContext?: PromptSection;
}): string {
  const sections: readonly string[] = [
    `/skill:prompt-engineer Refine the following user request into a clearer, more actionable objective for the ${args.workflowLabel} workflow. Improve clarity and completeness using the rubric below without changing the user's intent, expanding scope, or inventing requirements that cannot be reasonably inferred from the request.`,
    `<original_request>\n${args.request}\n</original_request>`,
    `<clarity_rubric>\nApply the Workflow Best Practices prompt anatomy. Make each of the following explicit where it can be reasonably inferred from the original request:\n${PROMPT_REFINEMENT_CRITERIA}\n</clarity_rubric>`,
    [
      "<refinement_rules>",
      "- Preserve the user's original intent and scope; do not add unrelated work.",
      "- If the original request is already clear and complete, return it essentially unchanged with only clarity improvements.",
      "- Where a criterion cannot be reasonably inferred, state it as a concise assumption or a 'to confirm' note rather than fabricating specifics.",
      "- Do not implement anything, run commands, or edit files. This stage only produces the refined request text.",
      "</refinement_rules>",
    ].join("\n"),
    `<output_format>\nReturn ONLY the refined request. No preamble, no explanation, and no Markdown fences. The returned text replaces the original request as the operative objective for the rest of the workflow, so it must be a single self-contained request.\n</output_format>`,
  ];
  const tail = args.workflowCwdContext === undefined
    ? []
    : [`<${args.workflowCwdContext[0]}>\n${args.workflowCwdContext[1].trim()}\n</${args.workflowCwdContext[0]}>`];
  return [...sections, ...tail].join("\n\n");
}

/** Minimal context surface required to run a tracked refinement stage. */
type PromptRefinementContext = {
  task(name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
};

/** Model-chain + tool gating forwarded to the refinement stage session. */
export type PromptRefinementModelConfig = {
  readonly model?: WorkflowModelValue;
  readonly fallbackModels?: readonly string[];
  readonly noTools?: "all" | "builtin";
  readonly excludedTools?: readonly string[];
  readonly tools?: readonly string[];
};

/**
 * Run the shared `prompt-refinement` stage once and return the refined request.
 * Falls back to the original request when the stage produces no usable text.
 */
export async function runPromptRefinementStage(
  ctx: PromptRefinementContext,
  options: {
    readonly request: string;
    readonly workflowLabel: string;
    readonly workflowCwdContext?: PromptSection;
    readonly modelConfig: PromptRefinementModelConfig;
  },
): Promise<string> {
  const result = await ctx.task("prompt-refinement", {
    prompt: renderPromptRefinementPrompt({
      request: options.request,
      workflowLabel: options.workflowLabel,
      ...(options.workflowCwdContext === undefined ? {} : { workflowCwdContext: options.workflowCwdContext }),
    }),
    ...options.modelConfig,
  });
  const refined = (result.text ?? "").trim();
  return refined.length > 0 ? refined : options.request;
}
