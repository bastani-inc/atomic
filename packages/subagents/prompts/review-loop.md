---
description: Specialist review/fix loop until clean
---

Run a parent-orchestrated review-and-fix loop for the requested work.

Use the `subagent` tool. Keep the parent session as the loop controller and final decision-maker. Child subagents must receive concrete role-specific tasks; they must not run subagents or manage the loop themselves.

There is no generic worker or reviewer in this skill — the loop composes specialist agents:

- Writers (one per pass): `debugger` for bug fixes, correctness/regression fixes, or behavior changes; `code-simplifier` for cleanup, refinement, or simplification.
- Read-only reviewers (parallel each round): `codebase-analyzer` for correctness and flow; `debugger` in inspect-only mode for failure-mode hunts; `codebase-pattern-finder` for consistency; `codebase-online-researcher` for external-spec conformance; `codebase-research-locator` + `codebase-research-analyzer` for prior decisions.

Default to a maximum of 3 review rounds unless I specify a different cap. Count a review round each time fresh-context reviewers inspect the current diff after a writer pass. Stop early when reviewers find no blockers or fixes worth doing now.

If the invocation includes an implementation request, first launch one async writer for the approved scope — `debugger` when the work is correctness-shaped, `code-simplifier` when it is refinement-shaped. If the current diff is already the target, start with review. The sequence can be launched up front as an async/background chain when the workflow is clear, or continued as follow-up subagent runs after each async completion. For an initial chain, pass `async: true` so the main chat is unblocked; programmatic runs are non-interactive, so resolve any questions with me before launching. Use only one writer against the active worktree at a time unless I explicitly ask for isolated worktrees.

For each review round, launch fresh-context read-only reviewer specialists in parallel. They must inspect the repository, relevant instructions, and current diff directly from files and commands. They must not rely on the main conversation history and must not edit files — when using `debugger` for this pass, explicitly tell it to inspect and report only.

Choose review angles from the actual change. Common angles are correctness/regressions (`codebase-analyzer`), failure-mode hunt (`debugger` inspect-only), and pattern fit (`codebase-pattern-finder`). Add external-spec (`codebase-online-researcher`) or prior-decision (`codebase-research-*`) angles when the work calls for it. Prefer three strong reviewers over many vague reviewers.

After reviewers return, synthesize their feedback into:

- blockers or scope/product/architecture decisions that need user approval;
- fixes worth doing now;
- optional improvements;
- feedback to ignore or defer, with a short reason.

Do not blindly apply every finding. If reviewers surface an unapproved product, scope, or architecture decision, pause and ask me before launching a fix writer.

When an async implementation writer completes, treat its handoff as the transition into review, not as final completion, unless I explicitly asked for writer-only work, review-only output, or to stop after implementation.

When there are fixes worth doing now and the workflow is implementation-authorized, launch one async writer to apply only those synthesized fixes — `debugger` for correctness fixes, `code-simplifier` for cleanup fixes. Ask it to preserve the approved scope, run focused validation, and report changed files, commands run with exit codes, validation evidence, surprises, and anything left undone.

After a fix writer returns, run another review round only when it made material changes or addressed non-trivial findings. Do not keep looping for optional polish, speculative improvements, or findings already deferred by the parent.

Stop and summarize when one of these is true:

- reviewers find no blockers or fixes worth doing now;
- remaining feedback is optional, speculative, or intentionally deferred;
- reviewers surface an unapproved decision that needs me;
- the max review-round cap is reached.

On completion, inspect the final diff yourself, run or confirm focused validation where appropriate, and summarize the loop: rounds run, fixes applied, validation, remaining deferred items, and why the loop stopped.

Additional target, implementation request, max-iteration cap, or review focus from the slash command invocation:

$@
