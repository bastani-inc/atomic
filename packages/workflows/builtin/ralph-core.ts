import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { WorkflowTaskResult } from "../src/shared/types.js";
import { createWorkflowArtifactDirectory } from "../src/shared/workflow-artifacts.js";
import {
  E2E_VERIFICATION_GUIDANCE,
  keepContext,
  LITERAL_OBJECTIVE_CONTRACT,
} from "./shared-prompts.js";
import type { ReviewDecision, ReviewFinding } from "./ralph-review-gate.js";
import { reviewDecisionApproved } from "./ralph-review-gate.js";
import {
  parseFailureDiagnostics,
  finalActionRemaining,
  reviewerFailureText,
  summarizeReviewConvergence,
  type ConsolidatedFinding,
  type ParsedReviewDecision,
  type ReviewConvergenceSummary,
} from "./review-convergence.js";


export const DEFAULT_MAX_LOOPS = 10;
const DEFAULT_RESEARCH_DIR = "research";
const IMPLEMENTATION_NOTES_FILENAME = "implementation-notes.md";
const QA_E2E_VIDEO_FILENAME = "qa-e2e-evidence.webm";
const MAX_RESEARCH_SLUG_LENGTH = 80;
// Reviewer fan-out launches two independent reviewers; the loop stops only when
// both reviewers independently approve. Approval is severity-aware: a reviewer
// approves when it judged the patch correct, reported no reviewer_error, and
// filed no *blocking* (P0/P1/P2) finding. P3 nice-to-haves no longer keep the
// loop iterating, so a single low-priority nit (or a placeholder finding) can no
// longer strand an otherwise-approved patch. Requiring unanimous approval still
// means a blocking finding from either reviewer keeps the loop going. See
// ./ralph-review-gate.ts for the gate types and decision logic.
export const REVIEWER_COUNT = 2;

const reviewFindingSchema = Type.Object(
  {
    title: Type.String(),
    body: Type.String(),
    confidence_score: Type.Number({ minimum: 0, maximum: 1 }),
    objective_alignment: Type.Union([
      Type.Literal("required_by_objective"),
      Type.Literal("consistent_with_objective"),
      Type.Literal("beyond_objective"),
      Type.Literal("contradicts_objective"),
    ]),
    priority: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0, maximum: 3 }), Type.Null()]),
    ),
    code_location: Type.Object(
      {
        absolute_file_path: Type.String(),
        line_range: Type.Object(
          {
            start: Type.Integer({ minimum: 1 }),
            end: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const requirementsTraceabilitySchema = Type.Object(
  {
    requirement: Type.String(),
    status: Type.Union([
      Type.Literal("proven"),
      Type.Literal("contradicted"),
      Type.Literal("missing"),
      Type.Literal("unverified"),
    ]),
    evidence: Type.String(),
  },
  { additionalProperties: false },
);

const reviewerErrorSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("validation_unavailable"),
      Type.Literal("dependency_unavailable"),
      Type.Literal("tool_failure"),
      Type.Literal("reviewer_failure"),
    ]),
    message: Type.String(),
    attempted_recovery: Type.String(),
  },
  { additionalProperties: false },
);

export const reviewDecisionSchema = Type.Object(
  {
    findings: Type.Array(reviewFindingSchema),
    overall_correctness: Type.Union([
      Type.Literal("patch is correct"),
      Type.Literal("patch is incorrect"),
    ]),
    overall_explanation: Type.String(),
    overall_confidence_score: Type.Number({ minimum: 0, maximum: 1 }),
    requirements_traceability: Type.Array(requirementsTraceabilitySchema),
    stop_review_loop: Type.Boolean(),
    reviewer_error: Type.Optional(
      Type.Union([Type.Null(), reviewerErrorSchema]),
    ),
  },
  { additionalProperties: false },
);

export type PromptSection = readonly [tag: string, content: string];

export function taggedPrompt(sections: readonly PromptSection[]): string {
  return sections
    .map(([tag, content]) => {
      const trimmed = content.trim();
      return `<${tag}>\n${trimmed}\n</${tag}>`;
    })
    .join("\n\n");
}

export function workflowCwdContextSection(workflowCwd: string): PromptSection {
  return [
    "context",
    [
      `Current working directory: ${workflowCwd}`,
      "Use this as the starting directory for repository work in this stage.",
      "Shell commands and relative file paths should be relative to this directory unless you intentionally pass an explicit cwd override.",
      "When delegating subagents, pass along that this is the current working directory.",
    ].join("\n"),
  ];
}

export function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function normalizeBranchInput(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;

  const looksLikeSafeGitRef =
    /^(?!-)(?!.*(?:\.\.|@\{|\/\/|\.lock(?:\/|$)))[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(
      trimmed,
    );
  return looksLikeSafeGitRef ? trimmed : fallback;
}

function slugifyResearchTopic(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_RESEARCH_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "research";
}

export function defaultResearchPath(prompt: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return join(DEFAULT_RESEARCH_DIR, `${date}-${slugifyResearchTopic(prompt)}.md`);
}

export async function createImplementationNotesFile(prompt: string, runId?: string): Promise<string> {
  const notesDir = await createWorkflowArtifactDirectory(runId);
  const notesPath = join(notesDir, IMPLEMENTATION_NOTES_FILENAME);
  const initialNotes = [
    "# Implementation Notes",
    "",
    `Task: ${prompt || "(empty prompt)"}`,
    "",
    "## Running Notes",
    "",
    "- Record implementation decisions, deviations from research, tradeoffs, blockers, validation outcomes, and user-relevant facts. Keep entries concise and readable.",
    "- Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.",
  ].join("\n");
  await writeFile(notesPath, `${initialNotes}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return notesPath;
}

// Stable absolute path the orchestrator records the QA end-to-end proof video to.
// The directory is created up front so `playwright-cli video-start <path>` can
// write to it; the video file itself is produced by the orchestrator's QA pass
// (and overwritten each iteration so it always reflects the latest state). The
// final pull-request stage attaches it when it exists.
export async function createQaEvidenceVideoPath(runId?: string): Promise<string> {
  const qaDir = await createWorkflowArtifactDirectory(runId);
  return join(qaDir, QA_E2E_VIDEO_FILENAME);
}

export function renderQaE2eVideoGuidance(qaVideoPath: string): string {
  return [
    E2E_VERIFICATION_GUIDANCE,
    `For a user-visible UI scenario, record the QA pass for review. After \`playwright-cli open\`, use \`playwright-cli video-start ${qaVideoPath}\`, annotate with \`playwright-cli video-chapter\` / \`playwright-cli video-show-actions\`, exercise the complete scenario, then run \`playwright-cli video-stop\`. Write to exactly ${qaVideoPath}, overwriting stale evidence.`,
    `Add a \`## QA E2E Video\` entry to the implementation notes with the absolute path ${qaVideoPath} and one sentence naming the proven scenario. For changes without a user-visible UI scenario, record why video does not apply; never fabricate one.`,
    "If `playwright-cli` or its browser runtime is unavailable, install it once per the skill (`npm install -g @playwright/cli@latest`, then `npx playwright install chromium` when needed). If a concrete attempt still fails, record the commands, observed failure output, smallest validation performed, and that no video was produced.",
  ].join("\n");
}

export function reviewDecisionFromResult(result: WorkflowTaskResult): ReviewDecision | undefined {
  return result.structured as ReviewDecision | undefined;
}

export function parsedReviewDecisionFromResult(
  result: WorkflowTaskResult,
  reviewer: string,
): ParsedReviewDecision<ReviewDecision> {
  const parsed = reviewDecisionFromResult(result);
  if (parsed !== undefined) {
    return { decision: parsed, parsed: true, diagnostics: [] };
  }
  const diagnostics = parseFailureDiagnostics(reviewer, result.text);
  return {
    decision: reviewerErrorDecision(diagnostics.join("\n")),
    parsed: false,
    diagnostics,
  };
}

export function ralphReviewConvergence(args: {
  readonly decision: ReviewDecision;
  readonly parsed: boolean;
  readonly diagnostics: readonly string[];
  readonly allowFinalActionRemaining: boolean;
}): ReviewConvergenceSummary {
  const approved = reviewDecisionApproved(args.decision);
  const hasFinalActionRemaining = args.allowFinalActionRemaining &&
    finalActionRemaining(args.decision.requirements_traceability);
  return summarizeReviewConvergence({
    parsed: args.parsed,
    approved,
    stopReviewLoop: args.decision.stop_review_loop,
    nextAction: approved && hasFinalActionRemaining ? "pull-request" : approved ? "finish" : "implementation",
    finalActionRemaining: approved && hasFinalActionRemaining,
    diagnostics: args.diagnostics,
  });
}

export function reviewerErrorDecision(error: string): ReviewDecision {
  return {
    findings: [],
    overall_correctness: "patch is incorrect",
    overall_explanation:
      "Reviewer execution failed, so the review gate cannot safely approve the current repository state.",
    overall_confidence_score: 0,
    stop_review_loop: false,
    requirements_traceability: [],
    reviewer_error: {
      kind: "reviewer_failure",
      message: error,
      attempted_recovery:
        "Model fallbacks were configured for the reviewer stage; continuing without approval.",
    },
  };
}

export function reviewerErrorResult(
  error: unknown,
): WorkflowTaskResult {
  return {
    name: "reviewer-error",
    stageName: "reviewer-error",
    text: reviewerFailureText(error),
  };
}

export function artifactSafeName(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "artifact";
}

type ReviewArtifact = {
  readonly reviewer: string;
  readonly decision: ReviewDecision;
  readonly convergence_decision: ReviewConvergenceSummary;
  readonly raw_text: string;
};

type ReviewRoundArtifact = {
  readonly convergence_decision: ReviewConvergenceSummary;
  readonly consolidated_findings?: readonly ConsolidatedFinding<ReviewFinding>[];
  readonly reviews: readonly {
    readonly reviewer: string;
    readonly artifact_path: string;
    readonly decision: ReviewDecision;
    readonly convergence_decision: ReviewConvergenceSummary;
  }[];
};

export async function writeJsonArtifact(path: string, content: ReviewArtifact | ReviewRoundArtifact): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(content, null, 2)}\n`, {
    encoding: "utf8",
  });
  return path;
}

export function compactReviewReport(path: string | undefined): string {
  return path === undefined
    ? "No reviewer artifact was produced."
    : `Latest review round artifact: ${path}`;
}

type ForkContinuationOptions = {
  readonly context?: "fork";
  readonly forkFromSessionFile?: string;
};

export function forkContinuationOptions(
  sessionFile: string | undefined,
): ForkContinuationOptions {
  return sessionFile === undefined || sessionFile.length === 0
    ? {}
    : { context: "fork", forkFromSessionFile: sessionFile };
}

export function renderResearchPromptRefinementPrompt(args: {
  readonly request: string;
  readonly acceptanceCriteria: string;
  readonly workflowCwdContext: PromptSection;
  readonly latestReviewReportPath: string | undefined;
}): string {
  return taggedPrompt([
    ["acceptance_criteria", keepContext(args.acceptanceCriteria)],
    ["literal_contract", LITERAL_OBJECTIVE_CONTRACT],
    args.workflowCwdContext,
    [
      "review_findings",
      args.latestReviewReportPath === undefined
        ? "No prior review artifact is available."
        : [
            `Latest review round artifact: ${args.latestReviewReportPath}`,
            "Include unresolved reviewer findings in the transformed research question only when consistent with the literal objective and acceptance criteria.",
          ].join("\n"),
    ],
    ["objective", `Research the full requested task: ${args.request}`],
    [
      "output",
      keepContext(
        "Return only one concise, complete codebase and online research question. Do not implement code changes or write an RFC/spec.",
      ),
    ],
    [
      "instruction",
      `/skill:prompt-engineer Transform this request into a codebase and online research question that covers the full requested task: ${args.request}`,
    ],
  ]);
}


export function renderResearchPrompt(args: {
  readonly transformedResearchQuestion: string;
  readonly prompt: string;
  readonly acceptanceCriteria: string;
  readonly workflowCwdContext: PromptSection;
  readonly latestReviewReportPath: string | undefined;
}): string {
  return taggedPrompt([
    ["acceptance_criteria", keepContext(args.acceptanceCriteria)],
    ["literal_contract", LITERAL_OBJECTIVE_CONTRACT],
    args.workflowCwdContext,
    [
      "review_findings",
      args.latestReviewReportPath === undefined
        ? "No prior review artifact is available."
        : [
            `Latest review round artifact: ${args.latestReviewReportPath}`,
            "Research whether each unresolved finding still applies and what objective-aligned implementation change would resolve it.",
          ].join("\n"),
    ],
    ["objective", `Research implementation requirements for: ${args.prompt}`],
    [
      "research_artifact",
      [
        "Return the complete research report as your final message. Downstream implementation and review stages read it from there.",
        "Produce a complete Markdown report with codebase and useful online/contextual findings, implementation guidance, relevant files/tests/docs, unresolved-finding analysis, and validation recommendations. Lead with conclusions; keep facts, caveats, and implementation-relevant next steps; drop background and repetition.",
        "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.",
        keepContext("This stage researches only. Do not author an RFC/spec or implement code changes."),
      ].join("\n"),
    ],
    [
      "instruction",
      `/skill:research-codebase ${args.transformedResearchQuestion}`,
    ],
  ]);
}


export type RalphInputs = {
  readonly prompt?: string;
  readonly acceptance_criteria?: string;
  readonly max_loops?: number;
  readonly base_branch?: string;
  readonly git_worktree_dir?: string;
  readonly create_pr?: boolean;
};

export type RalphWorkflowOptions = {
  readonly prompt: string;
  readonly acceptanceCriteria: string;
  readonly maxLoops: number;
  readonly comparisonBaseBranch: string;
  readonly workflowStartCwd: string;
  readonly createPr: boolean;
  readonly runId?: string;
};

export type RalphWorkflowResult = {
  readonly result: string;
  readonly plan: string;
  readonly plan_path: string;
  readonly research: string;
  readonly research_path: string;
  readonly implementation_notes_path: string;
  readonly qa_video_path?: string;
  readonly pr_report?: string;
  readonly approved: boolean;
  readonly iterations_completed: number;
  readonly review_report: string;
  readonly review_report_path?: string;
};

