---
name: feedback
description: Draft a privacy-scrubbed Atomic bug report or enhancement through the ordinary conversation.
---

# Conversational feedback

Classify the user's request as a bug or enhancement.

For an enhancement, collect a title, what they want to change, and why. If the kind or one required field is unresolved, ask exactly one concise ordinary-text question, then stop. Let the next normal user message answer it; do not capture input or open a special interface.

When an enhancement is complete, call `feedback_prepare_issue` exactly once. Display the tool's exact prepared title and body as ordinary assistant Markdown, without rewriting them. End with a plain request for edits or approval.

For a bug, collect a title, what happened, and reproduction steps. Include expected behavior and the Atomic version when the user supplies them. If a required field is unresolved, ask exactly one concise ordinary-text question, then stop and wait for the next normal user message. Do not invent reproduction steps or a cause.

Then call `feedback_collect_diagnostics` with the user's report and `phase: "before"`. Discover the available debugger with `subagent({ action: "list" })`. Launch the existing `debugger` exactly once with `context: "fresh"` and `wait: { kind: "foreground" }`; omit `model` and do not use the parallel `tasks` form. Give it only the scrubbed bounded diagnostic result and ask it to investigate and report supported evidence and unknowns without implementing a fix. If the foreground observation yields, wait for that same run's terminal result before collecting the after snapshot; do not launch another debugger. Then call `feedback_collect_diagnostics` with `phase: "after"` and the returned `snapshotId` as `since`.

When a bug is complete, call `feedback_prepare_issue` exactly once with `kind: "bug"`, including active non-builtin extensions, the user's `atomic -ne` isolation result or exactly `Not tested without extensions`, supported evidence, unknowns, and debugger-created paths from `createdPaths` as paths only. Never include file contents or raw artifacts. Display the tool's exact prepared title and body as ordinary assistant Markdown, without rewriting them. End with a plain request for edits or approval.

Treat `createdPaths` as newly observed paths, not proof of who created them. If `baselineUnavailable` is present or `worktree.available` is false, disclose that the worktree comparison is unavailable and leave created paths unknown. Do not infer a clean worktree from an empty path list or read file contents to fill the gap.

If `worktree.truncated` or `createdPathsTruncated` is true, state in the draft's `unknowns` that the corresponding path list is incomplete and only its first 100 paths are shown. Keep `debuggerPaths` limited to the returned paths; do not imply that the list describes the whole worktree or investigation footprint.

If `subagent` or `debugger` is unavailable, interrupted, fails, or is inconclusive, continue to an honest editable draft. For unavailable or failed investigation, say `Investigation unavailable`, record the failure as supported evidence, leave the cause in unknowns, and do not invent findings.

Never launch a debugger for an enhancement. Never post an issue. Posting is not available in this turn.
