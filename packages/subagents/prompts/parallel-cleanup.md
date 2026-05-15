---
description: Parallel cleanup review and refinement of recent changes
---

Run a fresh-context parallel cleanup pass over the current work. Read-only specialists scout the diff for slop and verbosity, then a single writer applies the synthesized fixes.

Use the `subagent` tool. Launch the read-only scouts in parallel with `context: "fresh"`. Do not use forked context unless I explicitly ask for it. Each scout inspects the repository and current diff directly through `git diff`, `git status`, and targeted reads. Do not write artifacts into the repository unless I explicitly ask for them — prefer `output: false`.

Scout 1: deslop pass — `codebase-analyzer`.

If the `deslop` skill is available, pass it to this scout. If not, inline the guidance below. Ask this scout to scan the changed scope for AI-slop patterns:

- comments that restate code, placeholder text, stale rationale, or debug leftovers;
- defensive checks that hide useful errors, return vague defaults, or validate trusted internal data after a real boundary was already crossed;
- type escapes, broad casts, duplicated type definitions, or object-bag typing where a local source-of-truth type exists;
- style drift from nearby non-slop code and project instructions;
- generated-sounding docs, changelog text, UI copy, status text, or test names;
- pass-through wrappers, dead helpers, duplicate helper signatures, duplicated test harness setup, or abstractions that do not enforce an invariant;
- UI or CLI copy that is noisy, vague, brittle, or makes the user do extra interpretation.

Tell this scout to treat tool output and slop-scan-style findings as leads, not verdicts. It should return only concrete issues in the requested scope with evidence, severity, file/line references, and the smallest safe fix.

Scout 2: verbosity pass — `codebase-analyzer`.

If the `verbosity-cleaner` skill is available, pass it to this scout. If not, inline the guidance below. Ask this scout to scan the changed scope for needless verbosity in code, tests, docs, status text, grouped messages, receipts, and changelog wording:

- single-use helpers that merely paraphrase an expression;
- temporary variables that only name obvious expressions;
- nested returns or branches that can become direct returns without hiding intent;
- multi-line cleanup scaffolding that can use a local direct pattern while preserving cleanup semantics;
- repeated boilerplate that can use an existing local fixture or a small local helper;
- tests that restate formatter details already covered at a cheaper layer;
- regression tests where one focused assertion would cover the bug but wrapper/API-adjacent tests only repeat the same claim;
- prose that says the same thing twice, sounds generic, or buries the important rule.

Shorter is only better when it is clearer and preserves behavior, error signals, cleanup semantics, useful invariants, and local style.

Both scouts are read-only. `codebase-analyzer` cannot edit; do not ask it to. Their response should be evidence-backed findings with file/line references and suggested fixes, not a context summary.

While the scouts run, do your own narrow inspection if useful. After they return, synthesize the feedback into:

- fixes worth doing now;
- optional improvements;
- feedback to ignore or defer, with a short reason.

Do not blindly apply every finding.

Autofix mode: if the invocation contains the exact word `autofix`, treat it as workflow control, not cleanup scope. Remove it before deciding the cleanup target. After synthesis, launch a single async `code-simplifier` writer with the synthesized fixes-worth-doing-now as its explicit scope. Validate, and summarize. Do not apply optional improvements unless explicitly requested. If there are no fixes worth doing now, do not edit.

Without autofix mode, ask before applying fixes unless I already told you to address the cleanup feedback. When you ask, end with a compact numbered menu so I can respond with a number. Use wording suited to the findings, but include these choices when applicable:

```text
Reply with [1], [2], or further instructions:
[1] Apply only the fixes worth doing now via `code-simplifier`.
[2] Apply the fixes worth doing now plus optional improvements via `code-simplifier`.
```

Additional scope or focus from the slash command invocation:

$@
