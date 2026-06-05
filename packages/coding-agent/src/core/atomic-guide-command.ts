import * as path from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getChangelogPath, parseChangelog } from "../utils/changelog.ts";

export const ATOMIC_GUIDE_COMMAND_NAME = "atomic";
export const ATOMIC_GUIDE_COMMAND_DESCRIPTION =
  "Atomic onboarding and help guide";

const OVERVIEW = `# Atomic overview

Atomic turns one-off prompts into developer workflows: on-call debugging, repo research that turns into implementation, testing and review loops, and larger multi-stage automation. Use \`/workflow goal\` for small-to-medium changes with a clear work surface, exact outcome, and named validation; keep \`/workflow ralph\` for larger migrations, broad refactors, and spec-to-reviewed-change work. Start Atomic in a project with \`atomic\`, then talk to it normally. Use \`@file\` to attach files, \`!command\` to run shell output through the model, and \`!!command\` to run shell output without adding it to context.

## Core session commands

| Command | Use |
|---|---|
| \`/login\` | configure auth |
| \`/model\` | switch model |
| \`/settings\` | thinking level, theme, message delivery, transport |
| \`/new\`, \`/resume\` | start or resume sessions |
| \`/tree\`, \`/fork\`, \`/clone\` | branch or navigate session history |
| \`/compact\` | summarize older context |
| \`/hotkeys\`, \`/changelog\` | local help and release notes |

## Examples of using Atomic

| Goal | How to use |
|---|---|
| On-call / broken behavior | Run \`/run debugger "Reproduce the failure, patch the root cause, and validate it"\` for a focused fix loop, or ask Atomic in chat to build a reusable workflow that does the same |
| Research → spec → implementation | Chain \`/skill:research-codebase\` → \`/skill:create-spec\` → \`/workflow goal objective="..."\` for bounded scoped work with explicit validation; use \`/workflow ralph ...\` when the work needs planning, broad refactoring, or final-stage PR prep with \`create_pr=true\` |
| Testing / regression hardening | Run \`/skill:tdd\` for test-first work, then \`/parallel-review current diff\`, then land the change |
| Large repo discovery | Run \`/parallel codebase-locator "map the area" -> codebase-analyzer "trace the current flow" -> codebase-pattern-finder "find patterns" --bg\`, or \`/workflow deep-research-codebase\` for whole-repo synthesis |
| UI / product polish | Run \`/skill:impeccable\` for interface critique and refinement, or \`/workflow open-claude-design\` for generation + refinement loops |

## Built-in workflows

| Workflow | When to use | How to run |
|---|---|---|
| \`deep-research-codebase\` | broad repo or cross-cutting research before you decide what to change (for one area, use \`/skill:research-codebase\`; this indexes the whole repo) | \`/workflow deep-research-codebase prompt="How do payment retries work end to end?"\` |
| \`goal\` | small-to-medium scoped changes when you can name the work surface, outcome, and validation; keeps receipts in a ledger and stops as \`complete\`, \`blocked\`, or \`needs_human\` | \`/workflow goal objective="Implement specs/<date>-<topic>.md, run focused tests, and validate the changed behavior"\` |
| \`ralph\` | larger migrations, broad refactors, multi-package changes, and spec-to-reviewed-change work where you want Atomic to plan, delegate, simplify, review, and iterate; add \`create_pr=true\` only when you want the final pull-request stage and report | \`/workflow ralph prompt="Plan and implement specs/<date>-<topic>.md" create_pr=true\` |
| \`open-claude-design\` | UI and design-system work that benefits from generation and refinement loops | \`/workflow open-claude-design prompt="Refresh the settings page hierarchy"\` |

Use \`/workflow list\` to see what is available and \`/workflow inputs <name>\` to inspect inputs in your environment.

## Top skills

| Skill | When to use | How to run |
|---|---|---|
| \`research-codebase\` | write a grounded research artifact for one subsystem or question | \`/skill:research-codebase how the rate limiter works in src/middleware/\` |
| \`create-spec\` | turn research into an implementation-ready plan | \`/skill:create-spec from research/docs/<date>-<topic>.md\` |
| \`tdd\` | do test-first feature or bug work | \`/skill:tdd\` |
| \`prompt-engineer\` | tighten a vague prompt before a long run | \`/skill:prompt-engineer Draft a sharper implementation prompt for ...\` |
| \`subagent\` | learn delegation patterns and exact \`/run\`, \`/parallel\`, and \`/chain\` usage | \`/skill:subagent\` |
| \`impeccable\` | critique or refine frontend and product UI | \`/skill:impeccable\` |

## Subagents

Subagents are focused child Atomic sessions you can point at one job inside the repo.

| Built-in subagent | Use |
|---|---|
| \`codebase-locator\` | find relevant files, tests, entrypoints, and configs |
| \`codebase-analyzer\` | explain current behavior with file:line refs |
| \`codebase-pattern-finder\` | find existing code to model after |
| \`debugger\` | reproduce, diagnose, and fix broken behavior |

How the direct commands map to repo work:
- \`/run\` = one specialist on one job, for example \`/run codebase-locator "Map the webhook retry flow"\`
- \`/parallel\` = several independent specialists at once, for example \`/parallel codebase-locator "map retry files" -> codebase-pattern-finder "find existing retry/backoff patterns" -> codebase-online-researcher "research current retry guidance" --bg\`
- \`/chain\` = ordered handoffs, for example \`/chain codebase-locator "find the auth files" -> codebase-analyzer "trace the auth flow" -> debugger "patch the failing auth edge case"\`

─────────────────────────────────────────────────────────────────

Where to next:

\`/atomic example\` — see the pieces used on a code task
\`/atomic workflows\` — learn when to use workflows`;

const EXAMPLE = `# Practical example

This is an example of a spec-driven development process using Atomic workflows. Use it when you are new to a repo or the task has non-trivial scope. Type the examples below into the Atomic TUI chat after starting \`atomic\` in your project.

## 1. Research what exists

Use \`/skill:research-codebase\` for a scoped area, subsystem, or directory:

\`/skill:research-codebase how the rate limiter works in src/middleware/\`

Use \`deep-research-codebase\` when the answer spans the whole repo or a cross-cutting implementation path:

\`/workflow deep-research-codebase prompt="How do payment retries work end to end?"\`

If the research prompt is vague, tighten it first with \`/skill:prompt-engineer\`:

\`/skill:prompt-engineer Draft a sharper repo-research prompt for understanding payment retries end to end, including retries, queues, and failure handling.\`

## 2. Create a spec when requirements are fuzzy

Skip this if the implementation request is already precise.

\`/skill:create-spec from research/docs/<date>-<topic>.md\`

## 3. Implement with review built in

For ordinary work, ask Atomic directly and require validation:

\`Implement the approved spec in specs/<date>-<topic>.md. Run focused tests and summarize validation.\`

For small-to-medium scoped changes where you can identify the work surface, exact outcome, and validation, use \`goal\`:

\`/workflow goal objective="Implement specs/<date>-<topic>.md, run focused tests, and finish when the documented behavior is validated"\`

For larger migrations, broad refactors, multi-package changes, or spec-to-reviewed-change work, use \`ralph\`:

\`/workflow ralph prompt="Plan and implement specs/<date>-<topic>.md"\`

Add \`create_pr=true\` only when you want Ralph's final pull-request stage and report.

## 4. Decide and land

If you used \`goal\`, the workflow already persisted receipts in a goal ledger and reviewer-gated completion. Use its final status — \`complete\`, \`blocked\`, or \`needs_human\` — plus the remaining-work report to decide whether to ship, unblock, or clarify.

If you used \`ralph\`, the workflow planned the approach, delegated implementation through sub-agents, simplified, reviewed, and iterated. If you enabled \`create_pr=true\`, use its final pull-request report to decide whether to ship or iterate again.

If you implemented directly instead of using a workflow, you can still run:

\`/parallel-review current diff\`

Atomic will synthesize reviewer feedback and ask before applying fixes.

─────────────────────────────────────────────────────────────────

Where to next:

\`/atomic workflows\` — learn when to use workflows
\`/atomic overview\` — quick refresh`;

const WORKFLOWS = `# Workflows primer

A workflow is a TypeScript-defined pipeline exported from \`defineWorkflow(...).compile()\`. It can run tasks, chains, parallel fan-out, human-in-the-loop prompts, background status, and model fallback chains.

You do not have to write TypeScript to add one. Describe the workflow you want in plain chat — goal, inputs, stages, which steps are parallel or sequential, handoff/output shape, and any model or thinking-level preferences — and Atomic will use the workflow docs to scaffold a reusable definition under \`.atomic/workflows/\` and reload it for you. Hand-edit the TypeScript afterward when you want precise control.

## Built-in workflows

| Workflow | When to use | How to run |
|---|---|---|
| \`deep-research-codebase\` | broad repo or cross-cutting research before you decide what to change (for one area, use \`/skill:research-codebase\`; this indexes the whole repo) | \`/workflow deep-research-codebase prompt="How do payment retries work end to end?"\` |
| \`goal\` | small-to-medium scoped changes with a clear outcome and named validation | \`/workflow goal objective="Update the CLI docs, include one usage example, and verify the docs build passes"\` |
| \`ralph\` | larger migrations, broad refactors, multi-package changes, and spec-to-reviewed-change work | \`/workflow ralph prompt="Plan a database-layer migration, implement it, and review it" create_pr=true\` |
| \`open-claude-design\` | frontend and product design work | \`/workflow open-claude-design prompt="Refresh the settings page hierarchy"\` |

Use \`/workflow inputs <name>\` to inspect the exact inputs in your environment.

Use \`/skill:research-codebase ...\` when you want research on one subsystem, directory, or focused question. Use \`/workflow deep-research-codebase ...\` when the answer needs end-to-end tracing across many parts of the repo.

If you are drafting research, reviewer, or synthesis prompts for a workflow, use \`/skill:prompt-engineer\` first. It is a good fit when a stage prompt feels vague, overloaded, or underspecified.

## What good workflow authoring looks like

A good workflow request is explicit about stage purpose, model choice, handoff, and the decision each step must return.

Example: ask Atomic in chat with something like this:

~~~text
Create a reusable workflow called review-changes.

It should accept one required text input called target for a diff, PR summary, or review target.

Run two independent review stages in parallel with fresh context:
- one reviewer focused on correctness, regressions, and missing tests using openai-codex/gpt-5.5 at xhigh thinking
- one reviewer focused on edge cases, maintainability, and hidden risks using anthropic/claude-opus-4-8 at xhigh thinking

Then add an aggregate stage that consolidates both reviews, deduplicates overlap, keeps only evidence-backed issues, and separates blockers from optional suggestions using openai/gpt-5.5 at high thinking.

Finally add an adjudicate stage using anthropic/claude-sonnet-4 at high thinking that decides what to fix now, what to defer, and what to reject. Return a short action list with rationale.

The workflow should return structured output with consolidated_review and decision fields.
~~~

Why this is good:
- it names the workflow and required input
- it specifies which stages are parallel vs sequential
- each stage has one job
- it defines the handoff and final outputs
- it calls out model choice and thinking level where that matters

## Run and inspect

\`/workflow list\`

\`/workflow inputs goal\`

\`/workflow goal objective="Fix the settings form validation bug, add the focused test, and finish when invalid emails show the inline error without submitting"\`

\`/workflow inputs ralph\`

\`/workflow ralph prompt="Migrate the database layer to Drizzle" create_pr=true\`

\`/workflow status\`

\`/workflow connect <run-id>\`

\`/workflow interrupt <run-id>\`

\`/workflow resume <run-id>\`

Workflows run as background tasks. Use F2 or \`/workflow connect <run-id>\` for the graph viewer. Human-in-the-loop prompts appear there, not as chat modals, and awaiting-input states do not wake the main chat agent. Completion and failure notices are steered back into the main chat; answers submitted in the workflow UI interrupt stale main-chat questions so the model does not ask again.

## Author your own

Describe your workflow in plain chat — say what you want the workflow to accomplish, what inputs it should accept, what stages should run, and what final output or decision it should return. Atomic will use the workflow docs to scaffold a reusable definition under \`.atomic/workflows/\`, ask clarifying questions when stage purpose, models, or handoffs are ambiguous, and run \`/workflow reload\` so you can launch it immediately.

─────────────────────────────────────────────────────────────────

Where to next:

\`/atomic example\` — see workflows in a normal task flow
\`/atomic overview\` — quick refresh`;

const GUIDE_SECTIONS = [
  {
    name: "overview",
    aliases: [],
    label: "overview",
    description: "30-second overview",
    render: () => OVERVIEW,
  },
  {
    name: "workflows",
    aliases: ["workflow"],
    label: "workflows",
    description: "Workflow primer",
    render: () => WORKFLOWS,
  },
  {
    name: "example",
    aliases: ["examples"],
    label: "example",
    description: "Practical first workflow",
    render: () => EXAMPLE,
  },
  {
    name: "whats-new",
    aliases: ["what's new", "whats new", "news", "updates", "changelog"],
    label: "what's new",
    description: "Recent release notes",
    render: readLatestStableChangelog,
  },
] as const satisfies readonly {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly label: string;
  readonly description: string;
  readonly render: (cwd: string) => string;
}[];

type AtomicGuideSection = (typeof GUIDE_SECTIONS)[number];
type AtomicGuideSectionName = AtomicGuideSection["name"];

export type AtomicGuideHelpChoice = AtomicGuideSection["label"];

export type AtomicGuideMode = "help" | AtomicGuideSectionName;

export const ATOMIC_GUIDE_HELP_CHOICES: readonly AtomicGuideHelpChoice[] =
  GUIDE_SECTIONS.map((section) => section.label);

const GUIDE_SECTIONS_BY_NAME = new Map<
  AtomicGuideSectionName,
  AtomicGuideSection
>(GUIDE_SECTIONS.map((section) => [section.name, section]));
const GUIDE_SECTIONS_BY_LABEL = new Map<string, AtomicGuideSection>(
  GUIDE_SECTIONS.map((section) => [section.label, section]),
);
const GUIDE_SECTIONS_BY_INPUT = new Map<string, AtomicGuideSection>(
  GUIDE_SECTIONS.flatMap((section) =>
    [section.name, section.label, ...section.aliases].map(
      (input) => [input, section] as const,
    ),
  ),
);

export function isAtomicGuideHelpChoice(
  choice: string,
): choice is AtomicGuideHelpChoice {
  return GUIDE_SECTIONS_BY_LABEL.has(choice);
}

const ATOMIC_GUIDE_TRAILING_PUNCTUATION = "?!.,;:";

function stripTrailingAtomicGuidePunctuation(value: string): string {
  let end = value.length;
  while (
    end > 0 &&
    ATOMIC_GUIDE_TRAILING_PUNCTUATION.includes(value.charAt(end - 1))
  ) {
    end--;
  }
  return value.slice(0, end);
}

function getGuideSectionForChoice(
  choice: string,
): AtomicGuideSection | undefined {
  return GUIDE_SECTIONS_BY_LABEL.get(choice);
}

function getGuideSectionForMode(
  mode: AtomicGuideSectionName,
): AtomicGuideSection {
  const section = GUIDE_SECTIONS_BY_NAME.get(mode);
  if (!section) throw new Error(`Unknown Atomic guide section: ${mode}`);
  return section;
}

function getAtomicGuideHelpMenu(): string {
  const sectionHelp = GUIDE_SECTIONS.map(
    (section) => `- \`${section.label}\` — run \`/atomic ${section.label}\``,
  ).join("\n");
  return `# Atomic\n\nSelect where to start:\n\n${sectionHelp}`;
}

export function normalizeAtomicGuideMode(args: string): AtomicGuideMode {
  const normalized = stripTrailingAtomicGuidePunctuation(
    args.trim().toLowerCase(),
  );
  if (!normalized) return "help";

  return GUIDE_SECTIONS_BY_INPUT.get(normalized)?.name ?? "help";
}

export function getAtomicGuideArgumentCompletions(
  prefix: string,
): AutocompleteItem[] | null {
  const query = prefix.trim().toLowerCase();
  const items = GUIDE_SECTIONS.map((section) => ({
    value: section.label,
    label: section.label,
    description: section.description,
  }));
  const filtered = query
    ? items.filter(
        (item) => item.value.startsWith(query) || item.label.startsWith(query),
      )
    : items;
  return filtered.length > 0 ? filtered : null;
}

function readLatestStableChangelog(cwd: string): string {
  const changelogPath = getChangelogPath();
  const stableSections = parseChangelog(changelogPath)
    .filter((entry) => entry.prerelease === null)
    .slice(0, 3)
    .map((entry) => entry.content.trim())
    .filter(Boolean);

  if (stableSections.length === 0) {
    return `# What's new\n\nNo stable release sections were found. Try \`/changelog\` for the interactive changelog viewer.\n\n─────────────────────────────────────────────────────────────────\n\nWhere to next:\n\n\`/atomic example\` — see a practical first workflow\n\`/atomic overview\` — quick refresh`;
  }

  const relativePath = path.relative(cwd, changelogPath) || changelogPath;
  return `# What's new\n\n${stableSections.join("\n\n")}\n\nSource: \`${relativePath}\`\n\n─────────────────────────────────────────────────────────────────\n\nWhere to next:\n\n\`/atomic example\` — see a practical first workflow\n\`/atomic overview\` — quick refresh`;
}

export function getAtomicGuideMessage(
  mode: AtomicGuideMode,
  cwd: string,
): string {
  if (mode === "help") return getAtomicGuideHelpMenu();
  return getGuideSectionForMode(mode).render(cwd);
}

export function atomicGuideModeForChoice(
  choice: AtomicGuideHelpChoice,
): AtomicGuideMode {
  return getGuideSectionForChoice(choice)?.name ?? "help";
}
