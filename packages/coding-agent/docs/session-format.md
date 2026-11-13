# Session File Format

This page describes format-4 JSONL files used by explicit JSONL stores and exports. Sessions default to SQLite; see [Session storage](/sessions#session-storage) to choose a store. In JSONL, each line is a JSON object with a `type` field. Session entries form a tree through `id` and `parentId`.

## File Location

```
<selected-jsonl-directory>/<timestamp>_<session-id-hash>.jsonl
```

`sessions.storage.dir` and `--session-dir` select the directory containing the JSONL files. Session IDs, not these paths, are used for resume and fork selection. Local artifacts and tool-result files remain on the filesystem even with a database-backed session.

## Deleting Sessions

For an explicitly selected JSONL store, sessions can be removed by deleting their `.jsonl` files. Do not delete the shared SQLite database to remove a single session.

Delete individual sessions from `/resume`: select a session, press `CTRL+D`, then confirm. Database stores delete the selected session record. JSONL stores use the `trash` CLI when available.

## Session Version

SessionManager writes version 4 headers with `createdAt` and `parentSessionId`. Sessions in formats 1, 2, and 3, and early version-4 files whose header has `timestamp` and `parentSession` instead, are upgraded automatically when opened, resumed, imported, or forked. Reading converts older records in memory; listing sessions and looking up headers leave files unchanged. Opening an older JSONL session persists its upgrade atomically under the file lock before new entries are saved. Future versions, unrecognized version values, and structurally invalid entries remain rejected; unloadable sessions are omitted from resume listings. A complete final record without a newline is accepted; a torn final record is rejected.

## Source Files

Source on GitHub ([atomic](https://github.com/bastani-inc/atomic)):
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/session-manager.ts) - Session entry types and SessionManager
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/messages.ts) - Extended message types (BashExecutionMessage, CustomMessage, etc.)

For TypeScript definitions in your project, inspect the installed `@bastani/atomic`, `@bastani/pi-ai`, and `@earendil-works/pi-agent-core` packages under their `dist/` directories.

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
  arguments: JsonObject;
}
```

<a id="base-message-types-from-bastani/pi-ai"></a>

### Base Message Types (from `@bastani/pi-ai`)

```typescript
interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: ToolReference[];
  timestamp: number;
}

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
  details?: JsonValue; // Tool-specific durable metadata
  structuredContent?: JsonValue; // Machine-readable tool output
  usage?: Usage;                 // Tool's own and nested billed usage
  nestedCalls?: NestedToolCalls; // Bounded metadata, not nested outputs
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

The pi-ai `StopReason` type also includes `"pending"`, the reason a message carries while it is still streaming. The terminal event replaces it before the assistant message is written, so `"pending"` does not appear in session JSONL.

System messages record prompt and tool changes in chronological order. Later `content` adds instructions, `sections` patches names (`null` deletes), and tool declarations add or remove availability. Resume and branch selection replay that branch's state. Compaction entries can contain a `systemMessage` checkpoint, replayed before the compacted transcript; system instructions are not offered to the deletion planner. Older sessions acquire a declaration on their next request, not merely when opened. Forced per-run prompts affect provider requests but are not written to the transcript.

A process can stop after a `toolUse` assistant message reaches JSONL but before every corresponding `toolResult` is appended. Atomic does not rewrite that append-only history. When the inactive session is reopened, its derived context supplies an error result for each unanswered call before rendering, compaction, or another provider request. The error states that execution was interrupted and its result is unavailable; it does not claim the tool had no side effects. Orphaned and duplicate results are also removed from provider-bound derived context. The original JSONL remains the authoritative record of what was actually persisted.

Nested tool calls are recorded on their parent `toolResult`, not as independent messages. `nestedCalls` contains `{ calls, complete }`: each call has its ID, name, status, optional arguments, duration and error. At most 256 calls are retained; arguments exceeding 8 KiB per call or 32 KiB across the parent are omitted. `complete: false` means the record is incomplete. Do not treat this metadata as a complete audit log or infer that omitted calls had no side effects. Nested output is not retained there; the parent reports any result needed by the conversation.

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

`compactionSummary` appears only in older session files and is inert. Active verbatim boundaries appear in rebuilt context as visible `custom` messages with `customType: "compaction"`.

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

First line of the file. Metadata only, not a tree entry. Its `id` identifies the session; it has no `parentId`.

```json
{"type":"session","version":4,"id":"uuid","createdAt":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

For sessions with a parent (created via `/fork`, `/clone`, or `newSession({ parentSession })`):

```json
{"type":"session","version":4,"id":"uuid","createdAt":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSessionId":"original-session-id"}
```

Workflow-owned sessions carry both `internal: true` and complete `workflow` linkage. Atomic writes this classification before the transcript becomes visible wherever possible, including workflow stage forks and fresh/forked subagents. A session is excluded from normal resume history only when `internal` is the exact boolean `true` and `workflow.runId`, `workflow.stageId`, and `workflow.stageName` are all non-empty strings:

```json
{"type":"session","version":4,"id":"uuid","createdAt":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","internal":true,"workflow":{"runId":"run-1","stageId":"stage-build","stageName":"build"}}
```

Malformed or incomplete workflow markers remain visible in normal history. Atomic does not infer workflow ownership from `parentSessionId`, so ordinary user-created forks are unaffected. Valid workflow classification is inherited when an internal workflow transcript is branched or forked.

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

A model change that a [model fallback](/settings#fallbackmodels) made also has `fallback`. It names the model the turn asked for (`requested`), the model that failed (`from`), and the failure (`reason`):

```json
{"type":"model_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","provider":"anthropic","modelId":"claude-opus-4-8","fallback":{"requested":"openai/gpt-4o","from":"openai/gpt-4o","reason":"503 Service Unavailable"}}
```

### ThinkingLevelChangeEntry

Emitted when the user changes the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### CompactionEntry

Created by `/compact`, RPC `compact`, and automatic compaction. The `summary` field contains the mechanically reconstructed verbatim transcript string, not generated summary prose. `firstKeptEntryId` is the first context-visible entry retained outside compaction, or `null` when no pre-boundary context-visible message is retained (including `preserve_recent: 0`).

An entry is active only when `details.strategy` is exactly `"verbatim-lines"`:

```json
{"type":"compaction","id":"c1","parentId":"m9","timestamp":"2026-07-13T10:00:00.000Z","summary":"[User]: fix the test\n(filtered 42 lines)\n[Assistant]: Fixed.","firstKeptEntryId":"m7","tokensBefore":51234,"details":{"strategy":"verbatim-lines","promptVersion":3,"rung":"planned","parameters":{"compression_ratio":0.5,"preserve_recent":2,"query":"fix the test"},"stats":{"linesBefore":812,"linesDeleted":417,"linesKept":395,"rangeCount":63,"tokensBefore":51234,"tokensAfter":24980,"percentReduction":51.2}}}
```

The rebuilt context contains one visible `custom` message with `customType: "compaction"`, combining the durable `summary` and retained tail. Full tool-result text and retained images remain available. `firstKeptEntryId: null` means there is no retained pre-boundary tail. Post-boundary messages remain ordinary messages, and resume needs no new planning request.

`details.rung` is `"planned"`, `"extension"` or `"fresh"`; `details.backupPath` is optional. A `"fresh"` entry written after planning failed also carries `details.freshReason`, the cause (for example `Compaction planning timed out after 300000 ms`).

A [background compaction](/compaction#background-compaction) boundary also has `coveredThroughEntryId`, the last entry its `summary` covers. Entries after it and before the boundary were appended while the background task ran; they replay unchanged after the compaction message. Before the boundary is written, the finished result is saved as a `custom` entry with `customType: "atomic:background-compaction-result"` and `data` holding `version`, `upToEntryId`, `startedAt`, `completedAt`, `summary`, `firstKeptEntryId`, `tokensBefore`, `details`, optional `usage` and `fromExtension`. Older Atomic versions load both and ignore the unknown field and custom type.

Historical `compaction` records without `details.strategy: "verbatim-lines"` are retired summary-compaction records. They remain parseable and visible to audit/export tools but are inert in active LLM context.

### ContextCompactionEntry (Retired)

Older Atomic versions stored logical entry/content-block deletions in `type:"context_compaction"` records:

```json
{"type":"context_compaction","id":"ctx12345","parentId":"f6g7h8i9","timestamp":"2024-12-03T14:12:00.000Z","promptVersion":1,"deletedTargets":[{"kind":"entry","entryId":"b2c3d4e5"}],"protectedEntryIds":["a1b2c3d4"],"stats":{"objectsBefore":20,"objectsAfter":19,"objectsDeleted":1,"tokensBefore":50000,"tokensAfter":43000,"percentReduction":14}}
```

These records are archival and never produced or applied by current Atomic. When an old session resumes, previously hidden content may re-enter context until verbatim-line compaction creates an active boundary.

### ContextEditEntry

Append-only edit of one earlier context-producing entry. It changes only future model context; the target entry and its metadata remain unchanged in raw history, UI, exports, and session accounting.

```json
{"type":"context_edit","id":"g6h7i8j9","parentId":"f6g7h8i9","timestamp":"2024-12-03T14:11:00.000Z","targetId":"c3d4e5f6","replacement":null}
```

Targets may be user, assistant, tool-result, or custom-message entries. `replacement: null` omits the target from model context. A non-null `replacement` replaces only the target message content. String replacements for assistant and tool-result entries are normalized to one text block because those roles require content arrays. If several edits target the same entry, the latest edit on the active branch wins. Edits are branch-relative: navigating to a point before the edit reveals the target's original contribution again.

Atomic writes these entries itself when it durably omits a failed attempt from model context (an automatic retry after a provider error, a model fallback, an overflow or length recovery, or an interrupted empty reply that resumes an admitted queued message). Extensions append them through the `turn_end` and `agent_before_settle` boundaries.

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

Atomic records one of its own: when the oversized result of an agent released while it waited (a workflow stage or a background subagent) is stored with the session in its session store, a `custom` entry with `customType: "atomic.tool-output"` names it, written before the tool result whose text points to `tool-output://<sha256>`:

```json
{"type":"custom","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:21:00.000Z","customType":"atomic.tool-output","data":{"toolCallId":"call_1","hash":"9c56…","bytes":1048576}}
```

`hash` is the SHA-256 of the stored bytes and `bytes` their size. In exported files `data` also has `base64`, the bytes themselves, each blob once; importing or forking the file checks every one against its `hash`, stores it with the new session and drops the field.

`/tree` without a summary records its move with a `custom` entry of `customType: "atomic.leaf"` and no `data`. Its parent is the selected entry, or it has `parentId: null` when the move reset the leaf to an empty conversation. When it is the session's last entry, the session reopens at its parent instead of at the entry itself. It contributes nothing to context and `getTree()` and `getChildren()` omit it. A reader that takes a session's last entry as its leaf follows the selected branch either way; older Atomic versions load it as an ordinary custom entry.

```json
{"type":"custom","id":"j0k1l2m3","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:22:00.000Z","customType":"atomic.leaf"}
```

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

Appending a `session_info` entry with an empty `name` clears the title. The distinction is durable: a cleared session keeps its trailing empty-name entry, while a never-named session has no `session_info` entry at all. Readers can tell them apart through `getSessionNameState()` (`{ hasName: false }` for never-named, `{ hasName: true }` for cleared) and through the `hasName` flag on listed `SessionInfo` rows; the bare `name` string is `undefined` in both cases.

### SessionSummaryEntry

A generated one-line description of the session, written automatically once the agent goes idle and shown in the session selector. Never sent to the LLM.

```json
{"type":"session_summary","id":"l2m3n4o5","parentId":"k1l2m3n4","timestamp":"2024-12-03T14:36:00.000Z","summary":"Refactored auth module token refresh and added retry tests","summarizedThroughId":"j0k1l2m3","usage":{"input":812,"output":21}}
```

- `summary`: The stored line. Whitespace is collapsed and length is clamped before writing.
- `summarizedThroughId`: Entry ID of the last user/assistant message the summary covers. The selector shows the summary only while this is still the newest conversation message; anything newer makes it stale and the selector falls back to the session name or first message. Tool results do not count.
- `usage`: Optional token usage from the model call, counted toward session usage totals.

A `branch_summary` written after a `session_summary` also retires it, because the branch it described was abandoned.

### WorktreeSnapshotEntry

The repository state of one checkout at the end of a turn that called a file-writing tool. Never sent to the LLM. See [Worktree snapshots](/worktree-snapshots).

```json
{"type":"worktree_snapshot","id":"m3n4o5p6","parentId":"l2m3n4o5","timestamp":"2024-12-03T14:37:00.000Z","root":"/home/me/project","snapshotId":"3f9a…","snapshot":{"version":1,"id":"3f9a…","root":"/home/me/project","remotes":["https://github.com/me/project.git"],"branch":"main","head":"…","tree":"…","envHash":"…","delta":{"base":"head","patch":"…","bytes":412},"chain":[{"tree":"…","patch":"…","bytes":412}],"bundle":null,"omitted":[],"filters":null,"capturedAt":"2024-12-03T14:37:00.000Z","snapshot":"…"}}
```

- `snapshot`: Present when the state changed. An entry without it refers to the earlier entry whose snapshot has the same `snapshotId`.
- `restore`: Present on the entry written when a resume restored the snapshot into a new worktree: `{ "from", "to", "snapshotId", "tree", "restoredAt" }`. Later resumes map `from` to `to`.
- `restore.degraded`: Present when the resume restored less than the snapshot (#4733): `{ "stage": "partial-changes" | "closest-commit", "head", "tree", "basis"?, "missingLinks", "missingPaths", "missingCommits", "cause", "causeReason"?, "hint" }`. `head` and `tree` are what the worktree holds; `basis` (`pushed-base`, `earlier-snapshot` or `branch-tip`) says where a `closest-commit` restore's commit came from.
- `unrestored`: Present on an entry written when a resume continued without restoring the checkout at `root` (#4733), never together with `restore`: `{ "snapshotId", "continuedIn", "place": "recorded" | "launch", "cause", "causeReason"?, "detail", "hint", "at" }`.
- `restoreWarnings`: Optional, only with `restore`: what that restore reported beyond the snapshot record, `{ "code": "lfs-objects-unavailable", "paths": [...] }` or `{ "code": "stale-restore-retained", "path": "...", "kind": "worktree" | "record" | "records-directory" }`.
- `blobs`: Present only in exported files: base64 patch and bundle content keyed by SHA-256. Import verifies and stores them, then drops this field.

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

`buildSessionProjection()` walks the active branch from root to leaf and replays model, thinking-level, and context-window changes. It selects the latest `compaction` entry whose `details.strategy` is `"verbatim-lines"`, then applies the latest `context_edit` for each selected target. It returns the model-visible messages together with their source entries (`entries[].sourceEntry` and `entries[].messages`); omitted targets produce no message, replacements retain the source entry's role and metadata while changing only content, and the raw selected entries are not modified. `buildSessionContext()` returns just the messages, thinking level, and model from that projection. Provider requests are built from this projection.

- With no active boundary, normal message, custom-message, and branch-summary entries are emitted verbatim.
- With a boundary whose `firstKeptEntryId` is a string, Atomic emits a single custom-role `customType:"compaction"` message whose text is the durable string plus the losslessly serialized kept tail (the entries from that ID up to the boundary, with context edits applied and retained images kept as image blocks on that message), then the messages appended after the boundary. Kept-tail entries project no standalone messages of their own.
- With `firstKeptEntryId: null`, Atomic emits the boundary and post-boundary messages but no pre-boundary ordinary message.
- With `coveredThroughEntryId`, only the kept tail up to that entry is serialized into the compaction message. The entries after it and before the boundary follow as ordinary messages, with context edits applied; an older `compaction` entry among them contributes nothing.
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
  }
}
```

## SessionManager API

Key methods for working with sessions programmatically.

Await `create`, `open`, `continueRecent`, `forkFrom`, and all session mutations. A resolved mutation has committed to its store; a failed write rejects with its typed storage error without publishing the failed entry. There is no `flush` method. `inMemory()` explicitly selects memory and performs no filesystem I/O. Factories without an explicit store or directory resolve the configured storage, defaulting to the shared local SQLite database. A directory argument explicitly selects JSONL. Store-open failures never fall back to memory.

### Static Creation Methods

- `SessionManager.create(cwd, sessionDir?, options?)` - New session in configured storage, or explicit JSONL when a directory is supplied.
- `SessionManager.create(store, cwd, options?)` - New session in a supplied `SessionStore`. Workflow-owned sessions require the pair `internal: true` and `workflow: { runId, stageId, stageName }`.
- `SessionManager.open(store, sessionId, cwdOverride?)` - Open an existing session by exact ID in that store. A missing ID raises `SessionNotFoundError`; it does not create a session.
- `SessionManager.open(path, sessionDir?, cwdOverride?)` - Open a JSONL file directly, creating it if missing. This is a file API, not the CLI session selector.
- `SessionManager.continueRecent(cwd, sessionDir?, options?)` or `continueRecent(store, cwd, options?)` - Continue the most recent regular session or create one. Pass `{ includeInternal: true }` only to include workflow sessions.
- `SessionManager.inMemory(cwd?, options?, entries?)` - Explicit memory storage.
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?, options?)` - Fork a JSONL file into the configured or explicit destination. To fork a database session, open it by ID and await `manager.forkTo(targetCwd, targetStore?, options?)`.
- `SessionManager.importFromJsonl(inputPath, cwd, targetStoreOrDir?)` - Import a JSONL export without changing its ID, upgrading older supported formats. An existing ID raises `SessionExistsError`.

### Static Listing Methods

- `SessionManager.list(cwd, storeOrDir?, onProgress?, options?)` - List project sessions. Internal workflow sessions are excluded by default.
- `SessionManager.listAll(storeOrDir?, onProgress?, options?)` - List sessions across projects in the selected store. Both methods accept `{ includeInternal: true, signal }` to include workflow sessions or cancel listing.

Use the returned `SessionInfo.id` to select a session. Its `path` contains a JSONL location when available and otherwise the ID; do not treat it as a filesystem path. To list workflow sessions in the active store:

```typescript
const stages = await SessionManager.list(cwd, manager.getSessionStore(), undefined, { includeInternal: true });
for (const stage of stages.filter((session) => session.internal)) {
  console.log(stage.workflow?.runId, stage.workflow?.stageId, stage.id);
}
```

### Instance Methods - Session Management

- `newSession(options?)` - Start a new session. Options include `parentSession`, `internal`, and workflow run/stage linkage; classification requires a complete marker pair.
- `markSessionInternal(workflow?)` - Apply valid workflow ownership to the current session, repairing malformed markers while preserving an existing valid marker.
- `setSessionFile(path)` - Switch to a JSONL file directly. For ID-based loading, use `SessionManager.open(store, sessionId)` to obtain a new manager.
- `createBranchedSession(leafId)` - Extract a branch into a new session in the same store
- `forkTo(cwd, targetStoreOrDir?, options?)` - Copy the conversation into a new session at the destination
- `deleteSession(sessionId)` - Delete another session and its entries from the active store. Rejects for the session this manager has open; deleting an ID that is not in the store does nothing. `SessionStore.delete(sessionId)` is the unguarded store-level operation behind it.

### Instance Methods - Appending (all return a promise of the entry ID)
- `appendMessage(message)` - Add message
- `appendThinkingLevelChange(level)` - Record thinking change
- `appendContextWindowChange(contextWindow)` - Record context-window selection in tokens
- `appendModelChange(provider, modelId)` - Record model change
- `appendCompaction(compactedText, firstKeptEntryId, tokensBefore, details)` - Add a durable verbatim-line compaction boundary; pass `null` when no pre-boundary message is retained
- `appendCustomEntry(customType, data?)` - Extension state (not in context)
- `appendSessionInfo(name)` - Set session display name; an empty string clears it
- `appendSessionSummary(summary, summarizedThroughId, usage?)` - Store a generated resume-picker summary, anchored to the message it describes
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
- `branch(entryId)` - Move leaf to earlier entry, in memory only; the session reopens at its last entry
- `resetLeaf()` - Reset leaf to null (before any entries), in memory only
- `recordBranch(entryId | null)` - Move the leaf like `branch()` (or `resetLeaf()` for `null`) and save the move, so the session reopens there
- `branchWithSummary(entryId, summary, details?, fromHook?)` - Branch with context summary

### Instance Methods - Context & Info
- `buildSessionProjection()` - Get the context-edited projection: source entries with their model-visible messages, plus thinkingLevel and model
- `buildSessionContext()` - Get messages, thinkingLevel, and model for LLM
- `buildContextEntries()` - Active branch entries after the latest compaction boundary
- `appendContextEdit(targetId, replacement)` - Append a branch-local context edit (`null` omits the target; `{ content }` replaces only its content)
- `getEntries()` - All entries (excluding header)
- `getHeader()` - Session header metadata
- `getSessionName()` - Get display name from latest session_info entry (`undefined` when cleared or never named)
- `getSessionNameState()` - Get the name state: `{ hasName: false }` when never named, `{ hasName: true }` when the latest entry cleared it, `{ hasName: true, name }` when currently named
- `getCwd()` - Working directory
- `getSessionDir()` - Local JSONL directory, or an empty string for non-JSONL storage
- `getSessionId()` - Exact session ID, not necessarily a UUID
- `getSessionStore()` - Active `SessionStore`
- `getSessionFile()` - Optional JSONL file location for display
- `isPersisted()` - Whether the store is not a `MemorySessionStore`
