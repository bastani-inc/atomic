---
title: "Summarize branches"
sidebarTitle: "Branch summaries"
description: "Optionally summarize an abandoned conversation branch when switching paths with /tree."
---

When [`/tree`](/sessions#branching-with-tree) switches away from a branch, Atomic can optionally summarize the abandoned branch and attach that summary at the new position. This preserves context from the path you left without replaying the entire branch.

<Note>
Branch summaries are separate from `/compact` and unaffected by `compactionModel`. Branch navigation generates a lossy prose summary of an abandoned path, whereas compaction uses [memory compaction](/compaction/memory-compaction) or a [custom compaction model](/compaction/custom-compactors) on your active context.
</Note>

## Choose whether to summarize

When leaving a branch in `/tree`, choose one of three options:

1. No summary
2. Summarize with the default prompt
3. Summarize with custom focus instructions

Set `"branchSummary": { "skipPrompt": true }` in `settings.json` to skip the prompt and default to no summary.

## How branch summarization works

Atomic collects as many recent messages from the abandoned branch (up to the common ancestor) as fit while leaving room for the summary prompt and reply. That history budget is `contextWindow - branchSummary.reserveTokens` (defaulting `contextWindow` to `128000` when unknown, and `reserveTokens` to `16384`). `branchSummary.reserveTokens` reserves headroom for the summary call rather than capping the history budget itself.

If the abandoned branch contains no summarizable messages, Atomic records `"No content to summarize"` without sending a model request.

Otherwise, the provider sizes summary output from the model's output limit and available context, inheriting the session's `thinkingLevel` unless it is `"off"`. Atomic rejects incomplete summaries rather than saving partial prose.

```text
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D ─ [summary of B,C,D]
    A ───┤
         └─ E ─ F (new leaf)
```

Built-in branch summaries keep a cumulative list of read and modified files, carrying forward file lists from earlier built-in branch summaries (extension-supplied summaries are not parsed for file lists).

## How summary requests run

Branch summary requests run no tools and bypass prompt cache writes so summarizing an abandoned branch does not disturb prompt caching on your main branch. They use normal authentication, cancellation, and retry behavior.

For the exact prompt template, `BranchSummaryEntry` structure, message serialization, edge cases, and the `session_before_tree` extension hook, see [Branch summary format](/compaction/reference#branch-summary-format) and [Extension hooks for branch summarization](/compaction/reference#extension-hooks-for-branch-summarization).
