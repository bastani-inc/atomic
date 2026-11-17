---
title: Compaction reference
sidebarTitle: "Compaction internals"
description: Compaction parameters, saved boundaries, extension hooks, exports, formats, and settings.
---

# Compaction reference

## Parameters

Extension events and results carry one parameter:

| Parameter | Default | Meaning |
|---|---|---|
| `query` | The latest user request | The `/compact` instructions when you gave them, otherwise the text of the latest user request. A compactor model receives it as its query. |

Instructions given to `/compact`, `session.compact({ query })`, `ctx.compact({ query })` or RPC `compact` are also added to the boundary message, after the recovery steps. Automatic compaction has no instructions.

`compression_ratio` and `preserve_recent` are no longer compaction options. A caller that still passes them has them ignored. The compactor's ratio, request timeout and output limit are fixed:

| Value | Export | Meaning |
|---|---|---|
| `0.5` | `COMPACTOR_COMPRESSION_RATIO` | Share of the conversation the compactor is asked to keep |
| `120000` | `COMPACTOR_REQUEST_TIMEOUT_MS` | Wall-clock limit on one compactor request, in milliseconds |
| `32000` | `COMPACTED_OUTPUT_MAX_TOKENS` | Largest compacted text, in estimated tokens. On a small context window the limit is half of the context the automatic trigger allows |

Compaction resets Claude's signed reasoning chain: `thinking` and `redacted_thinking` blocks do not survive the boundary. See [Preserved thinking and model switches](/models/reference#preserved-thinking-and-model-switches) for behavior between boundaries.

## Persistence and resume

A successful run appends a `type:"compaction"` entry:

```json
{
  "type": "compaction",
  "id": "c1",
  "parentId": "m9",
  "timestamp": "2026-11-17T10:00:00.000Z",
  "summary": "Context cleared. Your earlier conversation (51,234 tokens) is no longer in your context window. …",
  "firstKeptEntryId": null,
  "tokensBefore": 51234,
  "details": {
    "strategy": "verbatim-lines",
    "promptVersion": 7,
    "parameters": {"query": "fix the failing test"},
    "stats": {"linesBefore": 812, "linesDeleted": 812, "linesKept": 0, "rangeCount": 0, "tokensBefore": 51234, "tokensAfter": 2210, "percentReduction": 95.7},
    "form": "cleared",
    "history": {"sessionId": "019f6a2e-…", "linesBefore": 4210, "boundaryLine": 4211, "totalLines": 4232}
  }
}
```

| Field | Meaning |
|---|---|
| `summary` | The whole boundary message the model sees: the `Context cleared` or `Context compacted` text, any compacted text, the recovery instructions, and any `/compact` instructions |
| `firstKeptEntryId` | Always `null`: no earlier message stays in context |
| `tokensBefore` | The provider-aware whole-context count before the boundary, used for budgeting and the boundary line |
| `coveredThroughEntryId` | Written only by earlier versions, while a tool call was still waiting for its result: the waiting call's turn replays after the boundary. A boundary is no longer written while a call waits |
| `usage` | The compactor endpoint's usage, when it reported any |
| `details.form` | `cleared` (no model call) or `compacted` (a compactor or an extension supplied text) |
| `details.backend` | `compactor` or `extension`; present only on a `compacted` boundary |
| `details.model` | The compactor as `provider/model`, when one produced the text |
| `details.fallbackReason` | Why the configured compactor was not used and the context was cleared instead |
| `details.history` | Where the boundary sits in `history://sessions/<sessionId>`: `linesBefore` is the last line of the earlier conversation, `boundaryLine` the boundary's first line, and `totalLines` the history's length right after the boundary was written |
| `details.historyAccess` | How the boundary told the agent to reach its history: `read-search` (its own `read` and `search` tools) or `session-history-tool`. A resumed session after a boundary gets `session_history` whenever its resumed tools leave out `read` or `search` |
| `details.stats` | Heuristic estimates. `tokensAfter` counts the system prompt and the boundary message. `linesBefore` counts the serialized lines of the replaced context and `linesKept` the lines of compacted text, `0` on a clear. `rangeCount` is always `0` |
| `details.backupPath` | The pre-compaction backup, when it could be written |

`details.strategy` stays `"verbatim-lines"`, and only entries with that strategy affect active context. The display count is not stored again under `details.tokensBefore`.

Resume uses the saved boundary text without another request. New messages after the boundary remain ordinary messages. Old inactive formats do not reapply their historical omissions, so content they once hid can return on resume.

## Extension hooks

### `session_before_compact`

Extensions may cancel a compaction or supply their own replacement text:

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

`preparation` is a deep-frozen clone. `preparation.region.lines` holds everything in context since the last boundary, serialized as role-tagged lines (`[User]: `, `[Assistant]: `, `[Assistant tool calls]: `, `[Tool result]: `), with the previous boundary's text first. Nothing in it is protected: `firstKeptEntryId` is `null` and `keptTailMessageCount` is `0`. `parameters.query` is the `/compact` instructions or the latest user request.

Returning `{ cancel: true }` cancels the compaction. Returning `compactedText` writes a `Context compacted` boundary without calling the configured compactor: the model sees the text in a `<compacted-context>` block, followed by the recovery instructions. Empty or whitespace text is no replacement; the configured form runs as if the handler had returned nothing. Text over the compactor's output limit, or that would not fit below the automatic trigger together with the system prompt and the recovery instructions, is refused like a compactor's: the context is cleared instead, with the fallback reason `extension failed: output too long (…)`. A replacement needs no provider credentials. The hook runs before any compactor request and receives the compaction's abort signal.

### `session_compact`

After the boundary is saved, Atomic emits an observe-only event:

```typescript
pi.on("session_compact", async (event) => {
  console.log(event.result.form, event.result.backend, event.result.model); // "cleared" | "compacted"
  console.log(event.result.fallbackReason);    // set when a configured compactor was not used
  console.log(event.result.history);           // { sessionId, linesBefore, boundaryLine, totalLines }
  console.log(event.compactionEntry.details.strategy); // "verbatim-lines"
  console.log(event.fromExtension);
});
```

`event.result.compactedText` is the whole boundary message, the same text as the entry's `summary`. Observer errors are isolated and cannot roll back the saved boundary.

### `session_compact_failed`

A failed or cancelled manual, threshold, or overflow compaction emits an observe-only failure event:

```typescript
pi.on("session_compact_failed", async (event) => {
  console.log(event.reason, event.errorMessage);
  console.log(event.aborted, event.willRetry, event.fromExtension);
});
```

`errorMessage` is absent for cancellation. `fromExtension` identifies failures after a `session_before_compact` handler supplied replacement text; no compaction boundary is saved. A compactor failure is not a compaction failure: the context is cleared instead and `session_compact` reports the `fallbackReason`.

## Package exports

`@bastani/atomic` exports the pieces compaction is built from:

| Export | Use |
|---|---|
| `buildBoundaryText(input, totalLines)` | The boundary message for a session, its history location, and optional instructions or compacted text |
| `buildCompactorMessages(messages, isBoundary)` | Frame a context's messages the way the compactor receives them |
| `requestCompactorOutput(request)` | Send one `CompactorRequest` to a compactor endpoint; resolves with `{ text, usage? }` and throws `CompactorFailure` with the reason on any failure |
| `resolveCompactionModel(configured, models)` | Resolve a `compactionModel` value to a `CompactionModelSelection`: `auto`, with the reason a chat, classifier or unknown value was ignored, or a compactor |
| `SESSION_HISTORY_TOOL_NAME` | `"session_history"`, the tool an agent without `read` or `search` gets after its first clear |

The types `CompactionForm`, `CompactionBackend`, `CompactionHistoryLocation`, `CompactionModelSelection`, `CompactorMessage` and `CompactorRequest` are exported with them.

## Branch Summary Format

Branch summarization uses a structured format:

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

### Message Serialization for Branch Summaries

Branch-summary input uses role-labelled text:

```text
[User]: What they said
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

This prevents the model from treating it as a conversation to continue.

Thinking blocks are omitted.

Tool results are truncated to 2000 characters during serialization. Content beyond that limit is replaced with a marker indicating how many characters were truncated.

## Extension Hooks for Branch Summarization

### session_before_tree

Fired before `/tree` navigation. Always fires regardless of whether user chose to summarize. Can cancel navigation or provide custom summary.

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - where we're navigating to
  // preparation.oldLeafId - current position (being abandoned)
  // preparation.commonAncestorId - shared ancestor
  // preparation.entriesToSummarize - entries that would be summarized
  // preparation.userWantsSummary - whether user chose to summarize

  // Cancel navigation entirely:
  return { cancel: true };

  // Provide custom summary (only used if userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        details: { /* custom data */ },
      }
    };
  }
});
```

See `SessionBeforeTreeEvent` and `TreePreparation` in the types file.

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

| Setting | Default | Description |
|---------|---------|-------------|
| `compaction.enabled` | `true` | Enable automatic compaction. |
| `compaction.reserveTokens` | `16384` | Tokens to reserve for the next response. Automatic compaction starts when completed-response usage or the context after tool results exceeds the model's context window minus this reserve. |
| `compactionModel` | `"auto"` | `auto` or an empty value clears the context; an exact registered compactor ID, such as `morph/morph-compactor`, compacts with that model. See [Compaction model](/compaction#compaction-model). |

Disable automatic compaction with `"enabled": false`. You can still compact manually with `/compact`.

These settings were removed. Atomic ignores them when they are present, and settings load without an error: `compaction.compression_ratio`, `compaction.preserve_recent`, `compaction.keepContextShare`, `compaction.query`, `compaction.planningTimeoutMs`, `compaction.modelOverrides`, `compaction.background`, `compaction.backgroundThresholdPercent` and `compaction.historyRecall`.

## Historical formats

Older formats remain parseable:

- `type:"compaction"` entries with `details.strategy: "verbatim-lines"` written by earlier versions have no `details.form`. They kept part of the conversation verbatim, with `(filtered N lines)` markers and a kept tail, or held a summary. They stay active and replay as they were written. The chat shows them as `Context compacted`, or as `Context cleared` for an older boundary that started a fresh context window.
- `type:"context_compaction"` records store logical entry/content-block deletion targets from older versions. Those records are inert, so content they once hid can re-enter context when an old session resumes.
- `type:"compaction"` without `details.strategy: "verbatim-lines"` stored generated summary prose. Those records also remain inert.
