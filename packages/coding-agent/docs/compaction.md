---
title: "Manage context and compaction"
sidebarTitle: "Manage compaction"
description: "Keep long sessions inside the model's context window with memory compaction (default) or a custom compaction model."
---

LLMs have finite context windows. When a session nears its limit, Atomic compacts the active context window using one of **two forms of compaction**:

<Columns cols={2}>
  <Card title="1. Memory compaction (default)" href="/compaction/memory-compaction">
    Clears the active context window with no model call and no parameters. The full conversation stays verbatim in session history, and the agent recalls exact details on demand.
  </Card>
  <Card title="2. Custom compaction models" href="/compaction/custom-compactors">
    Sends the active context once to a dedicated compactor endpoint (`morph/morph-compactor` or your own remote compactor) using your own parameters, with automatic fallback to memory compaction.
  </Card>
</Columns>

In both forms, your full conversation stays verbatim in session history and the compaction boundary tells the agent where to find it.

<Columns cols={2}>
  <Card title="Branch summaries" href="/compaction/branch-summaries">
    Optional, lossy summary generated when you leave a branch with `/tree`. Separate from compaction.
  </Card>
  <Card title="Compaction reference" href="/compaction/reference">
    Compactor HTTP contract, saved boundary fields, extension hooks, continuation limits, SDK concurrency, error classes, and settings.
  </Card>
</Columns>

## Compare compaction forms

| Form | When it runs | Model call | Parameters | What the model sees after the boundary |
| --- | --- | --- | --- | --- |
| [Memory compaction](/compaction/memory-compaction) | Default (`compactionModel` is `""` or `"auto"`), or automatic fallback when a compactor fails | None | None | System prompt and one `Context cleared` boundary pointing to session history |
| [Custom compaction model](/compaction/custom-compactors) | `compactionModel` names a registered compactor model (or an extension supplies compacted text) | One compactor request | Only what you set on the model (`compactionParams`, optional `maxTokens`, `timeoutMs`) | System prompt and one `Context compacted` boundary with `<compacted-context>` plus history recovery steps |
| [Branch summaries](/compaction/branch-summaries) | Optional, when `/tree` leaves a branch | One summary request | `branchSummary.reserveTokens`, optional focus prompt | A branch summary attached at the new tree position |

## When compaction runs {#when-compaction-runs}

Atomic triggers compaction in five situations:

- **Automatic threshold.** Estimated context usage exceeds the model's context window minus `compaction.reserveTokens`. Atomic checks after tool results arrive, before follow-up requests, and before every new request. A completed answer that finishes over the threshold stays visible as the last answer so you can read or `/copy` it; Atomic compacts right before the next request. When a provider reports zero usage, Atomic estimates visible message size instead of skipping the check.
- **Resumed near the window.** On a Claude model with a fixed thinking budget, the first prompt after resume clears earlier conversation if newly added resume context (updated `AGENTS.md` or prompt files, blueprint context, or recovery notices) would crowd out the thinking budget. Those resume additions stay in context after the boundary. When automatic compaction is off, or clearing does not run, Atomic shrinks the thinking budget to fit instead.
- **Overflow.** On a provider context-overflow error, Atomic compacts and retries the interrupted turn automatically.
- **Truncated response.** When a reply is cut short by a token or output limit, Atomic automatically continues or compacts and retries (see [Automatic trigger and continuation limits](/compaction/reference#automatic-trigger-and-continuation-limits) for exact counts).
- **Manual.** Run `/compact [instructions]` in the terminal (or trigger compaction programmatically from the SDK or RPC).

## Compaction instructions

`/compact` accepts optional focus instructions, such as:

```text
/compact keep the migration plan and the names of the failing tests
```

Atomic appends your instructions to the boundary message after the recovery steps and sends them as the query to any configured compactor model.

## Safety, backups, and cancellation

A compaction boundary never lands mid-stream or between a tool call and its result. Running `/compact` stops the active run before starting; if a tool call is still waiting for its result, `/compact` tells you to wait until it finishes, while automatic compaction runs once the result arrives.

When nothing new has entered context since the last boundary, compaction does nothing and `/compact` reports `Nothing to compact`. Automatic compaction also skips when the system prompt and clear boundary alone already fill the automatic threshold, letting [`fallbackModels`](/settings#fallbackmodels) handle any provider overflow.

<Note>
**Pre-compaction backups (JSONL stores only).** Before writing a boundary in a JSONL directory store, Atomic saves a best-effort copy alongside the session file at `<sessionFile>.<timestamp>.<label>.bak` (these files are not deleted automatically). If a backup cannot be written (for example on a full disk), Atomic still writes the boundary. SQLite, PostgreSQL, and in-memory stores do not write separate backup files (see [Storage](/storage)).
</Note>

- **Cancellation.** Press `Escape` to cancel compaction before the boundary commits and leave the session unchanged. If a custom compactor request is already running, `Escape` stops that request and falls back to memory compaction instead.
- **Queued input and commands.** Queued messages wait in arrival order and run automatically once compaction finishes. Non-prompt commands (`/settings`, `/tasks`) run immediately during compaction, `/compact` takes over automatic compaction, and session-switching commands (`/new`) cancel compaction immediately.
- **Automatic continuations.** Continuations remain part of the original prompt until the chain finishes, so status monitors such as [Herdr](/herdr) stay active across continuations.

For SDK compaction calls, concurrency, cancellation helpers, and extension hooks, see [Compaction and tree navigation](/sdk#compaction-and-tree-navigation) and [Compaction reference](/compaction/reference#sdk-concurrency-and-message-queuing).

## The boundary in the chat

Both the main chat and subagent views in `/tasks` show one line per boundary:

```text
⚛ Context cleared · 182.0k tokens
⚛ Context compacted · morph/morph-compactor · 182.0k → 21.4k tokens
```

A boundary supplied by an extension names `extension` as its source. When a configured compactor was not used, a `Compaction model not used (<reason>); context cleared instead` notice appears beneath the line. Press `Ctrl+O` or click the boundary to expand the full recovery instructions and any compacted text.

A failed or cancelled `/compact` stops its spinner, displays the error, writes no boundary, and leaves the session ready for another `/compact` or normal turn.

## Failed turns and token accounting

When counting context tokens and checking compaction thresholds, Atomic measures only what will actually be sent to the model. When Atomic recovers from a provider retry, model fallback, context overflow, or truncated response, the failed attempt stays in raw history while Atomic omits it from future model context (see [Session file format](/session-format#contexteditentry)).

Omitted attempts do not count toward compaction thresholds or token estimates, and usage from an omitted reply is excluded from threshold checks. You can still inspect the original provider error in the agent panel, `/tasks`, raw transcripts, exports, and history search.
