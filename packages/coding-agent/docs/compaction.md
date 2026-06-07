# Compaction & Branch Summarization

LLMs have limited context windows. When conversations grow too long, Atomic uses a deletion-only form of Context Compaction called **Verbatim Compaction**: it deletes safe older transcript objects while preserving every retained object byte-for-byte. This page covers auto-compaction, manual compaction, and branch summarization.

Atomic's default compaction design and terminology are informed by Morph's Context Compaction work: [Morph's Context Compaction](https://www.morphllm.com/context-compaction). In particular, Atomic follows the same core idea that coding agents benefit from deleting low-signal context instead of rewriting high-signal details like file paths, line numbers, and error strings into a lossy summary.

**Source files** ([atomic](https://github.com/bastani-inc/atomic)):
- [`packages/coding-agent/src/core/compaction/compaction.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) - Summary compaction logic
- [`packages/coding-agent/src/core/compaction/context-compaction.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/context-compaction.ts) - Verbatim context compaction
- [`packages/coding-agent/src/core/compaction/branch-summarization.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) - Branch summarization
- [`packages/coding-agent/src/core/compaction/utils.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/utils.ts) - Shared utilities (file tracking, serialization)
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/session-manager.ts) - Entry types (`ContextCompactionEntry`, `CompactionEntry`, `BranchSummaryEntry`)
- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/extensions/types.ts) - Extension event types

For TypeScript definitions in your project, inspect `node_modules/@bastani/atomic/dist/`.

## Overview

Atomic has three compaction/summarization mechanisms:

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Default context compaction (Verbatim Compaction) | Context exceeds threshold, context overflow, or `/compact` | Delete safe old transcript objects while retaining surviving content verbatim |
| Summary compaction internals | Core APIs and legacy extension hooks | Summarize old messages into replacement context |
| Branch summarization | `/tree` navigation | Preserve context when switching branches |

`/compact` has no user-facing arguments. It uses a fixed internal prompt, validates model-proposed deletion targets locally, and stores logical deletions in a `context_compaction` entry. Auto-compaction uses the same deletion-only path.

## Default Context Compaction (Verbatim Compaction)

### When It Triggers

Auto-compaction triggers when:

```
contextTokens > contextWindow - reserveTokens
```

By default, `reserveTokens` is 16384 tokens. Configure it in `~/.atomic/agent/settings.json` or `<project-dir>/.atomic/settings.json`; legacy `.pi` paths are also supported. This leaves room for the LLM's response.

You can also trigger manually with `/compact`. Custom summary instructions are no longer accepted because retained transcript content stays verbatim.

### How It Works

1. Build a compactable transcript for the active branch with stable entry IDs and content-block indexes.
2. Ask the selected model, with a fixed internal prompt, for JSON deletion targets only.
3. Validate the plan locally: unknown IDs, protected user messages, recent operations, unresolved errors, and tool-call/tool-result orphaning fail closed.
4. Write a backup snapshot for persisted sessions.
5. Append a `context_compaction` entry containing validated logical deletion targets and stats.
6. Rebuild active LLM context by filtering those targets. Retained entries/content blocks are reused unchanged.

Tradeoff: compaction performs logical deletion during session rebuild instead of physically rewriting JSONL. The full raw history remains in the session file and backup, while the active LLM context is reduced.

### Verbatim Compaction Diagram

Unlike legacy summary compaction, Verbatim Compaction does not add a generated summary or rewrite retained messages. It appends a `context_compaction` entry that records exactly which older transcript objects should be hidden from future active context rebuilds.

```
Before verbatim compaction:

  entry:  0     1     2      3      4     5      6      7
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass  │ tool │ ass │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┘
                    │      │            │      │
                    └──────┴────────────┴──────┘
                    planner may mark low-signal old objects

Validated deletion plan:

  delete entry 2        (older assistant text)
  delete entry 3        (superseded tool output)
  keep   entries 0,1,4,5,6,7 unchanged

After compaction (new entry appended; JSONL remains append-only):

  entry:  0     1     2      3      4     5      6      7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass  │ tool │ ass │ ctx │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴─────┘
                    ╳      ╳                                      ↑
             logical deletions                       context_compaction entry

What the LLM sees after rebuild:

  ┌────────┬─────┬─────┬──────┬──────┬─────┐
  │ system │ usr │ usr │ ass  │ tool │ ass │
  └────────┴─────┴─────┴──────┴──────┴─────┘
            entry 1 entry 4 entry 5 entry 6 entry 7

No generated summary is inserted. Every surviving entry/content block is reused
verbatim; deleted objects are simply omitted from the active LLM context.
```

## Summary Compaction Internals

The older summarization pipeline still exists in the core compaction module and for legacy extension hook types, but `/compact` and auto-compaction no longer use it by default.

```
Before summary compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

On repeated compactions, the summarized span starts at the previous compaction's kept boundary (`firstKeptEntryId`), not at the compaction entry itself, falling back to the entry after the previous compaction if that kept entry cannot be found in the path. This preserves messages that survived the earlier compaction by including them in the next summarization pass as well. Atomic also recalculates `tokensBefore` from the rebuilt session context before writing the new `CompactionEntry`, so the token count reflects the actual pre-compaction context being replaced.

### Split Turns

A "turn" starts with a user message and includes all assistant responses and tool calls until the next user message. Normally, compaction cuts at turn boundaries.

When a single turn exceeds `keepRecentTokens`, the cut point lands mid-turn at an assistant message. This is a "split turn":

```
Split turn (one huge turn exceeds budget):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (no complete turns before)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

For split turns, Atomic generates two summaries and merges them:
1. **History summary**: Previous context (if any)
2. **Turn prefix summary**: The early part of the split turn

### Cut Point Rules

Valid cut points are:
- User messages
- Assistant messages
- BashExecution messages
- Custom messages (custom_message, branch_summary)

Never cut at tool results (they must stay with their tool call).

### CompactionEntry Structure

Defined in [`session-manager.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/session-manager.ts):

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;  // ISO timestamp
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Legacy summary compaction uses this for details (from compaction.ts):
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Extensions can store any JSON-serializable data in `details`. The legacy summary compaction pipeline tracks file operations, but custom extension implementations can use their own structure.

See [`prepareCompaction()`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) and [`compact()`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) for the implementation.

## Branch Summarization

### When It Triggers

When you use `/tree` to navigate to a different branch, Atomic offers to summarize the work you're leaving. This injects context from the left branch into the new branch.

### How It Works

1. **Find common ancestor**: Deepest node shared by old and new positions
2. **Collect entries**: Walk from old leaf back to common ancestor
3. **Prepare with budget**: Include messages up to token budget (newest first)
4. **Generate summary**: Call LLM with structured format
5. **Append entry**: Save `BranchSummaryEntry` at navigation point

```
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

Both compaction and branch summarization track files cumulatively. When generating a summary, Atomic extracts file operations from:
- Tool calls in the messages being summarized
- Previous compaction or branch summary `details` (if any)

This means file tracking accumulates across multiple compactions or nested branch summaries, preserving the full history of read and modified files.

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

Same as compaction, extensions can store custom data in `details`.

See [`collectEntriesForBranchSummary()`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), [`prepareBranchEntries()`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), and [`generateBranchSummary()`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) for the implementation.

## Summary Format

Both compaction and branch summarization use the same structured format:

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

### Message Serialization

Before summarization, messages are serialized to text via [`serializeConversation()`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/utils.ts):

```
[User]: What they said
[Assistant thinking]: Internal reasoning
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

This prevents the model from treating it as a conversation to continue.

Tool results are truncated to 2000 characters during serialization. Content beyond that limit is replaced with a marker indicating how many characters were truncated. This keeps summarization requests within reasonable token budgets, since tool results (especially from `read` and `bash`) are typically the largest contributors to context size.

## Custom Summarization via Extensions

Extensions can still customize the legacy summary compaction pipeline and branch summarization. Default `/compact` and auto-compaction use deletion-only context compaction and do not call summary customization hooks. See [`extensions/types.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/extensions/types.ts) for event type definitions.

### session_before_compact

Fired before legacy summary compaction. Can cancel or provide custom summary. See `SessionBeforeCompactEvent` and `CompactionPreparation` in the types file.

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, signal } = event;

  // preparation.messagesToSummarize - messages to summarize
  // preparation.turnPrefixMessages - split turn prefix (if isSplitTurn)
  // preparation.previousSummary - previous compaction summary
  // preparation.fileOps - extracted file operations
  // preparation.tokensBefore - context tokens before compaction
  // preparation.firstKeptEntryId - where kept messages start
  // preparation.settings - compaction settings

  // branchEntries - all entries on current branch (for custom state)
  // signal - AbortSignal (pass to LLM calls)

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: { /* custom data */ },
    }
  };
});
```

#### Converting Messages to Text

To generate a summary with your own model, convert messages to text using `serializeConversation`:

```typescript
import { convertToLlm, serializeConversation } from "@bastani/atomic";

pi.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;
  
  // Convert AgentMessage[] to Message[], then serialize to text
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // Returns:
  // [User]: message text
  // [Assistant thinking]: thinking content
  // [Assistant]: response text
  // [Assistant tool calls]: read(path="..."); bash(command="...")
  // [Tool result]: output text

  // Now send to your model for summarization
  const summary = await myModel.summarize(conversationText);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }
  };
});
```

See [custom-compaction.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/custom-compaction.ts) for a complete example using a different model.

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
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable automatic Verbatim Compaction |
| `reserveTokens` | `16384` | Tokens to reserve for LLM response |
| `keepRecentTokens` | `20000` | Recent tokens to protect from deletion |

Disable auto-compaction with `"enabled": false`. You can still compact manually with `/compact`.
