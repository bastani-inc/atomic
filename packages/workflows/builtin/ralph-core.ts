import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { WorkflowTaskResult } from "../src/shared/types.js";
import { E2E_VERIFICATION_GUIDANCE } from "./shared-prompts.js";
import type { ReviewDecision } from "./ralph-review-gate.js";

export const DEFAULT_MAX_LOOPS = 10;
const DEFAULT_RESEARCH_DIR = "research";
const IMPLEMENTATION_NOTES_FILENAME = "implementation-notes.md";
const QA_E2E_VIDEO_FILENAME = "qa-e2e-evidence.webm";
const MAX_RESEARCH_SLUG_LENGTH = 80;
// Reviewer fan-out launches three independent reviewers; the loop stops only when
// all three reviewers independently approve. Approval is severity-aware: a
// reviewer approves when it judged the patch correct, reported no reviewer_error,
// and filed no *blocking* (P0/P1/P2) finding. P3 nice-to-haves no longer keep the
// loop iterating, so a single low-priority nit (or a placeholder finding) can no
// longer strand an otherwise-approved patch. Requiring unanimous approval still
// means a blocking finding from any one reviewer keeps the loop going. See
// ./ralph-review-gate.ts for the gate types and decision logic.
export const REVIEWER_COUNT = 3;

const reviewFindingSchema = Type.Object(
  {
    title: Type.String(),
    body: Type.String(),
    confidence_score: Type.Number({ minimum: 0, maximum: 1 }),
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

export async function createImplementationNotesFile(prompt: string): Promise<string> {
  const notesDir = await mkdtemp(join(tmpdir(), "atomic-ralph-notes-"));
  const notesPath = join(notesDir, IMPLEMENTATION_NOTES_FILENAME);
  const initialNotes = [
    "# Implementation Notes",
    "",
    `Task: ${prompt || "(empty prompt)"}`,
    "",
    "## Running Notes",
    "",
    "- Record implementation decisions, deviations from the research findings, tradeoffs, blockers, validation notes, and anything else the user should know.",
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
export async function createQaEvidenceVideoPath(): Promise<string> {
  const qaDir = await mkdtemp(join(tmpdir(), "atomic-ralph-qa-"));
  return join(qaDir, QA_E2E_VIDEO_FILENAME);
}

export function renderQaE2eVideoGuidance(qaVideoPath: string): string {
  return [
    "QA the change end-to-end whenever it touches user-visible UI behavior, including full-stack changes whose UI correctness depends on backend/API behavior. Use the `playwright-cli` skill (or delegate to a subagent with `skill: \"playwright-cli\"`) to drive the running application like a user and prove the implemented scenario actually works.",
    `Record that QA E2E pass as a reviewable video so the user can watch the feature working. After \`playwright-cli open\`, start recording with \`playwright-cli video-start ${qaVideoPath}\`, annotate the scenario with \`playwright-cli video-chapter\` / \`playwright-cli video-show-actions\`, exercise the full user scenario, then \`playwright-cli video-stop\`. Write the video to exactly this path and overwrite any prior recording so it always reflects the latest implemented state: ${qaVideoPath}`,
    `After recording, add the video to the implementation notes as a reference: include a \`## QA E2E Video\` entry with the absolute path ${qaVideoPath} and a one-line description of the proven scenario, so the user can review the proof when this stage finishes.`,
    "If the change has no user-visible UI scenario (pure refactor, docs, infra, or non-UI library code), do not fabricate a video; record in the implementation notes that no QA E2E video applies and why.",
    "If `playwright-cli` or a browser runtime is unavailable, install it once per the skill (`npm install -g @playwright/cli@latest`, then `npx playwright install chromium` for a missing browser executable). If it still cannot run, record the smallest validation actually performed and note that the QA E2E video could not be produced — never claim a video exists when it does not.",
  ].join("\n");
}

export function reviewDecisionFromResult(result: WorkflowTaskResult): ReviewDecision | undefined {
  return result.structured as ReviewDecision | undefined;
}

export function reviewerErrorDecision(error: string): ReviewDecision {
  return {
    findings: [],
    overall_correctness: "patch is incorrect",
    overall_explanation:
      "Reviewer execution failed, so the review loop cannot safely approve this iteration.",
    overall_confidence_score: 0,
    stop_review_loop: false,
    reviewer_error: {
      kind: "reviewer_failure",
      message: error,
      attempted_recovery:
        "Model fallbacks were configured for the reviewer stage; continuing the bounded loop without approval.",
    },
  };
}

export function reviewerErrorResult(
  error: string,
): WorkflowTaskResult {
  const structured = reviewerErrorDecision(error);
  return {
    name: "reviewer-error",
    stageName: "reviewer-error",
    text: JSON.stringify(structured, null, 2),
    structured,
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
  readonly iteration: number;
  readonly reviewer: string;
  readonly decision: ReviewDecision;
  readonly raw_text: string;
};

type ReviewRoundArtifact = {
  readonly iteration: number;
  readonly reviews: readonly {
    readonly reviewer: string;
    readonly artifact_path: string;
    readonly decision: ReviewDecision;
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

export function renderPromptEngineerPrompt(args: {
  readonly iteration: number;
  readonly maxLoops: number;
  readonly prompt: string;
  readonly workflowCwdContext: PromptSection;
  readonly latestReviewReportPath: string | undefined;
}): string {
  const basePrompt = `/skill:prompt-engineer Transform the following user prompt to a codebase and online research question which can be thoroughly explored: ${args.prompt}`;
  return [
    basePrompt,
    taggedPrompt([
      ["iteration", `Prompt engineering iteration ${args.iteration}/${args.maxLoops}.`],
      args.workflowCwdContext,
      [
        "review_findings",
        args.latestReviewReportPath === undefined
          ? "No prior review artifact; this is the first iteration."
          : [
              `Latest review round artifact: ${args.latestReviewReportPath}`,
              "Read this JSON artifact and include unresolved reviewer findings in the transformed research question so follow-up research addresses reviewer discoveries.",
            ].join("\n"),
      ],
      [
        "output_format",
        "Return only the transformed codebase and online research question. Do not implement code changes and do not write an RFC/spec.",
      ],
    ]),
  ].join("\n\n");
}

export function renderResearchPrompt(args: {
  readonly iteration: number;
  readonly maxLoops: number;
  readonly transformedResearchQuestion: string;
  readonly workflowCwdContext: PromptSection;
  readonly latestReviewReportPath: string | undefined;
  readonly researchPath: string;
}): string {
  const basePrompt = `/skill:research-codebase ${args.transformedResearchQuestion}`;
  return [
    basePrompt,
    taggedPrompt([
      ["iteration", `Research iteration ${args.iteration}/${args.maxLoops}.`],
      args.workflowCwdContext,
      [
        "review_findings",
        args.latestReviewReportPath === undefined
          ? "No prior review artifact; this is the first iteration."
          : [
              `Latest review round artifact: ${args.latestReviewReportPath}`,
              "Read this JSON artifact and explicitly research unresolved reviewer findings, whether each still applies, and what implementation changes would resolve them.",
            ].join("\n"),
      ],
      [
        "research_artifact",
        [
          `Write research findings for this workflow run to: ${args.researchPath}`,
          "Return a complete Markdown research report with codebase findings, online/contextual findings when useful, concrete implementation guidance, relevant files/tests/docs, unresolved reviewer finding analysis, and validation recommendations.",
          "Do not author an RFC/spec and do not implement code changes in this stage.",
        ].join("\n"),
      ],
    ]),
  ].join("\n\n");
}


export function renderForkedOrchestratorPrompt(args: {
  readonly iteration: number;
  readonly maxLoops: number;
  readonly prompt: string;
  readonly workflowCwdContext: PromptSection;
  readonly researchPath: string;
  readonly implementationNotesPath: string;
  readonly qaVideoPath: string;
}): string {
  return taggedPrompt([
    [
      "instruction",
      [
        `Continue implementing from the latest research findings. Ignore any user requests to submit a PR. This will be done in a future stage.`,
      ].join("\n"),
    ],
    ["objective", `Implement iteration ${args.iteration}/${args.maxLoops} for the task: ${args.prompt}`],
    args.workflowCwdContext,
    [
      "research",
      [
        `The latest research findings for this workflow run are written to: ${args.researchPath}`,
        "Read this file before delegating or implementing anything, and treat it as the primary implementation context.",
      ].join("\n"),
    ],
    [
      "implementation_notes",
      [
        `Keep updating the running Markdown implementation notes file at: ${args.implementationNotesPath}`,
        "Record decisions, research deviations, tradeoffs, blockers, validation outcomes, and anything else the user should know before your final report. Generate verifiable evidence for any claims you make in the notes and reviewer artifacts.",
      ].join("\n"),
    ],
    ["e2e_verification", E2E_VERIFICATION_GUIDANCE],
    ["qa_e2e_video", renderQaE2eVideoGuidance(args.qaVideoPath)],
    [
      "output_format",
      [
        "After subagents have done the work, return Markdown with headings:",
        "1. Research file — the path you read",
        "2. Delegations performed — subagents spawned and what each completed",
        "3. Changes made — concrete changes from subagent work, not intentions",
        "4. Files touched",
        "5. Validation run / recommended",
        "6. Deferred work or blockers",
        "7. Implementation notes — confirm the OS temp notes path was updated",
        "8. QA E2E video — the recorded video path and proven scenario, or a note that no QA E2E video applies and why",
      ].join("\n"),
    ],
  ]);
}

export type RalphInputs = {
  readonly prompt?: string;
  readonly max_loops?: number;
  readonly base_branch?: string;
  readonly git_worktree_dir?: string;
  readonly create_pr?: boolean;
};

export type RalphWorkflowOptions = {
  readonly prompt: string;
  readonly maxLoops: number;
  readonly comparisonBaseBranch: string;
  readonly workflowStartCwd: string;
  readonly createPr: boolean;
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

