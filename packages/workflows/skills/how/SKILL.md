---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Can critique architecture. Use why for motivation."
license: MIT. LICENSE.txt has complete terms
metadata:
    author: Lauren Tan
    github-repo: https://github.com/cursor/plugins
    github-path: pstack/skills/how
    github-ref: refs/heads/main
    github-tree-sha: 46125561306434d8a1d7745d540d8932ab0cd2a2
---

# How

Explore the codebase to answer "how does X work?" questions. Produce clear architectural explanations at the level of a senior engineer onboarding onto a subsystem. Enough to build a working mental model, not annotated source code.

Two modes:

1. **Explain** (default). Explore the codebase and produce a clear explanation
2. **Critique.** Explain first, then run several fresh-context Atomic specialists to identify architectural issues independently

## Explain Mode

### Step 1. Understand the Question and Assess Complexity

Parse what the user is asking about:

- "How does the rate limiter work?", a subsystem
- "How do we handle billing for on-demand usage?", a feature flow
- "How is the auth service structured?", an architectural overview
- "Walk me through what happens when a user submits a form", a runtime trace

Identify the scope. If ambiguous, state your best-guess interpretation before exploring. Don't ask. Let the user redirect if you're off.

**Assess complexity to decide the approach:**

- **Simple** (a single module, a small utility, a narrow question like "how does function X work"): run one `codebase-analyzer` that explores and explains in a single pass. Go to Step 2b.
- **Complex** (a subsystem spanning multiple files/services, a cross-cutting feature, a full architectural overview): run parallel Atomic exploration specialists, then synthesize their evidence in the parent. Go to Step 2a.

When in doubt, lean simple. Add a focused exploration specialist only when the first analysis exposes a real gap.

Before delegating, discover the executable Atomic agents. Do not invent an agent name or pin a model:

```typescript
subagent({ action: "list" })
```

Use the listed agents' declared models and fallback policies unless the user explicitly requests an available override.

### Step 2a. Explore (complex questions only)

Decompose the question into 2-4 parallel exploration angles, each a distinct slice of the subsystem so explorers don't duplicate work. Example split for "how does the rate limiter work?":

- Explorer 1: data model and state management
- Explorer 2: request path and enforcement
- Explorer 3: configuration and metrics infrastructure

The right decomposition depends on the question. Use your judgment. Narrow questions: 2 explorers is fine. Broad subsystems: up to 4.

Launch the exploration as one Atomic parallel call. Use `codebase-locator` for the file map, `codebase-analyzer` for implementation flow, and `codebase-pattern-finder` only when analogous conventions materially help. Broad questions may use multiple `codebase-analyzer` tasks, one per non-overlapping slice.

```typescript
subagent({
  tasks: [
    { agent: "codebase-locator", task: "Map the files, entry points, tests, and configuration for <question>. Return paths and why each matters." },
    { agent: "codebase-analyzer", task: "Trace <exploration-angle-1> for <question>, with file:line evidence. Inspect and report only; do not edit." },
    { agent: "codebase-analyzer", task: "Trace <exploration-angle-2> for <question>, with file:line evidence. Inspect and report only; do not edit." },
    { agent: "codebase-pattern-finder", task: "Find existing patterns analogous to <question> and explain where they agree or differ. Inspect and report only." }
  ],
  concurrency: 4,
  context: "fresh"
})
```

Include only the tasks the question needs; do not add a pattern pass decoratively. Build each analyzer task from `references/explorer-prompt.md` plus its specific angle. Each exploration task should:
- Start broad with `find` and `search` for relevant directories and symbols
- Follow the thread from an entry point through callers, callees, data flow, and type definitions
- Read the actual code instead of guessing from file names
- Stop when it can describe the path from input to output (or trigger to effect) without hand-waving
- Note surprising or non-obvious behavior a newcomer could miss

The specialists return structured findings with components, flow, files, and non-obvious details. Overlap is acceptable; the parent reconciles it.

Then proceed to Step 3.

### Step 2b. Direct Explain (simple questions)

Run one `codebase-analyzer` in fresh context:

```typescript
subagent({
  agent: "codebase-analyzer",
  task: "Explore and explain <question> with file:line evidence. Follow the communication style and output structure from the how skill's explainer prompt. Inspect and report only; do not edit.",
  context: "fresh"
})
```

Build the task from `references/explainer-prompt.md`. The analyzer explores with Atomic's `find`, `search`, and `read` tools and writes the explanation directly; there are no explorer findings to hand off.

Proceed to Step 4.

### Step 3. Synthesize (complex questions only)

Once all specialists return, synthesize their findings in the parent session. The parent owns orchestration and the final response; Atomic subagents cannot launch another subagent, and no generic synthesis agent is needed.

Follow `references/explainer-prompt.md` for the communication style and output format. Reconcile overlap and contradictions against the cited code, then weave the slices into one coherent explanation. If a contradiction cannot be resolved from the returned evidence, run one focused follow-up `codebase-analyzer` call rather than guessing.

### Step 4. Present

Present the final explanation to the user. You may lightly edit specialist output for clarity or add context from the conversation, but preserve evidence and file references. The explanation is the product.

### Output Format

Follow this structure, adapted to the question. Not every section is needed for every question.

**Overview.** 1-2 paragraphs. What it is, what it does, why it exists. Enough to decide whether to keep reading.

**Key Concepts.** The important types, services, or abstractions. Brief definition of each. Not exhaustive, just the ones needed to understand the rest.

**How It Works.** The core of the explanation. Walk through the flow: what triggers it, what happens step by step, where data goes, the decision points. Prose, not pseudocode. Reference specific files and functions so the reader can go look, but don't dump code blocks unless a snippet is genuinely necessary.

**Where Things Live.** A brief map of the relevant files/directories. Not every file, just the ones needed to start working in this area.

**Gotchas.** Non-obvious or surprising things that would trip someone up. Historical context that explains why something looks weird. Known sharp edges.

## Critique Mode

Triggered when the user asks for architectural issues, problems, or improvements, not just understanding.

### Step 1. Explain First

Run the full explain flow above (Steps 1-4). You must understand the architecture before critiquing it.

### Step 2. Run Atomic Critics

After the explanation is complete, launch fresh-context specialists with distinct review angles. Keep their declared model defaults; do not create a model roster or override models merely for diversity.

```typescript
subagent({
  tasks: [
    { agent: "codebase-analyzer", task: "Critique <explanation> for correctness, coupling, ownership, and regressions. Inspect <relevant-paths>. Report evidence-backed findings only; do not edit.", output: false },
    { agent: "debugger", task: "Inspect-only architectural failure-mode review of <explanation> and <relevant-paths>. Do not edit. Challenge lifecycle, state, error, concurrency, and boundary assumptions using concrete code evidence.", output: false },
    { agent: "codebase-pattern-finder", task: "Compare <explanation> and <relevant-paths> with established repository patterns. Report meaningful consistency gaps or better-fitting precedents with file:line evidence; do not edit.", output: false }
  ],
  concurrency: 3,
  context: "fresh"
})
```

Use only agents returned by `subagent({ action: "list" })`. Read `references/critic-prompt.md` and `references/critique-rubric.md` when building each role-specific task. Every critic receives the explanation and relevant file paths, but owns a different angle rather than a different hard-coded model.

### Step 3. Lead Judgment

Same framework as the interrogate skill. You're a pragmatic lead, not an aggregator.

Categorize findings:
- **Act on.** Architectural problems worth fixing now
- **Consider.** Real concerns, but the cost/benefit is unclear
- **Noted.** Valid observations, low priority
- **Dismissed.** Wrong, missing context, or style preference

Present the explanation first (from Step 1), then the critique verdict below it. The explanation should stand on its own; someone who just wants to understand the system shouldn't wade through critique.
