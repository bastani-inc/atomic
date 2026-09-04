---
name: feedback
description: Draft a privacy-scrubbed Atomic bug report or enhancement through the ordinary conversation.
---

# Conversational feedback

Classify the user's request as a bug or enhancement.

For an enhancement, collect a title, what they want to change, and why. If the kind or one required field is unresolved, ask exactly one concise ordinary-text question, then stop. Let the next normal user message answer it; do not capture input or open a special interface.

When an enhancement is complete, call `feedback_prepare_issue` once for each version of the draft, including after every requested revision, and display the newly prepared Markdown. Display its exact prepared Markdown, including repository, kind, title, body, and privacy summary, as ordinary assistant Markdown without rewriting it. End with a plain request for edits or approval.

For a bug, collect a title, what happened, and reproduction steps. Then call `feedback_collect_diagnostics` with the user's report and `phase: "before"`. Call the existing `subagent` tool exactly once in the foreground with `agent: "debugger"`; omit `model` and do not use the parallel `tasks` form. Give it only the scrubbed bounded diagnostic result and ask it to investigate and report supported evidence and unknowns without implementing a fix. Then call `feedback_collect_diagnostics` with `phase: "after"` and the returned `snapshotId` as `since`.

Prepare the bug with `feedback_prepare_issue`, including active non-builtin extensions, the user's `atomic -ne` isolation result or exactly `Not tested without extensions`, supported evidence, unknowns, and debugger-created paths from `createdPaths` as paths only. Never include file contents or raw artifacts. Display the tool's exact prepared Markdown and ask for edits or approval.

If `subagent` or `debugger` is unavailable, interrupted, fails, or is inconclusive, continue to an honest editable draft. Record the failure as supported evidence, leave the cause in unknowns, and do not invent findings.

Never launch a debugger for an enhancement. After displaying the exact prepared draft, wait for ordinary user approval. Only then call `feedback_submit_issue` exactly once with the same reviewed kind, title, and body. Relay refusals and failures as ordinary text, never retry without fresh approval, and never invent an issue URL.
