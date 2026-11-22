---
title: "Context and compaction"
description: "How compaction clears or compacts the context window, how the agent recovers earlier work from session history, and branch summarization."
---

# Compaction and branch summarization

LLMs have finite context windows. When a session nears its limit, Atomic compacts the context window in one of two ways:

- **Context cleared (default).** No model is called. Atomic clears the context window, and the agent recovers what it needs from session history using its own tools.
- **Context compacted.** When `compactionModel` names a compactor model, Atomic sends the conversation to that compactor once and replaces the context with its output.

In both modes, the full conversation stays in session history and the boundary message tells the agent where to find it. Branch summarization is a separate, lossy summary offered when you navigate away from a branch with `/tree`.

## On this page and its reference

This page covers how compaction and branch summarization work in everyday use. Parameters, saved entry formats, extension hooks, exports, and settings live in the [Compaction reference](/compaction/reference).

## Overview

| Form | When | Model call | What the model sees after the boundary |
| --- | --- | --- | --- |
| Context cleared | `compactionModel` is `auto` or empty, or the compactor failed | None | The system prompt and one `Context cleared` message |
| Context compacted | `compactionModel` names a compactor model, or an extension supplied replacement text | One compactor request | The system prompt and one `Context compacted` message holding the compacted text |
| Branch summarization | Optional, when `/tree` leaves a branch | One summary request | A `BranchSummaryEntry` at the new branch position |

## When compaction runs

Atomic triggers compaction in five situations:

- **Automatic threshold.** Estimated context usage exceeds the model's context window minus `compaction.reserveTokens`. Atomic checks after tool results arrive, before follow-up requests, and before every new request. A completed answer that finishes over the threshold stays as the session's last answer so `prompt()`, RPC `get_last_assistant_text`, and `/copy` can read it; Atomic clears the context right before the next request. When a provider reports all-zero usage, Atomic estimates visible message size instead of skipping the check.
- **Resumed near the window.** On a Claude model with a fixed thinking budget, the first prompt after resume clears earlier conversation when newly added resume context (changed `AGENTS.md` or prompt files, blueprint context, or recovery notices) would crowd out the thinking budget. The resume additions stay in context after the boundary. When automatic compaction is off, or clearing does not run, Atomic shrinks the thinking budget to fit instead.
- **Overflow.** On a provider context-overflow error, Atomic compacts and retries the interrupted turn once per turn.
- **Truncated response.** When a response stops with `length` before the requested output cap, Atomic runs one compact-and-retry. If nothing can be compacted, Atomic attempts at most one direct continuation instead.
- **Manual.** Run `/compact [instructions]`, call `ctx.compact()` or `session.compact()`, or send RPC `{ "type": "compact" }`.

### Boundaries, cancellation, and concurrency

A boundary never lands mid-stream or between a tool call and its result. Manual compaction stops the active run before starting. While a tool call waits for its result, no boundary is written; automatic compaction clears context before the next request with the result, and `/compact` reports that a tool call is waiting.

When nothing new has entered context since the last boundary, compaction does nothing and `/compact` reports `Nothing to compact`. Automatic compaction also skips when the system prompt and boundary message alone would still exceed the trigger, so [`fallbackModels`](/settings#fallbackmodels) handles any provider overflow.

Atomic saves a best-effort backup before writing a boundary. If the backup cannot be written, such as on a full disk, Atomic still writes the boundary without `backupPath`.

Pressing `Escape` cancels compaction before the boundary commits and leaves the session unchanged. If a compactor request is running, `Escape` stops that request and clears the context instead. Queued input resumes automatically once the active run becomes idle.

Automatic continuations belong to the original prompt, including output-cap continuations. The prompt and `agent_settled` finish only after the chain completes, so status monitors such as [Herdr](/herdr) remain active across continuations.

Concurrent manual SDK compaction calls share one run and result. Calling `abortCompaction()` cancels the run for all waiters, or falls back to clearing context if a compactor request is already in flight. A manual request during automatic compaction cancels the automatic work and its continuation, then runs after the active work settles (or follows the automatic boundary if it already committed).

In the TUI, `/compact` takes over automatic compaction, refuses a second manual compaction or branch summary, and lets non-prompt commands such as `/settings` and `/tasks` run immediately. Session commands such as `/new` run immediately and cancel compaction.

User messages arriving during compaction (from typed input, prompt templates, skills, SDK `prompt()`, RPC `prompt`, or extension `sendUserMessage()`) wait in arrival order until compaction ends, then run once. If an earlier waiting message has already started a turn, later messages without `streamingBehavior` or `deliverAs` queue behind it as steering.

Waiting messages appear in `getSteeringMessages()`, `getFollowUpMessages()`, and `queue_update`, and `clearQueue()` returns them without sending them. Before the TUI runs an extension command during compaction, it hands already-typed messages to the session so messages sent by the command run after them.

SDK `prepareNextTurn` and `prepareNextTurnWithContext` callbacks receive the rebuilt context after mid-turn compaction. Returning `{ action: "end" }` from `finishTurn` keeps queued input pending until an explicit prompt or continuation, while mid-turn compaction resumes streaming automatically.

### Compaction instructions

`/compact` accepts optional focus instructions, such as `/compact keep the migration plan and the names of the failing tests`. Atomic appends those instructions to the boundary message after the recovery steps and sends them as the compactor query.

SDK and extension code pass instructions as `query` in `session.compact({ query })` or `ctx.compact({ query })`. RPC clients pass `{ "type": "compact", "instructions": "..." }`.

## Context cleared

With the default `compactionModel`, compaction makes no model call. After the boundary, the model sees the system prompt and one `Context cleared` message telling the agent:

- How many tokens the earlier conversation held, the exact `history://sessions/<session id>` URL for this session, which saved entries hold the earlier conversation, the boundary's entry position, and the total entry count.
- What to recover, in order. First, every `<keepContext>` span verbatim and whole by searching for `keepContext`. Next, the user's objectives and latest requests, constraints, decisions and their reasons, key identifiers (branches, worktrees, pull requests, run IDs, file paths, commands), open work, and needed tool results, preferring the most recent records.
- How to recover it. Search the exact session URL first (a plain `history://sessions` search skips the current session), then read narrow ranges of about 200 saved entries with `read history://sessions/<id>:N-M`. Ranges select saved entries rather than rendered lines. Follow continuation URLs when reads or searches stop early, and check any `Full output saved to: <location>` or `Full output: <location>` path (`tool-output://` or `artifact://`) when full tool output is needed.
- Your `/compact` instructions, if provided, followed by a prompt to continue the task.

The agent recovers details with `read` and `search` in its next turn. An abbreviated boundary message looks like this:

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

Agents whose tool allowlist omits `read` or `search`, such as restricted subagents, receive one read-only tool named `session_history` after their first context clear (or on resume whenever `read` or `search` is absent).

Pass `{"pattern": "<regex>"}` to search the session's own history, and pass `{"lines": "N-M"}` to read a saved-entry range (despite the parameter name). Continue a bounded read with `{"lines": "<continuation URL>"}`, or continue a search with `{"pattern": "<same regex>", "lines": "<continuation URL>"}`. The tool cannot access any other session, file, or project, and leaves the agent's other tools unchanged.

## Context compacted

When `compactionModel` names a registered compactor model (currently `morph/morph-compactor`), compaction sends the active context to that compactor once. Atomic frames previous compacted text first, followed by role-labelled user messages, assistant text, tool calls with arguments, tool results (marked when errors), shell commands with exit codes, and extension messages.

Images are replaced with an omission marker, thinking blocks are omitted, and long lines are wrapped. Messages excluded from model context, such as `!!` shell commands and extension messages with `excludeFromContext`, are not sent.

The request uses your `/compact` instructions as its query, or your latest request if none were given. It asks the compactor to keep about half of the conversation (a fixed ratio, not configurable) and times out after 120 seconds.

The compactor's output replaces the context inside a `<compacted-context>` block, followed by the same recovery instructions used by context clearing so the agent can retrieve omitted details from history.

Output longer than 32,000 estimated tokens fails. On small context windows, the limit drops to half of the automatic trigger budget. Output also fails if the compacted text, system prompt, and recovery instructions together would exceed the automatic trigger. If an endpoint echoes your API key, Atomic replaces it with `[redacted]` before storing or displaying the output.

### When the compactor fails

Any compactor failure falls back to clearing the context instead. This covers missing credentials, HTTP errors, empty or malformed output, timeouts, and oversized output.

Atomic prints a one-line notice (`Compaction model not used (<reason>); context cleared instead`) without exposing your API key. Pressing `Escape` or calling `abortCompaction()` during a compactor request also clears the context with reason `request aborted`. A takeover by `/compact`, closing the session, or an extension returning `{ cancel: true }` cancels compaction completely.

## Compaction model

Open `/settings` and select **Compaction model** to choose **Auto (clear and recover)** or a registered compactor model. The selector updates project settings when a project override already exists, and global settings otherwise. You can also edit `compactionModel` in `~/.atomic/agent/settings.json` or a trusted project's `.atomic/settings.json`:

```json
{
  "compactionModel": "morph/morph-compactor"
}
```

`auto` or an empty string clears the context by default. An exact registered compactor ID compacts with that model. For Morph, authenticate with `/login morph` or set `MORPH_API_KEY`. Without credentials, the selector labels it `requires /login morph` and compaction falls back to context clearing with a notice. Morph is not a chat model and does not appear in `/model`.

A compactor receives your in-context conversation and uses its own provider credentials, so enable one only if that provider may receive your session text. Changing `compactionModel` does not affect branch summaries. SDK and extension callers can override the setting for a single run with `session.compact({ compactionModel })` or `ctx.compact({ compactionModel })`.

Compaction does not call chat models or classifiers. On startup, after extensions load, and when a project becomes trusted, Atomic resets any saved chat or classifier `compactionModel` to `auto`. Compactor IDs and unknown IDs remain untouched; an unknown ID or a per-run chat or classifier override falls back to context clearing with a notice.

## `keepContext` tags

Wrap text the agent must not lose in `<keepContext>` and `</keepContext>`:

```text
<keepContext>
You are researching only. Do not implement code changes.
</keepContext>
```

The tags do not pin text in the context window automatically. Instead, recovery instructions tell the agent to search session history for every tagged span and recover each one verbatim before anything else. A compactor model may also honor the tags.

- Put each opening and closing tag on its own line.
- Tag constraints, prohibitions, acceptance criteria, and key identifiers. Keep spans short and place large material in files so recovery stays fast.

## The boundary in the chat

Both the main chat and subagent views in `/tasks` show one line per boundary:

```text
⚛ Context cleared · 182.0k tokens
⚛ Context compacted · morph/morph-compactor · 182.0k → 21.4k tokens
```

A boundary supplied by an extension names `extension` as its source. When a configured compactor was not used, the `Compaction model not used (<reason>); context cleared instead` notice appears beneath the line. Press `Ctrl+O` (`app.tools.expand`) or click the boundary to expand the full recovery instructions and any compacted text.

A failed or cancelled `/compact` stops its spinner, displays the error, writes no boundary, and leaves the session ready for another `/compact` or normal turn.

## Recovery omissions

Threshold checks and recovery read the canonical session projection. When Atomic recovers from a provider retry, model fallback, context overflow, or truncated response, the failed attempt stays in raw history while a `context_edit` entry omits it from model context (see [Session format](/session-format#contexteditentry)).

Omitted entries do not count toward compaction or token estimates, and usage from an omitted or edited assistant message is not used for threshold checks. You can still inspect the original provider error in the agent panel, `/tasks`, raw transcripts, exports, and history search.

<a id="branch-summarization" />

## Branch summaries

When `/tree` switches away from a branch, Atomic can optionally summarize the abandoned branch and attach that summary at the new position. This preserves work from the path you left without replaying the entire branch.

When prompted, choose one of three options:

1. No summary
2. Summarize with the default prompt
3. Summarize with custom focus instructions

Set `"branchSummary": { "skipPrompt": true }` to skip the prompt and default to no summary. Branch summaries are separate from `/compact`. Branch navigation generates summary prose, whereas compaction clears context or replaces it with a compactor's output.

### How branch summarization works

Atomic collects entries from the abandoned branch up to the common ancestor, prioritizing newer messages within `branchSummary.reserveTokens`, and saves the summary at the navigation point. The provider sizes summary output from the model's output limit and available context; `branchSummary.reserveTokens` controls only how much branch history is selected. Atomic rejects incomplete summaries rather than saving partial prose.

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

Branch summaries keep a cumulative list of read and modified files, including files carried forward from earlier branch summaries.

### Summary request isolation

Branch summary requests execute no tools and do not write into the main chat's prompt cache. They keep normal authentication, cancellation, and retry behavior.

See [Branch summary format](/compaction/reference#branch-summary-format) and [Extension hooks for branch summarization](/compaction/reference#extension-hooks-for-branch-summarization) for saved entry types and `session_before_tree`.

## Moved sections

<a id="parameters" />
<a id="persistence-and-resume" />
<a id="extension-hooks" />
<a id="session_before_compact" />
<a id="session_compact" />
<a id="session_compact_failed" />
<a id="branch-summary-format" />
<a id="message-serialization-for-branch-summaries" />
<a id="extension-hooks-for-branch-summarization" />
<a id="session_before_tree" />
<a id="settings" />
<a id="historical-formats" />

Parameters, persistence details, extension hooks, branch summary formats, settings, and historical formats moved to the [Compaction reference](/compaction/reference).
