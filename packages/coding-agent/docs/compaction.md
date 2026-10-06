---
title: "Context and compaction"
description: "Verbatim line compaction, when it runs, planning rungs, and branch summarization."
---

# Compaction & Branch Summarization

LLMs have finite context windows. Atomic reduces older transcript context with **verbatim line compaction** while preserving a configured count of recent context-visible messages. Branch summarization is a separate, lossy feature used when navigating away from a branch.

Compaction normally uses the model selected by `compactionModel`. If it fails, Atomic borrows the next model from your configured `fallbackModels` for that request. A chat model's policy refusal first triggers a pi-style summary on the same model; if that also fails, Atomic continues through the fallback models. Classifier and Morph failures go straight to the fallback models.

**The selected compaction model and configured fallback models may receive the compaction transcript**, using their own credentials. Borrowing never changes the session's model or thinking level. Line planners select deletions, and Atomic reconstructs surviving lines without rewriting them. The policy-refusal summary fallback is lossy and appears as `summary (pi fallback)`.

## On this page and its reference

This page covers the concepts and normal use of compaction and branch summarization. Parameters, persistence, extension hooks, formats, settings, and historical formats live in the [Compaction reference](/compaction/reference).

## Overview

| Mechanism | Trigger | Model output | Durable result |
|---|---|---|---|
| Verbatim compaction | `/compact`, RPC `compact`, or automatic threshold/overflow recovery | Per-message `id:start,end` deletion records | Retained transcript text reconstructed from the originals |
| Planner fallback borrowing | A failed selected compaction model | Same deletion records, from a configured `fallbackModels` entry | Retained text with the borrowed model recorded |
| Policy-refusal summary fallback | A chat provider refuses compaction under its policy | A pi-style summary from the same model | A summary boundary labeled `summary (pi fallback)` |
| Fresh context window | Load-bearing compaction after every configured model failed | *(none — no model call)* | A `CompactionEntry` with `details.rung: "fresh"` |
| Branch summarization | Optional `/tree` navigation | Generated summary prose | A `BranchSummaryEntry` |

There is one context-compaction door: `compact`.

## Verbatim Line Compaction

<a id="what-verbatim-means"></a>

### What "verbatim" means

Atomic serializes the compactable part of the conversation into role-tagged lines:

```text
[User]: Fix the failing parser test
[Assistant thinking]: I will inspect the parser.
[Assistant tool calls]: read(path="src/parser.ts")
[Tool result]: export function parse(...) {
...
[Assistant]: The off-by-one error is fixed.
```

The planner receives messages with their role and an array of lines. It returns inclusive per-message deletion ranges. For example, this deletes lines 2 through 5 of message 1:

```text
1:2,5
```

The model selects lines to delete; it does not rewrite retained text. Retained non-marker lines stay byte-identical and in their original order.

### Markers and repeated compaction

Each deleted span is replaced on its own line with exactly:

```text
(filtered N lines)
```

Counts remain cumulative across repeated compactions. The spelling is always plural, including `(filtered 1 lines)`.

### Protected structure

Role-header lines such as `[User]:` and `[Assistant]:` are ordinary ranked lines and may be deleted. Explicit protected spans, including blank lines, are never deleted. The configured number of newest context-visible messages remains outside the classifier request entirely; all preceding active transcript content is included.

Images in the compactable region become the literal line `[image]`; images in the protected recent tail remain normal image content. Tool-result text remains capped at 16,000 characters before becoming durable compaction text, with an explicit truncation marker for the remainder.

### `keepContext` tags

Wrap any section you never want compressed in `<keepContext>` / `</keepContext>`. Tagged content survives compression verbatim regardless of the compression ratio:

```
<keepContext>
You are researching only. Do not implement code changes.
</keepContext>
```

Protection includes the tags and survives repeated compaction, even if the planner ignores its instructions.

- Put each tag on its own line. Tags mentioned inside prose do not protect content.
- A span stays within one user or assistant message. An unclosed span protects through that message's end; a closing tag without an opener is ignored.
- Tags in tool results have no effect. Restate important file or fetched content in your own message.
- Protected content counts toward the keep target. Protect only essential constraints, since protecting more leaves less room for surrounding context.

Results report protected ranges as `keptRanges`.

## Compaction model

Use `/settings` → **Compaction model** to choose Auto, a chat model, a registered classifier, or Morph without changing your chat model. Auto uses the current session model. The selector saves to project settings when a project override already exists; otherwise it saves globally.

You can also set `compactionModel` in `~/.atomic/agent/settings.json` or a trusted project's `.atomic/settings.json`:

```json
{
  "compactionModel": "auto",
  "fallbackModels": ["openai-codex/gpt-6.1-sol"]
}
```

The default, `auto`, or an empty value uses the current session model, including Anthropic models. An exact registered chat-model ID selects that model just for compaction. Registered classifiers and Morph compactors are also selectable. Project settings cannot select `morph/*`; choose Morph globally instead.

An explicit compaction model can send the compactable transcript to a different provider, using that provider's credentials. Choose only providers permitted to receive your conversation. Changing `compactionModel` does not affect branch summaries.

For classifier compaction, log in with `/login typesafe`, then set `"compactionModel": "typesafe/jev-latest"`. The classifier scores groups of transcript lines; Atomic removes lower-scored groups without rewriting the rest. Protected lines and the recent tail are not sent for scoring. If scoring fails, Atomic tries your fallback models. Group boundaries can make the retained fraction differ from the requested compression ratio.

For Morph compaction, use `/login morph` or set `MORPH_API_KEY`, then choose `morph/morph-compactor` in the global selector or settings file. Without a credential, the selector marks Morph as `requires /login morph`. Morph receives the compactable transcript, including serialized thinking, but not the recent tail. Atomic reconstructs surviving lines from the originals and preserves `<keepContext>` spans. Morph is not a chat-model choice.

The compaction card shows the backend and model that produced the result, such as `classifier · typesafe/jev-latest` or `morph · morph/morph-compactor`. A policy-refusal summary appears as `summary (pi fallback)`.

### Troubleshooting policy refusals

If you see "This request was blocked as it seems to violate Anthropic's Terms of Service", or a refusal about reverse engineering or duplicating model outputs, the provider refused that compaction request. Atomic does not retry policy refusals as transient errors. For a chat model, it tries a pi-style summary on the same model. That summary retries recoverable rate-limit, server, overload, and transport errors according to `settings.retry`, just like the planner. If the summary also fails or is refused, Atomic continues through `fallbackModels`.

Classifier and Morph refusals skip the summary fallback and go directly to the next configured model. Anthropic remains a supported compactor. To keep verbatim compaction when a model refuses deletion planning, choose another `compactionModel`, such as a chat model, classifier, or Morph. Adding a `fallbackModels` entry gives Atomic another verbatim planner if the same-model summary fails.

If every attempt fails, manual `/compact` leaves your context unchanged. Overflow recovery and post-tool preflight may instead clear older context as described below.

## Parameters

Moved to [Compaction reference](/compaction/reference#parameters).

### Per-model budgets

Moved to [Compaction reference](/compaction/reference#per-model-budgets).

## When compaction runs

- **Manual:** `/compact`, `ctx.compact()`, `session.compact()`, or RPC `{ "type": "compact" }`.
- **Threshold:** automatic compaction starts when estimated context usage exceeds the effective input budget minus `reserveTokens`. Atomic checks both completed responses and the prospective next-turn context after tool results have been appended. When a provider reports all-zero usage, Atomic estimates the visible message size instead of skipping the check. A post-tool crossing is compacted before the active Pi tool loop sends its follow-up provider request.
- **Overflow:** an actual provider context overflow compacts and then retries the interrupted turn.
- **Truncated response:** a `length` stop before the original requested output cap gets one compact-and-retry attempt, independent of reported context-window metadata. If no compactable region exists, Atomic makes at most one direct continuation under that same recovery budget; a later actual context overflow remains eligible for load-bearing recovery. A response that reached the cap keeps Atomic's bounded direct-continuation behavior.

The recent tail counts messages, not whole turns. Queued input resumes when the active run becomes idle after automatic compaction. Escape cancels active compaction; you do not need to press it to release queued input. Atomic saves a backup before writing the compaction boundary.

Automatic continuations belong to the original prompt, including repeated output-cap continuations. The prompt and `agent_settled` lifecycle finish only after the entire chain drains, so status integrations such as [Herdr](/herdr) stay working through quiet response waits and continuation gaps.

Concurrent manual SDK requests share one run and result; `abortCompaction()` cancels it for all waiters. A manual request during automatic compaction cancels unfinished automatic work and its pending continuation, then runs after the active work settles. If the automatic boundary already committed, the manual run follows it. In the TUI, `/compact` can take over automatic compaction but refuses a second manual compaction or branch summary. Ordinary text remains queued until non-mid-turn compaction finishes, fails, or is cancelled.

SDK `prepareNextTurn` and `prepareNextTurnWithContext` callbacks receive rebuilt context after post-tool compaction. A `finishTurn` decision of `{ action: "end" }` leaves queued input pending until an explicit prompt or continuation. Mid-turn compaction resumes streaming without another user action.

### Recovery omissions

Threshold decisions and recovery use the canonical session projection. When Atomic recovers from a provider error retry, a model fallback, a context overflow, or a truncated response, the failed attempt stays in raw session history and a `context_edit` entry durably omits it from model context (see [Session Format](/session-format)). Omitted entries do not affect the compactable region, the kept tail, or token estimates, and usage captured by an omitted or later-edited assistant is not trusted for threshold checks. Extensions can inspect the omitted attempt through the raw transcript, exports, and history search.

## Planning rungs and failure behavior

Atomic uses the session's reasoning level unless a fallback entry specifies its own level. The provider controls the planner's output limit.

`settings.retry` controls recoverable-error retries within one chat model, including a policy-refusal summary fallback. Policy refusals are not retried. If compaction fails, Atomic tries configured `settings.fallbackModels` in order, using each model's own credentials and skipping the selected compaction model if listed again. Unavailable credentials do not prevent trying later models. Borrowing does not change the chat model, thinking level, or model-selection events.

When every configured model is exhausted, what happens depends on how much the caller can afford to lose:

| Call site | Urgency | Can borrow a model | Can start a fresh context window |
|---|---|---|---|
| `/compact`, `ctx.compact()`, `session.compact()`, RPC `compact` | recoverable | yes | no |
| Threshold auto-compaction | recoverable | yes | no |
| Overflow recovery | load-bearing | yes | yes |
| Post-tool preflight | load-bearing | yes | yes |

Recoverable failure writes no boundary, schedules no continuation, and reports the cause through `compaction_end`. Manual calls cannot request destructive recovery. Overflow recovery and post-tool preflight can fall back to the fresh context window below.

A successful compaction may delete less than requested. The retry can still report a context overflow.

### The fresh context window rung

If all configured planners fail during overflow recovery or post-tool preflight, Atomic can discard older compactable conversation and its prior summary. Explicit protected spans and the recent tail remain, unless the tail alone exceeds the provider's hard input limit. A region too small to plan is cleared only when known not to fit; a post-tool threshold crossing that still fits leaves it unchanged.

The chat shows `✻ Context cleared (compaction degraded)` rather than `✻ Context compacted`, and results record `details.rung: "fresh"`. Check what context remains before continuing important work.

Clearing context does not fix provider rate limits or guarantee the next turn succeeds. Atomic refuses a follow-up request still known to exceed the hard input limit. A committed boundary remains visible even if that request fails; `compaction_end` can contain both `result` and `errorMessage`.

### Length-truncated response recovery

Atomic may recover usable deletion records when the provider truncates a planner response. Successful recovery appears as ordinary `✻ Context compacted`; unusable output advances to the next configured model.

### Planner failure diagnostics

For a persisted session, each failed planner attempt writes its own JSON sidecar beside the session JSONL and carries the path on the typed outcome. When a recoverable compaction exhausts every configured model, the resulting `RangePlanError` includes that path, for example:

```text
Compaction range planning returned malformed output (diagnostic: /path/session-compaction-diagnostic-1785222000000-019fa7….json)
```

Treat diagnostic sidecars like session files: a raw model response may echo sensitive input. They use `0600` permissions where supported and omit API keys, request headers, and the planner request. In-memory sessions do not create them.

Interactive main chat and attached workflow stage chat treat `compaction_end` as the authority for cancellation and failure UI. A failed or cancelled `/compact` stops its spinner, shows the event-provided status or diagnostic path without a duplicate stack trace, writes no boundary, and leaves the session usable for another `/compact` attempt or a normal follow-up turn.

The displayed token count and estimated reduction can differ. See the [persisted statistics reference](/compaction/reference#persistence-and-resume) when interpreting results.

## Persistence and resume

Moved to [Compaction reference](/compaction/reference#persistence-and-resume).

## Extension hooks

Moved to [Compaction reference](/compaction/reference#extension-hooks).

### `session_before_compact`

Moved to [Compaction reference](/compaction/reference#session_before_compact).

### `session_compact`

Moved to [Compaction reference](/compaction/reference#session_compact).

### `session_compact_failed`

Moved to [Compaction reference](/compaction/reference#session_compact_failed).

## Branch Summarization

### When It Triggers

When you use `/tree` to navigate to a different branch, Atomic offers to summarize the work you're leaving. This injects context from the left branch into the new branch.

Branch summarization is a separate mechanism from context compaction. It generates a summary of the abandoned branch path and injects it into the new branch position. This is appropriate here because the alternative (losing branch context entirely on navigation) is worse than a lossy summary.

### How It Works

Atomic summarizes the branch you leave, prioritizing newer messages within its token budget, and saves the summary at the navigation point. It rejects incomplete summaries rather than saving partial prose.

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

### Cumulative File Tracking

Branch summaries retain the cumulative history of read and modified files, including files recorded by earlier branch summaries.

### BranchSummaryEntry Structure

Defined in [`session-manager.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/session-manager.ts):

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string | null;
  timestamp: string;  // ISO timestamp
  summary: string;
  fromId: string;      // Entry we navigated from
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default branch summarization uses this for details (from branch-summarization.ts):
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Extensions can store custom data in `details`.

## Branch Summary Format

Moved to [Compaction reference](/compaction/reference#branch-summary-format).

### Message Serialization for Branch Summaries

Moved to [Compaction reference](/compaction/reference#message-serialization-for-branch-summaries).

## Extension Hooks for Branch Summarization

Moved to [Compaction reference](/compaction/reference#extension-hooks-for-branch-summarization).

### session_before_tree

Moved to [Compaction reference](/compaction/reference#session_before_tree).

## Branch Summaries

When `/tree` switches away from one branch to another, Atomic can summarize the abandoned branch and attach that summary at the new position. This preserves important context from the path you left without replaying the whole branch.

When prompted, choose one of:

1. no summary
2. summarize with the default prompt
3. summarize with custom focus instructions

Branch summaries are separate from `/compact`: branch navigation generates summary prose, while normal verbatim compaction selects per-message line ranges and reconstructs retained text mechanically. A compaction policy refusal can trigger the pi-style summary fallback described above.

Use the [Compaction reference](/compaction/reference) for extension hooks and saved formats.

## Summary request isolation

Summary and planner requests do not execute tools or write into the main chat's prompt cache. They retain normal authentication, cancellation, and retry behavior.

**A model in `settings.fallbackModels` may receive the compaction transcript.** It uses its own provider credentials. Remove an entry if you do not want that provider to receive transcript content.

## Settings

Moved to [Compaction reference](/compaction/reference#settings).

## Historical formats

Moved to [Compaction reference](/compaction/reference#historical-formats).
