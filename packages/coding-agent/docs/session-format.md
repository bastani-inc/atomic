# Session File Format

Sessions are stored as JSONL (JSON Lines) files. Each line is a JSON object with a `type` field. Session entries form a tree structure via `id`/`parentId` fields, enabling in-place branching without creating new files.

## File Location

```
~/.atomic/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

Where `<path>` is the working directory with `/` replaced by `-`.

## Deleting Sessions

Sessions can be removed by deleting their `.jsonl` files under `~/.atomic/agent/sessions/` (legacy `~/.pi/agent/sessions/` may exist from older Pi installs).

Atomic also supports deleting sessions interactively from `/resume` (select a session and press `CTRL+D`, then confirm). When available, Atomic uses the `trash` CLI to avoid permanent deletion.

## Session Version

Sessions have a version field in the header:

- **Version 1**: Linear entry sequence (legacy, auto-migrated on load)
- **Version 2**: Tree structure with `id`/`parentId` linking
- **Version 3**: Renamed `hookMessage` role to `custom` (extensions unification)

Existing sessions are automatically migrated to the current version (v3) when loaded.

## Source Files

Source on GitHub ([atomic](https://github.com/bastani-inc/atomic)):
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/session-manager.ts) - Session entry types and SessionManager
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/messages.ts) - Extended message types (BashExecutionMessage, CustomMessage, etc.)

Base message and agent event types are provided by Atomic's installed runtime dependencies (`@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`), not by separate `packages/ai` or `packages/agent` directories in this monorepo. For TypeScript definitions in your project, inspect `node_modules/@bastani/atomic/dist/`, `node_modules/@earendil-works/pi-ai/dist/`, and `node_modules/@earendil-works/pi-agent-core/dist/`.

## Message Types

Session entries contain `AgentMessage` objects. Understanding these types is essential for parsing sessions and writing extensions.

### Content Blocks

Messages contain arrays of typed content blocks:

```typescript
interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;      // base64 encoded
  mimeType: string;  // e.g., "image/jpeg", "image/png"
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}
```

### Base Message Types (from `@earendil-works/pi-ai`)

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix ms
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: any;      // Tool-specific metadata
  isError: boolean;
  timestamp: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

### Extended Message Types (from Atomic coding-agent)

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;  // true for !! prefix commands
  timestamp: number;
}

interface CustomMessage {
  role: "custom";
  customType: string;            // Extension identifier
  content: string | (TextContent | ImageContent)[];
  display: boolean;              // Show in TUI
  details?: any;                 // Extension-specific metadata
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;                // Entry we branched from
  timestamp: number;
}
```

Historical sessions may contain retired `compactionSummary` role messages from the old summary-compaction implementation. Atomic no longer produces them, they are not part of the active `AgentMessage` union, and they are not injected when active LLM context is rebuilt.

### AgentMessage Union

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage;
// CompactionSummaryMessage was removed; it is no longer part of the active union.
```

## Entry Base

All entries (except `SessionHeader`) extend `SessionEntryBase`:

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // 8-char hex ID
  parentId: string | null;  // Parent entry ID (null for first entry)
  timestamp: string;    // ISO timestamp
}
```

## Entry Types

### SessionHeader

First line of the file. Metadata only, not part of the tree (no `id`/`parentId`).

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

For sessions with a parent (created via `/fork`, `/clone`, or `newSession({ parentSession })`):

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

Sessions created by automated machinery (notably workflow stage sessions) carry an `internal` flag and optional `workflow` linkage so they can be excluded from the standard `/resume` history while remaining resumable through their owning workflow:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","internal":true,"workflow":{"runId":"run-1","stageId":"stage-build","stageName":"build"}}
```

### SessionMessageEntry

A message in the conversation. The `message` field contains an `AgentMessage`.

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello"}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop"}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false}}
```

### ModelChangeEntry

Emitted when the user switches models mid-session.

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

Emitted when the user changes the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### ContextWindowChangeEntry

Emitted when the user selects a supported context-window size for the active model. The value is a token count, independent of thinking/reasoning level. Explicit startup selections are journaled even when they equal the model's scalar default so the user's budget choice survives later settings changes and resume.

```json
{"type":"context_window_change","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:07:00.000Z","contextWindow":1000000}
```

`buildSessionContext()` replays the latest `context_window_change` on the active branch. In-place tree navigation also applies the branch's replayed context window to the active model without appending another `context_window_change` entry or writing context-window defaults to settings. If a historical value is no longer supported by the current model, session creation/navigation falls back to the model default the same way other context-window restore paths do.

### CompactionEntry

Retired summary-compaction entry. Atomic no longer produces this entry type, does not treat it as an active compaction boundary, and does not inject its generated summary into active LLM context. Historical JSONL files may still contain these lines for audit/export compatibility.

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000}
```

Optional historical fields:
- `details`: Legacy implementation-specific data
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if Atomic-generated (legacy field name)

### ContextCompactionEntry

Created by `/compact`, RPC compaction commands, and auto-compaction. Stores Atomic's default **Verbatim Compaction** data: validated logical deletion targets, not replacement text. The internal planner can search/read transcript slices and record exact entry/content-block targets with transcript-bound tools; Atomic validates those targets locally before saving. During `buildSessionContext()`, matching entries/content blocks are filtered from active LLM context while retained content remains verbatim. This deletion-only Context Compaction approach is informed by Morph's write-up at [Morph's Context Compaction](https://www.morphllm.com/context-compaction).

```json
{"type":"context_compaction","id":"ctx12345","parentId":"f6g7h8i9","timestamp":"2024-12-03T14:12:00.000Z","promptVersion":1,"deletedTargets":[{"kind":"entry","entryId":"b2c3d4e5"}],"protectedEntryIds":["a1b2c3d4"],"stats":{"objectsBefore":20,"objectsAfter":19,"objectsDeleted":1,"tokensBefore":50000,"tokensAfter":43000,"percentReduction":14},"backupPath":"/path/session.jsonl.2024-12-03T14-12-00-000Z.compact.bak"}
```

`deletedTargets` entries are either whole entries (`{ kind: "entry", entryId }`) or content blocks (`{ kind: "content_block", entryId, blockIndex }`). Content-block targets are not applied to retained assistant messages that contain `thinking` or `redacted_thinking`; those assistant messages are replay-sensitive for Anthropic-compatible extended-thinking providers and are restored as full content arrays during active context rebuild. The JSONL file remains append-only; this is logical deletion for active context rebuild.

### BranchSummaryEntry

Created when switching branches via `/tree` with an LLM generated summary of the left branch up to the common ancestor. Captures context from the abandoned path.

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

Optional fields:
- `details`: File tracking data (`{ readFiles: string[], modifiedFiles: string[] }`) for default, or custom data for extensions
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if Atomic-generated (legacy field name)

### CustomEntry

Extension state persistence. Does NOT participate in LLM context.

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

Use `customType` to identify your extension's entries on reload.

### CustomMessageEntry

Extension-injected messages that DO participate in LLM context.

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

Fields:
- `content`: String or `(TextContent | ImageContent)[]` (same as UserMessage)
- `display`: `true` = show in TUI with distinct styling, `false` = hidden
- `details`: Optional extension-specific metadata (not sent to LLM)

### LabelEntry

User-defined bookmark/marker on an entry.

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

Set `label` to `undefined` to clear a label.

### SessionInfoEntry

Session metadata (e.g., user-defined display name). Set via `/name`, `--name` / `-n`, or `pi.setSessionName()` in extensions.

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

The session name is displayed in the session selector (`/resume`) instead of the first message when set.

## Tree Structure

Entries form a tree:
- First entry has `parentId: null`
- Each subsequent entry points to its parent via `parentId`
- Branching creates new children from an earlier entry
- The "leaf" is the current position in the tree

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context Building

`buildSessionContext()` walks from the current leaf to the root, producing the message list for the LLM:

1. Collects all entries on the active branch path
2. Extracts current model, thinking level, and context-window settings
3. Applies every `ContextCompactionEntry` logical deletion on that path, filtering targeted entries/content blocks from active context while leaving retained content unchanged
4. Converts `BranchSummaryEntry` and `CustomMessageEntry` to appropriate message formats
5. Ignores retired `CompactionEntry` lines for active LLM context; they remain archival JSONL data only

## Parsing Example

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Retired summary-compaction record: ${entry.tokensBefore} tokens summarized historically`);
      break;
    case "context_compaction":
      console.log(`[${entry.id}] Context compaction: ${entry.stats.objectsDeleted} objects deleted`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] Branch from ${entry.fromId}`);
      break;
    case "custom":
      console.log(`[${entry.id}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] Extension message (${entry.customType}): ${entry.content}`);
      break;
    case "label":
      console.log(`[${entry.id}] Label "${entry.label}" on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] Thinking: ${entry.thinkingLevel}`);
      break;
    case "context_window_change":
      console.log(`[${entry.id}] Context window: ${entry.contextWindow}`);
      break;
  }
}
```

## SessionManager API

Key methods for working with sessions programmatically.

### Static Creation Methods
- `SessionManager.create(cwd, sessionDir?)` - New session
- `SessionManager.open(path, sessionDir?)` - Open existing session file
- `SessionManager.continueRecent(cwd, sessionDir?)` - Continue most recent or create new
- `SessionManager.inMemory(cwd?)` - No file persistence
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)` - Fork session from another project

### Static Listing Methods
- `SessionManager.list(cwd, sessionDir?, onProgress?)` - List sessions for a directory
- `SessionManager.listAll(onProgress?)` - List all sessions across all projects

### Instance Methods - Session Management
- `newSession(options?)` - Start a new session (options: `{ parentSession?: string }`)
- `setSessionFile(path)` - Switch to a different session file
- `createBranchedSession(leafId)` - Extract branch to new session file

### Instance Methods - Appending (all return entry ID)
- `appendMessage(message)` - Add message
- `appendThinkingLevelChange(level)` - Record thinking change
- `appendContextWindowChange(contextWindow)` - Record context-window selection in tokens
- `appendModelChange(provider, modelId)` - Record model change
- `appendContextCompaction(deletedTargets, protectedEntryIds, stats, backupPath?)` - Add logical deletion compaction
- `appendCustomEntry(customType, data?)` - Extension state (not in context)
- `appendSessionInfo(name)` - Set session display name
- `appendCustomMessageEntry(customType, content, display, details?)` - Extension message (in context)
- `appendLabelChange(targetId, label)` - Set/clear label

### Instance Methods - Tree Navigation
- `getLeafId()` - Current position
- `getLeafEntry()` - Get current leaf entry
- `getEntry(id)` - Get entry by ID
- `getBranch(fromId?)` - Walk from entry to root
- `getTree()` - Get full tree structure
- `getChildren(parentId)` - Get direct children
- `getLabel(id)` - Get label for entry
- `branch(entryId)` - Move leaf to earlier entry
- `resetLeaf()` - Reset leaf to null (before any entries)
- `branchWithSummary(entryId, summary, details?, fromHook?)` - Branch with context summary

### Instance Methods - Context & Info
- `buildSessionContext()` - Get messages, thinkingLevel, and model for LLM
- `getEntries()` - All entries (excluding header)
- `getHeader()` - Session header metadata
- `getSessionName()` - Get display name from latest session_info entry
- `getCwd()` - Working directory
- `getSessionDir()` - Session storage directory
- `getSessionId()` - Session UUID
- `getSessionFile()` - Session file path (undefined for in-memory)
- `isPersisted()` - Whether session is saved to disk
