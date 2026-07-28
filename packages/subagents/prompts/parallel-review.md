---
description: Parallel specialist review of the current work
---

## Goal

Produce an adversarial, evidence-backed review of the current work, separating fixes worth doing now from optional or inapplicable feedback. Apply fixes only when authorized.

Additional review target or focus from the slash command invocation:

$@

If this supplies a URL, issue, file, plan, or freeform focus, treat it as primary scope: read or fetch it before assigning angles and pass it into every specialist task.

## Constraints and tools

Use fresh context unless I explicitly request forked context. Specialists inspect repository instructions, relevant files, and the current diff through direct reads and commands, not main-conversation history. There is no generic `reviewer`; choose read-only specialists with distinct angles derived from user intent, the plan, implementation, and diff. Use my angles when supplied; otherwise select three applicable angles:

- **Correctness and regressions — `codebase-analyzer`:** trace the diff and surrounding flow against the request, preserved behavior, edge cases, and hidden runtime failures; cite `file:line` for every claim.
- **Bug and failure modes — `debugger`:** reproduce relevant behavior where possible, assess how the suspect diff could break, and report evidence.
- **Pattern fit — `codebase-pattern-finder`:** compare analogous code and conventions, identifying structural drift or missed reuse with `file:line` snippets.
- **Prior constraints — `codebase-research-locator` then `codebase-research-analyzer`:** surface applicable research or specs and the decisions the change must honor.
- **External conformance — `codebase-online-researcher`:** compare an external API, RFC, or library contract with its authoritative source.

Use `/parallel-cleanup` instead for simplicity, slop, or verbosity angles. Every specialist gets a task naming its angle and returns concise review findings with evidence, `file:line`, and suggested fixes—not a context summary. Every specialist is read-only, including agent types that can edit. While they run, perform a narrow inspection if useful.

Synthesize fixes worth doing now, optional improvements, and ignored or deferred feedback with a short reason; assess findings rather than applying them blindly. Delegate only independent work too large for a handful of tool calls; do not delegate auditing your own work, and prefer one subagent over several. Parallelize independent reads; stay sequential when one result determines the next; synthesize after retrieval. Keep work within the requested scope.

In **autofix** mode, an invocation containing the exact word `autofix` uses it as workflow control, not review scope; remove it before identifying the target. After synthesis, launch one async writer—`debugger` for correctness/regression fixes or `code-simplifier` for cleanup-shaped feedback—with only the explicit fixes-worth-doing-now list as scope. Validate and summarize. Do not apply optional improvements unless explicitly requested; if no fixes are worth doing now, do not edit.

Without autofix mode, ask before applying fixes unless I already authorized addressing review feedback. End that request with a compact numbered menu, including when applicable:

```text
Reply with [1], [2], or further instructions:
[1] Apply only the fixes worth doing now.
[2] Apply the fixes worth doing now plus optional improvements.
```

## Output

Return a concise, user-facing review of roughly 400–800 words: outcome, evidence-backed fixes worth doing now, optional improvements, ignored or deferred feedback with reasons, and any authorized edits and validation. Lead with the outcome; keep facts, decisions, caveats, and next steps; drop background and repetition; stay readable rather than compressed into fragments.

Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.

## Stop rule

Done means the specialist evidence has been assessed and synthesized, then either authorized fixes were validated, no worthwhile fixes exist, or the numbered approval menu was presented. Stop without editing when authorization is absent.
