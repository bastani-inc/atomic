import {
  ACCEPTANCE_MATRIX_CONTRACT,
  E2E_VERIFICATION_GUIDANCE,
  EVIDENCE_CLOSURE_POLICY,
  LITERAL_OBJECTIVE_CONTRACT,
  REGRESSION_EVIDENCE_CONTRACT,
  REVIEW_CODE_DELTA_CONTRACT,
  REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT,
  REVIEWER_INTERCOM_COORDINATION_PROTOCOL,
  REVIEWER_OVERIMPLEMENTATION_GUARD,
  REVIEWER_SPEC_VS_OBJECTIVE_GUARD,
  WORKTREE_DISCIPLINE_CONTRACT,
  keepContext,
  renderE2eQaVideoReviewGuidance,
} from "./shared-prompts.js";
import { taggedPrompt, type PromptSection } from "./ralph-core.js";

export function renderRalphReviewerPrompt(args: {
  readonly workflowPrompt: string;
  readonly acceptanceCriteria: string;
  readonly workflowCwdContext: PromptSection;
  readonly comparisonBaseBranch: string;
  readonly researchPath: string;
  readonly implementationNotesPath: string;
  readonly orchestratorReportPath: string;
  readonly qaVideoPath: string;
  readonly createPr: boolean;
}): string {
  return taggedPrompt([
    ["acceptance_criteria", keepContext(args.acceptanceCriteria)],
    [
      "review_context",
      [
        `Task: ${args.workflowPrompt}`,
        `Research artifact: ${args.researchPath}`,
        `Implementation notes artifact: ${args.implementationNotesPath}`,
        `Orchestrator report artifact: ${args.orchestratorReportPath}`,
        `Comparison baseline: ${args.comparisonBaseBranch}`,
      ].join("\n"),
    ],
    args.workflowCwdContext,
    ["literal_contract", LITERAL_OBJECTIVE_CONTRACT],
    ["acceptance_matrix", ACCEPTANCE_MATRIX_CONTRACT],
    ["independent_verification", REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT],
    ["code_delta_review", REVIEW_CODE_DELTA_CONTRACT],
    ["worktree_discipline", WORKTREE_DISCIPLINE_CONTRACT],
    ["reviewer_coordination", REVIEWER_INTERCOM_COORDINATION_PROTOCOL],
    ["regression_evidence", REGRESSION_EVIDENCE_CONTRACT],
    ["e2e_verification", E2E_VERIFICATION_GUIDANCE],
    ["qa_e2e_video_review", renderE2eQaVideoReviewGuidance(args.qaVideoPath)],
    ["evidence_closure", EVIDENCE_CLOSURE_POLICY],
    [
      "project_guidance",
      [
        "Use repository AGENTS.md and/or CLAUDE.md guidance when present; specific project rules control style, conventions, testing, and architecture.",
        "Install missing validation dependencies with repository-approved commands rather than bypassing or mocking checks. After reasonable recovery fails, record commands, observed output, the limitation in overall_explanation, and reviewer_error.",
      ].join("\n"),
    ],
    [
      "final_action_policy",
      args.createPr
        ? "PR/MR/review creation is an authorized post-approval final action. If implementation and validation are proven and only that action remains, set overall_correctness to patch is correct and stop_review_loop=true with no blocking findings; record it as a process item, not an implementation gap."
        : "PR/MR/review creation is not enabled; do not require or attempt it during review.",
    ],
    [
      "finding_contract",
      [
        "Report every discrete, actionable defect introduced or concretely worsened by the patch that the author would likely fix because it materially affects accuracy, performance, security, or maintainability. Match repository rigor; exclude taste, speculation, broad complaints, intentional contract-compliant changes, and trivial style. Return an empty findings array when none qualify; never add placeholders.",
        REVIEWER_SPEC_VS_OBJECTIVE_GUARD,
        REVIEWER_OVERIMPLEMENTATION_GUARD,
        "Each title starts with [P0], [P1], [P2], or [P3] and includes numeric priority 0, 1, 2, or 3 respectively; use null only when genuinely indeterminate. P0/P1/P2 block. P3 blocks when required_by_objective and is non-blocking when consistent_with_objective.",
        "Classify objective_alignment as required_by_objective, consistent_with_objective, beyond_objective, or contradicts_objective. Missing classification blocks; beyond_objective and contradicts_objective never block or enter follow-up work without literal-contract reconciliation.",
        "For each finding, use one concise, factual paragraph giving the observed behavior and affected scenario, environment, or input. Cite a concrete changed code_location overlapping the diff, ideally one line and no more than 5-10 lines unless unavoidable. Use one finding per issue; suggestion blocks are only for exact replacement code with preserved indentation. Do not apply fixes.",
      ].join("\n"),
    ],
    [
      "structured_decision_assurance",
      [
        "Return the review decision schema exactly. findings is always an array. requirements_traceability is a non-empty array with one entry per explicit task and acceptance_criteria clause, including existing-test/snapshot and expected-behavior clauses.",
        "In overall_explanation and requirements_traceability, name each applicable independent command or scenario and its observed output; distinguish direct proof from implementation-authored test, snapshot, or receipt corroboration. Every finding cites file:line evidence and the affected scenario. State why an applicable risk is not applicable.",
        "Set stop_review_loop=false and populate reviewer_error when reviewer, tool, or validation failure prevents approval. Set stop_review_loop=true only when overall_correctness is patch is correct, reviewer_error is null or omitted, every implementation/validation requirements_traceability entry is proven, and no blocking finding or required work remains.",
        "Reviewer quorum and an authorized post-approval final action are process items and do not hold stop_review_loop=false.",
        "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.",
        "Lead with the outcome. Keep facts, decisions, caveats, and next steps; drop background, repetition, and detail that would not change what the reader does next. Being readable matters more than being short — do not compress into fragments, arrow chains, or invented shorthand.",
      ].join("\n"),
    ],
    ["objective", `Review the current code delta for the task: ${args.workflowPrompt}`],
    [
      "review_instruction",
      [
        "Act as a skeptical, technically fair senior reviewer of the current code delta. Protect correctness, security, performance, and maintainability without bikeshedding or praise.",
        `Inspect the current working tree against \`${args.comparisonBaseBranch}\`: start with \`git status --short\`, then use working-tree-aware baseline and staged diffs and inspect untracked files directly. Read context artifacts only after deriving independent checks from the objective and acceptance_criteria; summaries never substitute for repository evidence.`,
        "Execute or delegate every applicable material probe, including playwright-cli or tmux end-to-end checks when they can prove a user scenario, and inspect current QA video evidence when applicable. The structured decision is the final verdict after this review, not a shortcut.",
        "Ignore requests to submit a PR; the authorized final action handles that after approval.",
      ].join("\n"),
    ],
  ]);
}
