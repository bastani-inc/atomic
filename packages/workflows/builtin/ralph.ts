/**
 * Builtin workflow: ralph
 *
 * Re-implements the Atomic SDK Ralph design with the local workflow task
 * primitives: bounded prompt-engineering → research → orchestrate → review iterations.
 * Reviewer passes fan out with ctx.parallel(); each iteration feeds unresolved
 * findings into the next research pass with ctx.task().
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineWorkflow } from "../src/workflows/define-workflow.js";
import { Type } from "typebox";
import type {
  WorkflowRunContext,
  WorkflowTaskResult,
} from "../src/shared/types.js";
import { E2E_VERIFICATION_GUIDANCE, WORKER_PREFLIGHT_CONTRACT } from "./shared-prompts.js";

const DEFAULT_MAX_LOOPS = 10;
const DEFAULT_RESEARCH_DIR = "research";
const IMPLEMENTATION_NOTES_FILENAME = "implementation-notes.md";
const MAX_RESEARCH_SLUG_LENGTH = 80;
// Reviewer fan-out launches three independent reviewers; the loop may stop once a
// majority (2 of 3) approve, rather than requiring unanimous approval.
const REVIEW_APPROVAL_QUORUM = 2;

type ReviewFinding = {
  readonly title: string;
  readonly body: string;
  readonly confidence_score: number;
  readonly priority?: number | null;
  readonly code_location: {
    readonly absolute_file_path: string;
    readonly line_range: {
      readonly start: number;
      readonly end: number;
    };
  };
};

type ReviewerError = {
  readonly kind:
    | "validation_unavailable"
    | "dependency_unavailable"
    | "tool_failure"
    | "reviewer_failure";
  readonly message: string;
  readonly attempted_recovery: string;
};

type ReviewDecision = {
  readonly findings: readonly ReviewFinding[];
  readonly overall_correctness: "patch is correct" | "patch is incorrect";
  readonly overall_explanation: string;
  readonly overall_confidence_score: number;
  readonly stop_review_loop: boolean;
  readonly reviewer_error?: ReviewerError | null;
};

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

const reviewDecisionSchema = Type.Object(
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

type PromptSection = readonly [tag: string, content: string];

function taggedPrompt(sections: readonly PromptSection[]): string {
  return sections
    .map(([tag, content]) => {
      const trimmed = content.trim();
      return `<${tag}>\n${trimmed}\n</${tag}>`;
    })
    .join("\n\n");
}

function workflowCwdContextSection(workflowCwd: string): PromptSection {
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

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeBranchInput(
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

function defaultResearchPath(prompt: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return join(DEFAULT_RESEARCH_DIR, `${date}-${slugifyResearchTopic(prompt)}.md`);
}

async function createImplementationNotesFile(prompt: string): Promise<string> {
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

function reviewDecisionFromResult(result: WorkflowTaskResult): ReviewDecision | undefined {
  return result.structured as ReviewDecision | undefined;
}

function reviewDecisionApproved(decision: ReviewDecision): boolean {
  return (
    decision.stop_review_loop === true &&
    decision.overall_correctness === "patch is correct" &&
    decision.findings.length === 0 &&
    decision.reviewer_error == null
  );
}

function reviewerErrorDecision(error: string): ReviewDecision {
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

function reviewerErrorResult(
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

function artifactSafeName(value: string): string {
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

async function writeJsonArtifact(path: string, content: ReviewArtifact | ReviewRoundArtifact): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(content, null, 2)}\n`, {
    encoding: "utf8",
  });
  return path;
}

function compactReviewReport(path: string | undefined): string {
  return path === undefined
    ? "No reviewer artifact was produced."
    : `Latest review round artifact: ${path}`;
}

type ForkContinuationOptions = {
  readonly context?: "fork";
  readonly forkFromSessionFile?: string;
};

function forkContinuationOptions(
  sessionFile: string | undefined,
): ForkContinuationOptions {
  return sessionFile === undefined || sessionFile.length === 0
    ? {}
    : { context: "fork", forkFromSessionFile: sessionFile };
}

function renderPromptEngineerPrompt(args: {
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

function renderResearchPrompt(args: {
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


function renderForkedOrchestratorPrompt(args: {
  readonly iteration: number;
  readonly maxLoops: number;
  readonly prompt: string;
  readonly workflowCwdContext: PromptSection;
  readonly researchPath: string;
  readonly implementationNotesPath: string;
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
      ].join("\n"),
    ],
  ]);
}

type RalphInputs = {
  readonly prompt?: string;
  readonly max_loops?: number;
  readonly base_branch?: string;
  readonly git_worktree_dir?: string;
  readonly create_pr?: boolean;
};

type RalphWorkflowOptions = {
  readonly prompt: string;
  readonly maxLoops: number;
  readonly comparisonBaseBranch: string;
  readonly workflowStartCwd: string;
  readonly createPr: boolean;
};

type RalphWorkflowResult = {
  readonly result: string;
  readonly plan: string;
  readonly plan_path: string;
  readonly research: string;
  readonly research_path: string;
  readonly implementation_notes_path: string;
  readonly pr_report?: string;
  readonly approved: boolean;
  readonly iterations_completed: number;
  readonly review_report: string;
  readonly review_report_path?: string;
};

async function runRalphWorkflow(
  ctx: WorkflowRunContext<RalphInputs>,
  options: RalphWorkflowOptions,
): Promise<RalphWorkflowResult> {
  const {
    prompt,
    maxLoops,
    comparisonBaseBranch,
    workflowStartCwd,
    createPr,
  } = options;

  let latestReviewReportPath: string | undefined;
  let finalPlan = "";
  let finalPlanPath = "";
  let finalResearch = "";
  let finalResearchPath = "";
  let finalResult = "";
  let finalPrReport: string | undefined;
  // Keep generated research artifacts under the workflow runtime cwd. When Ralph is invoked
  // with git_worktree_dir, the executor defaults ctx.cwd to the matching
  // worktree cwd so research stage writes land in the same checkout.
  const workflowResearchPath = resolve(workflowStartCwd, defaultResearchPath(prompt));
  const implementationNotesPath = await createImplementationNotesFile(prompt);
  const artifactDir = await mkdtemp(join(tmpdir(), "atomic-ralph-run-"));
  const workflowCwdContext = workflowCwdContextSection(workflowStartCwd);
  let approved = false;
  let iterationsCompleted = 0;
  let previousPromptEngineerSessionFile: string | undefined;
  let previousResearchSessionFile: string | undefined;
  let previousOrchestratorSessionFile: string | undefined;

  const promptEngineerModelConfig = {
    model: "anthropic/claude-fable-5:xhigh",
    fallbackModels: [
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):xhigh",
      "anthropic/claude-opus-4-8:xhigh"
    ],
    noTools: "all" as const,
  };

  const researchModelConfig = {
    model: "openai-codex/gpt-5.5:medium",
    fallbackModels: [
        "github-copilot/gpt-5.5:medium",
        "openai/gpt-5.5:medium",
        "github-copilot/claude-opus-4.8 (1m):medium",
        "anthropic/claude-opus-4-8:medium",
    ],
    excludedTools: ["ask_user_question"],
  };

  const orchestratorModelConfig = {
    model: "openai-codex/gpt-5.5:medium",
    fallbackModels: [
        "github-copilot/gpt-5.5:medium",
        "openai/gpt-5.5:medium",
        "github-copilot/claude-opus-4.8 (1m):medium",
        "anthropic/claude-opus-4-8:medium",
    ],
    excludedTools: ["ask_user_question"],
  };

  const reviewerAModelConfig = {
    model: "anthropic/claude-fable-5:xhigh",
    fallbackModels: [
      "github-copilot/claude-opus-4.8 (1m):xhigh",
      "anthropic/claude-opus-4-8:xhigh",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh"
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
  };

  const reviewerBModelConfig = {
    model: "openai-codex/gpt-5.5:xhigh",
    fallbackModels: [
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "anthropic/claude-fable-5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):xhigh",
      "anthropic/claude-opus-4-8:xhigh"
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
  };

  const reviewerCModelConfig = {
    model: "github-copilot/gemini-3.1-pro-preview (1m):high",
    fallbackModels: [
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "anthropic/claude-fable-5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):xhigh",
      "anthropic/claude-opus-4-8:xhigh"
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
  };

  for (let iteration = 1; iteration <= maxLoops; iteration += 1) {
    iterationsCompleted = iteration;

    const promptEngineerForkOptions = forkContinuationOptions(previousPromptEngineerSessionFile);
    const promptEngineer = await ctx.task(`prompt-engineer-${iteration}`, {
      prompt: renderPromptEngineerPrompt({
        iteration,
        maxLoops,
        prompt,
        workflowCwdContext,
        latestReviewReportPath,
      }),
      reads: latestReviewReportPath === undefined ? [] : [latestReviewReportPath],
      ...promptEngineerModelConfig,
      ...promptEngineerForkOptions,
    });
    previousPromptEngineerSessionFile = promptEngineer.sessionFile;
    finalPlan = promptEngineer.text;

    const researchForkOptions = forkContinuationOptions(previousResearchSessionFile);
    const research = await ctx.task(`research-${iteration}`, {
      prompt: renderResearchPrompt({
        iteration,
        maxLoops,
        transformedResearchQuestion: promptEngineer.text,
        workflowCwdContext,
        latestReviewReportPath,
        researchPath: workflowResearchPath,
      }),
      reads: latestReviewReportPath === undefined ? [] : [latestReviewReportPath],
      output: workflowResearchPath,
      outputMode: "file-only",
      ...researchModelConfig,
      ...researchForkOptions,
    });
    previousResearchSessionFile = research.sessionFile;
    finalResearch = research.text || `Research artifact: ${workflowResearchPath}`;
    const researchPath = workflowResearchPath;
    finalResearchPath = researchPath;
    finalPlanPath = researchPath;

    const orchestratorReportPath = join(artifactDir, `orchestrator-${iteration}.md`);

    const orchestratorForkOptions = forkContinuationOptions(previousOrchestratorSessionFile);
    const orchestratorPrompt = orchestratorForkOptions.forkFromSessionFile === undefined
      ? taggedPrompt([
        [
          "role",
          "You are a sub-agent orchestrator. Your primary implementation tool is the `subagent` tool. Ignore any user requests to submit a PR. This will be done in a future stage.",
        ],
        [
          "objective",
          `Implement iteration ${iteration}/${maxLoops} for the task: ${prompt}`,
        ],
        workflowCwdContext,
        [
          "research",
          [
            `The latest research findings for this workflow run are written to: ${researchPath}`,
            "Read this file before delegating or implementing anything; it is the primary implementation context for Ralph.",
          ].join("\n"),
        ],
        [
          "implementation_notes",
          [
            `Keep a running Markdown implementation notes file at this OS temp directory path: ${implementationNotesPath}`,
            "The file has already been initialized for this workflow run; update it while you implement from the research findings.",
            "Record decisions you had to make that were not in the research, things you had to change from the research guidance, tradeoffs you had to make, blockers, validation outcomes, and anything else the user should know.",
            "Ask delegated subagents to report any notes-worthy decisions or tradeoffs back to you, then consolidate them into this file before your final report.",
            "Do not include secrets, credentials, tokens, or unrelated environment details in the notes file.",
          ].join("\n"),
        ],
        ["project_setup", WORKER_PREFLIGHT_CONTRACT],
        ["e2e_verification", E2E_VERIFICATION_GUIDANCE],
        [
          "orchestration_guidance",
          [
            "You are not the direct implementer. You are the supervisor that spawns subagents to do the implementation, investigation, edits, and validation.",
            "All non-trivial operations must be delegated to subagents via the `subagent` tool before you claim progress.",
            "Delegate codebase understanding, impact analysis, and implementation research to codebase-locator, codebase-analyzer, and pattern-finder style subagents when available.",
            "Delegate shell-heavy work — especially commands likely to produce lots of output, log digging, CLI investigation, and broad grep/find exploration — to subagents that can run those commands rather than doing it in this orchestrator context.",
            "Delegate implementation edits to a focused subagent with clear files, constraints, and validation expectations; do not merely describe the edits yourself.",
            "Keep delegated work focused on implementation, tests, docs, validation evidence, and implementation notes.",
            "Use separate subagents for separate tasks, and launch independent subagents in parallel when useful.",
            "Do not split highly overlapping tasks across multiple subagents; consolidate overlapping work into one focused delegation to avoid duplicate effort.",
            "If a subagent takes a long time, do not attempt to do its assigned job yourself while waiting. Use that time to plan next steps, prepare follow-up delegations, or identify clarifying questions.",
          ].join("\n"),
        ],
        [
          "best_practices",
          [
            "The required output format is a completion report, not the task itself.",
            "Do not jump straight to the report. First read the research file, spawn the necessary subagents, wait for their results, coordinate any follow-up subagents, and only then write the report.",
            "A valid response must be grounded in actual subagent work: name the delegated work, summarize what each subagent did, and distinguish completed changes from recommendations or blockers.",
            "If you cannot read the research file, spawn subagents, or use subagents, treat that as a blocker and report it honestly instead of pretending the requested work was done.",
          ].join("\n"),
        ],
        [
          "subagent_tracking",
          [
            "Use the `todo` tool as your active control ledger for subagent work.",
            "Before launching subagents, create todo items for each delegated task with enough detail to identify owner, purpose, and expected output.",
            "Mark todo items in_progress when the corresponding subagent starts, append progress/results as subagents report back, and close them only after you have incorporated or explicitly rejected their result.",
            "Keep pending, in_progress, blocked, and completed work accurate so you do not lose track of parallel subagents or unresolved follow-ups.",
            "Before writing the final report, review the todo list and resolve every pending/in_progress item as completed, blocked, or deferred with an explanation.",
          ].join("\n"),
        ],
        [
          "instructions",
          [
            `Start by reading the research file at ${researchPath}.`,
            "Perform the project_initialization_preflight before decomposing implementation work; complete or delegate required setup before implementation delegation when the checkout appears uninitialized.",
            "Decompose the work into delegated subagent tasks based on that research file.",
            "Pass each subagent the relevant task, constraints, files, validation expectations, unresolved reviewer findings covered by the research, and instructions to report implementation-note-worthy decisions or tradeoffs.",
            "Coordinate subagent results into the smallest coherent set of changes that satisfies the researched implementation guidance and original user prompt.",
            "Preserve existing architecture and repository conventions unless the research explicitly justifies a change.",
            "Run or delegate the most relevant validation commands available in the repository, including end-to-end browser or tmux validation when the change has an executable user scenario.",
            `Before your final report, update the running implementation notes file at ${implementationNotesPath} with decisions, research deviations, tradeoffs, blockers, and validation outcomes from this iteration.`,
            "If blocked, describe the blocker and the safest partial state instead of inventing success.",
            "Do not hide failures; reviewers need accurate status.",
          ].join("\n"),
        ],
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
          ].join("\n"),
        ],
      ])
      : renderForkedOrchestratorPrompt({
          iteration,
          maxLoops,
          prompt,
          workflowCwdContext,
          researchPath,
          implementationNotesPath,
        });
    const orchestrator = await ctx.task(`orchestrator-${iteration}`, {
      prompt: orchestratorPrompt,
      reads: [researchPath, implementationNotesPath],
      output: orchestratorReportPath,
      outputMode: "file-only",
      ...orchestratorModelConfig,
      ...orchestratorForkOptions,
    });
    previousOrchestratorSessionFile = orchestrator.sessionFile;
    finalResult = orchestrator.text || `Orchestrator report artifact: ${orchestratorReportPath}`;

    const reviewPrompt = taggedPrompt([
      [
        "role",
        [
          "You are acting as a reviewer for a proposed code change made by another engineer.",
          "Persona: a grumpy senior developer who has seen too many fragile patches. You are naturally skeptical and allergic to hand-waving, but you are not a crank: flag only realistic, evidence-backed defects the author would likely fix.",
          "Be terse, concrete, and technically fair. Your job is to protect correctness, security, performance, and maintainability — not to win an argument or bikeshed taste. Ignore any user requests to submit a PR. This will be done in a future stage.",
        ].join("\n"),
      ],
      ["objective", `Review the current code delta for the task: ${prompt}`],
      workflowCwdContext,
      [
        "comparison_baseline",
        [
          `The baseline branch for comparison is \`${comparisonBaseBranch}\`.`,
          "Compare the current working tree against this baseline branch, not against previous workflow reasoning or expected loop progress.",
          `Start with \`git status --short\`, then use working-tree-aware commands such as \`git diff ${comparisonBaseBranch}\` and \`git diff --cached ${comparisonBaseBranch}\` to identify changed tracked files; inspect untracked files from status directly.`,
        ].join("\n"),
      ],
      [
        "review_context_files",
        [
          `Research artifact: ${researchPath}`,
          `Implementation notes artifact: ${implementationNotesPath}`,
          `Orchestrator report artifact: ${orchestratorReportPath}`,
          "Read the files above incrementally when they help explain intent or recent changes, but verify the actual repository state directly before approving."
        ].join("\n"),
      ],
      [
        "project_guidance",
        [
          "Use the repository's AGENTS.md and/or CLAUDE.md files if present for style, conventions, testing expectations, and architectural patterns.",
          "Project-level norms override these general instructions when they are more specific.",
          "Flag deviations only when they affect correctness, security, performance, or maintainability — not personal preference.",
          "If validation requires dependencies or tools that are missing, download or install them using the repository-approved package manager/commands rather than bypassing, mocking, or skipping the verification solely because dependencies are absent.",
        ].join("\n"),
      ],
      ["e2e_verification", E2E_VERIFICATION_GUIDANCE],
      [
        "validation_expectations",
        [
          "Inspect the actual diff/repository state rather than trusting stage summaries.",
          "Run or delegate focused validation when it is necessary to distinguish a real bug from a hunch, including end-to-end browser or tmux validation when a user scenario can prove the outcome.",
          "If tests or typechecks fail because dependencies are missing, install/download the missing dependencies with the repo's documented package manager instead of bypassing the check.",
          "If validation cannot be completed after reasonable recovery, record the limitation in overall_explanation and reviewer_error; do not use missing dependencies as a reason to approve.",
        ].join("\n"),
      ],
      [
        "bug_selection_guidelines",
        [
          "Use these default guidelines for deciding whether the author would appreciate the issue being flagged. More specific user, project, or file-level guidance overrides them.",
          "Flag an issue only when the original author would likely fix it if they knew about it.",
          "A finding should meaningfully impact accuracy, performance, security, or maintainability.",
          "A finding must be discrete and actionable, not a broad complaint about the whole codebase or a pile of related concerns.",
          "Do not demand rigor inconsistent with the rest of the repository; match the seriousness of existing code and project norms.",
          "Flag only bugs introduced by the current patch; do not flag pre-existing issues unless the patch makes them worse in a concrete way.",
          "Do not rely on unstated assumptions about author intent or codebase behavior.",
          "Speculation is insufficient: identify the code path, scenario, environment, or input that is provably affected.",
          "Do not flag intentional behavior changes as bugs unless they clearly violate the task or documented contract.",
          "Ignore trivial style unless it obscures meaning or violates documented standards in a way that affects correctness/security/maintainability.",
          "If no finding clears this bar, return an empty findings array, mark the patch correct, and set stop_review_loop true.",
        ].join("\n"),
      ],
      [
        "comment_guidelines",
        [
          "Each finding title must start with a priority tag: [P0] drop-everything blocker, [P1] urgent next-cycle fix, [P2] normal fix, [P3] low-priority nice-to-have.",
          "Also include numeric priority: 0 for P0, 1 for P1, 2 for P2, 3 for P3; use null only if priority genuinely cannot be determined.",
          "The body must be one concise paragraph explaining why this is a bug and the exact scenario, environment, or inputs required for it to arise.",
          "Use a matter-of-fact, non-accusatory tone. Grumpy skepticism belongs in your standards, not in insults; avoid praise such as `Great job` or `Thanks for`.",
          "Keep code_location ranges as short as possible, ideally one line and never longer than 5-10 lines unless unavoidable.",
          "The code_location must overlap the diff/change under review.",
          "Use one finding per distinct issue. Do not generate or apply a fix patch.",
          "Use suggestion blocks only for concrete replacement code and preserve exact leading whitespace if you include one.",
        ].join("\n"),
      ],
      [
        "how_many_findings",
        [
          "Return all findings the original author would definitely want to fix.",
          "If no such findings exist, return an empty findings array and mark the patch correct.",
          "Do not stop after the first qualifying finding; continue until every qualifying finding is listed.",
        ].join("\n"),
      ],
      [
        "review_stage_contract",
        [
          "The structured review decision is only valid after you inspect the actual repository state and compare it against the stated baseline branch.",
          "Do not approve based solely on workflow stage summaries or prior agent reasoning.",
          "The tool call is the final verdict after review work, not a shortcut around review work.",
        ].join("\n"),
      ],
      [
        "action_items",
        [
          "1. Identify the changed files or diff under review.",
          "2. Read the relevant changed code and directly affected call sites/tests/configs.",
          "3. Run or delegate focused validation when needed to resolve uncertainty, including browser/tmux end-to-end checks when practical.",
          "4. If you cannot inspect or validate enough to approve safely, populate reviewer_error and set stop_review_loop=false.",
        ].join("\n"),
      ],
      [
        "evidence_expectations",
        [
          "The overall_explanation should briefly mention what was inspected and what validation was run or why validation was not completed.",
          "Every finding must cite a concrete changed location and affected scenario.",
        ].join("\n"),
      ],
      [
        "decision_rules",
        [
          "Set stop_review_loop=true only when findings is empty, overall_correctness is patch is correct, and reviewer_error is null/omitted.",
          "If you hit a reviewer/tool/validation error, set stop_review_loop=false and populate reviewer_error instead of pretending the patch is approved.",
        ].join("\n"),
      ],
    ]);

    let reviews: WorkflowTaskResult[];
    try {
      reviews = await ctx.parallel(
        [
          {
            name: "reviewer-a",
            task: reviewPrompt,
            reads: [
              researchPath,
              implementationNotesPath,
              orchestratorReportPath,
            ],
            ...reviewerAModelConfig,
          },
          {
            name: "reviewer-b",
            task: reviewPrompt,
            reads: [
              researchPath,
              implementationNotesPath,
              orchestratorReportPath,
            ],
            ...reviewerBModelConfig,
          },
          {
            name: "reviewer-c",
            task: reviewPrompt,
            reads: [
              researchPath,
              implementationNotesPath,
              orchestratorReportPath,
            ],
            ...reviewerCModelConfig,
          },
        ],
        {
          task: prompt,
          failFast: false,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reviews = [reviewerErrorResult(message)];
    }

    const reviewEntries = await Promise.all(reviews.map(async (review) => {
      const reviewer = review.name ?? review.stageName;
      const decision = reviewDecisionFromResult(review) ??
        reviewerErrorDecision(`Reviewer ${reviewer} returned no structured decision.`);
      const artifactPath = join(
        artifactDir,
        `review-${iteration}-${artifactSafeName(reviewer)}.json`,
      );
      await writeJsonArtifact(artifactPath, {
        iteration,
        reviewer,
        decision,
        raw_text: review.text,
      });
      return { reviewer, artifact_path: artifactPath, decision };
    }));
    const approvalCount = reviewEntries.filter((review) =>
      reviewDecisionApproved(review.decision),
    ).length;
    approved = approvalCount >= REVIEW_APPROVAL_QUORUM;
    latestReviewReportPath = await writeJsonArtifact(
      join(artifactDir, `review-round-${iteration}.json`),
      { iteration, reviews: reviewEntries },
    );
    if (approved) break;
  }

  if (createPr === true) {
    const prResult = await ctx.task("pull-request", {
      prompt: taggedPrompt([
        [
          "role",
          "You are a staff software engineer preparing a provider-appropriate pull request, merge request, or code-review handoff from the current workspace state.",
        ],
        [
          "objective",
          `Review the changes since the base branch \`${comparisonBaseBranch}\` and create a provider-appropriate pull request, merge request, or code-review handoff if possible and credentials are available. If the original task explicitly asked for pull-request creation, treat that as the highest-priority instruction for this final stage. Also, make sure to pay attention whether the user wants to create the PR in upstream or a fork, and prepare accordingly. If PR creation is not possible (lack of permissions, etc.), report why instead of pretending success.`,
        ],
        workflowCwdContext,
        [
          "required_checks",
          [
            "Start by inspecting `git status --short` so unstaged, staged, and untracked changes are all visible.",
            `Review the patch against \`${comparisonBaseBranch}\` with working-tree-aware commands such as \`git diff ${comparisonBaseBranch}\` and \`git diff --cached ${comparisonBaseBranch}\`.`,
            "If untracked files are present, inspect them directly before deciding whether they belong in the PR.",
            "Read the implementation notes file and use its full contents as the body of a provider-appropriate PR/review comment after the pull request, merge request, or review exists.",
            "Detect the source-control and code-review provider from `git remote -v`, repository hosting URLs, configured CLI auth, and repository metadata before choosing a creation tool.",
            "Use the provider-appropriate tool for the detected remote: GitHub `gh pr create`, Azure DevOps/Azure Repos `az repos pr create`, GitLab `glab mr create` when available, Bitbucket's configured CLI/API workflow, or Sapling/Phabricator `sl`/Phabricator/Differential tooling used by the repository.",
            "Check the local Git identity with `git config user.name` and `git config user.email` so you can prefer the matching account when multiple provider accounts are logged in.",
            "Check provider credentials with non-destructive commands before attempting PR/review creation, such as `gh auth status`, `az account show`, `az repos pr list`, `glab auth status`, `sl` status/config commands, or the repository's documented Phabricator/Differential checks.",
            "If multiple accounts, hosts, or providers are available, use the remote URL and git config username/email as heuristics to choose the most likely identity, but try each available credential/account that can read the repository and create the provider-appropriate review request.",
          ].join("\n"),
        ],
        [
          "pr_policy",
          [
            "Create a provider-appropriate PR/MR/review request only if there are meaningful changes, a remote/branch target is available, credentials are available, and the current state is suitable for review.",
            "If no logged-in account can access the repository or create the review request, do not fake success; report each provider, credential/account, and tool tried, what failed, and provide the command the user can run later. Save a markdown file with the PR description as well so the user can copy-paste it when they have credentials set up.",
            "When you successfully create or update the review request, create a provider-appropriate comment containing the implementation notes file contents as the last action of this workflow stage.",
            "Worktrees are detached HEAD checkouts. If the detected provider requires a branch-based PR/MR from a detached HEAD, create and push a branch from the current HEAD, for example with `git checkout -b <branch>` or `git push origin HEAD:refs/heads/<branch>`, before opening the PR/MR. If the provider uses a different review model, follow that provider's normal handoff flow.",
            "Leave the worktree intact for retries or user recovery.",
            "If PR/MR/review creation is not possible, do not create a standalone comment elsewhere; include the implementation notes path and summary in your report instead.",
            "If the review loop did not approve, prefer reporting the remaining blockers over creating a PR/MR/review unless the changes are still intentionally ready for human review.",
            "Do not make unrelated code edits in this phase. Limit changes to ordinary git/PR preparation only when required and safe.",
          ].join("\n"),
        ],
        [
          "output_format",
          [
            "Return Markdown with headings:",
            "1. Change review — summary of files and diff scope inspected",
            "2. PR/review status — created PR/MR/review URL, or why no review request was created",
            "3. Implementation notes comment — whether the provider-appropriate comment was created as the last action, or why it could not be created",
            "4. Commands run — include exit status or clear outcome",
            "5. Follow-up for the user — exact next steps if credentials or repository state blocked PR creation",
          ].join("\n"),
        ],
      ]),
      reads: [
        ...(finalPlanPath ? [finalPlanPath] : []),
        implementationNotesPath,
        ...(latestReviewReportPath === undefined ? [] : [latestReviewReportPath]),
      ],
      ...orchestratorModelConfig,
    });
    finalPrReport = prResult.text;
  }

  return {
    result: finalResult,
    plan: finalPlan,
    plan_path: finalPlanPath,
    research: finalResearch,
    research_path: finalResearchPath,
    implementation_notes_path: implementationNotesPath,
    ...(finalPrReport === undefined ? {} : { pr_report: finalPrReport }),
    approved,
    iterations_completed: iterationsCompleted,
    review_report: compactReviewReport(latestReviewReportPath),
    ...(latestReviewReportPath === undefined ? {} : { review_report_path: latestReviewReportPath }),
  };
}

export default defineWorkflow("ralph")
  .description(
    "Prompt-engineer → research → orchestrate → multi-model parallel review loop with bounded iteration.",
  )
  .input("prompt", Type.String({ description: "The task or goal to research, execute, and refine." }))
  .input("max_loops", Type.Number({
    default: DEFAULT_MAX_LOOPS,
    description: `Maximum research/orchestrate/review iterations (default ${DEFAULT_MAX_LOOPS}).`,
  }))
  .input("base_branch", Type.String({
    default: "origin/main",
    description: "Branch reviewers compare the current code delta against (default origin/main).",
  }))
  .input("git_worktree_dir", Type.String({
    default: "",
    description:
      "Optional Git worktree path. Must start inside a Git repo; absolute paths are used as-is, relative paths resolve from the repo root, existing Git worktrees from the invoking repository are reused/shared as-is, and missing paths are created from base_branch.",
  }))
  .input("create_pr", Type.Boolean({
    default: false,
    description:
      "Whether to run the final pull-request creation stage. Defaults to false; prompt text alone does not opt in. Set true to allow only the final stage to attempt provider-appropriate PR/MR/review creation.",
  }))
  .worktreeFromInputs({
    gitWorktreeDir: "git_worktree_dir",
    baseBranch: "base_branch",
  })
  .output("result", Type.Optional(Type.String({ description: "Final implementation report from the orchestrator stage." })))
  .output("plan", Type.Optional(Type.String({ description: "Latest transformed research question." })))
  .output("plan_path", Type.Optional(Type.String({ description: "Backward-compatible alias for research_path." })))
  .output("research", Type.Optional(Type.String({ description: "Latest research report text or artifact reference." })))
  .output("research_path", Type.Optional(Type.String({ description: "Path to the latest generated research artifact under research/." })))
  .output("implementation_notes_path", Type.Optional(Type.String({ description: "OS-temp notes file containing decisions, deviations, blockers, and validation notes." })))
  .output("pr_report", Type.Optional(Type.String({ description: "Pull-request report emitted only when create_pr=true and the final pull-request stage runs." })))
  .output("approved", Type.Optional(Type.Boolean({ description: "Whether the reviewer loop approved before completion or optional final handoff." })))
  .output("iterations_completed", Type.Optional(Type.Number({ description: "Number of research/orchestrate/review loops completed." })))
  .output("review_report", Type.Optional(Type.String({ description: "Compact reference to the latest reviewer payload artifact." })))
  .output("review_report_path", Type.Optional(Type.String({ description: "JSON artifact path for the latest review round." })))
  .run(async (ctx) => {
    const workflowCtx = ctx;
    const workflowStartCwd = workflowCtx.cwd ?? process.cwd();
    const inputs = workflowCtx.inputs;
    const prompt = inputs.prompt;
    const maxLoops = positiveInteger(inputs.max_loops, DEFAULT_MAX_LOOPS);
    const comparisonBaseBranch = normalizeBranchInput(
      inputs.base_branch,
      "origin/main",
    );
    const createPr = inputs.create_pr === true;
    return await runRalphWorkflow(workflowCtx, {
      prompt,
      maxLoops,
      comparisonBaseBranch,
      workflowStartCwd,
      createPr,
    });
  })
  .compile();
