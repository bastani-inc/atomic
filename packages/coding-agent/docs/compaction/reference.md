---
title: Compaction reference
sidebarTitle: "Compaction internals"
description: Compaction parameters, saved results, extension hooks, formats, and settings.
---

# Compaction reference

## Parameters

The effective parameters appear in extension events and successful results:

| Parameter | Default | Meaning |
|---|---:|---|
| `compression_ratio` | `0.5` | Fraction of compactable **lines to keep**, not a token ratio |
| `preserve_recent` | `2` | Exact number of newest context-visible messages protected client-side |
| `query` | Last visible user message | Relevance focus for deciding which older lines to retain |

`preserve_recent` counts context-visible messages without aligning to a user turn. An assistant message or tool result may begin the kept tail. A value of `0` protects no messages and makes the entire active transcript compactable.

Atomic carries the recent tail with the compaction boundary rather than replaying it as separate assistant and tool-result messages. Tail text, tool calls, and tool results remain lossless; images remain image blocks. If `query` is absent, Atomic uses the last visible user message.

The policy-refusal summary fallback instead keeps a token-based recent tail, replayed as separate messages. Its checkpoint is lossy rather than a verbatim transcript.

Compaction resets Claude's signed reasoning chain: `thinking` and `redacted_thinking` blocks do not survive the boundary. See [Preserved thinking and model switches](/models/reference#preserved-thinking-and-model-switches) for behavior between boundaries.

The query is never truncated. An oversized planner request reports overflow rather than silently dropping part of it. Use `keepContext` tags, not a longer query, to guarantee protection.

Configure defaults in `~/.atomic/agent/settings.json` or `.atomic/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "compression_ratio": 0.5,
    "preserve_recent": 2,
    "query": "optional focus"
  }
}
```

`reserveTokens` controls the automatic threshold that decides when compaction runs; it is not converted into a classifier line ratio. Manual calls can pass parameter overrides through the SDK.

### Per-model budgets

Use `compaction.modelOverrides` to set `reserveTokens` and/or `preserve_recent` for an exact `"provider/modelId"` key. For example:

```json
{
  "compaction": {
    "reserveTokens": 16384,
    "preserve_recent": 2,
    "modelOverrides": {
      "anthropic/claude-sonnet-4-5": { "reserveTokens": 32768, "preserve_recent": 4 }
    }
  }
}
```

Each field falls back independently to the ordinary setting, then its built-in default. Keys are case-sensitive and do not support wildcards or reasoning suffixes. Both fields require non-negative safe integers. The active session model selects the budgets for manual, automatic, overflow, and post-tool compaction; switching models changes the next resolution, while borrowing a fallback planner does not. Explicit manual parameters take precedence over resolved defaults.

`preserve_recent` counts messages, not tokens. `compression_ratio`, `query`, and `enabled` remain ordinary settings, not per-model overrides. See [Settings](/settings#compaction) for merge and validation rules.

## Persistence and resume

A successful run appends the existing pi-style `type:"compaction"` entry shape:

```json
{
  "type": "compaction",
  "id": "c1",
  "parentId": "m9",
  "timestamp": "2026-07-13T10:00:00.000Z",
  "summary": "[User]: fix the failing test\n(filtered 42 lines)\n[Assistant]: Fixed.",
  "firstKeptEntryId": "m7",
  "tokensBefore": 51234,
  "details": {
    "strategy": "verbatim-lines",
    "promptVersion": 4,
    "rung": "planned",
    "backend": "planner",
    "model": "openai-codex/gpt-6.1-sol",
    "parameters": {"compression_ratio": 0.5, "preserve_recent": 2, "query": "fix the failing test"},
    "stats": {"linesBefore": 812, "linesDeleted": 417, "linesKept": 395, "rangeCount": 63, "tokensBefore": 51234, "tokensAfter": 24980, "percentReduction": 51.2}
  }
}
```

The entry's `tokensBefore` is the provider-aware whole-context count used for budgeting and the Compacted from display. `details.stats.tokensBefore`, `tokensAfter`, and `percentReduction` are heuristic estimates of the compactable region plus the kept tail. Those stats can differ from the entry count, and `percentReduction` is negative when the reconstructed estimate is larger. The display count is not stored again under `details.tokensBefore`.

`details.rung` is `"planned"` for successful model compaction, `"extension"` for a `session_before_compact` override, or `"fresh"` when older context was discarded. `details.backend` and `details.model` identify the successful compactor. A policy-refusal fallback records `backend: "summary"`, the same model that refused, and file lists in `details.summary`. Its card says `summary (pi fallback)`. `details.plannerModel` identifies a borrowed chat planner:

```json
"details": {
  "strategy": "verbatim-lines",
  "promptVersion": 4,
  "rung": "planned",
  "plannerModel": {"provider": "openai", "id": "gpt-5.1", "thinkingLevel": "high"}
}
```

A `"fresh"` boundary that drops the recent tail records `firstKeptEntryId: null`. Only entries with `details.strategy === "verbatim-lines"` affect active context.

Resume uses the saved compacted text without rerunning planning. The TUI shows a collapsible compaction card; new messages after it remain ordinary messages. Old inactive formats do not reapply their historical omissions, so content they once hid can return on resume.

## Extension hooks

### `session_before_compact`

Extensions may cancel or provide a complete replacement for the prepared region:

```typescript
pi.on("session_before_compact", async (event) => {
  const { reason, parameters, preparation, branchEntries, signal } = event;
  if (signal.aborted) return { cancel: true };

  // Optional offline override. It must contain non-whitespace text.
  if (reason === "manual" && branchEntries.length > 100) {
    return { compactedText: preparation.region.lines.slice(0, 40).join("\n") };
  }
});
```

`preparation` is a deep-frozen clone. An override changes only the compacted region text; Atomic retains the prepared boundary and persists the supplied text verbatim. Empty/whitespace text is rejected. The override path does not require provider credentials.

### `session_compact`

After persistence, Atomic emits an observe-only event:

```typescript
pi.on("session_compact", async (event) => {
  console.log(event.result.rung, event.result.stats);   // rung: "planned" | "extension" | "fresh"
  console.log(event.result.plannerModel);               // set only when a fallback model was borrowed
  console.log(event.compactionEntry.details.strategy);  // "verbatim-lines"
  console.log(event.fromExtension);
});
```

Observer errors are isolated and cannot roll back the already-persisted boundary.

### `session_compact_failed`

A failed or cancelled manual, threshold, or overflow compaction emits an observe-only failure event:

```typescript
pi.on("session_compact_failed", async (event) => {
  console.log(event.reason, event.errorMessage);
  console.log(event.aborted, event.willRetry, event.fromExtension);
});
```

`errorMessage` is absent for cancellation. `fromExtension` identifies failures after a `session_before_compact` handler supplied replacement text; no compaction boundary is persisted.

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
[Assistant thinking]: Internal reasoning
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

This prevents the model from treating it as a conversation to continue.

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
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable automatic Verbatim Compaction. |
| `reserveTokens` | `16384` | Tokens to reserve for the next LLM response; threshold auto-compaction starts when completed-response usage or a prospective post-tool context exceeds the model's effective input budget minus this reserve. It is an **input-side** reserve only and never caps planner output. |

The top-level `compactionModel` setting defaults to `"auto"`, using the session model. An exact registered chat-model, classifier, or compactor ID selects a separate compactor. See [Compaction model](/compaction#compaction-model).

Fallback borrowing reuses `settings.fallbackModels`, the same ordered `provider/model[:thinkingLevel]` list used for chat fallback. It skips entries equal to the selected compaction model. A policy refusal from any chat compaction model, including `auto`, explicit chat-model IDs, and borrowed fallback entries, first tries pi's summary compaction on the same model. Classifier and Morph refusals skip summary fallback and advance directly to the next configured model. Other failures and failed summaries also advance to the next configured model. Only load-bearing recovery may clear older context after all attempts fail.

Disable auto-compaction with `"enabled": false`. You can still compact manually with `/compact`.

## Historical formats

Two old formats remain parseable but inactive:

- `type:"context_compaction"` records store logical entry/content-block deletion targets from older versions. Those records are inert, so content they once hid can re-enter context when an old session resumes.
- `type:"compaction"` without `details.strategy: "verbatim-lines"` stored generated summary prose. Those records also remain inert.
