---
title: Compaction reference
sidebarTitle: "Compaction internals"
description: Compaction parameters, saved boundaries, extension hooks, exports, formats, and settings.
---

# Compaction reference

## Parameters

Extension events and compaction results carry one parameter:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `query` | Latest user request | Your `/compact` instructions when provided, otherwise the text of the latest user request. A compactor model receives it as its query. |

Instructions passed to `/compact`, `session.compact({ query })`, `ctx.compact({ query })`, or RPC `compact` are also appended to the boundary message after the recovery steps. Automatic compaction passes no custom instructions.

`compression_ratio` and `preserve_recent` are no longer compaction options and are ignored if supplied. The compactor ratio, request timeout, and output cap are fixed constants exported from `@bastani/atomic`:

| Value | Export | Meaning |
| --- | --- | --- |
| `0.5` | `COMPACTOR_COMPRESSION_RATIO` | Share of the conversation the compactor is asked to keep |
| `120000` | `COMPACTOR_REQUEST_TIMEOUT_MS` | Wall-clock limit on one compactor request, in milliseconds |
| `32000` | `COMPACTED_OUTPUT_MAX_TOKENS` | Largest allowed compacted text in estimated tokens (or half of the automatic trigger budget on small context windows) |

Compaction resets Claude's signed reasoning chain, so `thinking` and `redacted_thinking` blocks do not survive a boundary. See [Preserved thinking and model switches](/models/reference#preserved-thinking-and-model-switches) for behavior between boundaries.

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
| `details.form` | `"cleared"` (no model call) or `"compacted"` (compactor or extension supplied replacement text) |
| `details.backend` | `"compactor"` or `"extension"`, present only on `"compacted"` boundaries |
| `details.model` | Compactor ID as `provider/model` when a compactor produced the text |
| `details.fallbackReason` | Reason a configured compactor was not used and context was cleared instead |
| `details.history` | Boundary location in `history://sessions/<sessionId>`: `rangeUnit: "entries"`, `entriesBefore`, `boundaryEntry`, and `totalEntries` |
| `details.historyAccess` | `"read-search"` or `"session-history-tool"`. Resumed sessions receive `session_history` whenever `read` or `search` is absent from resumed tools |
| `details.stats` | Heuristic estimates: `tokensAfter` counts the system prompt and boundary message, `linesBefore` counts replaced context lines, `linesKept` counts compacted lines (`0` on a clear), and `rangeCount` is `0` |
| `details.backupPath` | Path to the pre-compaction backup when written |

Only `compaction` entries with `details.strategy: "verbatim-lines"` affect active context. Resuming uses the saved boundary text directly without another model request, and messages appended after the boundary stay ordinary messages. Inactive legacy formats do not reapply historical omissions, so content they previously hid may reappear on resume.

## Extension hooks

### `session_before_compact`

Extensions can cancel compaction or provide custom replacement text before any compactor call runs:

```typescript
pi.on("session_before_compact", async (event) => {
  const { reason, parameters, preparation, branchEntries, signal } = event;
  if (signal.aborted) return { cancel: true };

  // Optional offline replacement. Empty or whitespace text counts as no replacement.
  if (reason === "manual" && branchEntries.length > 100) {
    const requests = preparation.region.lines.filter((line) => line.startsWith("[User]: "));
    return { compactedText: requests.join("\n") };
  }
});
```

`preparation` is a deep-frozen clone. `preparation.region.lines` holds the entire active context since the last boundary serialized as role-tagged lines (`[User]: `, `[Assistant]: `, `[Assistant tool calls]: `, `[Tool result]: `), starting with any previous boundary text. `firstKeptEntryId` is `null`, `keptTailMessageCount` is `0`, and `parameters.query` holds the `/compact` instructions or latest user request.

Return `{ cancel: true }` to cancel compaction. Return `{ compactedText }` to write a `Context compacted` boundary offline without provider credentials; the model sees your text in a `<compacted-context>` block followed by recovery instructions.

Empty or whitespace-only text counts as no replacement, so the configured compaction form runs normally. Replacement text exceeding the compactor output cap or automatic trigger budget is rejected and falls back to context clearing with fallback reason `extension failed: output too long (...)`.

### `session_compact`

Emitted as an observe-only event after the boundary is saved:

```typescript
pi.on("session_compact", async (event) => {
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
pi.on("session_compact_failed", async (event) => {
  console.log(event.reason, event.errorMessage);
  console.log(event.aborted, event.willRetry, event.fromExtension);
});
```

`errorMessage` is absent when cancelled. `fromExtension` marks failures after a `session_before_compact` handler supplied replacement text, and no boundary is saved. A compactor failure is not a compaction failure because Atomic falls back to clearing context and reports `fallbackReason` on `session_compact`.

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

Branch summarization writes structured Markdown:

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

## Critical Context
- [Data needed to continue]

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

Thinking blocks are omitted. Tool results longer than 2,000 characters are truncated with a marker stating how many characters were removed.

## Extension hooks for branch summarization

### `session_before_tree`

Fired before `/tree` navigation regardless of whether the user requested a summary. Handlers can cancel navigation or supply a custom summary:

```typescript
pi.on("session_before_tree", async (event, ctx) => {
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
