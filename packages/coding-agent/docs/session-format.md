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

`compactionSummary` is a historical message role that appears only in older session files; Atomic never produces it and treats historical occurrences as inert. Active verbatim boundaries are synthesized at rebuild time as visible `custom` messages with `customType: "compaction"`; `convertToLlm()` maps them to provider-facing user messages.

### AgentMessage Union

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage;
// compactionSummary appears only in older session files and is not part of the active union.
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

Workflow-owned sessions carry both `internal: true` and complete `workflow` linkage. Atomic writes this classification before the transcript becomes visible wherever possible, including workflow stage forks and fresh/forked subagents. A session is excluded from normal resume history only when `internal` is the exact boolean `true` and `workflow.runId`, `workflow.stageId`, and `workflow.stageName` are all non-empty strings:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","internal":true,"workflow":{"runId":"run-1","stageId":"stage-build","stageName":"build"}}
```

Malformed, incomplete, workflow-only, or truthy non-boolean legacy markers remain visible in normal history. Atomic does not infer workflow ownership from `parentSession`, so ordinary user-created forks are unaffected. Valid workflow classification is inherited when an internal workflow transcript is branched or forked.

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

Created by `/compact`, RPC `compact`, and automatic compaction. The `summary` field contains the mechanically reconstructed verbatim transcript string, not generated summary prose. `firstKeptEntryId` is the first context-visible entry retained outside compaction, or `null` when no pre-boundary context-visible message is retained (including `preserve_recent: 0`).

An entry is active only when `details.strategy` is exactly `"verbatim-lines"`:

```json
{"type":"compaction","id":"c1","parentId":"m9","timestamp":"2026-07-13T10:00:00.000Z","summary":"[User]: fix the test\n(filtered 42 lines)\n[Assistant]: Fixed.","firstKeptEntryId":"m7","tokensBefore":51234,"details":{"strategy":"verbatim-lines","promptVersion":3,"rung":"planned","parameters":{"compression_ratio":0.5,"preserve_recent":2,"query":"fix the test"},"stats":{"linesBefore":812,"linesDeleted":417,"linesKept":395,"rangeCount":63,"tokensBefore":51234,"tokensAfter":24980,"percentReduction":51.2}}}
```

On rebuild, Atomic emits the durable `summary` as a synthesized visible custom message, then emits original entries beginning at a string `firstKeptEntryId`. When the field is `null`, it emits no pre-boundary ordinary entries. In both cases, messages appended after the boundary are emitted. This exact state survives resume without rerunning a planner. Existing records with string IDs retain their behavior; `details.rung` is `"planned"` or `"extension"`, and `details.backupPath` is optional.

Historical `compaction` records without `details.strategy: "verbatim-lines"` are retired summary-compaction records. They remain parseable and visible to audit/export tools but are inert in active LLM context.

### ContextCompactionEntry (Retired)

Older Atomic versions stored logical entry/content-block deletions in `type:"context_compaction"` records:

```json
{"type":"context_compaction","id":"ctx12345","parentId":"f6g7h8i9","timestamp":"2024-12-03T14:12:00.000Z","promptVersion":1,"deletedTargets":[{"kind":"entry","entryId":"b2c3d4e5"}],"protectedEntryIds":["a1b2c3d4"],"stats":{"objectsBefore":20,"objectsAfter":19,"objectsDeleted":1,"tokensBefore":50000,"tokensAfter":43000,"percentReduction":14}}
```

These records are archival and never produced or applied by current Atomic. When an old session resumes, previously hidden content may re-enter context until verbatim-line compaction creates an active boundary.

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

`buildSessionContext()` walks the active branch from root to leaf and replays model, thinking-level, and context-window changes. It selects the latest `compaction` entry whose `details.strategy` is `"verbatim-lines"`.

- With no active boundary, normal message, custom-message, and branch-summary entries are emitted verbatim.
- With a boundary whose `firstKeptEntryId` is a string, Atomic emits its durable string as a custom-role `customType:"compaction"` message, then original messages from that ID onward, including messages appended after the boundary.
- With `firstKeptEntryId: null`, Atomic emits the boundary and post-boundary messages but no pre-boundary ordinary message.
- If a corrupt/foreign boundary's non-null `firstKeptEntryId` is absent, Atomic emits the boundary followed by post-boundary messages rather than resurrecting all older content.
- Legacy `context_compaction` entries and non-verbatim `compaction` entries are skipped as inert archival records.
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
      if (entry.details?.strategy === "verbatim-lines") {
        console.log(`[${entry.id}] Verbatim compaction: ${entry.details.stats.linesKept}/${entry.details.stats.linesBefore} lines kept`);
      } else {
        console.log(`[${entry.id}] Retired summary-compaction record`);
      }
      break;
    case "context_compaction":
      console.log(`[${entry.id}] Retired logical-deletion compaction record`);
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

- `SessionManager.create(cwd, sessionDir?, options?)` - New session. Workflow-owned sessions require the pair `internal: true` and `workflow: { runId, stageId, stageName }`.
- `SessionManager.open(path, sessionDir?)` - Open a specific session file directly, including an internal session.
- `SessionManager.continueRecent(cwd, sessionDir?, options?)` - Continue the most recent regular session or create a new one. Pass `{ includeInternal: true }` only for workflow-specific recovery or diagnostics.
- `SessionManager.inMemory(cwd?, options?)` - No file persistence
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?, options?)` - Fork a session from another project. Relevant `NewSessionOptions`, including valid workflow classification, are written in the initial header.

### Static Listing Methods

- `SessionManager.list(cwd, sessionDir?, onProgress?, options?)` - List project sessions. Internal workflow sessions are excluded by default; pass `{ includeInternal: true }` to include them and expose their `SessionInfo.workflow` linkage.
- `SessionManager.listAll(sessionDir?, onProgress?, options?)` - List sessions across projects, or from a custom session directory. The same `includeInternal` default and opt-in apply.

Normal `/resume`, `atomic -r`, and `--continue` callers use the default filtering. Workflow-specific code can opt in without changing user-facing history:

```typescript
const stages = await SessionManager.list(cwd, sessionDir, undefined, { includeInternal: true });
for (const stage of stages.filter((session) => session.internal)) {
  console.log(stage.workflow?.runId, stage.workflow?.stageId, stage.path);
}
```

### Instance Methods - Session Management

- `newSession(options?)` - Start a new session. Options include `parentSession`, `internal`, and workflow run/stage linkage; classification requires a complete marker pair.
- `markSessionInternal(workflow?)` - Apply valid workflow ownership to the current session, repairing malformed markers while preserving an existing valid marker.
- `setSessionFile(path)` - Switch to a different session file
- `createBranchedSession(leafId)` - Extract branch to new session file

### Instance Methods - Appending (all return entry ID)
- `appendMessage(message)` - Add message
- `appendThinkingLevelChange(level)` - Record thinking change
- `appendContextWindowChange(contextWindow)` - Record context-window selection in tokens
- `appendModelChange(provider, modelId)` - Record model change
- `appendCompaction(compactedText, firstKeptEntryId, tokensBefore, details)` - Add a durable verbatim-line compaction boundary; pass `null` when no pre-boundary message is retained
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
