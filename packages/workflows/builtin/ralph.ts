/**
 * Builtin workflow: ralph
 *
 * Re-implements the Atomic SDK Ralph design with the local workflow task
 * primitives: bounded plan → orchestrate → simplify → discover → review
 * iterations. Reviewer and discovery passes fan out with ctx.parallel(); each
 * iteration feeds review findings into the next planner with ctx.task().
 */

import { defineWorkflow } from "../src/index.js";
import type { WorkflowTaskResult } from "../src/shared/types.js";

const DEFAULT_MAX_LOOPS = 10;

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

function reviewApproved(text: string): boolean {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("patch is correct") ||
    normalized.includes("overall_correctness: patch is correct")
  ) {
    return true;
  }
  if (
    normalized.startsWith("approved") ||
    normalized.includes("no actionable findings")
  ) {
    return true;
  }
  return false;
}

function formatDiscovery(results: readonly WorkflowTaskResult[]): string {
  return results
    .map((result) => `### ${result.name}\n\n${result.text}`)
    .join("\n\n---\n\n");
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
    description: "The task or goal for ralph to plan, execute, and refine.",
  })
  .input("max_loops", {
    type: "number",
    default: DEFAULT_MAX_LOOPS,
    description: `Maximum plan/orchestrate/review iterations (default ${DEFAULT_MAX_LOOPS}).`,
  })
  .run(async (ctx) => {
    const inputs = ctx.inputs as {
      prompt?: string;
      max_loops?: number;
    };
    const prompt = inputs.prompt ?? "";
    const maxLoops = positiveInteger(inputs.max_loops, DEFAULT_MAX_LOOPS);

    let reviewReport = "";
    let finalPlan = "";
    let finalResult = "";
    let approved = false;
    let iterationsCompleted = 0;

    let noAskQuestionToolSet = ["read, bash, edit, write, todo"];

    let plannerModelConfig = {
      model: "openai/gpt-5.5",
      fallbackModels: [
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
        "github-copilot/gpt-5.5",
        "anthropic/claude-opus-4-7",
        "github-copilot/claude-opus-4.7",
      ],
      thinkingLevel: "high" as const,
      tools: noAskQuestionToolSet,
    };

    let explorerModelConfig = {
      model: "openai/gpt-5.4-mini",
      fallbackModels: [
        "github-copilot/gpt-5.4-mini",
        "anthropic/claude-haiku-4-5",
        "github-copilot/claude-haiku-4.5",
      ],
      thinkingLevel: "low" as const,
      tools: noAskQuestionToolSet,
    };

    for (let iteration = 1; iteration <= maxLoops; iteration += 1) {
      iterationsCompleted = iteration;

      const planAndExecute = await ctx.chain(
        [
          {
            name: `planner-${iteration}`,
            task: taggedPrompt([
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
                "short_circuit",
                [
                  "If the user specification is a file path instead of raw prose, and it explicitly asks you to forward or use that path rather than author an RFC, output only the absolute path and stop.",
                  "Otherwise, author the RFC normally.",
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
            ...plannerModelConfig,
          },
          {
            name: `orchestrator-${iteration}`,
            task: taggedPrompt([
              [
                "role",
                "You are a sub-agent orchestrator with many tools available. Your primary implementation tool is the `subagent` tool.",
              ],
              [
                "objective",
                `Implement iteration ${iteration}/${maxLoops} for the task: ${prompt}`,
              ],
              ["planner_notes", "{previous}"],
              [
                "delegation_policy",
                [
                  "All non-trivial operations must be delegated to subagents via the `subagent` tool.",
                  "Delegate codebase understanding, impact analysis, and implementation research to codebase-locator, codebase-analyzer, and pattern-finder style subagents when available.",
                  "Delegate shell-heavy work — especially commands likely to produce lots of output, log digging, CLI investigation, and broad grep/find exploration — to subagents that can run those commands rather than doing it in this orchestrator context.",
                  "Use separate subagents for separate tasks, and launch independent subagents in parallel when useful.",
                  "Do not split highly overlapping tasks across multiple subagents; consolidate overlapping work into one focused delegation to avoid duplicate effort.",
                  "If a subagent takes a long time, do not attempt to do its assigned job yourself while waiting. Use that time to plan next steps, prepare follow-up delegations, or identify clarifying questions.",
                ].join("\n"),
              ],
              [
                "instructions",
                [
                  "Start from the planner notes and decompose the work into delegated subagent tasks.",
                  "Pass each subagent the relevant task, constraints, files, validation expectations, and any prior review findings.",
                  "Coordinate subagent results into the smallest coherent set of changes that satisfies the planner notes.",
                  "Preserve existing architecture and repository conventions unless the plan explicitly justifies a change.",
                  "Run or delegate the most relevant validation commands available in the repository.",
                  "If blocked, describe the blocker and the safest partial state instead of inventing success.",
                  "Do not hide failures; reviewers need accurate status.",
                ].join("\n"),
              ],
              [
                "output_format",
                [
                  "Markdown with headings:",
                  "1. Changes made",
                  "2. Files touched",
                  "3. Validation run / recommended",
                  "4. Deferred work or blockers",
                ].join("\n"),
              ],
            ]),
            ...orchestratorModelConfig,
          },
        ],
        { task: prompt },
      );
      const planner = planAndExecute[0]!;
      const orchestrator = planAndExecute[1]!;
      finalPlan = planner.text;
      finalResult = orchestrator.text;

      const simplifier = await ctx.task(`code-simplifier-${iteration}`, {
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
                "instructions",
                [
                  "Locate package scripts, test configs, CI workflows, generated artifacts, lint/typecheck setup, and release gates.",
                  "Prefer exact file paths and commands.",
                  "Explain how each item should influence review or validation.",
                  "If a category does not exist, state that explicitly.",
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
                "instructions",
                [
                  "Identify hidden coupling with build, tests, linting, runtime config, release automation, or generated files.",
                  "Name the exact validations that would most efficiently detect regressions.",
                  "Separate confirmed risks from speculative risks.",
                  "Do not repeat generic review advice; ground findings in repository evidence.",
                ].join("\n"),
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
              [
                "role",
                "You find repository patterns that a patch must follow.",
              ],
              [
                "objective",
                `Extract conventions relevant to reviewing this task: ${prompt}`,
              ],
              [
                "instructions",
                [
                  "Find examples of build/test/style/release/architecture patterns the patch should mirror.",
                  "Use concrete paths, commands, or symbols as evidence.",
                  "Highlight conventions that commonly cause subtle review failures.",
                  "If examples conflict, describe the conflict instead of forcing a single rule.",
                ].join("\n"),
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
          "You are acting as a reviewer for a proposed code change made by another engineer.",
        ],
        [
          "objective",
          `Review iteration ${iteration}/${maxLoops} for the task: ${prompt}`,
        ],
        ["latest_orchestrator_result", orchestrator.text],
        ["latest_simplifier_result", simplifier.text],
        ["infrastructure_discovery", discoveryContext],
        [
          "project_guidance",
          [
            "Use the repository's AGENTS.md and/or CLAUDE.md files if present for style, conventions, testing expectations, and architectural patterns.",
            "Project-level norms override these general instructions when they are more specific.",
            "Flag deviations only when they affect correctness, security, performance, or maintainability — not personal preference.",
          ].join("\n"),
        ],
        [
          "bug_selection_guidelines",
          [
            "Flag an issue only when the original author would likely fix it if they knew about it.",
            "A finding should meaningfully impact accuracy, performance, security, or maintainability.",
            "A finding must be discrete and actionable, not a broad complaint about the whole codebase.",
            "Do not demand rigor inconsistent with the rest of the repository.",
            "Flag only bugs introduced by this iteration's patch; do not flag pre-existing issues.",
            "Do not rely on unstated assumptions about author intent or codebase behavior.",
            "Speculation is insufficient: identify the code path, scenario, environment, or input that is provably affected.",
            "Do not flag intentional behavior changes as bugs unless they clearly violate the task or documented contract.",
            "Ignore trivial style unless it obscures meaning or violates documented standards in a way that affects correctness/security/maintainability.",
          ].join("\n"),
        ],
        [
          "comment_guidelines",
          [
            "Each finding title must start with a priority tag such as [P1], [P2], or [P3]. Use [P0] only for universal release/operations blockers.",
            "Also include numeric priority: 0 for P0, 1 for P1, 2 for P2, 3 for P3.",
            "The body must be one concise paragraph explaining why this is a bug and the exact scenario or inputs required for it to arise.",
            "Use a matter-of-fact, non-accusatory tone. Avoid praise such as `Great job` or `Thanks for`.",
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
          "output_schema",
          [
            "Return JSON only. Do not wrap the JSON in markdown fences or add extra prose.",
            "The JSON must match this schema exactly:",
            "{",
            '  "findings": [',
            "    {",
            '      "title": "<≤ 80 chars, imperative, starts with [P0]/[P1]/[P2]/[P3]>",',
            '      "body": "<one paragraph of valid Markdown explaining why this is a problem; cite files/lines/functions>",',
            '      "confidence_score": <float 0.0-1.0>,',
            '      "priority": <int 0-3, optional>,',
            '      "code_location": {',
            '        "file_path": "<repo-relative path>",',
            '        "line_range": {"start": <int>, "end": <int>}',
            "      }",
            "    }",
            "  ],",
            '  "overall_correctness": "patch is correct" | "patch is incorrect",',
            '  "overall_explanation": "<1-3 sentence explanation justifying the verdict>",',
            '  "overall_confidence_score": <float 0.0-1.0>',
            "}",
          ].join("\n"),
        ],
      ]);

      const reviews = await ctx.parallel(
        [
          {
            name: `reviewer-${iteration}-a`,
            task: reviewPrompt,
            previous: [orchestrator, simplifier, ...discovery],
            ...reviewerModelConfig,
          },
          {
            name: `reviewer-${iteration}-b`,
            task: reviewPrompt,
            previous: [orchestrator, simplifier, ...discovery],
            ...reviewerModelConfig,
          },
        ],
        { task: prompt },
      );

      approved =
        reviews.length > 0 &&
        reviews.every((review) => reviewApproved(review.text));
      reviewReport = formatReview(reviews);
      if (approved) break;
    }

    return {
      result: finalResult,
      plan: finalPlan,
      approved,
      iterations_completed: iterationsCompleted,
      review_report: reviewReport,
    };
  })
  .compile();
