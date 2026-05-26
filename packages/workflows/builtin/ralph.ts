/**
 * Builtin workflow: ralph
 *
 * Re-implements the Atomic SDK Ralph design with the local workflow task
 * primitives: bounded plan → orchestrate → simplify → discover → review
 * iterations. Reviewer and discovery passes fan out with ctx.parallel(); each
 * iteration feeds review findings into the next planner with ctx.task().
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineWorkflow } from "../src/index.js";
import type { WorkflowTaskResult } from "../src/shared/types.js";

const DEFAULT_MAX_LOOPS = 10;
const IMPLEMENTATION_NOTES_FILENAME = "implementation-notes.md";

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
  readonly goal_oracle_satisfied: boolean;
  readonly receipt_assessment: string;
  readonly verification_remaining: string;
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
    "goal_oracle_satisfied",
    "receipt_assessment",
    "verification_remaining",
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
    goal_oracle_satisfied: { type: "boolean" },
    receipt_assessment: { type: "string" },
    verification_remaining: { type: "string" },
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

const GOAL_CONTRACT_TEMPLATE = `
# Goal Contract / Execution Brief

| Document Metadata      | Details                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| Author(s)              | !\`git config user.name\`                                                        |
| Status                 | Draft (WIP) / In Review (goal contract) / Approved / Implemented / Deprecated / Rejected |
| Team / Owner           |                                                                                |
| Created / Last Updated |                                                                                |

## 1. Outcome

## 2. Scope and Non-Goals

## 3. Verification Oracle

## 4. Work Surface and Execution Loop

## 5. Proof and Review Criteria

## 6. Implementation Strategy

## 7. Context and Motivation

### 7.1 Current State

### 7.2 The Problem

## 8. Bounded Work Slices

## 9. Proposed Approach

### 9.1 System Architecture Diagram

Include a Mermaid system architecture diagram grounded in the actual components this work touches.

### 9.2 Architectural Pattern

### 9.3 Key Components

| Component | Responsibility | Technology Stack | Justification |
| --------- | -------------- | ---------------- | ------------- |

## 10. Implementation Notes

### 10.1 API Interfaces

### 10.2 Data Model / Schema

### 10.3 Algorithms and State Management

## 11. Alternatives Considered

| Option | Pros | Cons | Reason for Rejection |
| ------ | ---- | ---- | -------------------- |

## 12. Cross-Cutting Concerns

### 12.1 Security and Privacy

### 12.2 Observability Strategy

### 12.3 Scalability and Capacity Planning

## 13. Validation and Rollout

### 13.1 Deployment Strategy

### 13.2 Data Migration Plan

### 13.3 Test Plan

## 14. Open Questions / Unresolved Issues
`.trim();

const GOAL_OPERATING_LOOP =
  "intent, verification oracle, work surface, execution loop, and proof";

const GOAL_METHOD_REFERENCE = [
  "Maintain a concrete goal contract for the run: intent, verification oracle, work surface, execution loop, and proof.",
  "Infer the owner outcome and a verifiable oracle from the user's task and repository evidence; do not ask the user unless the workflow is truly blocked.",
  "Treat any user-supplied planning artifacts as supporting context, not as the primary success criterion.",
  "Keep pressure on current evidence: the current worktree, artifacts, command output, tests, demos, generated files, and explicit human decisions are more authoritative than prior conversation summaries.",
  "Never call the work complete because planning, discovery, task selection, or a substantial-looking diff exists; completion requires proof mapped back to the original owner outcome.",
].join("\n");

const RECEIPT_EXPECTATIONS = [
  "Every implementation, simplification, discovery, review, and audit stage should leave a receipt reviewers can inspect.",
  "A useful receipt names what changed, files touched, commands or checks run with outcomes, artifacts produced, decisions made, blockers, residual risks, and the next safest action.",
  "Receipts should explicitly say which part of the verification oracle they support or what verification remains.",
].join("\n");

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

async function createImplementationNotesFile(prompt: string): Promise<string> {
  const notesDir = await mkdtemp(join(tmpdir(), "atomic-goal-notes-"));
  const notesPath = join(notesDir, IMPLEMENTATION_NOTES_FILENAME);
  const initialNotes = [
    "# Implementation Notes",
    "",
    `Task: ${prompt || "(empty prompt)"}`,
    "",
    "## Goal Charter",
    "",
    "- Outcome: inferred by the planner/orchestrator from the user task and repository evidence.",
    "- Scope: record allowed changes and explicit non-goals as they become clear.",
    "- Oracle: record the observable signal that proves the owner outcome is true.",
    `- Execution contract: ${GOAL_OPERATING_LOOP}`,
    "- Proof: collect receipts that map implementation and validation back to the oracle.",
    "",
    "## Work Surface State",
    "",
    "- Active work: none recorded yet.",
    "- Blocked work: none recorded yet.",
    "- Completed work: none recorded yet.",
    "- Verification status: no receipts yet.",
    "",
    "## Receipts",
    "",
    "- Record implementation decisions, deviations from the goal contract, tradeoffs, blockers, validation notes, artifacts, and anything else the user should know.",
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
    if (typeof parsed.goal_oracle_satisfied !== "boolean") return undefined;
    if (typeof parsed.receipt_assessment !== "string") return undefined;
    if (typeof parsed.verification_remaining !== "string") return undefined;
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
    decision.goal_oracle_satisfied === true &&
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
    goal_oracle_satisfied: false,
    receipt_assessment:
      "No reviewer receipt could be produced because reviewer execution failed.",
    verification_remaining: "Recover reviewer execution and re-run oracle validation.",
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

function formatReview(results: readonly WorkflowTaskResult[]): string {
  return results
    .map((result) => `### ${result.name}\n\n${result.text}`)
    .join("\n\n---\n\n");
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
  .run(async (ctx) => {
    const inputs = ctx.inputs as {
      prompt?: string;
      max_loops?: number;
      base_branch?: string;
    };
    const prompt = inputs.prompt ?? "";
    const maxLoops = positiveInteger(inputs.max_loops, DEFAULT_MAX_LOOPS);
    const comparisonBaseBranch = normalizeBranchInput(inputs.base_branch, "origin/main");

    let reviewReport = "";
    let finalPlan = "";
    let finalPlanPath = "";
    let finalResult = "";
    let finalPrReport = "";
    const implementationNotesPath = await createImplementationNotesFile(prompt);
    const goalContractPath = join(dirname(implementationNotesPath), "goal-contract.md");
    let approved = false;
    let iterationsCompleted = 0;

    let noAskQuestionToolSet = [
      "read",
      "bash",
      "edit",
      "write",
      "todo",
      "subagent",
      "web_search",
      "code_search",
      "fetch_content",
      "get_search_content",
      "intercom",
    ];

    let plannerModelConfig = {
      model: "openai/gpt-5.5",
      fallbackModels: [
        "openai-codex/gpt-5.5",
        "github-copilot/gpt-5.5",
        "anthropic/claude-opus-4-7",
        "github-copilot/claude-opus-4.7",
      ],
      thinkingLevel: "high" as const,
      tools: noAskQuestionToolSet,
    };

    let orchestratorModelConfig = {
      model: "openai/gpt-5.5",
      fallbackModels: [
        "openai-codex/gpt-5.5",
        "github-copilot/gpt-5.5",
        "anthropic/claude-sonnet-4-6",
        "github-copilot/claude-sonnet-4.6",
      ],
      thinkingLevel: "medium" as const,
      tools: noAskQuestionToolSet,
    };

    let simplifierModelConfig = {
      model: "openai/gpt-5.5",
      fallbackModels: [
        "openai-codex/gpt-5.5",
        "github-copilot/gpt-5.5",
        "anthropic/claude-sonnet-4-6",
        "github-copilot/claude-sonnet-4.6",
      ],
      thinkingLevel: "medium" as const,
      tools: noAskQuestionToolSet,
    };

    let reviewerModelConfig = {
      model: "openai/gpt-5.5",
      fallbackModels: [
        "openai-codex/gpt-5.5",
        "github-copilot/gpt-5.5",
        "anthropic/claude-opus-4-7",
        "github-copilot/claude-opus-4.7",
      ],
      thinkingLevel: "high" as const,
      tools: noAskQuestionToolSet,
      customTools: [reviewDecisionTool],
    };

    for (let iteration = 1; iteration <= maxLoops; iteration += 1) {
      iterationsCompleted = iteration;

      const planner = await ctx.task(`planner-${iteration}`, {
        prompt: taggedPrompt([
          [
            "role",
            "You are a technical architect. Your job is to transform the user's task into a goal charter, verification oracle, review criteria, and supporting goal contract that engineers can use to execute against evidence.",
          ],
          ["goal_framework", GOAL_METHOD_REFERENCE],
          [
            "critical_deliverable",
            [
              "Your final output is a filled-in goal contract rendered as markdown text, with explicit outcome, scope, verification oracle, work surface, and proof sections.",
              "Render the goal contract template in this prompt with every section populated by feature-specific content drawn from the user's task and your codebase investigation.",
              "The goal contract artifact supports implementation, but the primary success criterion is whether receipts and verification prove the inferred owner outcome.",
              "Do not implement code changes in this stage; this stage only investigates, infers the verification contract, and authors the goal contract.",
            ].join("\n"),
          ],
          [
            "task",
            `Plan iteration ${iteration}/${maxLoops} for this user task:\n${prompt}`,
          ],
          [
            "previous_review_findings",
            reviewReport
              ? "Previous review findings:\n{previous}"
              : "No prior review findings; this is the first iteration.",
          ],
          [
            "input_goal_contract_files",
            [
              "If the user task is a file path instead of raw prose, read that file and use it as source material for the goal contract.",
              "Still author the goal contract normally; do not output only a forwarded path.",
            ].join("\n"),
          ],
          [
            "investigation_phase",
            [
              "Before drafting, read the task carefully and infer the concrete goal contract: outcome, scope, non-goals, verification oracle, work surface, proof expectations, and review criteria tied to the oracle.",
              "Survey the codebase using file/search tools such as read plus grep/rg/find/glob-style shell commands to ground the goal contract in current architecture.",
              "Name concrete services, modules, files, tests, data models, APIs, CLIs, config files, and external integrations this work will touch.",
              "Capture metadata with bash: `git config user.name` for Author(s), and `date '+%Y-%m-%d'` for Created / Last Updated.",
              "Look for prior art: existing goal contracts, ADRs, README files, plans, docs, tests, or code comments that explain why the current state exists.",
            ].join("\n"),
          ],
          [
            "authoring_principles",
            [
              "Be specific: `src/server/auth.ts:42` beats `the auth layer`.",
              "Trade-offs over conclusions: Alternatives Considered must include at least two real alternatives with honest pros, cons, and rejection reasons.",
              "Non-goals matter: explicitly exclude work that is out of scope to prevent scope creep.",
              "Diagrams are load-bearing when architecture changes are involved: include a Mermaid system architecture diagram grounded in real components in Section 9.1; for non-architecture work, state why no diagram is needed.",
              "Surface open questions in Section 14 with owner placeholders such as `[OWNER: infra team]`; do not paper over uncertainty, but make the workflow autonomous by choosing safe defaults and verifiable assumptions when possible.",
              "Match depth to stakes: a small refactor can be concise, but every template section header must remain present.",
              "If prior review findings are present, explicitly address each finding or explain why it is obsolete.",
              "For Sections 1-5, include review criteria tied to the oracle, not document-completeness criteria.",
            ].join("\n"),
          ],
          [
            "stage_contract",
            [
              "This stage is investigation-first goal-charter and goal contract authoring. The goal contract is only valid if it is grounded in repository inspection performed during this stage.",
              "Do not fill the template from generic architecture guesses. Before writing the final goal contract, inspect relevant code, docs, tests, configs, and prior design material.",
              "Treat the output format as the report after investigation, not a substitute for investigation.",
              "Treat the goal contract as supporting context rather than the primary success criterion; success is receipt-backed satisfaction of the verification oracle.",
            ].join("\n"),
          ],
          [
            "evidence_expectations",
            [
              "Every major design claim should be traceable to concrete evidence: file paths, symbols, commands, docs, tests, configs, or prior goal contracts.",
              "Include those concrete references inside the goal contract sections where they support the design.",
              "For the verification oracle, name the observable proof signal: passing tests, browser walkthrough, generated artifact, benchmark, migration result, demo transcript, source-backed answer, or explicit human decision.",
              "If expected evidence cannot be found, say so in the relevant goal contract section or Open Questions rather than papering over the gap.",
            ].join("\n"),
          ],
          [
            "output_discipline",
            [
              "Render the goal contract template exactly as the final document structure: preserve every header and the metadata table.",
              "Replace instructional placeholders with real, feature-specific content; do not leave template guidance in the final goal contract.",
              "Output nothing after the goal contract: no meta-commentary, no summary of what you wrote, no implementation log.",
            ].join("\n"),
          ],
          ["goal_contract_template", GOAL_CONTRACT_TEMPLATE],
        ]),
        ...(reviewReport
          ? { previous: { name: "review-report", text: reviewReport } }
          : {}),
        ...plannerModelConfig,
      });
      finalPlan = planner.text;
      await writeFile(goalContractPath, planner.text.endsWith("\n") ? planner.text : `${planner.text}\n`, {
        encoding: "utf8",
        flag: "w",
      });
      finalPlanPath = goalContractPath;

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
          ["goal_framework", GOAL_METHOD_REFERENCE],
          [
            "goal_contract_file",
            [
              `The goal contract for this iteration was written to: ${goalContractPath}`,
              "Read this file before delegating or implementing anything, especially the outcome, scope, verification oracle, work surface, and proof sections.",
              "Do not rely on an inline planner transcript; the goal contract file is the authoritative supporting plan for this iteration.",
              "The goal contract is not the finish line: the finish line is receipt-backed proof that the verification oracle is satisfied.",
            ].join("\n"),
          ],
          [
            "implementation_notes",
            [
              `Keep a running Markdown implementation notes file at this OS temp directory path: ${implementationNotesPath}`,
              "The file has already been initialized for this workflow run; update it while you implement the goal contract.",
              "Maintain the Goal Charter, Work Surface State, and Receipts sections while you implement.",
              "Record active work, blocked work, completed work, verification status, decisions you had to make that were not in the goal contract, things you had to change from the goal contract, tradeoffs you had to make, blockers, validation outcomes, and anything else the user should know.",
              "Ask delegated subagents to report receipts and any notes-worthy decisions or tradeoffs back to you, then consolidate them into this file before your final report.",
              "Do not include secrets, credentials, tokens, or unrelated environment details in the notes file.",
            ].join("\n"),
          ],
          [
            "project_initialization_preflight",
            [
              "Before normal implementation delegation, determine whether this checkout appears initialized for its actual language, framework, and build system.",
              "Do not rely on hard-coded assumptions about JavaScript, TypeScript, Python, Rust, Go, Java, mobile, or any other ecosystem. Infer the project type and setup requirements from repository evidence.",
              "Inspect source layout, setup docs, package/build manifests, lockfiles, toolchain files, generated-artifact conventions, CI workflows, workflow configuration, and package scripts or equivalent task definitions.",
              "Look for evidence that dependencies, generated files, local toolchains, submodules, codegen outputs, or other project-specific initialization artifacts are missing for this checkout.",
              "When repository evidence shows missing initialization, run or delegate the appropriate documented setup command before implementation work.",
              "You are responsible for initializing the checkout when setup commands are documented; missing dependencies, generated files, or local toolchains are setup work, not user handoff work.",
              "Once setup succeeds, continue normal implementation orchestration. Do not treat missing dependencies or generated setup artifacts in a fresh worktree as implementation failures.",
              "If setup requirements cannot be determined confidently, delegate a focused discovery task before implementation instead of guessing.",
              "If setup remains blocked after evidence-based discovery and setup attempts, report the blocker with commands tried and the exact evidence needed to continue.",
            ].join("\n"),
          ],
          [
            "delegation_policy",
            [
              "You are not the implementer. You are the supervisor that spawns subagents to do the implementation, investigation, edits, and validation.",
              "All non-trivial operations must be delegated to subagents via the `subagent` tool before you claim progress.",
              "Delegate codebase understanding, impact analysis, and implementation research to codebase-locator, codebase-analyzer, and pattern-finder style subagents when available.",
              "Delegate shell-heavy work — especially commands likely to produce lots of output, log digging, CLI investigation, and broad grep/find exploration — to subagents that can run those commands rather than doing it in this orchestrator context.",
              "Delegate implementation edits to a focused subagent with clear files, constraints, validation expectations, and the receipts it must return; do not merely describe the edits yourself.",
              "Choose the largest safe useful slice for each write delegation: safe means bounded, explicit, verified, and reversible, not tiny.",
              "Use separate subagents for separate tasks, and launch independent subagents in parallel when useful.",
              "Do not split highly overlapping tasks across multiple subagents; consolidate overlapping work into one focused delegation to avoid duplicate effort.",
              "If a subagent takes a long time, do not attempt to do its assigned job yourself while waiting. Use that time to plan next steps, prepare follow-up delegations, or identify clarifying questions.",
            ].join("\n"),
          ],
          [
            "execution_contract",
            [
              "The required output format is a completion report, not the task itself.",
              "Do not jump straight to the report. First read the goal contract file, spawn the necessary subagents, wait for their results, coordinate any follow-up subagents, and only then write the report.",
              "A valid response must be grounded in actual subagent work: name the delegated work, summarize what each subagent did, preserve its receipt, and distinguish completed changes from recommendations or blockers.",
              "If you cannot read the goal contract file, spawn subagents, or use subagents, treat that as a blocker and report it honestly instead of pretending the requested work was done.",
            ].join("\n"),
          ],
          [
            "subagent_tracking",
            [
              "Use the `todo` tool as your active control ledger for subagent work.",
              "Before launching subagents, create todo items for each delegated task with enough detail to identify owner, purpose, and expected output.",
              "Mark todo items in_progress when the corresponding subagent starts, append progress/results/receipts as subagents report back, and close them only after you have incorporated or explicitly rejected their result.",
              "Keep pending, in_progress, blocked, completed, and verification status accurate so you do not lose track of parallel subagents or unresolved follow-ups.",
              "Before writing the final report, review the todo list and resolve every pending/in_progress item as completed, blocked, or deferred with an explanation.",
            ].join("\n"),
          ],
          [
            "instructions",
            [
              `Start by reading the goal contract file at ${goalContractPath}.`,
              "Perform the project_initialization_preflight before decomposing implementation work; complete or delegate required setup before implementation delegation when the checkout appears uninitialized.",
              "Decompose the work into delegated subagent tasks based on that goal contract file.",
              "Pass each subagent the relevant task, constraints, files, validation expectations, verification oracle, any prior review findings from the goal contract, and instructions to return a receipt: changed files, checks run, artifacts, decisions, blockers, residual risks, and what remains to verify.",
              "Coordinate subagent results into the largest safe useful slice that advances the owner outcome and remains reversible and verifiable.",
              "Preserve existing architecture and repository conventions unless the goal contract explicitly justifies a change.",
              "Run or delegate the most relevant validation commands available in the repository.",
              `Before your final report, update the running implementation notes file at ${implementationNotesPath} with the current Goal Charter, Work Surface State, receipts, decisions, goal-contract deviations, tradeoffs, blockers, and validation outcomes from this iteration.`,
              "If a specific slice is blocked, record that blocker and continue adjacent safe local work that advances the full goal when possible; do not treat one blocked slice as a completed goal.",
              "Do not hide failures; reviewers need accurate status.",
            ].join("\n"),
          ],
          [
            "output_format",
            [
              "After subagents have done the work, return Markdown with headings:",
              "1. Goal contract file — the path you read",
              "2. Goal contract — the inferred outcome, scope, verification oracle, and proof loop used",
              "3. Work surface state — active, blocked, completed, and verification status",
              "4. Delegations performed — subagents spawned and what each completed",
              "5. Receipts — concrete evidence from each stage, including changed files, checks, artifacts, decisions, and risks",
              "6. Changes made — concrete changes from subagent work, not intentions",
              "7. Files touched",
              "8. Validation run / recommended — map each check to the verification oracle",
              "9. Deferred work or blockers",
              "10. Implementation notes — confirm the OS temp notes path was updated",
            ].join("\n"),
          ],
        ]),
        reads: [goalContractPath, implementationNotesPath],
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
            `Refine recently modified code for this task while preserving exact behavior and the verification oracle: ${prompt}`,
          ],
          ["goal_framework", GOAL_METHOD_REFERENCE],
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
            [
              "In the final report, distinguish edits actually applied from observations only. Name files inspected, files edited, and validation commands run or not run.",
              "Produce a receipt that maps simplifications and validation back to the verification oracle or explicitly says no oracle-relevant simplification was needed.",
            ].join("\n"),
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
              "2. Receipt — files inspected/edited, checks run, artifacts, and oracle relevance",
              "3. Behavior-preservation notes",
              "4. Validation run / recommended",
              "5. Skipped risky simplifications",
            ].join("\n"),
          ],
        ]),
        previous: [planner, orchestrator],
        ...simplifierModelConfig,
      });

      const reviewPrompt = taggedPrompt([
        [
          "role",
          [
            "You are acting as a reviewer for a proposed code change made by another engineer.",
            "Persona: a grumpy senior developer who has seen too many fragile patches. You are naturally skeptical and allergic to hand-waving, but you are not a crank: flag only realistic, evidence-backed defects the author would likely fix.",
            "Be terse, concrete, and technically fair. Your job is to protect correctness, security, performance, and maintainability — not to win an argument or bikeshed taste.",
          ].join("\n"),
        ],
        [
          "objective",
          `Review the current code delta for the task: ${prompt}`,
        ],
        ["goal_framework", GOAL_METHOD_REFERENCE],
        ["receipt_expectations", RECEIPT_EXPECTATIONS],
        [
          "goal_context_files",
          [
            `Planner/supporting goal contract path: ${goalContractPath}`,
            `Implementation notes and receipts path: ${implementationNotesPath}`,
            "Read these files to recover the goal charter, verification oracle, work surface state, receipts, and verification claims before approving anything.",
            "Review success is whether current evidence and receipts satisfy the verification oracle, not whether the supporting goal contract looks complete.",
          ].join("\n"),
        ],
        [
          "comparison_baseline",
          [
            `The baseline branch for comparison is \`${comparisonBaseBranch}\`.`,
            "Compare the current working tree against this baseline branch, not against previous workflow reasoning or expected loop progress.",
            `Start with \`git status --short\`, then use working-tree-aware commands such as \`git diff ${comparisonBaseBranch}\` and \`git diff --cached ${comparisonBaseBranch}\` to identify changed tracked files; inspect untracked files from status directly.`,
          ].join("\n"),
        ],
        [
          "project_guidance",
          [
            "Use the repository's AGENTS.md and/or CLAUDE.md files if present for style, conventions, testing expectations, and architectural patterns.",
            "Inspect the codebase for testing, linting, typecheck, build, generated-artifact, and CI patterns that should shape review; prefer commands and conventions copied from actual repository scripts/configs over invented checks.",
            "When changed files touch an area with established test or lint patterns, compare the patch against nearby tests, package scripts, config files, and CI workflows before approving.",
            "Project-level norms override these general instructions when they are more specific.",
            "Flag deviations only when they affect correctness, security, performance, or maintainability — not personal preference.",
            "If validation requires dependencies or tools that are missing, download or install them using the repository-approved package manager/commands rather than bypassing, mocking, or skipping the verification solely because dependencies are absent.",
          ].join("\n"),
        ],
        [
          "validation_expectations",
          [
            "Inspect the actual diff/repository state rather than trusting stage summaries.",
            "Identify the smallest relevant validation set from repository evidence: targeted tests, lint, typecheck, build, generated-artifact checks, CI-equivalent scripts, or user-flow proof.",
            "When practical, include an end-to-end QA check that exercises the app the way a user would: use the tmux skill for terminal app environments and playwright-cli for web app environments.",
            "For web app environments, capture a screenshot as a certificate of correct completion when the UI state proves the oracle; for terminal app environments, capture the terminal window/output that shows proof of correctness.",
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
            "If no finding clears this bar and receipts prove the verification oracle, return an empty findings array, mark the patch correct, set goal_oracle_satisfied true, and set stop_review_loop true.",
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
            "If no such findings exist, return an empty findings array and mark the patch correct only when receipt-backed evidence also satisfies the verification oracle.",
            "Do not stop after the first qualifying finding; continue until every qualifying finding is listed.",
          ].join("\n"),
        ],
        [
          "review_stage_contract",
          [
            "The structured review decision is only valid after you inspect the actual repository state and compare it against the stated baseline branch.",
            "Do not approve based solely on workflow stage summaries or prior agent reasoning.",
            "Treat this review as the completion audit for the current iteration: approval means receipts and current evidence prove the original owner outcome against the verification oracle.",
            "Do not approve when proof only shows planning, discovery, task selection, helper documents, or a narrow slice while the broader requested outcome still has safe local work remaining.",
            "The tool call is the final verdict after review work, not a shortcut around review work.",
          ].join("\n"),
        ],
        [
          "required_actions_before_tool_call",
          [
            "1. Identify the changed files or diff under review.",
            "2. Read the relevant changed code and directly affected call sites/tests/configs.",
            "3. Read the implementation notes receipts and map them to the inferred verification oracle and original owner outcome.",
            "4. Run or delegate focused validation when needed to resolve uncertainty.",
            "5. Decide whether the receipt/evidence map proves completion; if evidence is uncertain, indirect, stale, missing, or narrower than the requested outcome, set goal_oracle_satisfied=false and stop_review_loop=false.",
            "6. If you cannot inspect receipts or validate enough to approve safely, populate reviewer_error and set stop_review_loop=false.",
          ].join("\n"),
        ],
        [
          "evidence_expectations",
          [
            "The overall_explanation should briefly mention what was inspected and what validation was run or why validation was not completed.",
            "The receipt_assessment should map concrete receipts, files, commands, artifacts, or reviewer checks back to the original owner outcome and verification oracle.",
            "The verification_remaining field should say `none` only when no oracle-relevant verification remains.",
            "Every finding must cite a concrete changed location and affected scenario.",
          ].join("\n"),
        ],
        [
          "structured_output_contract",
          [
            "You have a structured-output tool named review_decision. Use it after your investigation and validation attempts.",
            "The tool terminates the turn and provides the structured data; do not emit a separate final assistant response after calling it.",
            "The review loop decides whether to stop only by parsing the JSON object returned by this tool; invalid JSON, missing fields, reviewer_error, or stop_review_loop=false are treated as not approved for safety.",
            "Set stop_review_loop=true only when findings is empty, overall_correctness is patch is correct, goal_oracle_satisfied is true, verification_remaining is `none` or equivalent, and reviewer_error is null/omitted.",
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
            '  "goal_oracle_satisfied": <boolean>,',
            '  "receipt_assessment": "<how receipts/current evidence map to the verification oracle>",',
            '  "verification_remaining": "<oracle-relevant verification still missing, or none>",',
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
              reads: [goalContractPath, implementationNotesPath],
              ...reviewerModelConfig,
            },
            {
              name: "reviewer-b",
              task: reviewPrompt,
              reads: [goalContractPath, implementationNotesPath],
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
              ? `Planner goal contract path: ${finalPlanPath}`
              : "Planner goal contract path: unavailable",
            `Implementation notes path: ${implementationNotesPath}`,
            reviewReport
              ? `Latest reviewer decisions:\n${reviewReport}`
              : "Latest reviewer decisions: unavailable",
          ].join("\n"),
        ],
        [
          "required_checks",
          [
            "Start by inspecting `git status --short` so unstaged, staged, and untracked changes are all visible.",
            `Review the patch against \`${comparisonBaseBranch}\` with working-tree-aware commands such as \`git diff ${comparisonBaseBranch}\` and \`git diff --cached ${comparisonBaseBranch}\`.`,
            "If untracked files are present, inspect them directly before deciding whether they belong in the PR.",
            "Read the implementation notes file and latest structured reviewer decisions before deciding whether the PR is ready.",
            "Use the implementation notes contents as the body of a PR comment after the pull request exists.",
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
            "When you successfully create or update the PR, create a PR comment containing the implementation notes file contents and latest reviewer approval summary as the last action of this workflow stage.",
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
            "3. Implementation notes and reviewer approval comment — whether the PR comment was created as the last action, or why it could not be created",
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
  })
  .compile();
