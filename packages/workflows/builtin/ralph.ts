/**
 * Builtin workflow: ralph
 *
 * Re-implements the Atomic SDK Ralph design with the local workflow task
 * primitives: bounded plan → orchestrate → simplify → discover → review
 * iterations. Reviewer and discovery passes fan out with ctx.parallel(); each
 * iteration feeds review findings into the next planner with ctx.task().
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineWorkflow } from "../src/index.js";
import type {
  WorkflowRunContext,
  WorkflowTaskResult,
} from "../src/shared/types.js";
import { WORKER_PREFLIGHT_CONTRACT } from "./shared-prompts.js";

const DEFAULT_MAX_LOOPS = 10;
const DEFAULT_SPEC_DIR = "specs";
const IMPLEMENTATION_NOTES_FILENAME = "implementation-notes.md";
const MAX_SPEC_SLUG_LENGTH = 80;

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

const reviewDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "findings",
    "overall_correctness",
    "overall_explanation",
    "overall_confidence_score",
    "stop_review_loop",
  ],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "confidence_score", "code_location"],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          confidence_score: { type: "number", minimum: 0, maximum: 1 },
          priority: { type: ["integer", "null"], minimum: 0, maximum: 3 },
          code_location: {
            type: "object",
            additionalProperties: false,
            required: ["absolute_file_path", "line_range"],
            properties: {
              absolute_file_path: { type: "string" },
              line_range: {
                type: "object",
                additionalProperties: false,
                required: ["start", "end"],
                properties: {
                  start: { type: "integer", minimum: 1 },
                  end: { type: "integer", minimum: 1 },
                },
              },
            },
          },
        },
      },
    },
    overall_correctness: {
      type: "string",
      enum: ["patch is correct", "patch is incorrect"],
    },
    overall_explanation: { type: "string" },
    overall_confidence_score: { type: "number", minimum: 0, maximum: 1 },
    stop_review_loop: { type: "boolean" },
    reviewer_error: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "message", "attempted_recovery"],
          properties: {
            kind: {
              type: "string",
              enum: [
                "validation_unavailable",
                "dependency_unavailable",
                "tool_failure",
                "reviewer_failure",
              ],
            },
            message: { type: "string" },
            attempted_recovery: { type: "string" },
          },
        },
      ],
    },
  },
} as const;

const reviewDecisionTool = {
  name: "review_decision",
  label: "Review Decision",
  description:
    "Emit the final structured review verdict after inspecting the patch.",
  promptSnippet: "Emit the final review verdict as structured data",
  promptGuidelines: [
    "Call review_decision after completing review investigation and validation.",
    "This is a terminating structured-output tool; do not emit another assistant response after calling it.",
  ],
  parameters: reviewDecisionSchema,
  async execute(_toolCallId: string, params: ReviewDecision) {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(params, null, 2) },
      ],
      details: params,
      terminate: true,
    };
  },
};

const PLANNER_RFC_TEMPLATE = `
# [Project Name] Technical Design Document / RFC

| Document Metadata      | Details                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| Author(s)              | !\`git config user.name\`                                                        |
| Status                 | Draft (WIP) / In Review (RFC) / Approved / Implemented / Deprecated / Rejected |
| Team / Owner           |                                                                                |
| Created / Last Updated |                                                                                |

## 1. Executive Summary

## 2. Context and Motivation

### 2.1 Current State

### 2.2 The Problem

## 3. Goals and Non-Goals

### 3.1 Functional Goals

### 3.2 Non-Goals (Out of Scope)

## 4. Proposed Solution (High-Level Design)

### 4.1 System Architecture Diagram

Include a Mermaid system architecture diagram grounded in the actual components this work touches.

### 4.2 Architectural Pattern

### 4.3 Key Components

| Component | Responsibility | Technology Stack | Justification |
| --------- | -------------- | ---------------- | ------------- |

## 5. Detailed Design

### 5.1 API Interfaces

### 5.2 Data Model / Schema

### 5.3 Algorithms and State Management

## 6. Alternatives Considered

| Option | Pros | Cons | Reason for Rejection |
| ------ | ---- | ---- | -------------------- |

## 7. Cross-Cutting Concerns

### 7.1 Security and Privacy

### 7.2 Observability Strategy

### 7.3 Scalability and Capacity Planning

## 8. Migration, Rollout, and Testing

### 8.1 Deployment Strategy

### 8.2 Data Migration Plan

### 8.3 Test Plan

## 9. Open Questions / Unresolved Issues
`.trim();

type PromptSection = readonly [tag: string, content: string];

function taggedPrompt(sections: readonly PromptSection[]): string {
  return sections
    .map(([tag, content]) => `<${tag}>\n${content.trim()}\n</${tag}>`)
    .join("\n\n");
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

function slugifySpecTopic(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SPEC_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "plan";
}

function defaultSpecPath(prompt: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return join(DEFAULT_SPEC_DIR, `${date}-${slugifySpecTopic(prompt)}.md`);
}

async function writeSpecFile(path: string, content: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content.endsWith("\n") ? content : `${content}\n`, {
    encoding: "utf8",
  });
  return path;
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
    "- Record implementation decisions, deviations from the spec, tradeoffs, blockers, validation notes, and anything else the user should know.",
  ].join("\n");
  await writeFile(notesPath, `${initialNotes}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return notesPath;
}

function parseReviewDecision(text: string): ReviewDecision | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<ReviewDecision>;
    if (
      parsed.overall_correctness !== "patch is correct" &&
      parsed.overall_correctness !== "patch is incorrect"
    ) {
      return undefined;
    }
    if (!Array.isArray(parsed.findings)) return undefined;
    if (typeof parsed.stop_review_loop !== "boolean") return undefined;
    if (typeof parsed.overall_explanation !== "string") return undefined;
    if (typeof parsed.overall_confidence_score !== "number") return undefined;
    return parsed as ReviewDecision;
  } catch {
    return undefined;
  }
}

function reviewApproved(text: string): boolean {
  const decision = parseReviewDecision(text);
  if (decision === undefined) return false;
  return (
    decision.stop_review_loop === true &&
    decision.overall_correctness === "patch is correct" &&
    decision.findings.length === 0 &&
    decision.reviewer_error == null
  );
}

function reviewerErrorResult(
  iteration: number,
  error: string,
): WorkflowTaskResult {
  const decision: ReviewDecision = {
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
  return {
    name: "reviewer-error",
    stageName: "reviewer-error",
    text: JSON.stringify(decision, null, 2),
  };
}

function discoveryContextLabel(name: string | undefined): string {
  if (name?.startsWith("infra-locate-")) return "Infrastructure locator";
  if (name?.startsWith("infra-analyze-")) return "Infrastructure analyzer";
  if (name?.startsWith("infra-patterns-"))
    return "Infrastructure pattern finder";
  return "Infrastructure discovery";
}

function formatDiscovery(results: readonly WorkflowTaskResult[]): string {
  return results
    .map(
      (result) => `### ${discoveryContextLabel(result.name)}\n\n${result.text}`,
    )
    .join("\n\n---\n\n");
}

function formatReview(results: readonly WorkflowTaskResult[]): string {
  return results
    .map((result) => `### ${result.name}\n\n${result.text}`)
    .join("\n\n---\n\n");
}

type RalphInputs = {
  readonly prompt?: string;
  readonly max_loops?: number;
  readonly base_branch?: string;
  readonly git_worktree_dir?: string;
};

type RalphWorkflowOptions = {
  readonly prompt: string;
  readonly maxLoops: number;
  readonly comparisonBaseBranch: string;
  readonly workflowStartCwd: string;
};

type RalphWorkflowResult = {
  readonly result: string;
  readonly plan: string;
  readonly plan_path: string;
  readonly implementation_notes_path: string;
  readonly pr_report: string;
  readonly approved: boolean;
  readonly iterations_completed: number;
  readonly review_report: string;
};

async function runRalphWorkflow(
  ctx: WorkflowRunContext<RalphInputs>,
  options: RalphWorkflowOptions,
): Promise<RalphWorkflowResult> {
  const { prompt, maxLoops, comparisonBaseBranch, workflowStartCwd } = options;

  let reviewReport = "";
  let finalPlan = "";
  let finalPlanPath = "";
  let finalResult = "";
  let finalPrReport = "";
  // Keep generated specs under the workflow runtime cwd. When Ralph is invoked
  // with git_worktree_dir, the executor defaults ctx.cwd to the matching
  // worktree cwd so specs and stage writes land in the same checkout.
  const workflowSpecPath = resolve(workflowStartCwd, defaultSpecPath(prompt));
  const implementationNotesPath = await createImplementationNotesFile(prompt);
  let approved = false;
  let iterationsCompleted = 0;

  const plannerModelConfig = {
    model: "openai/gpt-5.5",
    fallbackModels: [
      "openai-codex/gpt-5.5",
      "github-copilot/gpt-5.5",
      "anthropic/claude-opus-4-7",
      "github-copilot/claude-opus-4.7",
    ],
    thinkingLevel: "high" as const,
    excludedTools: ["ask_user_question"],
  };

  const orchestratorModelConfig = {
    model: "openai/gpt-5.5",
    fallbackModels: [
      "openai-codex/gpt-5.5",
      "github-copilot/gpt-5.5",
      "anthropic/claude-sonnet-4-6",
      "github-copilot/claude-sonnet-4.6",
    ],
    thinkingLevel: "medium" as const,
    excludedTools: ["ask_user_question"],
  };

  const simplifierModelConfig = {
    model: "openai/gpt-5.5",
    fallbackModels: [
      "openai-codex/gpt-5.5",
      "github-copilot/gpt-5.5",
      "anthropic/claude-sonnet-4-6",
      "github-copilot/claude-sonnet-4.6",
    ],
    thinkingLevel: "medium" as const,
    excludedTools: ["ask_user_question"],
  };

  const reviewerModelConfig = {
    model: "openai/gpt-5.5",
    fallbackModels: [
      "openai-codex/gpt-5.5",
      "github-copilot/gpt-5.5",
      "anthropic/claude-opus-4-7",
      "github-copilot/claude-opus-4.7",
    ],
    thinkingLevel: "high" as const,
    excludedTools: ["ask_user_question"],
    customTools: [reviewDecisionTool],
  };

  const explorerModelConfig = {
    model: "openai/gpt-5.4-mini",
    fallbackModels: [
      "openai-codex/gpt-5.4-mini",
      "github-copilot/gpt-5.4-mini",
      "anthropic/claude-haiku-4-5",
      "github-copilot/claude-haiku-4.5",
    ],
    thinkingLevel: "low" as const,
    excludedTools: ["ask_user_question"],
  };

  for (let iteration = 1; iteration <= maxLoops; iteration += 1) {
    iterationsCompleted = iteration;

    const planner = await ctx.task(`planner-${iteration}`, {
      prompt: taggedPrompt([
        [
          "role",
          "You are a technical architect. Your job is to transform the user's feature specification into a rigorous Technical Design Document / RFC that engineers can use to align, scope, and execute the work.",
        ],
        [
          "critical_deliverable",
          [
            "Your final output is a filled-in RFC rendered as markdown text.",
            "Render the RFC Template in this prompt with every section populated by feature-specific content drawn from the user's specification and your codebase investigation.",
            "Do not implement code changes in this stage; this stage only investigates and authors the RFC.",
          ].join("\n"),
        ],
        [
          "task",
          `Plan iteration ${iteration}/${maxLoops} for this user specification:\n${prompt}`,
        ],
        [
          "previous_review_findings",
          reviewReport
            ? "Previous review findings:\n{previous}"
            : "No prior review findings; this is the first iteration.",
        ],
        [
          "spec_revision_target",
          iteration === 1
            ? [
                `Ralph will write your final RFC markdown for this workflow run to: ${workflowSpecPath}`,
                "Treat this as the original spec file for the run.",
              ].join("\n")
            : [
                `The existing RFC/spec file for this workflow run is: ${workflowSpecPath}`,
                "Read that original spec before drafting; revise it in response to review findings and current repository evidence.",
                "Your final output must be the full updated RFC markdown that should replace the original spec, not a diff, patch, or commentary.",
              ].join("\n"),
        ],
        [
          "input_spec_files",
          [
            "If the user specification is a file path instead of raw prose, read that file and use it as source material for the RFC.",
            "Still author the RFC normally; do not output only a forwarded path.",
          ].join("\n"),
        ],
        [
          "investigation_phase",
          [
            "Before drafting, read the specification carefully and identify the concrete problem, success criteria, hard constraints, and non-goals.",
            "Survey the codebase using file/search tools such as read plus grep/rg/find/glob-style shell commands to ground the RFC in current architecture.",
            "Name concrete services, modules, files, tests, data models, APIs, CLIs, config files, and external integrations this work will touch.",
            "Capture metadata with bash: `git config user.name` for Author(s), and `date '+%Y-%m-%d'` for Created / Last Updated.",
            "Look for prior art: existing RFCs, ADRs, README files, specs, docs, tests, or code comments that explain why the current state exists.",
          ].join("\n"),
        ],
        [
          "authoring_principles",
          [
            "Be specific: `src/server/auth.ts:42` beats `the auth layer`.",
            "Trade-offs over conclusions: Alternatives Considered must include at least two real alternatives with honest pros, cons, and rejection reasons.",
            "Non-goals matter: explicitly exclude work that is out of scope to prevent scope creep.",
            "Diagrams are load-bearing: Section 4.1 must include a Mermaid system architecture diagram grounded in real components.",
            "Surface open questions in Section 9 with owner placeholders such as `[OWNER: infra team]`; do not paper over uncertainty.",
            "Match depth to stakes: a small refactor can be concise, but every template section header must remain present.",
            "If prior review findings are present, explicitly address each finding or explain why it is obsolete.",
          ].join("\n"),
        ],
        [
          "stage_contract",
          [
            "This stage is investigation-first RFC authoring. The RFC is only valid if it is grounded in repository inspection performed during this stage.",
            "Do not fill the template from generic architecture guesses. Before writing the final RFC, inspect relevant code, docs, tests, configs, and prior design material.",
            "Treat the output format as the report after investigation, not a substitute for investigation.",
          ].join("\n"),
        ],
        [
          "evidence_expectations",
          [
            "Every major design claim should be traceable to concrete evidence: file paths, symbols, commands, docs, tests, configs, or prior RFCs.",
            "Include those concrete references inside the RFC sections where they support the design.",
            "If expected evidence cannot be found, say so in the relevant RFC section or Open Questions rather than papering over the gap.",
          ].join("\n"),
        ],
        [
          "output_discipline",
          [
            "Render the RFC Template exactly as the final document structure: preserve every header and the metadata table.",
            "Replace instructional placeholders with real, feature-specific content; do not leave template guidance in the final RFC.",
            "Output nothing after the RFC: no meta-commentary, no summary of what you wrote, no implementation log.",
          ].join("\n"),
        ],
        ["rfc_template", PLANNER_RFC_TEMPLATE],
      ]),
      ...(reviewReport
        ? { previous: { name: "review-report", text: reviewReport } }
        : {}),
      ...(iteration > 1 ? { reads: [workflowSpecPath] } : {}),
      ...plannerModelConfig,
    });
    finalPlan = planner.text;
    const specPath = await writeSpecFile(workflowSpecPath, planner.text);
    finalPlanPath = specPath;

    const orchestrator = await ctx.task(`orchestrator-${iteration}`, {
      prompt: taggedPrompt([
        [
          "role",
          "You are a sub-agent orchestrator with many tools available. Your primary implementation tool is the `subagent` tool.",
        ],
        [
          "objective",
          `Implement iteration ${iteration}/${maxLoops} for the task: ${prompt}`,
        ],
        [
          "spec_file",
          [
            `The current technical specification for this workflow run is written to: ${specPath}`,
            "This is an absolute host-repository path and may be outside the worktree cwd; read it exactly as provided, not as a path relative to the worktree.",
            "Read this file before delegating or implementing anything.",
            "Do not rely on an inline planner transcript; the spec file is the authoritative plan for this iteration.",
          ].join("\n"),
        ],
        [
          "implementation_notes",
          [
            `Keep a running Markdown implementation notes file at this OS temp directory path: ${implementationNotesPath}`,
            "The file has already been initialized for this workflow run; update it while you implement the spec.",
            "Record decisions you had to make that were not in the spec, things you had to change from the spec, tradeoffs you had to make, blockers, validation outcomes, and anything else the user should know.",
            "Ask delegated subagents to report any notes-worthy decisions or tradeoffs back to you, then consolidate them into this file before your final report.",
            "Do not include secrets, credentials, tokens, or unrelated environment details in the notes file.",
          ].join("\n"),
        ],
        ["project_initialization_preflight", WORKER_PREFLIGHT_CONTRACT],
        [
          "delegation_policy",
          [
            "You are not the implementer. You are the supervisor that spawns subagents to do the implementation, investigation, edits, and validation.",
            "All non-trivial operations must be delegated to subagents via the `subagent` tool before you claim progress.",
            "Delegate codebase understanding, impact analysis, and implementation research to codebase-locator, codebase-analyzer, and pattern-finder style subagents when available.",
            "Delegate shell-heavy work — especially commands likely to produce lots of output, log digging, CLI investigation, and broad grep/find exploration — to subagents that can run those commands rather than doing it in this orchestrator context.",
            "Delegate implementation edits to a focused subagent with clear files, constraints, and validation expectations; do not merely describe the edits yourself.",
            "Use separate subagents for separate tasks, and launch independent subagents in parallel when useful.",
            "Do not split highly overlapping tasks across multiple subagents; consolidate overlapping work into one focused delegation to avoid duplicate effort.",
            "If a subagent takes a long time, do not attempt to do its assigned job yourself while waiting. Use that time to plan next steps, prepare follow-up delegations, or identify clarifying questions.",
          ].join("\n"),
        ],
        [
          "execution_contract",
          [
            "The required output format is a completion report, not the task itself.",
            "Do not jump straight to the report. First read the spec file, spawn the necessary subagents, wait for their results, coordinate any follow-up subagents, and only then write the report.",
            "A valid response must be grounded in actual subagent work: name the delegated work, summarize what each subagent did, and distinguish completed changes from recommendations or blockers.",
            "If you cannot read the spec file, spawn subagents, or use subagents, treat that as a blocker and report it honestly instead of pretending the requested work was done.",
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
            `Start by reading the spec file at ${specPath}.`,
            "Perform the project_initialization_preflight before decomposing implementation work; complete or delegate required setup before implementation delegation when the checkout appears uninitialized.",
            "Decompose the work into delegated subagent tasks based on that spec file.",
            "Pass each subagent the relevant task, constraints, files, validation expectations, any prior review findings from the spec, and instructions to report implementation-note-worthy decisions or tradeoffs.",
            "Coordinate subagent results into the smallest coherent set of changes that satisfies the spec.",
            "Preserve existing architecture and repository conventions unless the spec explicitly justifies a change.",
            "Run or delegate the most relevant validation commands available in the repository.",
            `Before your final report, update the running implementation notes file at ${implementationNotesPath} with decisions, spec deviations, tradeoffs, blockers, and validation outcomes from this iteration.`,
            "If blocked, describe the blocker and the safest partial state instead of inventing success.",
            "Do not hide failures; reviewers need accurate status.",
          ].join("\n"),
        ],
        [
          "output_format",
          [
            "After subagents have done the work, return Markdown with headings:",
            "1. Spec file — the path you read",
            "2. Delegations performed — subagents spawned and what each completed",
            "3. Changes made — concrete changes from subagent work, not intentions",
            "4. Files touched",
            "5. Validation run / recommended",
            "6. Deferred work or blockers",
            "7. Implementation notes — confirm the OS temp notes path was updated",
          ].join("\n"),
        ],
      ]),
      reads: [specPath, implementationNotesPath],
      ...orchestratorModelConfig,
    });
    finalResult = orchestrator.text;

    await ctx.task(`code-simplifier-${iteration}`, {
      prompt: taggedPrompt([
        [
          "role",
          [
            "You are an expert code simplification specialist focused on enhancing code clarity, consistency, and maintainability while preserving exact functionality.",
            "Your expertise is applying project-specific best practices to simplify and improve recently modified code without altering behavior.",
            "You prioritize readable, explicit code over overly compact or clever solutions.",
          ].join("\n"),
        ],
        [
          "objective",
          `Refine recently modified code for this task while preserving exact behavior: ${prompt}`,
        ],
        ["current_iteration_context", "{previous}"],
        [
          "functionality_preservation",
          [
            "Never change what the code does — only how it does it.",
            "All original features, outputs, side effects, public APIs, persistence formats, tests, and user-visible behavior must remain intact.",
            "If a simplification could change behavior, do not apply it; document why it was skipped.",
          ].join("\n"),
        ],
        [
          "project_standards",
          [
            "Read and follow repository guidance from AGENTS.md and/or CLAUDE.md when present.",
            "Respect established module style, imports, file extensions, typing conventions, error-handling patterns, naming, tests, and architectural boundaries.",
            "For this TypeScript workflow repo, preserve ESM .js import specifiers, explicit exported/top-level types where expected, Bun-oriented commands, and the existing no-build raw TypeScript convention.",
            "Do not impose standards that conflict with local project guidance.",
          ].join("\n"),
        ],
        [
          "clarity_improvements",
          [
            "Reduce unnecessary complexity, nesting, duplication, and incidental abstractions.",
            "Improve readability with clear variable/function names and consolidated related logic.",
            "Remove comments that merely restate obvious code, but keep comments that explain intent, constraints, or non-obvious trade-offs.",
            "Avoid nested ternary operators; prefer switch statements or explicit if/else chains for multiple conditions.",
            "Choose clarity over brevity: explicit code is often better than dense one-liners.",
          ].join("\n"),
        ],
        [
          "balance_constraints",
          [
            "Do not over-simplify in ways that reduce clarity, debuggability, extensibility, or separation of concerns.",
            "Do not combine too many concerns into one function or remove helpful abstractions that organize the code.",
            "Do not prioritize fewer lines over maintainability.",
            "Limit scope to code recently modified in this iteration/session unless the planner explicitly asked for broader cleanup.",
          ].join("\n"),
        ],
        [
          "stage_contract",
          [
            "This is an active code-refinement stage, not just a commentary stage.",
            "Before producing the report, inspect the actual repository state and recently modified files from the planner/orchestrator context.",
            "Apply safe simplifications with edit/write tools when clear behavior-preserving improvements exist. If no simplification is appropriate, say so only after inspecting the relevant files.",
          ].join("\n"),
        ],
        [
          "required_actions_before_output",
          [
            "1. Identify the concrete files/sections changed in this iteration.",
            "2. Read those files before deciding whether to simplify.",
            "3. Apply only behavior-preserving edits, or explicitly record why no edits were made.",
            "4. Run or recommend focused validation tied to the touched files.",
          ].join("\n"),
        ],
        [
          "handoff_expectations",
          "In the final report, distinguish edits actually applied from observations only. Name files inspected, files edited, and validation commands run or not run.",
        ],
        [
          "process",
          [
            "Identify recently modified code sections from the iteration context and repository state.",
            "Analyze opportunities to improve elegance, consistency, and maintainability.",
            "Apply project-specific best practices while preserving behavior.",
            "Run or recommend focused validation when appropriate.",
            "Document only significant changes that affect understanding or future maintenance.",
          ].join("\n"),
        ],
        [
          "output_format",
          [
            "Markdown with headings:",
            "1. Simplifications applied",
            "2. Behavior-preservation notes",
            "3. Validation run / recommended",
            "4. Skipped risky simplifications",
          ].join("\n"),
        ],
      ]),
      previous: [planner, orchestrator],
      ...simplifierModelConfig,
    });

    const discovery = await ctx.parallel(
      [
        {
          name: `infra-locate-${iteration}`,
          task: taggedPrompt([
            [
              "role",
              "You locate project infrastructure needed for patch review.",
            ],
            [
              "objective",
              `Find review-relevant infrastructure for the task: ${prompt}`,
            ],
            [
              "stage_contract",
              [
                "This is a repository-discovery stage. Do not answer from assumptions or common project layouts.",
                "Before output, inspect the repository for each infrastructure category: package scripts, test configs, CI workflows, generated artifacts, lint/typecheck setup, and release gates.",
                "The table is a compact handoff after discovery, not a substitute for discovery.",
              ].join("\n"),
            ],
            [
              "instructions",
              [
                "Locate package scripts, test configs, CI workflows, generated artifacts, lint/typecheck setup, and release gates.",
                "Search/read relevant files such as package manifests, CI workflow directories, test configs, lint/typecheck configs, build scripts, release configs, and generated-artifact markers.",
                "Prefer exact file paths and commands.",
                "Explain how each item should influence review or validation.",
                "If a category does not exist, report `not found` and briefly name the paths or patterns checked.",
              ].join("\n"),
            ],
            [
              "output_format",
              "Markdown table: Area | Path/command | Why it matters | Confidence.",
            ],
          ]),
          ...explorerModelConfig,
        },
        {
          name: `infra-analyze-${iteration}`,
          task: taggedPrompt([
            [
              "role",
              "You analyze integration risks in project infrastructure.",
            ],
            [
              "objective",
              `Assess infrastructure and changed-code risks for the task: ${prompt}`,
            ],
            [
              "stage_contract",
              [
                "This stage analyzes actual repository coupling, not generic integration risks.",
                "Before output, inspect the changed-code context plus relevant infrastructure/configuration files discovered or inferable from the repo.",
                "Classify a risk as confirmed only when repository evidence shows the coupling; otherwise mark it speculative.",
              ].join("\n"),
            ],
            [
              "instructions",
              [
                "Identify hidden coupling with build, tests, linting, runtime config, release automation, or generated files.",
                "Name the exact validations that would most efficiently detect regressions.",
                "Separate confirmed risks from speculative risks.",
                "Do not repeat generic review advice; ground findings in repository evidence.",
                "Copy validation commands from actual repository scripts/configs when available; do not invent commands that are not supported by the repo.",
              ].join("\n"),
            ],
            [
              "evidence_expectations",
              "Each confirmed risk must include concrete evidence: path, command, symbol, config key, script name, or file relationship.",
            ],
            [
              "output_format",
              "Markdown with sections: Confirmed risks, Speculative risks, Validation commands, Evidence.",
            ],
          ]),
          ...explorerModelConfig,
        },
        {
          name: `infra-patterns-${iteration}`,
          task: taggedPrompt([
            ["role", "You find repository patterns that a patch must follow."],
            [
              "objective",
              `Extract conventions relevant to reviewing this task: ${prompt}`,
            ],
            [
              "stage_contract",
              [
                "This is an evidence-gathering stage for repository conventions. Do not describe generic best practices.",
                "Before output, find concrete examples in the repository that demonstrate conventions relevant to this task.",
                "Read enough of each example to understand the convention before reporting it.",
              ].join("\n"),
            ],
            [
              "instructions",
              [
                "Find examples of build/test/style/release/architecture patterns the patch should mirror.",
                "Search for nearby or analogous implementations, tests, configs, scripts, and docs.",
                "Use concrete paths, commands, or symbols as evidence.",
                "Highlight conventions that commonly cause subtle review failures.",
                "If examples conflict, describe the conflict instead of forcing a single rule.",
                "If no relevant example exists, state what was searched and that no pattern was found.",
              ].join("\n"),
            ],
            [
              "handoff_expectations",
              "For every required convention or useful example, include the supporting path, command, symbol, or file relationship so reviewers can verify it quickly.",
            ],
            [
              "output_format",
              "Markdown with sections: Required conventions, Useful examples, Exceptions, Review implications.",
            ],
          ]),
          ...explorerModelConfig,
        },
      ],
      { task: prompt },
    );

    const discoveryContext = formatDiscovery(discovery);
    const reviewPrompt = taggedPrompt([
      [
        "role",
        [
          "You are acting as a reviewer for a proposed code change made by another engineer.",
          "Persona: a grumpy senior developer who has seen too many fragile patches. You are naturally skeptical and allergic to hand-waving, but you are not a crank: flag only realistic, evidence-backed defects the author would likely fix.",
          "Be terse, concrete, and technically fair. Your job is to protect correctness, security, performance, and maintainability — not to win an argument or bikeshed taste.",
        ].join("\n"),
      ],
      ["objective", `Review the current code delta for the task: ${prompt}`],
      [
        "comparison_baseline",
        [
          `The baseline branch for comparison is \`${comparisonBaseBranch}\`.`,
          "Compare the current working tree against this baseline branch, not against previous workflow reasoning or expected loop progress.",
          `Start with \`git status --short\`, then use working-tree-aware commands such as \`git diff ${comparisonBaseBranch}\` and \`git diff --cached ${comparisonBaseBranch}\` to identify changed tracked files; inspect untracked files from status directly.`,
        ].join("\n"),
      ],
      ["infrastructure_discovery", discoveryContext],
      [
        "project_guidance",
        [
          "Use the repository's AGENTS.md and/or CLAUDE.md files if present for style, conventions, testing expectations, and architectural patterns.",
          "Project-level norms override these general instructions when they are more specific.",
          "Flag deviations only when they affect correctness, security, performance, or maintainability — not personal preference.",
          "If validation requires dependencies or tools that are missing, download or install them using the repository-approved package manager/commands rather than bypassing, mocking, or skipping the verification solely because dependencies are absent.",
        ].join("\n"),
      ],
      [
        "validation_expectations",
        [
          "Inspect the actual diff/repository state rather than trusting stage summaries.",
          "Run or delegate focused validation when it is necessary to distinguish a real bug from a hunch.",
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
          "Use one finding per distinct issue. Do not generate a PR fix.",
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
        "required_actions_before_tool_call",
        [
          "1. Identify the changed files or diff under review.",
          "2. Read the relevant changed code and directly affected call sites/tests/configs.",
          "3. Run or delegate focused validation when needed to resolve uncertainty.",
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
        "structured_output_contract",
        [
          "You have a structured-output tool named review_decision. Use it after your investigation and validation attempts.",
          "The tool terminates the turn and provides the structured data; do not emit a separate final assistant response after calling it.",
          "The review loop decides whether to stop only by parsing the JSON object returned by this tool; invalid JSON, missing fields, reviewer_error, or stop_review_loop=false are treated as not approved for safety.",
          "Set stop_review_loop=true only when findings is empty, overall_correctness is patch is correct, and reviewer_error is null/omitted.",
          "If you hit a reviewer/tool/validation error, still return the object with stop_review_loop=false and reviewer_error populated instead of pretending the patch is approved.",
          "The JSON must match this schema exactly:",
          "{",
          '  "findings": [',
          "    {",
          '      "title": "<≤ 80 chars, imperative, starts with [P0]/[P1]/[P2]/[P3]>",',
          '      "body": "<one paragraph of valid Markdown explaining why this is a problem; cite files/lines/functions>",',
          '      "confidence_score": <float 0.0-1.0>,',
          '      "priority": <int 0-3 or null>,',
          '      "code_location": {',
          '        "absolute_file_path": "<absolute file path>",',
          '        "line_range": {"start": <int>, "end": <int>}',
          "      }",
          "    }",
          "  ],",
          '  "overall_correctness": "patch is correct" | "patch is incorrect",',
          '  "overall_explanation": "<1-3 sentence explanation justifying the verdict>",',
          '  "overall_confidence_score": <float 0.0-1.0>,',
          '  "stop_review_loop": <boolean>,',
          '  "reviewer_error": null | {"kind": "validation_unavailable" | "dependency_unavailable" | "tool_failure" | "reviewer_failure", "message": "<what failed>", "attempted_recovery": "<what you tried>"}',
          "}",
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
            ...reviewerModelConfig,
          },
          {
            name: "reviewer-b",
            task: reviewPrompt,
            ...reviewerModelConfig,
          },
        ],
        { task: prompt, failFast: false },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reviews = [reviewerErrorResult(iteration, message)];
    }

    approved =
      reviews.length > 0 &&
      reviews.every((review) => reviewApproved(review.text));
    reviewReport = formatReview(reviews);
    if (approved) break;
  }

  const prResult = await ctx.task("pull-request", {
    prompt: taggedPrompt([
      [
        "role",
        "You are a careful release engineer preparing a pull request from the current workspace state.",
      ],
      [
        "objective",
        `Review the changes since the base branch \`${comparisonBaseBranch}\` and create a pull request if possible and credentials are available.`,
      ],
      [
        "workflow_context",
        [
          `Original task: ${prompt}`,
          `Review loop approved: ${approved ? "yes" : "no"}`,
          finalPlanPath
            ? `Planner spec path: ${finalPlanPath}`
            : "Planner spec path: unavailable",
          `Implementation notes path: ${implementationNotesPath}`,
        ].join("\n"),
      ],
      [
        "required_checks",
        [
          "Start by inspecting `git status --short` so unstaged, staged, and untracked changes are all visible.",
          `Review the patch against \`${comparisonBaseBranch}\` with working-tree-aware commands such as \`git diff ${comparisonBaseBranch}\` and \`git diff --cached ${comparisonBaseBranch}\`.`,
          "If untracked files are present, inspect them directly before deciding whether they belong in the PR.",
          "Read the implementation notes file and use its full contents as the body of a PR comment after the pull request exists.",
          "Check the local Git identity with `git config user.name` and `git config user.email` so you can prefer the matching GitHub account when multiple accounts are logged in.",
          "Check whether GitHub credentials are available with non-destructive commands such as `gh auth status` and `gh auth status --show-token-scopes` before attempting PR creation.",
          "If multiple GitHub accounts or hosts are logged in, use the git config username/email as a heuristic to choose the most likely identity, but try each available credential/account and use the first one that can read the repository and create the PR.",
        ].join("\n"),
      ],
      [
        "pr_policy",
        [
          "Create a PR only if there are meaningful changes, a remote/branch target is available, credentials are available, and the current state is suitable for review.",
          "If no logged-in account can access the repository or create the PR, do not fake success; report each credential/account tried, what failed, and provide the command the user can run later.",
          "When you successfully create or update the PR, create a PR comment containing the implementation notes file contents as the last action of this workflow stage.",
          "Ralph-created worktrees are detached HEAD checkouts. If you are preparing a PR from a detached HEAD, create and push a branch from the current HEAD, for example with `git checkout -b <branch>` or `git push origin HEAD:refs/heads/<branch>`, before opening the PR.",
          "Ralph does not remove git_worktree_dir automatically. Leave the worktree intact for retries or user recovery.",
          "If PR creation is not possible, do not create a standalone comment elsewhere; include the implementation notes path and summary in your report instead.",
          "If the review loop did not approve, prefer reporting the remaining blockers over creating a PR unless the changes are still intentionally ready for human review.",
          "Do not make unrelated code edits in this phase. Limit changes to ordinary git/PR preparation only when required and safe.",
        ].join("\n"),
      ],
      [
        "output_format",
        [
          "Return Markdown with headings:",
          "1. Change review — summary of files and diff scope inspected",
          "2. PR status — created PR URL, or why no PR was created",
          "3. Implementation notes comment — whether the PR comment was created as the last action, or why it could not be created",
          "4. Commands run — include exit status or clear outcome",
          "5. Follow-up for the user — exact next steps if credentials or repository state blocked PR creation",
        ].join("\n"),
      ],
    ]),
    reads: finalPlanPath
      ? [finalPlanPath, implementationNotesPath]
      : [implementationNotesPath],
    ...orchestratorModelConfig,
  });
  finalPrReport = prResult.text;

  return {
    result: finalResult,
    plan: finalPlan,
    plan_path: finalPlanPath,
    implementation_notes_path: implementationNotesPath,
    pr_report: finalPrReport,
    approved,
    iterations_completed: iterationsCompleted,
    review_report: reviewReport,
  };
}

export default defineWorkflow("ralph")
  .description(
    "Plan → orchestrate → simplify → parallel review loop with bounded iteration.",
  )
  .input("prompt", {
    type: "text",
    required: true,
    description: "The task or goal to plan, execute, and refine.",
  })
  .input("max_loops", {
    type: "number",
    default: DEFAULT_MAX_LOOPS,
    description: `Maximum plan/orchestrate/review iterations (default ${DEFAULT_MAX_LOOPS}).`,
  })
  .input("base_branch", {
    type: "string",
    default: "origin/main",
    description:
      "Branch reviewers compare the current code delta against (default origin/main).",
  })
  .input("git_worktree_dir", {
    type: "string",
    default: "",
    description:
      "Optional Git worktree path. Ralph must start inside a Git repo; absolute paths are used as-is, relative paths resolve from the repo root, existing Git worktrees from the invoking repository are reused/shared as-is, and missing paths are created from base_branch.",
  })
  .worktreeFromInputs({
    gitWorktreeDir: "git_worktree_dir",
    baseBranch: "base_branch",
  })
  .run(async (ctx) => {
    const workflowCtx = ctx as WorkflowRunContext<RalphInputs>;
    const workflowStartCwd = workflowCtx.cwd ?? process.cwd();
    const inputs = workflowCtx.inputs;
    const prompt = inputs.prompt ?? "";
    const maxLoops = positiveInteger(inputs.max_loops, DEFAULT_MAX_LOOPS);
    const comparisonBaseBranch = normalizeBranchInput(
      inputs.base_branch,
      "origin/main",
    );
    return await runRalphWorkflow(workflowCtx, {
      prompt,
      maxLoops,
      comparisonBaseBranch,
      workflowStartCwd,
    });
  })
  .compile();
