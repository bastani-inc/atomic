---
title: "Context and compaction"
description: "Verbatim line compaction, when it runs, planning rungs, and branch summarization."
---

# Compaction & Branch Summarization

LLMs have finite context windows. Atomic reduces older transcript context with **verbatim line compaction** while preserving a configured count of recent context-visible messages. Branch summarization is a separate, lossy feature used when navigating away from a branch.

Compaction normally uses the model selected by `compactionModel`. If it fails, Atomic borrows the next model from your configured `fallbackModels` for that request. A chat model's policy refusal that arrives before it generated anything first triggers pi's summary compaction on the same model, whether selected by `auto`, an explicit chat-model ID, or a `fallbackModels` entry. A refusal that arrives partway through the model's output is retried once and then planned in parts, keeping the result verbatim, before any summary. If that also fails, Atomic continues through the fallback models. Classifier and Morph failures go straight to the fallback models.

**The selected compaction model and configured fallback models may receive the compaction transcript**, using their own credentials. Borrowing never changes the session's model or thinking level. Line planners select deletions, and Atomic reconstructs surviving lines without rewriting them. The policy-refusal summary fallback is lossy and appears as `summary (fallback)`.

## On this page and its reference

This page covers the concepts and normal use of compaction and branch summarization. Parameters, persistence, extension hooks, formats, settings, and historical formats live in the [Compaction reference](/compaction/reference).

## Overview

| Mechanism | Trigger | Model output | Durable result |
|---|---|---|---|
| Verbatim compaction | `/compact`, RPC `compact`, or automatic threshold/overflow recovery | Per-message `id:start,end` deletion records | Retained transcript text reconstructed from the originals |
| Background compaction | Context passes `compaction.backgroundThresholdPercent` (75% by default) | The same verbatim compaction, run while the agent keeps working | The same boundary, committed at the next turn boundary |
| Planner fallback borrowing | A failed selected compaction model | Same deletion records, from a configured `fallbackModels` entry | Retained text with the borrowed model recorded |
| Split planning | A chat provider refuses a compaction request partway through its output, twice | The same deletion records, planned for each part of the transcript split at message boundaries | Retained text reconstructed from the originals |
| Policy-refusal summary fallback | A chat provider refuses compaction under its policy before generating anything, or split planning failed | Pi's summary compaction on the same model | A summary boundary labeled `summary (fallback)` |
| Fresh context window | Load-bearing compaction after every configured model failed | *(none — no model call)* | A `CompactionEntry` with `details.rung: "fresh"` |
| Branch summarization | Optional `/tree` navigation | Generated summary prose | A `BranchSummaryEntry` |

There is one context-compaction door: `compact`.

## Verbatim Line Compaction

<a id="what-verbatim-means"></a>

### What "verbatim" means

Atomic serializes the compactable part of the conversation into role-tagged lines:

```text
[User]: Fix the failing parser test
[Assistant tool calls]: read(path="src/parser.ts")
[Tool result]: export function parse(...) {
...
[Assistant]: The off-by-one error is fixed.
```

Thinking is left out, as in summary compaction: the transcript keeps user text, assistant text, tool calls, and tool results. Some providers refuse a compaction request that replays earlier thinking as text. Messages after the compaction boundary keep their thinking, and the session file keeps every message unchanged.

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

Removed lines are not lost. They stay in the session's history, and the compacted context tells the agent so, naming this session's `history://sessions/<sessionId>` URL: the agent uses `search` on that URL to find removed text, including text removed by earlier compactions of the same session, and `read` with `:N-M` to open it. The same note points the agent at `search history://sessions` for the project's other sessions, `search history://workflows` for workflow runs and `search history://` for both. It tells the agent to use them before redoing an investigation, or when a removed decision, error message, file path or result matters, and that a search over several records covers the newest ones by default and pages on with `?offset=`. The planner is told that removed lines stay retrievable, so it removes bulky output that can be read again, such as tool results, file dumps and logs, before your requests, decisions, root causes and conclusions. See [Recalling earlier work](/sessions#recalling-earlier-work).

### Recalled context

Once the planner has chosen what to keep, Atomic looks through history for lines that bear on the current task and adds the best few to the compacted context, in a short `Recalled context` section after the kept lines. The search uses your latest request and the compaction `query`. It covers this session's own history, which includes lines earlier compactions removed, then the project's other sessions and workflow runs, with the same `history://` search the agent has. No model call is involved.

Each snippet is quoted with `> ` and starts with a source line such as `history://sessions/<id>:12-14`, which `read` opens in full. A line the compacted context already shows, including the kept recent messages, is never repeated, and each line appears once.

The section stays small: at most 10% of the kept context, never more than 1,500 tokens, and the whole search has 3 seconds. If the search fails, runs out of time, finds nothing relevant, or the compaction is cancelled, the compacted context stays as the planner left it and compaction carries on. A boundary written by a `session_before_compact` extension, a fresh context window or the policy-refusal summary fallback gets no recalled context. A recalled line is data, not structure: quoting means it can never act as a `<keepContext>` span, a role header or a `(filtered N lines)` marker when the boundary is compacted again.

Recall is on by default. Set `compaction.historyRecall` to `false` in settings to leave the compacted context exactly as the planner kept it.

### Keep target

The planner lists its deletions in priority order, lowest continuation value first. Atomic applies them in that order and stops once the lines deleted reach the keep target (`compression_ratio`) plus a small tolerance of 5% of the compactable lines, trimming the deletion that crosses the limit. Deletions the planner lists after that point are ignored, so a plan that deletes far more than the ratio asks for no longer shrinks the transcript below it. A plan that deletes less than the target is applied as written. Protected lines are never deleted and do not count against the limit.

### Protected structure

Role-header lines such as `[User]:` and `[Assistant]:` are ordinary ranked lines and may be deleted. Explicit protected spans, including blank lines, are never deleted. The configured number of newest context-visible messages remains outside the classifier request entirely; all preceding active transcript content is included.

Images in the compactable region become the literal line `[image]`; images in the protected recent tail remain normal image content. Tool-result text is capped at 2,000 characters before the planner sees it and before it becomes durable compaction text. The truncation marker gives the exact location of the full output, for example `[... 41230 more characters truncated; full output: read history://sessions/<sessionId>:1234-1890]`, and `read` on that path returns the whole output. When the location cannot be determined, such as in a session that is not saved, the marker only says the full output is in this session's history, which the agent can search as described above.

The recent tail is appended to the boundary in the same grammar, without thinking. Its tool results keep their full text.

Compactions written by earlier Atomic versions still load unchanged. When such a session is compacted again, the `[Assistant thinking]:` sections in its earlier compacted text are dropped before the request. Thinking lines whose header an earlier compaction already deleted cannot be identified and stay.

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

The default, `auto`, or an empty value uses the current session model, including Anthropic models. An exact registered chat-model ID selects that model just for compaction. Registered classifiers and Morph compactors are also selectable, in global or trusted project settings.

An explicit compaction model can send the compactable transcript to a different provider, using that provider's credentials. Choose only providers permitted to receive your conversation. Changing `compactionModel` does not affect branch summaries. SDK and extension code can pick a model for a single run with `session.compact({ compactionModel })` or `ctx.compact({ compactionModel })`, which leaves the setting unchanged.

For classifier compaction, log in with `/login typesafe`, then set `"compactionModel": "typesafe/jev-latest"`. The classifier scores groups of transcript lines; Atomic removes lower-scored groups without rewriting the rest. Protected lines and the recent tail are not sent for scoring. If scoring fails, Atomic tries your fallback models. Group boundaries can make the retained fraction differ from the requested compression ratio.

For Morph compaction, use `/login morph` or set `MORPH_API_KEY`, then choose `morph/morph-compactor` in the selector or a settings file. Without a credential, the selector marks Morph as `requires /login morph`. Morph receives the compactable transcript without thinking, but not the recent tail. Atomic reconstructs surviving lines from the originals and preserves `<keepContext>` spans. Morph is not a chat-model choice.

The compaction card shows the model that produced the result, such as `github-copilot/claude-opus-5.5` or `morph/morph-compactor`. A policy-refusal summary is headed `Context compacted · summary (fallback)`.

### Troubleshooting policy refusals

If you see "This request was blocked as it seems to violate Anthropic's Terms of Service", or a refusal about reverse engineering or duplicating model outputs, the provider refused that compaction request. Atomic does not retry policy refusals as transient errors, and it handles two kinds differently.

- **Refused before the model generated anything.** The provider rejected the request at once. For any chat compaction model, including `auto`, Atomic tries pi's summary compaction on the same model. That summary retries recoverable rate-limit, server, overload, and transport errors according to `settings.retry`, just like the planner. If the summary also fails or is refused, Atomic continues through `fallbackModels`.
- **Refused partway through the model's output.** The refusal came after the model had billed output or reasoning tokens, which on a very large transcript can take minutes. Atomic retries the planner once. If the retry fails for another reason, Atomic goes to the summary as it does for an immediate refusal. If the retry is refused again, Atomic splits the compactable transcript at message boundaries and plans each half, then each quarter of a half that is refused, and merges the deletions into one verbatim result. A quarter that is still refused ends this step. Only then does Atomic fall back to the same-model summary and the `fallbackModels` as above.

Splitting costs extra planner requests, at most eight per planner model, each billed by your provider. Automatic compaction shares the [planning time limit](#planning-time-limit) across all of them, so a run that is still refusing after five minutes ends as timed out; raise `compaction.planningTimeoutMs` or run `/compact`, which has no limit, to give it longer.

Classifier and Morph refusals skip the summary fallback and go directly to the next configured model. Anthropic remains a supported compactor. To keep verbatim compaction when a model refuses deletion planning, choose another `compactionModel`, such as a chat model, classifier, or Morph. Adding a `fallbackModels` entry gives Atomic another verbatim planner if the same-model summary fails.

If every attempt fails, manual `/compact` leaves your context unchanged. Overflow recovery and post-tool preflight may instead clear older context as described below.

## Parameters

Moved to [Compaction reference](/compaction/reference#parameters).

### Per-model budgets

Moved to [Compaction reference](/compaction/reference#per-model-budgets).

## When compaction runs

- **Manual:** `/compact`, `ctx.compact()`, `session.compact()`, or RPC `{ "type": "compact" }`.
- **Background:** when context usage passes `compaction.backgroundThresholdPercent` of the context window, compaction runs in the background while turns continue. See [Background compaction](#background-compaction).
- **Threshold:** blocking compaction starts when estimated context usage exceeds the effective input budget minus `reserveTokens` and no background result is ready. Atomic checks both completed responses and the prospective next-turn context after tool results have been appended. When a provider reports all-zero usage, Atomic estimates the visible message size instead of skipping the check. A post-tool crossing is compacted before the active Pi tool loop sends its follow-up provider request.
- **Overflow:** an actual provider context overflow compacts and then retries the interrupted turn.
- **Truncated response:** a `length` stop before the original requested output cap gets one compact-and-retry attempt, independent of reported context-window metadata. If no compactable region exists, Atomic makes at most one direct continuation under that same recovery budget; a later actual context overflow remains eligible for load-bearing recovery. A response that reached the cap keeps Atomic's bounded direct-continuation behavior.

The recent tail counts messages, not whole turns. Queued input resumes when the active run becomes idle after automatic compaction. Escape cancels active compaction; you do not need to press it to release queued input. Atomic saves a backup before writing the compaction boundary.

Automatic continuations belong to the original prompt, including repeated output-cap continuations. The prompt and `agent_settled` lifecycle finish only after the entire chain drains, so status integrations such as [Herdr](/herdr) stay working through quiet response waits and continuation gaps.

Concurrent manual SDK requests share one run and result; `abortCompaction()` cancels it for all waiters. A manual request during automatic compaction cancels unfinished automatic work and its pending continuation, then runs after the active work settles. If the automatic boundary already committed, the manual run follows it. In the TUI, `/compact` can take over automatic compaction but refuses a second manual compaction or branch summary. Ordinary text, prompt templates and skills remain queued until non-mid-turn compaction finishes, fails, or is cancelled. Commands that do not send a prompt, such as `/settings`, `/tasks` and `/workflow connect`, run at once. A session command such as `/new` also runs at once and cancels the compaction. A user message that reaches the session while it compacts, whether from an SDK `prompt()`, an RPC `prompt` or an extension's `sendUserMessage()`, waits until compaction ends, then goes out once, in arrival order. If an earlier waiting message has started a turn by then, a message sent without `streamingBehavior` or `deliverAs` is queued behind it as steering. Waiting messages appear in `getSteeringMessages()`/`getFollowUpMessages()` and `queue_update`, and `clearQueue()` returns them without sending them. Before the TUI runs an extension command during compaction, it hands the messages already typed to the session, so a message the command sends goes out after them.

SDK `prepareNextTurn` and `prepareNextTurnWithContext` callbacks receive rebuilt context after post-tool compaction. A `finishTurn` decision of `{ action: "end" }` leaves queued input pending until an explicit prompt or continuation. Mid-turn compaction resumes streaming without another user action.

## Background compaction

Background compaction is on by default. When context usage passes `compaction.backgroundThresholdPercent` of the context window (75% by default), Atomic compacts the older part of the conversation while the agent keeps taking turns. This applies to interactive sessions, SDK and RPC sessions, workflow stages and subagents.

1. **It compacts a frozen copy of history.** The background task covers history up to the last saved entry, leaving out trailing tool calls that have no result yet. Messages added while it runs are not part of it. It uses the same compaction model, fallback models and policy-refusal summary fallback as any other compaction.
2. **The result waits for a turn boundary.** When the task finishes, Atomic saves the result in the session and applies it before the next model request, or before the next prompt when the agent is idle. It is applied once. Messages added after the frozen copy stay exactly as they were and follow the compacted text.
3. **Blocking compaction is only the fallback.** If the context reaches the `reserveTokens` threshold, or a request overflows, Atomic first applies a ready background result. It compacts in the foreground only when no result is ready, or the ready one does not free enough space. A foreground compaction cancels a background task that is still running.

If the background task fails, or applying its saved result fails, history stays unchanged and the turn continues. `session.compaction` reports `failed` with a typed error, and Atomic tries again at a later turn with an increasing delay (15 seconds after the first failure, doubling up to 15 minutes). Overflow and the `reserveTokens` threshold still compact in the foreground in the meantime.

Applying a result changes the start of the prompt, so the next request misses the provider's prompt cache. With **Cache miss notices** on in `/settings`, the chat shows the expected miss when the result is applied.

A fork or `/tree` branch taken before a result was applied keeps its full history. A fork taken after the result was saved but before it was applied can apply it at its own next turn. If a newer compaction already covers the same history, or an earlier message in that history was edited after the result was made, Atomic discards the result and reports why in the `background_compaction` event.

Background compaction can only start before the blocking `reserveTokens` threshold: the background threshold, `backgroundThresholdPercent` of the context window, must be lower than the context window minus `reserveTokens`. With the default 16,384-token reserve and 75% that holds for windows above 65,536 tokens. On smaller windows every automatic compaction stays blocking, as before; a smaller `reserveTokens` or a lower percentage widens the range.

To turn it off, set **Background compaction** to `false` in `/settings` or `compaction.background: false` in settings. Atomic then compacts in the foreground at the `reserveTokens` threshold, as before. A result saved before you turned it off is kept but not applied, and `session.compaction` reads `idle` until you turn it back on. Only a boundary write that had already started finishes. **Background compaction threshold** in `/settings` sets the percentage.

SDK sessions expose the state as `session.compaction`, `{ state: "idle" | "running" | "ready" | "failed", upToEntryId, startedAt, error }`, together with `session.onCompactionReady(listener)` and `await session.awaitBackgroundCompaction()`. RPC `get_state` returns the same state as `compaction`. Workflow stage status, including `workflow stages` and `workflow stage`, shows it as `compaction`. See the [Compaction reference](/compaction/reference#background-compaction-state) for the fields and error codes.

### Recovery omissions

Threshold decisions and recovery use the canonical session projection. When Atomic recovers from a provider error retry, a model fallback, a context overflow, or a truncated response, the failed attempt stays in raw session history and a `context_edit` entry durably omits it from model context (see [Session Format](/session-format)). Omitted entries do not affect the compactable region, the kept tail, or token estimates, and usage captured by an omitted or later-edited assistant is not trusted for threshold checks. Extensions can inspect the omitted attempt through the raw transcript, exports, and history search.

## Planning rungs and failure behavior

Atomic uses the session's reasoning level unless a fallback entry specifies its own level. The provider controls output limits for both planning and policy-refusal summary requests, using the model's output limit reduced as needed to fit the request within its context window. `compaction.reserveTokens` controls only when automatic compaction starts.

`settings.retry` controls recoverable-error retries within one chat model, including a policy-refusal summary fallback. Policy refusals are not retried. If compaction fails, Atomic tries configured `settings.fallbackModels` in order, using each model's own credentials and skipping the selected compaction model if listed again. Unavailable credentials do not prevent trying later models. Borrowing does not change the chat model, thinking level, or model-selection events.

When every configured model is exhausted, what happens depends on how much the caller can afford to lose:

| Call site | Urgency | Can borrow a model | Can start a fresh context window |
|---|---|---|---|
| `/compact`, `ctx.compact()`, `session.compact()`, RPC `compact` | recoverable | yes | no |
| Threshold auto-compaction | recoverable | yes | no |
| Background compaction | recoverable | yes | no |
| Overflow recovery | load-bearing | yes | yes |
| Post-tool preflight | load-bearing | yes | yes |

Recoverable failure writes no boundary, schedules no continuation, and reports the cause through `compaction_end`. Manual calls cannot request destructive recovery. Overflow recovery and post-tool preflight can fall back to the fresh context window below.

A successful compaction may delete less than requested, because the planner can list fewer deletions than the keep target allows, but it does not delete more than the keep target plus a small tolerance. The retry can still report a context overflow.

### Planning time limit

Automatic compaction (threshold, overflow recovery and post-tool preflight) gives model planning at most `compaction.planningTimeoutMs`, five minutes by default. The limit covers every planner, classifier or Morph request, same-model retry, overflow trim and borrowed fallback model, and the credential lookups in between. The per-request `streamDeadlineMs` cannot replace it: a planner that keeps streaming, for example long reasoning over a very large uncached transcript, never goes idle. When the limit runs out, Atomic aborts the in-flight request and treats planning as failed. Overflow recovery and post-tool preflight then start a fresh context window, so the active turn continues. Threshold auto-compaction fails with `Compaction planning timed out after <n> ms` and leaves the context unchanged. The limit does not cover extension `session_before_compact` handlers, which run before planning; they receive the compaction's abort signal. Manual compaction has no limit; press Escape to cancel it. Set the limit to `0` or `"disabled"` to turn it off.

### The fresh context window rung

If all configured planners fail during overflow recovery or post-tool preflight, Atomic can discard older compactable conversation and its prior summary. Explicit protected spans and the recent tail remain, unless the tail alone exceeds the provider's hard input limit. A region too small to plan is cleared only when known not to fit; a post-tool threshold crossing that still fits leaves it unchanged.

The chat shows `✻ Context cleared (compaction degraded)` rather than `✻ Context compacted`, and results record `details.rung: "fresh"`. When planning failed first, `details.freshReason` names the cause, for example `Compaction planning timed out after 300000 ms` or the last planner's provider error. Check what context remains before continuing important work.

Clearing context does not fix provider rate limits or guarantee the next turn succeeds. Atomic refuses a follow-up request still known to exceed the hard input limit. A committed boundary remains visible even if that request fails; `compaction_end` can contain both `result` and `errorMessage`.

### Length-truncated response recovery

Atomic may recover usable deletion records when the provider truncates a planner response. Successful recovery appears as ordinary `✻ Context compacted`; unusable output advances to the next configured model.

### Planner output with stray lines

A planner answer is a list of `id:start,end` records. Atomic skips lines around the records that are not records, such as a sentence of prose, a header, blank lines or a Markdown fence, and trims whitespace around each record. The remaining records keep the order the planner listed them.

An answer is treated as malformed output, and the next configured model is tried, when it contains no valid record or when more than half of its non-blank lines are not records. A derailed or conversational answer is therefore not mistaken for a sparse plan. A recovered answer that tolerated stray lines records how many were skipped as `skippedLineCount` in its recovery diagnostic.

### Planner failure diagnostics

For a persisted session, each failed planner attempt writes its own JSON sidecar and carries the path on the typed outcome. A session kept in a JSONL file gets the sidecar beside the session file. A session kept in SQLite or another store has no session file, so its sidecars go to `compaction-diagnostics/` in the agent directory (`~/.atomic/agent/compaction-diagnostics/`, or under `ATOMIC_CODING_AGENT_DIR` when that is set) and are named `<session id>-compaction-diagnostic-<time>-<id>.json`. When a recoverable compaction exhausts every configured model, the resulting `RangePlanError` includes that path, for example:

```text
Compaction range planning returned malformed output (diagnostic: /path/session-compaction-diagnostic-1785222000000-019fa7….json)
```

Treat diagnostic sidecars like session files: a raw model response may echo sensitive input. They use `0600` permissions where supported and omit API keys, request headers, and the planner request. The `rawResponse` field holds the model's answer with credential-shaped text replaced by `[redacted]`, cut to 65,536 characters; when it was cut, `rawResponseChars` gives its full length. Writing a sidecar is best effort: if the directory cannot be written, compaction reports its own failure without a path, and turning on debug mode records the unwritable path in the debug log. Atomic does not delete sidecars, so remove old files from the directory when you no longer need them. In-memory sessions do not create them.

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

Atomic summarizes the branch you leave, prioritizing newer messages within its token budget, and saves the summary at the navigation point. The provider sizes summary output from the model's output limit and the available context; `branchSummary.reserveTokens` only controls how much history is selected. Atomic rejects incomplete summaries rather than saving partial prose.

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

Branch summaries are separate from `/compact`: branch navigation generates summary prose, while normal verbatim compaction selects per-message line ranges and reconstructs retained text mechanically. A chat compaction policy refusal can trigger pi's summary compaction as described above.

Use the [Compaction reference](/compaction/reference) for extension hooks and saved formats.

## Summary request isolation

Summary and planner requests do not execute tools or write into the main chat's prompt cache. They retain normal authentication, cancellation, and retry behavior.

**A model in `settings.fallbackModels` may receive the compaction transcript.** It uses its own provider credentials. Remove an entry if you do not want that provider to receive transcript content.

## Settings

Moved to [Compaction reference](/compaction/reference#settings).

## Historical formats

Moved to [Compaction reference](/compaction/reference#historical-formats).
