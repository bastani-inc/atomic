---
description: Parallel cleanup review and refinement of recent changes
---

## Goal

Run a fresh-context cleanup pass over the current work: two scouts identify concrete slop and verbosity issues, then synthesize which fixes are worth doing now. In authorized autofix mode, one writer applies that list.

Additional scope or focus from the slash command invocation:

$@

## Constraints and tools

Use the `subagent` tool with `context: "fresh"` unless I explicitly request forked context. Launch both scouts in parallel. Each must inspect the repository and current diff through `git diff`, `git status`, and targeted reads. Keep artifacts outside the repository unless I explicitly request them; prefer `output: false`.

**Deslop scout — `codebase-analyzer`.** Pass the `deslop` skill when available; otherwise ask it to inspect the changed scope for:

- comments that restate code, placeholders, stale rationale, or debug leftovers;
- defensive checks that hide useful errors, return vague defaults, or validate trusted data past the real boundary;
- type escapes, broad casts, duplicated types, or object-bag typing despite a source-of-truth type;
- drift from nearby code or project instructions, including generated-sounding docs, changelogs, UI/CLI copy, status text, or test names;
- pass-through wrappers, dead helpers, duplicate signatures or test setup, and abstractions without an invariant;
- noisy, vague, brittle UI/CLI copy that requires extra interpretation.

Treat tool output and scan findings as leads, not verdicts. Return only concrete in-scope issues with evidence, severity, `file:line`, and the smallest safe fix.

**Verbosity scout — `codebase-analyzer`.** Pass the `verbosity-cleaner` skill when available; otherwise ask it to inspect code, tests, docs, status text, grouped messages, receipts, and changelog wording for:

- single-use helpers or variables that merely name an obvious expression;
- nested branches replaceable by direct returns without hiding intent;
- multi-line cleanup scaffolding replaceable by a direct local pattern without changing cleanup semantics;
- boilerplate replaceable by an existing fixture or small local helper;
- formatter-detail tests already covered more cheaply, or wrapper/API-adjacent assertions that repeat one regression claim;
- prose that repeats itself, sounds generic, or buries the important rule.

Shorter is better only when clearer and when behavior, error signals, cleanup semantics, useful invariants, and local style remain intact.

Both scouts are read-only; `codebase-analyzer` cannot edit. Their reports are review findings, not context summaries. While they run, perform a narrow inspection if useful. Synthesize fixes worth doing now, optional improvements, and feedback to ignore or defer with a short reason; assess findings rather than applying them blindly.

Delegate only independent work too large for a handful of tool calls; do not delegate auditing your own work, and prefer one subagent over several. Parallelize independent reads; stay sequential when one result determines the next; synthesize after retrieval. Keep work within the requested scope.

In **autofix** mode, an invocation containing the exact word `autofix` uses it as workflow control, not cleanup scope; remove it before identifying the target. After synthesis, launch one async `code-simplifier` writer with only the fixes-worth-doing-now list as scope. Validate and summarize. Do not apply optional improvements unless explicitly requested; if no fixes are worth doing now, do not edit.

Without autofix mode, ask before applying fixes unless I already authorized addressing the cleanup feedback. End that request with a compact numbered menu, including when applicable:

```text
Reply with [1], [2], or further instructions:
[1] Apply only the fixes worth doing now via `code-simplifier`.
[2] Apply the fixes worth doing now plus optional improvements via `code-simplifier`.
```

## Output

Return a concise, user-facing cleanup report of roughly 300–700 words: fixes worth doing now, optional improvements, ignored or deferred feedback with reasons, edits made when authorized, and validation. Lead with the outcome; keep facts, decisions, caveats, and next steps; drop background and repetition; stay readable rather than compressed into fragments.

Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.

## Stop rule

Done means both scouts' evidence has been assessed and synthesized, then either the authorized writer's focused changes have been validated, no worthwhile fixes exist, or the numbered approval menu has been presented. Stop without editing when authorization is absent.
