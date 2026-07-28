---
description: Specialist review/fix loop until clean
---

## Goal

Run a parent-orchestrated review-and-fix loop for the requested work until the current scope is clean, blocked on an unapproved decision, or capped. The parent controls the loop and makes final decisions; children receive concrete role-specific tasks and must not launch subagents or manage the loop.

Additional target, implementation request, max-iteration cap, or review focus from the slash command invocation:

$@

## Constraints and tools

Use the `subagent` tool and specialist roles rather than a generic worker or reviewer. Use one writer per pass: `debugger` for bugs, correctness/regression fixes, or behavior changes; `code-simplifier` for cleanup, refinement, or simplification. Reviewer options are `codebase-analyzer` for correctness and flow, `debugger` in inspect-only mode for failure modes, `codebase-pattern-finder` for consistency, `codebase-online-researcher` for external conformance, and `codebase-research-locator` then `codebase-research-analyzer` for prior decisions.

Default to at most 3 review rounds unless I set another cap. A round is a fresh-context inspection of the current diff after a writer pass.

If the invocation requests implementation, first launch one async writer for the approved scope: `debugger` for correctness-shaped work or `code-simplifier` for refinement-shaped work. If the current diff is already the target, begin with review. Launch a clear sequence up front as an async/background chain or continue with follow-up runs after each completion. For an initial chain, pass `async: true`; because launches are non-interactive, resolve questions with me first. Use one writer against the active worktree at a time unless I explicitly request isolated worktrees.

Each review round uses fresh context. Reviewers inspect repository instructions, relevant files, and the current diff directly, without main-conversation history, and cannot edit; explicitly put `debugger` in inspect-only mode. Choose angles from the change. Common angles are correctness/regressions, failure modes, and pattern fit; add external-spec or prior-decision coverage when applicable. Prefer three strong reviewers over many vague ones.

Delegate only independent work too large for a handful of tool calls; do not delegate auditing your own work, and prefer one subagent over several. Parallelize independent reads; stay sequential when one result determines the next; synthesize after retrieval. Keep work within the requested scope.

After each round, synthesize blockers or scope/product/architecture decisions needing approval, fixes worth doing now, optional improvements, and feedback to ignore or defer with a short reason. Assess findings rather than applying them blindly. Pause for my approval before a writer acts on any unapproved product, scope, or architecture decision.

An async implementation writer's handoff transitions into review; it is not final completion unless I requested writer-only work, review-only output, or a stop after implementation. When implementation is authorized and fixes are worth doing now, launch one async writer to apply only the synthesized fixes—`debugger` for correctness or `code-simplifier` for cleanup. Require it to preserve approved scope, run focused validation, and report changed files, commands with exit codes, validation evidence, surprises, and unfinished work.

Run another review round after a fix only when it made material changes or addressed non-trivial findings. Do not loop for optional polish, speculative improvements, or already deferred findings.

## Output

On completion, inspect the final diff and run or confirm appropriate focused validation. Return a concise, user-facing summary of roughly 300–700 words: why the loop stopped, rounds run, fixes applied, validation, remaining blockers or deferred items, and next steps. Lead with the outcome; keep facts, decisions, caveats, and next steps; drop background and repetition; stay readable rather than compressed into fragments.

Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.

## Stop rule

Stop and summarize when reviewers find no blockers or fixes worth doing now; remaining feedback is optional, speculative, or intentionally deferred; an unapproved decision needs me; or the review-round cap is reached. The loop is done only after the final diff and focused validation have been inspected or explicitly reported as unverified.
