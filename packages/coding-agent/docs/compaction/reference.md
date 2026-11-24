---
title: "Compaction reference"
sidebarTitle: "Compaction"
description: "Reference for compaction parameters, saved boundary fields, extension hooks, SDK concurrency, exports, branch summary format, and settings."
---

## Parameters

Extension events and compaction results carry one parameter:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `query` | Latest user request | Your `/compact` instructions when provided, otherwise the text of the latest user request (or `"the latest user request"` when no user message exists on the active branch). A compactor model receives it as its query. |

Instructions passed to `/compact`, `session.compact({ query })`, `ctx.compact({ query })`, or RPC `compact` are also appended to the boundary message after the recovery steps. Automatic compaction passes no custom instructions.

`compression_ratio` and `preserve_recent` are not top-level `session.compact()` or `settings.json` compaction options and are ignored if supplied there, keeping default context-clearing compaction free of endpoint knobs. Configure endpoint-specific parameters directly on each compactor model in [`models.json`](/models#remote-compaction-models) (`compactionParams`, `endpointPath`, `timeoutMs`, `maxTokens`, `headers`) or via [`atomic.registerProvider()`](/custom-provider/api-reference) (`ProviderCompactorModelConfig`).

Default values used when a compactor model omits an override are exported from `@bastani/atomic`:

| Default | Export | Model override field | Meaning |
| --- | --- | --- | --- |
| `0.5` | `COMPACTOR_COMPRESSION_RATIO` | `compactionParams.compression_ratio` | Default share of the conversation requested for `api: "morph-compact"` |
| `120000` | `COMPACTOR_REQUEST_TIMEOUT_MS` | `timeoutMs` | Wall-clock limit on one compactor request, in milliseconds |
| `32000` | `COMPACTED_OUTPUT_MAX_TOKENS` | `maxTokens` | Largest allowed compacted text in estimated tokens (always also capped at `COMPACTED_OUTPUT_MAX_TRIGGER_SHARE` = 50% of the automatic trigger budget) |
| `2000` | `COMPACTOR_LINE_WIDTH` | None | Character width at which long lines wrap before framing |

### Compactor request contract

Atomic POSTs JSON to `<baseUrl><endpointPath>` (`endpointPath` defaults to `"/compact"`; `""` POSTs directly to `baseUrl`):

- **Payload for `api: "morph-compact"`:** sends `{ compression_ratio: 0.5, preserve_recent: 0, include_markers: true, include_line_ranges: false, ...compactionParams, messages, query, model }`. Any field in `compactionParams` overrides the default or adds custom endpoint fields.
- **Payload for any other `api` string (such as `"custom-compact"`):** sends `{ ...compactionParams, messages, query, model }` without injecting Morph-specific defaults.
- **Headers and authentication:** sends `Content-Type: application/json`, merges resolved provider and model `headers`, and adds `Authorization: Bearer <apiKey>` when `apiKey` is present and no explicit `Authorization` header was set. The API key and sensitive auth headers (`Authorization`, `Proxy-Authorization`, `X-API-Key`, `API-Key`) are redacted from HTTP error excerpts and compacted output.
- **Response parsing:** reads joined non-empty `messages[].content` entries when present, otherwise `output`, plus optional `usage.input_tokens` and `usage.output_tokens`.

Long lines sent to a compactor wrap at 2,000 characters. Compaction resets Claude's signed reasoning chain, so `thinking` and `redacted_thinking` blocks do not survive a boundary. See [Preserved thinking and model switches](/models/reference#preserved-thinking-and-model-switches) for behavior between boundaries.

## Persistence and resume

A successful compaction appends a `type: "compaction"` entry:

```json
{
  "type": "compaction",
  "id": "c1",
  "parentId": "m9",
  "timestamp": "2026-11-17T10:00:00.000Z",
  "summary": "Context cleared. Your earlier conversation (51,234 tokens) is no longer in your context window. ...",
  "firstKeptEntryId": null,
  "tokensBefore": 51234,
  "details": {
    "strategy": "verbatim-lines",
    "promptVersion": 7,
    "parameters": {"query": "fix the failing test"},
    "stats": {"linesBefore": 812, "linesDeleted": 812, "linesKept": 0, "rangeCount": 0, "tokensBefore": 51234, "tokensAfter": 2210, "percentReduction": 95.7},
    "form": "cleared",
    "history": {"sessionId": "019f6a2e-...", "rangeUnit": "entries", "entriesBefore": 4210, "boundaryEntry": 4211, "totalEntries": 4211}
  }
}
```

| Field | Meaning |
| --- | --- |
| `summary` | Full boundary message shown to the model: `Context cleared` or `Context compacted` text, any compacted text, recovery instructions, and any `/compact` instructions |
| `firstKeptEntryId` | Always `null` on new boundaries because no earlier message stays in context |
| `tokensBefore` | Provider-aware whole-context token count before the boundary, used for budgeting and the chat boundary line |
| `coveredThroughEntryId` | Written only by earlier versions while a tool call waited for its result; new boundaries are never written while a call waits |
| `usage` | Compactor endpoint usage when reported |
| `fromHook` | `true` when an extension supplied compacted text from `session_before_compact` |
| `systemMessage` | Optional replayed system prompt and tool state checkpoint at this boundary |
| `details.form` | `"cleared"` (no model call) or `"compacted"` (compactor or extension supplied replacement text) |
| `details.backend` | `"compactor"` or `"extension"`, present only on `"compacted"` boundaries |
| `details.model` | Compactor ID as `provider/model` when a compactor produced the text |
| `details.fallbackReason` | Reason a configured compactor was not used and context was cleared instead |
| `details.history` | Boundary location in `history://sessions/<sessionId>`: `rangeUnit: "entries"`, `entriesBefore`, `boundaryEntry`, and `totalEntries` |
| `details.historyAccess` | `"read-search"` or `"session-history-tool"`. Resumed sessions receive `session_history` whenever `read` or `search` is absent from resumed tools |
| `details.stats` | Heuristic estimates: `tokensAfter` counts the system prompt and boundary message, `linesBefore` counts replaced context lines, `linesKept` counts compacted lines (`0` on a clear), and `rangeCount` is `0` |
| `details.backupPath` | Path to the pre-compaction backup (`<sessionFile>.<timestamp>.<label>.bak`, never auto-deleted). Populated only for JSONL stores, never SQLite, libSQL, PostgreSQL, or memory stores. |

Only `compaction` entries with `details.strategy: "verbatim-lines"` affect active context. Resuming uses the saved boundary text directly without another model request, and messages appended after the boundary stay ordinary messages. Inactive legacy formats do not reapply historical omissions, so content they previously hid may reappear on resume.

## Extension hooks

### `session_before_compact`

Extensions can cancel compaction or provide custom replacement text before any compactor call runs:

```typescript
atomic.on("session_before_compact", async (event) => {
  const { reason, parameters, preparation, branchEntries, signal } = event;
  if (signal.aborted) return { cancel: true };

  // Optional offline replacement. Empty or whitespace text counts as no replacement.
  if (reason === "manual" && branchEntries.length > 100) {
    const requests = preparation.region.lines.filter((line) => line.startsWith("[User]: "));
    return { compactedText: requests.join("\n") };
  }
});
```

`preparation` is a deep-frozen clone (attempting to mutate it throws a `TypeError`). `preparation.region.lines` holds the entire active context since the last boundary serialized as role-tagged lines (`[User]: `, `[Assistant]: `, `[Assistant tool calls]: `, `[Tool result]: `), starting with any previous boundary text. `firstKeptEntryId` is `null`, `keptTailMessageCount` is `0`, and `parameters.query` holds the `/compact` instructions or latest user request.

Return `{ cancel: true }` to cancel compaction. Return `{ compactedText }` to write a `Context compacted` boundary offline without provider credentials; the model sees your text in a `<compacted-context>` block followed by recovery instructions.

Empty or whitespace-only text counts as no replacement, so the configured compaction form runs normally. If `compactedText` exceeds the compactor output cap or makes `systemPrompt + boundary >= trigger`, Atomic rejects it, falls back to clearing the context with `fallbackReason` starting with `extension failed: output too long`, and emits `session_compact` with `fromExtension: false`.

### `session_compact`

Emitted as an observe-only event after the boundary is saved:

```typescript
atomic.on("session_compact", async (event) => {
  console.log(event.result.form, event.result.backend, event.result.model); // "cleared" | "compacted"
  console.log(event.result.fallbackReason);            // set when a configured compactor was not used
  console.log(event.result.history);                   // { sessionId, rangeUnit: "entries", entriesBefore, boundaryEntry, totalEntries }
  console.log(event.compactionEntry.details.strategy); // "verbatim-lines"
  console.log(event.fromExtension);
});
```

`event.result.compactedText` matches the saved entry's `summary`. Observer errors are isolated and cannot roll back the saved boundary.

### `session_compact_failed`

Emitted as an observe-only event when a manual, threshold, or overflow compaction fails or is cancelled:

```typescript
atomic.on("session_compact_failed", async (event) => {
  console.log(event.reason, event.errorMessage);
  console.log(event.aborted, event.willRetry, event.fromExtension);
});
```

`errorMessage` is absent when cancelled. `fromExtension` marks failures after a `session_before_compact` handler supplied replacement text, and no boundary is saved. A compactor failure is not a compaction failure because Atomic falls back to clearing context and reports `fallbackReason` on `session_compact`.

## SDK concurrency and message queuing

- **Shared manual runs.** Concurrent manual SDK `session.compact()` calls share one run and resolve to the same result. Calling `abortCompaction()` cancels the run for all waiters, or falls back to clearing context if a compactor request is already in flight.
- **Manual takeover.** A manual compaction request arriving during automatic compaction cancels the automatic work and its continuation, then runs once the active work settles (or follows the automatic boundary if it already committed).
- **Automatic continuations.** Automatic continuations, including output-cap continuations, belong to the original prompt. Both the `prompt()` promise and `agent_settled` finish only after the full continuation chain completes.
- **Waiting messages.** User messages arriving during compaction (from typed input, prompt templates, skills, SDK `prompt()`, RPC `prompt`, or extension `sendUserMessage()`) wait in arrival order until compaction ends, then run once. If an earlier waiting message has already started a turn, later messages without `streamingBehavior` or `deliverAs` queue behind it as steering.
- **Inspecting and clearing queued input.** Waiting messages appear in `getSteeringMessages()`, `getFollowUpMessages()`, and `queue_update` events, and `clearQueue()` returns them without sending them. Before the TUI runs an extension command during compaction, it hands already-typed messages to the session so messages sent by the command run after them.
- **Turn hooks.** SDK `prepareNextTurn` and `prepareNextTurnWithContext` callbacks receive the rebuilt context after mid-turn compaction. Returning `{ action: "end" }` from `finishTurn` keeps queued input pending until an explicit prompt or continuation, while mid-turn compaction resumes streaming automatically.

## Package exports

`@bastani/atomic` exports these compaction helpers and types:

| Export | Use |
| --- | --- |
| `buildBoundaryText(input, totalEntries)` | Build the boundary message for a session, history location, and optional instructions or compacted text |
| `buildCompactorMessages(messages, isBoundary)` | Frame active context messages in the format sent to a compactor |
| `requestCompactorOutput(request)` | Send one `CompactorRequest` to a compactor endpoint; resolves `{ text, usage? }` or throws `CompactorFailure` |
| `resolveCompactionModel(configured, models)` | Resolve `compactionModel` to a `CompactionModelSelection` (`auto` with any fallback reason, or a compactor) |
| `SESSION_HISTORY_TOOL_NAME` | `"session_history"`, the read-only history tool granted after clearing when `read` or `search` is absent |

The types `CompactionForm`, `CompactionBackend`, `CompactionHistoryLocation`, `CompactionModelSelection`, `CompactorMessage`, `CompactorRequest`, and `BranchSummaryEntry` are exported alongside them.

## Branch summary format

Built-in branch summarization prepends the preamble `"The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n"` and writes structured Markdown with these sections:

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### `BranchSummaryEntry` structure

`BranchSummaryEntry` is exported from `@bastani/atomic`. Default branch summarization stores cumulative file lists in `details`, while extensions can store custom metadata:

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string | null;
  timestamp: string; // ISO timestamp
  fromId: string;    // Entry we navigated from
  summary: string;
  details?: T;       // Implementation-specific data (not sent to LLM)
  usage?: Usage;     // Usage from the summary model call
  fromHook?: boolean; // true if supplied by an extension
}

// Default branch summarization stores this shape in details:
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

### Message serialization for branch summaries

Branch-summary prompts serialize conversation messages with role labels so the model summarizes rather than continuing the conversation:

```text
[User]: What they said
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

Thinking blocks are omitted. Built-in branch summarization truncates every tool result to **500 characters** before serialization (with a marker stating how many characters were removed). Calling `serializeConversation()` directly on unshortened messages truncates tool results at 2,000 characters.

## Extension hooks for branch summarization

### `session_before_tree`

Fired before `/tree` navigation regardless of whether the user requested a summary. Handlers can cancel navigation or supply a custom summary:

```typescript
atomic.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - destination entry ID
  // preparation.oldLeafId - current leaf being abandoned
  // preparation.commonAncestorId - shared ancestor entry ID
  // preparation.entriesToSummarize - entries in the abandoned branch
  // preparation.userWantsSummary - whether the user requested a summary

  // Cancel navigation:
  return { cancel: true };

  // Provide a custom summary (applied only when userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        details: { /* custom data */ },
      },
    };
  }
});
```

`SessionBeforeTreeEvent` and `SessionBeforeTreeResult` are exported from `@bastani/atomic`.

## Settings

Configure compaction in `~/.atomic/agent/settings.json` or `<project-dir>/.atomic/settings.json` (legacy `.pi` paths are also supported):

```json
{
  "compactionModel": "auto",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384
  }
}
```

See [Compaction settings](/settings#compaction) for the complete `compaction` and `branchSummary` settings table, and [Compaction model](/compaction#compaction-model) for selecting `auto` or a registered compactor. Setting `"compaction": { "enabled": false }` turns off automatic compaction while keeping manual `/compact` available.

These removed compaction settings are ignored without error if still present in `settings.json`: `compaction.compression_ratio`, `compaction.preserve_recent`, `compaction.keepContextShare`, `compaction.query`, `compaction.planningTimeoutMs`, `compaction.modelOverrides`, `compaction.background`, `compaction.backgroundThresholdPercent`, and `compaction.historyRecall`.

## Historical formats

Older compaction records remain parseable:

- Earlier `type: "compaction"` entries with `details.strategy: "verbatim-lines"` and no `details.form` kept filtered conversation lines or a summary. They remain active and replay as written, displaying as `Context compacted` (or `Context cleared` for boundaries that started a fresh window).
- Retired `type: "context_compaction"` records stored logical entry and content-block deletions. They are inert, so previously hidden content may reappear when an old session resumes.
- Older `type: "compaction"` entries without `details.strategy: "verbatim-lines"` stored summary prose and are also inert.
