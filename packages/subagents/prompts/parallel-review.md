---
description: Parallel specialist review of the current work
---

Launch parallel specialists for an adversarial review of the current work.

Use fresh context, not forked context, unless I explicitly ask for forked context. Specialists should inspect the repository, relevant instructions, and current diff directly from files and commands. Do not rely on the main conversation history.

There is no generic `reviewer` agent — assemble the review from read-only specialists with distinct angles. Generate the angles dynamically from the user's intent, the plan, the implemented code, and the current diff. If I specify angles, use mine. Otherwise pick three of the following:

1. Correctness and regressions — `codebase-analyzer`
   Trace the current diff and the surrounding flow to check whether the change satisfies the request, preserves existing behavior, handles edge cases, and avoids hidden runtime failures. Cite `file:line` for every claim.

2. Bug and failure-mode hunt — `debugger`
   Treat the diff as a suspect change. Reproduce the relevant behavior when possible, hypothesize how it could break, and report findings with evidence. The `debugger` agent can write fixes — for this pass, explicitly instruct it to inspect and report only, not edit.

3. Pattern fit and consistency — `codebase-pattern-finder`
   Compare the implementation against existing analogous patterns and conventions in the codebase. Flag drift, divergence from established structure, or missed reuse opportunities with `file:line` snippets.

4. Prior decisions and constraints — `codebase-research-locator` then `codebase-research-analyzer`
   When prior research or specs likely constrain the change, surface the relevant docs and extract the decisions the new code must honor.

5. External-spec or API conformance — `codebase-online-researcher`
   When the change implements an external contract (API, RFC, library behavior), verify the implementation against the authoritative source.

Cleanup-style angles (simplicity, slop, verbosity) belong in `/parallel-cleanup`; use that instead of overloading this pass.

Give every specialist a specific task prompt naming its angle. Ask them to return concise, evidence-backed findings with file/line references and suggested fixes. The response should be review feedback, not a context summary. Specialists must not edit files in this pass, even when the agent type can — say so explicitly in the prompt.

While they run, do your own narrow inspection if useful. After they return, synthesize the feedback into:

- fixes worth doing now;
- optional improvements;
- feedback to ignore or defer, with a short reason.

Do not blindly apply every finding.

Autofix mode: if the invocation contains the exact word `autofix`, treat it as workflow control, not review scope. Remove it before deciding the review target. After synthesis, launch a single async writer (`debugger` for correctness or regression fixes, `code-simplifier` for cleanup-shaped feedback) with the explicit fix list as scope. Validate, and summarize. Do not apply optional improvements unless explicitly requested. If there are no fixes worth doing now, do not edit.

Without autofix mode, ask before applying fixes unless I already told you to address review feedback. When you ask, end with a compact numbered menu so I can respond with a number. Use wording suited to the findings, but include these choices when applicable:

```text
Reply with [1], [2], or further instructions:
[1] Apply only the fixes worth doing now.
[2] Apply the fixes worth doing now plus optional improvements.
```

Additional review target or focus from the slash command invocation:

$@

If the invocation provides a URL, issue link, file path, plan path, or freeform focus, treat it as the primary review scope. Read or fetch that target before assigning reviewer angles, and pass the target explicitly into each specialist task.
