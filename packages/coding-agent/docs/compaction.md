---
title: "Context and compaction"
description: "How compaction clears or compacts the context window, how the agent recovers earlier work from session history, and branch summarization."
---

# Compaction & Branch Summarization

LLMs have finite context windows. When a session's context nears the limit, Atomic compacts it in one of two forms:

- **Context cleared**, the default. No model is called. The context window is cleared, and the agent recovers what it needs from the session's history with its own tools.
- **Context compacted**, when `compactionModel` names a compactor model. The compactor condenses the conversation once, and its output replaces the context.

In both forms the whole conversation stays in the session's history, and the agent is told exactly where to find it. Branch summarization is a separate, lossy feature used when you navigate away from a branch with `/tree`.

## On this page and its reference

This page covers the concepts and normal use of compaction and branch summarization. Parameters, persistence, extension hooks, formats, and settings live in the [Compaction reference](/compaction/reference).

## Overview

| Form | When | Model call | What the model sees after the boundary |
|---|---|---|---|
| Context cleared | `compactionModel` is `auto` or empty, or the compactor failed | None | The system prompt and one `Context cleared` message |
| Context compacted | `compactionModel` names a compactor model, or an extension supplied replacement text | One compactor request | The system prompt and one `Context compacted` message that holds the compacted text |
| Branch summarization | Optional, when `/tree` leaves a branch | One summary request | A `BranchSummaryEntry` at the new position |

## When compaction runs

- **Automatic threshold:** when estimated context usage exceeds the model's context window minus `compaction.reserveTokens`. Atomic checks after tool results are added, before the follow-up request, and before every new request. A response that ends over the threshold stays the session's last answer, so `prompt()` callers, RPC `get_last_assistant_text` and `/copy` can read it; the context is cleared just before the next request: a new prompt, queued input, an extension's interrupt message, or the continuation after a tool's result. When a provider reports all-zero usage, Atomic estimates the visible message size instead of skipping the check.
- **Overflow:** a provider context-overflow error compacts and then retries the interrupted turn, once per turn.
- **Truncated response:** a `length` stop before the model's requested output cap gets one compact-and-retry. If there is nothing to compact, Atomic makes at most one direct continuation instead.
- **Manual:** `/compact [instructions]`, `ctx.compact()`, `session.compact()`, or RPC `{ "type": "compact" }`.

A boundary never falls in the middle of a stream or between a tool call and its result. Manual compaction stops the active run before it starts. While a tool call is still waiting for its result, such as a detached call, no boundary is written: automatic compaction clears the context before the request that continues with the result, and `/compact` reports that a tool call is still waiting. When nothing new has entered the context since the last boundary, compaction does nothing, and `/compact` reports `Nothing to compact`. Automatic compaction also does nothing when the system prompt and the boundary message alone would still exceed the trigger, because clearing could not help; a provider overflow is then left to [`fallbackModels`](/settings#fallbackmodels).

Queued input resumes when the active run becomes idle after automatic compaction. Escape cancels compaction until the boundary is written; a cancel before then leaves the session unchanged. While a compactor request runs, Escape stops that request and the context is cleared instead. You do not need to press it to release queued input. Atomic saves a backup before writing the boundary. The backup is best effort: if it cannot be written, for example on a full disk, the boundary is still written and records no `backupPath`.

Automatic continuations belong to the original prompt, including repeated output-cap continuations. The prompt and `agent_settled` lifecycle finish only after the entire chain drains, so status integrations such as [Herdr](/herdr) stay working through quiet response waits and continuation gaps.

Concurrent manual SDK requests share one run and result; `abortCompaction()` cancels it for all waiters, except that while a compactor request runs it stops the request and the context is cleared instead. A manual request during automatic compaction cancels the automatic work and its pending continuation, then runs after the active work settles. If the automatic boundary already committed, the manual run follows it. In the TUI, `/compact` can take over automatic compaction but refuses a second manual compaction or branch summary. Ordinary text, prompt templates and skills remain queued until compaction finishes, fails, or is cancelled. Commands that do not send a prompt, such as `/settings` and `/tasks`, run at once. A session command such as `/new` also runs at once and cancels the compaction. A user message that reaches the session while it compacts, whether from an SDK `prompt()`, an RPC `prompt` or an extension's `sendUserMessage()`, waits until compaction ends, then goes out once, in arrival order. If an earlier waiting message has started a turn by then, a message sent without `streamingBehavior` or `deliverAs` is queued behind it as steering. Waiting messages appear in `getSteeringMessages()`/`getFollowUpMessages()` and `queue_update`, and `clearQueue()` returns them without sending them. Before the TUI runs an extension command during compaction, it hands the messages already typed to the session, so a message the command sends goes out after them.

SDK `prepareNextTurn` and `prepareNextTurnWithContext` callbacks receive the rebuilt context after a compaction between tool calls. A `finishTurn` decision of `{ action: "end" }` leaves queued input pending until an explicit prompt or continuation. Mid-turn compaction resumes streaming without another user action.

### Compaction instructions

`/compact` takes optional instructions, for example `/compact keep the migration plan and the names of the failing tests`. The instructions are added to the boundary message after the recovery steps, so the agent knows what to recover first. They are also the compactor model's query. SDK and extension code pass them as `query`: `session.compact({ query })` or `ctx.compact({ query })`. RPC clients pass `{ "type": "compact", "instructions": "..." }`.

## Context cleared

With the default `compactionModel`, compaction makes no model call. After the boundary the model sees the system prompt and one `Context cleared` message. The message tells the agent:

- How many tokens the earlier conversation held, and that it is stored verbatim at `history://sessions/<session id>`, the exact URL of this session. It names the saved entries that hold the earlier conversation, the boundary's entry position, and how many entries the history has.
- What to recover, in order. First every `<keepContext>` span, verbatim and whole, found by searching the URL for `keepContext`. Then the user's objectives and latest requests, constraints and prohibitions, decisions and their reasons, identifiers such as branches, worktrees, pull requests, run ids, file paths and commands, open work, and tool results it still needs. It prefers the most recent records, because later requests replace earlier ones.
- How to recover it. Search first, then read narrow ranges of about 200 saved entries with `read history://sessions/<id>:N-M`. Ranges select entries, not rendered lines. Follow any continuation URL to finish a range or search. A plain `history://sessions` search skips the current session, so the agent uses the exact URL. It copies what it needs verbatim. A tool result that shows `Full output saved to: <location>` or `Full output: <location>` kept its full output at that path or `tool-output://` or `artifact://` URL, which may have been cleaned up since.
- Your `/compact` instructions, if you gave any, and then to continue the task.

The agent recovers with its own `read` and `search` tools in its next turn. An abbreviated example:

```text
Context cleared. Your earlier conversation (182,340 tokens) is no longer in your context window. It is stored verbatim in this session's history at history://sessions/019f6a2e-…: entries 1-4210 hold the earlier conversation, this boundary is entry 4211, and the history has 4211 entries now. Before you continue, recover what the task needs from there.

Recover what you need, in this order:
1. Every <keepContext> span, verbatim and whole: search history://sessions/019f6a2e-… for "keepContext". …
2. The user's objectives and latest requests; constraints and prohibitions …

How to recover:
- Search first …

Then continue the task.
```

See [Recalling earlier work](/sessions#recalling-earlier-work) for how `history://` URLs read and search.

### Agents without read or search

Some agents cannot read their history with their own tools, such as a subagent whose tool allowlist leaves out `read` or `search`. After its first clear, such an agent gets one read-only tool, `session_history`, and a resumed session gets it whenever its resumed tools leave out `read` or `search`. `{"pattern": "<regex>"}` searches its own session's history and `{"lines": "N-M"}` reads a saved-entry range of it, despite the parameter's name. To continue a bounded read, pass `{"lines": "<continuation URL>"}`. To continue a search, pass `{"pattern": "<same regex>", "lines": "<continuation URL>"}`. The tool reaches no other session, file or project, and the agent's other tools stay as they were.

## Context compacted

When `compactionModel` names a registered compactor model, today `morph/morph-compactor`, compaction sends the whole current context to that compactor once. It sends the previous compacted text first, then each message labelled by kind: user messages, assistant text, tool calls with their arguments, tool results (marked when they are errors), shell commands with their exit code, and extension messages. Images are replaced by an omission marker, thinking is left out, and very long lines are wrapped. Messages kept out of the model's context, such as `!!` shell commands and extension messages sent with `excludeFromContext`, are not sent.

The request uses your `/compact` instructions as its query, or else your latest request. It asks the compactor to keep about half of the conversation, a fixed ratio that is not a setting, and waits at most 120 seconds.

The compactor's output replaces the context. After the boundary the model sees the system prompt and one `Context compacted` message that holds the output in a `<compacted-context>` block, followed by the same recovery instructions as a clear. The compacted text keeps only part of the conversation, so the agent can still recover any detail it needs from history.

Output longer than 32,000 estimated tokens counts as a failure. On a small context window the limit is lower: half of the context the automatic trigger allows. Output also fails when, together with the system prompt and the recovery instructions, it would not fit below the automatic trigger. If the endpoint returns your API key, it is replaced with `[redacted]` before the output becomes context or history.

### When the compactor fails

Any compactor failure clears the context instead: missing credentials, an HTTP error, malformed or empty output, a timeout, or output that is too long. The boundary then shows a one-line notice, `Compaction model not used (<reason>); context cleared instead`. The reason never shows the API key. Pressing Escape or calling `abortCompaction()` while the request runs also clears the context, with the reason `request aborted`. A manual `/compact` that takes over, closing the session, or an extension that cancels still cancels the compaction.

## Compaction model

Use `/settings` → **Compaction model** to choose **Auto (clear and recover)** or a compactor model. The selector saves to project settings when a project override already exists; otherwise it saves globally. You can also set `compactionModel` in `~/.atomic/agent/settings.json` or a trusted project's `.atomic/settings.json`:

```json
{
  "compactionModel": "morph/morph-compactor"
}
```

`auto` or an empty value, the default, clears the context. An exact registered compactor ID compacts with that model. For Morph, use `/login morph` or set `MORPH_API_KEY`; without a credential the selector marks it `requires /login morph`, and compaction clears the context with a notice. Morph is not a chat model and does not appear in `/model`.

A compactor receives the conversation in context and uses its own credentials. Choose one only if its provider may receive your conversation. Changing `compactionModel` does not affect branch summaries. SDK and extension code can choose for one run with `session.compact({ compactionModel })` or `ctx.compact({ compactionModel })`, which leaves the setting unchanged.

Compaction no longer calls chat models or classifiers. When a session starts, a saved `compactionModel`, global or in a trusted project, that names a chat or classifier model is reset to `auto` and saved. The check runs again once extensions have loaded, so a chat model an extension registers is reset too, and when a project is trusted during startup. A compactor ID is kept, and so is an ID that names no registered model; compaction then clears the context with a notice that the model is not available. A per-run `compactionModel` that names a chat, classifier or unknown model also clears the context with a notice instead of failing.

## `keepContext` tags

Wrap text the agent must not lose in `<keepContext>` and `</keepContext>`:

```
<keepContext>
You are researching only. Do not implement code changes.
</keepContext>
```

The tags change nothing automatically: no text is protected or kept in context. After a clear or a compaction, the recovery instructions tell the agent to search its history for every tagged span and recover each one verbatim and whole before anything else. A compactor model may also honour the tags.

- Put each tag on its own line.
- Tag constraints, prohibitions, acceptance criteria and identifiers that the rest of the task depends on. Keep the spans short and pass bulk material through files, so the tagged text stays quick to recover.

## The boundary in the chat

The main chat and subagent views in `/tasks` show one line for each boundary:

```text
⚛ Context cleared · 182k tokens
⚛ Context compacted · morph/morph-compactor · 182k → 21.4k tokens
```

A boundary written from an extension's replacement text names `extension` as its source. When a configured compactor was not used, the `Compaction model not used (<reason>); context cleared instead` notice follows the line. Press Ctrl+O (`app.tools.expand`) or click the boundary to show the whole boundary message: the recovery instructions and any compacted text.

A failed or cancelled `/compact` stops its spinner, shows the error, writes no boundary, and leaves the session ready for another `/compact` or a normal turn.

## Recovery omissions

Threshold decisions and recovery use the canonical session projection. When Atomic recovers from a provider error retry, a model fallback, a context overflow, or a truncated response, the failed attempt stays in raw session history and a `context_edit` entry durably omits it from model context (see [Session Format](/session-format)). Omitted entries are left out of compaction and of token estimates, and usage captured by an omitted or later-edited assistant is not trusted for threshold checks. You can view the subagent from the agent panel or `/tasks` to read the original provider error, even while the next attempt is running. The error stays in the conversation without being sent back to the model. Extensions can also inspect the attempt through the raw transcript, exports, and history search.

## Parameters

Moved to [Compaction reference](/compaction/reference#parameters).

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

Branch summaries are separate from `/compact`: branch navigation generates summary prose, while compaction clears the context window or replaces it with a compactor's output.

Use the [Compaction reference](/compaction/reference) for extension hooks and saved formats.

## Summary request isolation

Branch summary requests do not execute tools or write into the main chat's prompt cache. They retain normal authentication, cancellation, and retry behavior.

## Settings

Moved to [Compaction reference](/compaction/reference#settings).

## Historical formats

Moved to [Compaction reference](/compaction/reference#historical-formats).
