---
title: Session format
description: Format-4 JSONL session schema, message and entry types, context projection, and the SessionManager API.
---

# Session file format

This page describes format-4 JSONL files used by explicit JSONL stores and session exports. Sessions default to SQLite; see [Session storage](/sessions#session-storage) to choose a store.

In JSONL, each line is a JSON object with a `type` field. Session entries form a tree through `id` and `parentId`.

## File location

```text
<selected-jsonl-directory>/<timestamp>_<session-id-hash>.jsonl
```

`sessions.storage.dir` and `--session-dir` select the directory that holds JSONL files. Resume and fork selection match by session ID rather than file path. Local artifacts and tool-result files stay on the filesystem even when a session is stored in a database.

## Deleting sessions

In an explicit JSONL store, you can remove a session by deleting its `.jsonl` file. Do not delete the shared SQLite database to remove a single session.

To delete individual sessions from `/resume`, select a session, press `Ctrl+D`, and confirm. Database stores delete the session record, and JSONL stores use the `trash` CLI when available.

Entries in the active window keep their exact `id` and `parentId` strings. Very large IDs count toward that window's memory even when the message is short or referenced only by a compaction boundary. Atomic does not shorten IDs when copying or importing a session.

## Session version

`SessionManager` writes format-4 headers with `createdAt` and `parentSessionId`. Sessions in formats 1, 2, and 3, along with early format-4 files that use `timestamp` and `parentSession`, upgrade automatically when opened, resumed, imported, or forked.

Reading upgrades older records in memory, while listing sessions and looking up headers leave files untouched. Opening an older JSONL session writes its upgrade atomically under the file lock before saving new entries.

Future versions, unrecognized version numbers, and structurally invalid entries are rejected, and unloadable sessions are omitted from resume listings. A complete final line without a trailing newline is accepted. An unfinished final line left by a crashed process is ignored with one warning naming the file, and the next saved entry removes it. A damaged record before the final line is rejected.

## Type definitions

Inspect the exported TypeScript declarations in your installed packages:

- `@bastani/atomic`: `SessionManager`, `SessionHeader`, `SessionEntry`, `BashExecutionMessage`, `CustomMessage`, and `BranchSummaryMessage`.
- `@bastani/atomic-ai`: `SystemMessage`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `Usage`, and `StopReason`.
- `@bastani/atomic-agent-core`: `AgentMessage`.

## Message types

Session entries store `AgentMessage` objects. Understanding these shapes helps when parsing exports or building extensions.

### Content blocks

Messages hold arrays of typed content blocks:

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

### Base message types

These message types come from `@bastani/atomic-ai`:

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
  details?: JsonValue;           // Tool-specific durable metadata
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

The `StopReason` type in `@bastani/atomic-ai` also includes `"pending"` (while a reply is still streaming) and `"deferred"`. Terminal events replace `"pending"` before the assistant message is saved, so `"pending"` does not appear in session JSONL.

System messages record prompt and tool changes in chronological order. Later `content` appends instructions, `sections` patches named sections (`null` deletes a section), and `toolsAdded` or `toolsRemoved` updates tool availability. Resume and branch selection replay that branch's state. Compaction entries may carry a `systemMessage` checkpoint replayed before the boundary message; system instructions are never sent to a compactor model. Older sessions record a declaration on their next request rather than on open, and forced per-run prompts are not written to the transcript.

If a process stops after writing a `toolUse` assistant message but before appending every matching `toolResult`, Atomic leaves the append-only history unchanged. Reopening the session synthesizes an interrupted error result for each unanswered call in derived context before rendering, compaction, or the next provider request. That error states that execution was interrupted and its result is unavailable without claiming the tool had no side effects. Derived context also drops orphaned and duplicate tool results, while the original JSONL remains the persisted record.

Nested tool calls are stored on their parent `toolResult` rather than as standalone messages. `nestedCalls` holds `{ calls, complete }`, where each call records its ID, name, status, optional arguments, duration, and error. Atomic keeps at most 256 calls and omits arguments over 8 KiB per call or 32 KiB across the parent. `complete: false` indicates an incomplete record; do not treat `nestedCalls` as a full audit log or assume omitted calls had no side effects. Nested outputs are not stored there.

### Extended message types

These message types come from `@bastani/atomic`:

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

`compactionSummary` appears only in older session files and is inert. Active compaction boundaries appear in rebuilt context as visible `custom` messages with `customType: "compaction"`.

### AgentMessage union

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

## Entry base

All entries except `SessionHeader` extend `SessionEntryBase`:

```typescript
interface SessionEntryBase {
  type: string;
  id: string;              // 8-char hex ID
  parentId: string | null; // Parent entry ID (null for first entry)
  timestamp: string;       // ISO timestamp
}
```

## Entry types

### SessionHeader

The first line of the file holds session metadata and is not a tree entry. Its `id` identifies the session, and it has no `parentId`:

```json
{"type":"session","version":4,"id":"uuid","createdAt":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

Sessions created from another session through `/fork`, `/clone`, or `newSession({ parentSession })` include `parentSessionId`:

```json
{"type":"session","version":4,"id":"uuid","createdAt":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSessionId":"original-session-id"}
```

Any session with `internal: true` in its header is excluded from `/resume`, `atomic -r`, `-c`, and `history://sessions`, while remaining openable by exact ID. Fresh subagent sessions and `newSession({ internal: true })` set this flag:

```json
{"type":"session","version":4,"id":"uuid","createdAt":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","internal":true}
```

Older workflow-stage sessions also carried `workflow` metadata (`runId`, `stageId`, and `stageName`). Current Atomic releases do not write new `workflow` metadata, and session stores preserve existing `workflow` fields read-only during export and import. Atomic does not infer internal status from `parentSessionId`, so ordinary user forks remain listed.

### SessionMessageEntry

A conversation message whose `message` field holds an `AgentMessage`:

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello"}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop"}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false}}
```

### ModelChangeEntry

Recorded when the active model changes mid-session:

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

When a [model fallback](/settings#fallbackmodels) switches models, the entry also includes `fallback`. It records the requested model (`requested`), the model that failed or lacked credentials (`from`), and the error (`reason`). When fallback skips candidates without sending a request, `fallback.skipped` lists each `{ model, provider, reason }` where `reason` is `"no-credentials"` or `"auth-failed"`:

```json
{"type":"model_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","provider":"anthropic","modelId":"claude-opus-4-8","fallback":{"requested":"openai/gpt-4o","from":"openai/gpt-4o","reason":"503 Service Unavailable"}}
{"type":"model_change","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:07:00.000Z","provider":"github-copilot","modelId":"gpt-5.5","fallback":{"requested":"openai/gpt-5","from":"openai/gpt-5","reason":"No API key found for openai","skipped":[{"model":"openai/gpt-5","provider":"openai","reason":"no-credentials"},{"model":"anthropic/claude-opus-4-8","provider":"anthropic","reason":"no-credentials"}]}}
```

### ThinkingLevelChangeEntry

Recorded when the thinking or reasoning level changes:

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### CompactionEntry

Created by `/compact`, RPC `compact`, and automatic compaction. The `summary` field holds the boundary message the model sees next, either a `Context cleared` message or a `Context compacted` message with compacted text, followed by recovery instructions. `firstKeptEntryId` is `null` because no earlier message stays in context.

An entry is active only when `details.strategy` is `"verbatim-lines"`:

```json
{"type":"compaction","id":"c1","parentId":"m9","timestamp":"2026-11-17T10:00:00.000Z","summary":"Context cleared. Your earlier conversation (51,234 tokens) is no longer in your context window. ...","firstKeptEntryId":null,"tokensBefore":51234,"details":{"strategy":"verbatim-lines","promptVersion":7,"parameters":{"query":"fix the test"},"stats":{"linesBefore":812,"linesDeleted":812,"linesKept":0,"rangeCount":0,"tokensBefore":51234,"tokensAfter":2210,"percentReduction":95.7},"form":"cleared","history":{"sessionId":"019f6a2e-...","rangeUnit":"entries","entriesBefore":4210,"boundaryEntry":4211,"totalEntries":4211}}}
```

Rebuilt context contains one visible `custom` message with `customType: "compaction"` holding `summary`. Messages appended after the boundary stay ordinary messages, and resuming requires no model request.

Key `details` fields include:

- `form`: `"cleared"` or `"compacted"`.
- `backend` and `model`: present on compacted entries (`"compactor"` or `"extension"`, plus `provider/model` for a compactor).
- `fallbackReason`: present when a configured compactor was not used and Atomic cleared context instead.
- `history`: locates the boundary in `history://sessions/<sessionId>` with `rangeUnit: "entries"`, `entriesBefore`, `boundaryEntry`, and `totalEntries`.
- `historyAccess`: `"read-search"` or `"session-history-tool"`.
- `backupPath`: optional pre-compaction backup path.

See [Persistence and resume](/compaction/reference#persistence-and-resume) for every field.

Atomic does not write a boundary while a tool call is waiting for its result. Older boundaries written in that state carry `coveredThroughEntryId`, so the waiting turn replays after the boundary. Older verbatim boundaries with a string `firstKeptEntryId` or legacy `details` fields remain active and replay as written. Older `compaction` records without `details.strategy: "verbatim-lines"`, and `custom` entries with `customType: "atomic:background-compaction-result"`, remain parseable for export and audit but are inert in active context.

### ContextCompactionEntry (retired)

Older Atomic versions stored logical entry and content-block deletions in `type: "context_compaction"` records:

```json
{"type":"context_compaction","id":"ctx12345","parentId":"f6g7h8i9","timestamp":"2024-12-03T14:12:00.000Z","promptVersion":1,"deletedTargets":[{"kind":"entry","entryId":"b2c3d4e5"}],"protectedEntryIds":["a1b2c3d4"],"stats":{"objectsBefore":20,"objectsAfter":19,"objectsDeleted":1,"tokensBefore":50000,"tokensAfter":43000,"percentReduction":14}}
```

Current Atomic never writes or applies these records. When an old session resumes, content hidden by these records may reappear in context until a new compaction writes an active boundary.

### ContextEditEntry

Append-only edit of one earlier context-producing entry. It changes only future model context; raw history, UI display, exports, and session accounting keep the original entry intact.

```json
{"type":"context_edit","id":"g6h7i8j9","parentId":"f6g7h8i9","timestamp":"2024-12-03T14:11:00.000Z","targetId":"c3d4e5f6","replacement":null}
```

Targets may be user, assistant, tool-result, or custom-message entries. `replacement: null` omits the target from model context, while a non-null `replacement` replaces only its content (string replacements for assistant and tool-result entries normalize to one text block). When several edits target the same entry on a branch, the latest edit wins. Edits are branch-relative, so navigating before the edit restores the original contribution.

Atomic writes `context_edit` entries when omitting failed attempts from model context, such as provider retries, model fallbacks, overflow or length recoveries, and interrupted empty replies. Extensions can append them from `turn_end` and `agent_before_settle`.

### BranchSummaryEntry

Created when `/tree` switches away from a branch with a summary of the abandoned path up to the common ancestor:

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

Optional fields:

- `details`: `{ readFiles: string[], modifiedFiles: string[] }` for built-in summaries, or custom extension data.
- `usage`: optional token usage from the summary model call.
- `fromHook`: `true` if supplied by an extension, `false` or omitted if generated by Atomic.

### CustomEntry

Extension state persistence that does not enter LLM context:

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

Use `customType` to identify your extension's entries on reload. Atomic also writes three built-in custom entry types:

- `atomic.tool-output`: written before a tool result that points to `tool-output://<sha256>` when oversized output from a released subagent is stored with the session. `data` holds `{ toolCallId, hash, bytes }`. Exported JSONL files also include `base64` once per blob; import and fork verify each blob against `hash`, store it, and drop `base64`.

```json
{"type":"custom","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:21:00.000Z","customType":"atomic.tool-output","data":{"toolCallId":"call_1","hash":"9c56...","bytes":1048576}}
```

- `atomic.leaf`: written with no `data` when `/tree` navigates without a summary. Its `parentId` is the selected entry, or `null` when resetting to an empty conversation. When it is the last entry, the session reopens at its parent. `getTree()` and `getChildren()` omit it, and it contributes nothing to context.

```json
{"type":"custom","id":"j0k1l2m3","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:22:00.000Z","customType":"atomic.leaf"}
```

- `resume_timings`: records millisecond restore and blueprint durations for `/session snapshot`. `phases` holds only the phases that ran (`fetch`, `reconstruct`, `materialize`, `lfs`, `verify`, `publish`, `seed`), `mode` is `fresh`, `claimed`, `in-place`, or `degraded`, `fetch` is `none`, `shallow`, `full`, or `bundle`, and `exit` is `ok`, `failed`, or `timed-out`. Read it with `latestResumeTimings(sessionManager)` and format it with `formatResumeTimings()`.

```json
{"type":"custom","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:23:00.000Z","customType":"resume_timings","data":{"version":1,"startedAt":"2024-12-03T14:22:00.000Z","restores":[{"root":"/home/me/project","mode":"fresh","fetch":"full","ms":18520,"phases":{"fetch":9900,"materialize":1400,"verify":210,"publish":12}}],"blueprint":[{"section":"maintenance","name":"npm install","ms":8600,"exit":"ok"}],"firstPromptReadyMs":28400,"blueprintReadyMs":28300}}
```

### CustomMessageEntry

Extension messages that enter LLM context unless `excludeFromContext` is `true`:

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

- `content`: string or `(TextContent | ImageContent)[]`, matching `UserMessage`.
- `display`: `true` displays in the TUI with distinct styling; `false` hides the message.
- `details`: optional extension metadata, never sent to the LLM.
- `excludeFromContext`: `true` marks a display-only message excluded from model requests.

### Reader-only chat records

Built-in stores save turn-ending diagnostic lines, such as cancelled retry errors, separately from session entries so reopening a session can display them in place. Each saved line is capped at 4,096 UTF-8 bytes and ends with `... [diagnostic truncated]` if trimmed, while the live terminal error stays intact.

These records are not session entries. `/tree`, model requests, compaction, token totals, conversation exports, and continuation logic ignore them. Copying a JSONL file or importing a session does not transfer them, and local libSQL `file:` databases do not store them.

Cache-miss and dropped-thinking notices are derived from saved assistant replies. When a compacted session opens on its active window, Atomic does not reload discarded history to reconstruct earlier notice counts.

### LabelEntry

User-defined bookmark on an entry:

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

Set `label` to `undefined` to clear a bookmark.

### SessionInfoEntry

Session metadata such as the display name set by `/name`, `--name` / `-n`, or `pi.setSessionName()`:

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

The session selector displays `name` instead of the first message when set. Appending a `session_info` entry with an empty `name` clears the display name durably. Use `getSessionNameState()` or the `hasName` flag on `SessionInfo` to distinguish a never-named session (`{ hasName: false }`) from a cleared one (`{ hasName: true }`); `getSessionName()` returns `undefined` in both cases.

### SessionSummaryEntry

Generated one-line session summary written when the agent goes idle and shown in `/resume`. Never sent to the LLM:

```json
{"type":"session_summary","id":"l2m3n4o5","parentId":"k1l2m3n4","timestamp":"2024-12-03T14:36:00.000Z","summary":"Refactored auth module token refresh and added retry tests","summarizedThroughId":"j0k1l2m3","usage":{"input":812,"output":21}}
```

- `summary`: stored one-line text with collapsed whitespace and bounded length.
- `summarizedThroughId`: entry ID of the latest user or assistant message covered by the summary. Tool results do not invalidate it, but any newer user or assistant message or a later `branch_summary` retires it.
- `usage`: optional token usage from the summary request, counted toward session totals.

### WorktreeSnapshotEntry

Repository state of one checkout at the end of a turn that ran a file-writing tool. Never sent to the LLM. See [Worktree snapshots](/worktree-snapshots).

```json
{"type":"worktree_snapshot","id":"m3n4o5p6","parentId":"l2m3n4o5","timestamp":"2024-12-03T14:37:00.000Z","root":"/home/me/project","snapshotId":"3f9a...","snapshot":{"version":1,"id":"3f9a...","root":"/home/me/project","remotes":["https://github.com/me/project.git"],"branch":"main","head":"...","tree":"...","envHash":"...","delta":{"base":"head","patch":"...","bytes":412},"chain":[{"tree":"...","patch":"...","bytes":412}],"bundle":null,"omitted":[],"filters":null,"capturedAt":"2024-12-03T14:37:00.000Z","snapshot":"..."}}
```

- `snapshot`: present when the state changed; an entry without `snapshot` references an earlier entry with the same `snapshotId`.
- `restore`: present when a resume restored the snapshot into a new worktree (`{ from, to, snapshotId, tree, restoredAt }`). Later resumes map `from` to `to`.
- `restore.degraded`: present when a resume restored less than the full snapshot (`{ stage, head, tree, basis?, missingLinks, missingPaths, missingCommits, cause, causeReason?, hint }`). `stage` is `"partial-changes"` or `"closest-commit"`, and `basis` (`"pushed-base"`, `"earlier-snapshot"`, or `"branch-tip"`) identifies the commit source for a closest-commit restore.
- `unrestored`: present instead of `restore` when a resume continued without restoring `root` (`{ snapshotId, continuedIn, place, from?, cause, causeReason?, detail, hint, at }`). `place` is `"recorded"` or `"launch"`. When `from` is set on the active checkout, file tools map paths under `from` to `continuedIn` until a later resume restores the checkout.
- `restoreWarnings`: optional host warnings paired with `restore`, such as `{ code: "lfs-objects-unavailable", paths }` or `{ code: "stale-restore-retained", path, kind }`. Fresh-worktree LFS downloads run after the restore entry is written, so their warnings appear in resume notices instead.
- `captureMs`: capture duration in milliseconds for a turn capture.
- `capturedAt`: recording timestamp when a resume adopts a subagent's newer snapshot for a checkout.
- `blobs`: present only in exported JSONL files, holding base64 patch and bundle payloads keyed by SHA-256. Import verifies and stores them, then drops `blobs`.

## Tree structure

Entries form a tree rooted at the first entry (`parentId: null`). Each subsequent entry points to its parent through `parentId`, branching adds sibling children from an earlier entry, and the leaf marks the active position:

```text
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context building

`buildSessionProjection()` walks the active branch from root to leaf, replays model, thinking-level, and context-window changes, selects the latest `compaction` entry with `details.strategy === "verbatim-lines"`, and applies the latest `context_edit` for each target.

It returns model-visible messages paired with their source entries (`entries[].sourceEntry` and `entries[].messages`). Omitted targets emit no message, content replacements preserve the source entry's role and metadata, and raw entries stay untouched. `buildSessionContext()` returns just the messages, thinking level, and model used for provider requests.

- Without an active boundary, message, custom-message, and branch-summary entries emit verbatim.
- With `firstKeptEntryId: null`, Atomic emits the boundary message and post-boundary messages only.
- With a legacy string `firstKeptEntryId`, Atomic emits one `customType: "compaction"` message combining the boundary text and the kept tail (with context edits applied and retained images kept), followed by post-boundary messages. If that entry ID is missing, Atomic omits pre-boundary entries rather than resurrecting older history.
- With a legacy `coveredThroughEntryId`, entries between that entry and the boundary replay as ordinary messages after the compaction message.
- Retired `context_compaction` entries and non-verbatim `compaction` entries are skipped as archival records.

## Parsing example

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
        console.log(`[${entry.id}] Compaction boundary: ${entry.details.form ?? "compacted"}, ${entry.tokensBefore} tokens before`);
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

Await `create`, `open`, `continueRecent`, `forkFrom`, and every session mutation. A resolved mutation has committed to its store, and a failed write rejects with a typed storage error without publishing the entry. There is no `flush` method.

`inMemory()` selects memory storage explicitly without filesystem I/O. Factories without an explicit store or directory resolve configured storage, defaulting to the shared local SQLite database. Passing a directory selects JSONL explicitly. Store-open failures never fall back to memory.

### Static creation methods

- `SessionManager.create(cwd, sessionDir?, options?)`: create a new session in configured storage, or in JSONL when `sessionDir` is provided.
- `SessionManager.create(store, cwd, options?)`: create a new session in a supplied `SessionStore`.
- `SessionManager.open(store, sessionId, cwdOverride?, options?)`: open an existing session by exact ID, raising `SessionNotFoundError` if missing. Defaults to `{ history: "tail" }`, loading from the latest compaction window; pass `{ history: "full" }` only when every stored entry must stay resident in memory. `openSessionById(id, cwd?, sessionDir?, options?)` and `continueRecent(store, cwd, options?)` share the same window behavior.
- `SessionManager.open(path, sessionDir?, cwdOverride?)`: open a JSONL file directly, creating it if missing. This is a file API rather than the CLI session selector.
- `SessionManager.continueRecent(cwd, sessionDir?, options?)` or `continueRecent(store, cwd, options?)`: continue the most recent regular session or create a new one. Pass `{ includeInternal: true }` to include internal sessions.
- `SessionManager.inMemory(cwd?, options?)`: create an empty memory-only session synchronously. To seed entries, await `SessionManager.inMemory(cwd, options, entries)` without mutating the supplied array until it resolves.
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?, options?)`: fork a JSONL file into the target store. For database sessions, open the session by ID and await `manager.forkTo(targetCwd, targetStore?, options?)`.
- `SessionManager.importFromJsonl(inputPath, cwd, targetStoreOrDir?)`: import a JSONL export preserving its ID and upgrading older supported formats. Raises `SessionExistsError` if the ID already exists, and opens at the current context window.

### Static listing methods

- `SessionManager.list(cwd, storeOrDir?, onProgress?, options?)`: list sessions for one project, excluding internal sessions by default.
- `SessionManager.listAll(storeOrDir?, onProgress?, options?)`: list sessions across all projects in the store. Both methods accept `{ includeInternal: true, signal }`.

Select sessions by `SessionInfo.id`. `SessionInfo.path` holds a JSONL path when available and otherwise the session ID; do not treat it as a filesystem path.

### Session management methods

- `newSession(options?)`: start a new session. `NewSessionOptions` accepts `id`, `parentSession`, and `internal` (`internal: true` hides the session from `/resume`, `atomic -r`, `-c`, and `history://sessions` while keeping it openable by ID).
- `setSessionFile(path)`: switch directly to a JSONL file. For ID-based loading, create a new manager with `SessionManager.open(store, sessionId)`.
- `createBranchedSession(leafId)`: extract a branch into a new session in the same store.
- `forkTo(cwd, targetStoreOrDir?, options?)`: copy the session into a new session at the destination.
- `deleteSession(sessionId)`: delete another session and its entries from the active store. Deleting a missing ID is a no-op. Rejects for the currently open session, and raises `SessionOpenElsewhereError` if another live Atomic session holds it open (tracked by an active heartbeat that expires after 60 seconds on another host). A session deleted while running fails its next save once with `SessionDeletedError`. `SessionStore.delete(sessionId)` is the unguarded store-level operation underneath.

### Appending methods

Every append method returns a promise resolving to the new entry ID:

| Method | Action |
| --- | --- |
| `appendMessage(message)` | Append a message entry |
| `appendThinkingLevelChange(level)` | Record a thinking-level change |
| `appendContextWindowChange(contextWindow)` | Record a context-window selection in tokens |
| `appendModelChange(provider, modelId)` | Record a model change |
| `appendCompaction(compactedText, firstKeptEntryId, tokensBefore, details)` | Append a durable compaction boundary (`null` for `firstKeptEntryId` on current boundaries) |
| `appendCustomEntry(customType, data?)` | Append extension state (excluded from LLM context) |
| `appendSessionInfo(name)` | Set the session display name (empty string clears it) |
| `appendSessionSummary(summary, summarizedThroughId, usage?)` | Store a generated resume-picker summary anchored to a message |
| `appendCustomMessageEntry(customType, content, display, details?)` | Append an extension message |
| `appendLabelChange(targetId, label)` | Set or clear an entry bookmark label |
| `appendContextEdit(targetId, replacement)` | Append a branch-local context edit (`null` omits the target; `{ content }` replaces only its content) |

### Tree navigation methods

| Method | Action |
| --- | --- |
| `getLeafId()` | Return the current leaf entry ID |
| `getLeafEntry()` | Return the current leaf entry |
| `getEntry(id)` | Return a resident entry by ID |
| `getBranch(fromId?)` | Walk from an entry to the root |
| `getTree()` | Return the tree of resident entries in the manager's current window; use `readHistory()` or `loadFullHistory()` for older entries outside the window |
| `getChildren(parentId)` | Return direct resident children of an entry |
| `getLabel(id)` | Return the label for an entry |
| `branch(entryId)` | Move the leaf to an earlier entry in memory only (the session reopens at its last saved entry) |
| `resetLeaf()` | Reset the leaf to `null` in memory only |
| `recordBranch(entryId \| null)` | Move the leaf like `branch()` or `resetLeaf()` and persist the move so the session reopens there |
| `branchWithSummary(entryId, summary, details?, fromHook?)` | Branch with a context summary |

### Context, history, and metadata methods

- `buildSessionProjection(mode?)`: return the context-edited projection (`entries` with source entries and model-visible messages, plus `thinkingLevel` and `model`). Pass `"transcript"` for saved chat rows that keep original displayed content for edited or omitted entries while hiding non-displayed custom messages. For a live session, `session.transcriptMessages` also includes unsaved live messages.
- `buildSessionContext()`: return messages, thinking level, and model for the LLM.
- `buildContextEntries()`: return active-branch entries after the latest compaction boundary.
- `getEntries()`: return raw entries in the manager's current window, excluding the header. System tool-change messages and `pi.appendEntry()` extension entries on the active branch stay resident here; use `readHistory()` or `readEntry(id)` for older retired entries.
- `hasFullHistory()`: return whether every stored entry is resident in memory.
- `loadFullHistory()`: load every stored entry on every branch into memory. Prefer `readHistory()` so large sessions stay bounded; Atomic itself never calls `loadFullHistory()`.
- `readHistory({ fromSeq?, toSeq?, direction?, signal? }?)`: iterate pages of `{ seq, entry }` between inclusive bounds. Use `direction: "backward"` to start from the latest page while keeping entries inside each page in append order. Resume with `{ cursor: page.nextCursor }` without new bounds. Entries over 1 MiB appear as `{ kind: "oversized", seq, bytes }` references instead of truncated objects. Replaced or recreated sessions reject rather than mixing generations.
- `readHistoryChunks(reference, { offset?, signal? }?)`: read an oversized entry's encoded UTF-8 bytes in chunks of at most 64 KiB. Track consumed bytes to resume at an offset and decode with a streaming UTF-8 decoder.
- `readSessionHistory(store, sessionId, options?)` and `readSessionHistoryChunks(store, reference, options?)`: imported from `@bastani/atomic/storage` for read-only paged and chunked access directly from a `SessionStore` without opening a `SessionManager`.
- `readEntry(id)`: read one entry by ID, including entries outside the active window, or return `undefined` if absent.
- `getOmittedHistoryTotals()`: return usage and message counts omitted by a tail window, or `undefined` when full history is held.
- `getLastSeq()`: return the session's last stored sequence number, including entries not held in memory.
- `getEntrySeq(id)` and `findEntrySeq(id)`: return a resident entry's sequence synchronously (`getEntrySeq`) or look up any entry's sequence in the store without loading earlier transcript entries (`findEntrySeq`).
- `forEachStoredEntry(fromSeq, visit)`: visit every stored entry from `fromSeq` in store order, paging older entries without holding them in memory, and resolve to the last visited sequence.
- `getWorktreeSnapshotRecords()` and `getLatestWorktreeSnapshots()`: return held snapshot records (`getWorktreeSnapshotRecords`) or the latest snapshot per checkout root on the active branch (`getLatestWorktreeSnapshots`).
- `loadWorktreeSnapshotRecords(ids, { signal? }?)`: resolve snapshot records by ID across any branch, reading the store for records outside the window and omitting unknown IDs.
- `readWorktreeSnapshotPages({ branch?, direction?, signal? }?)`: iterate `worktree_snapshot` entries in pages of `{ seq, entry }` across all branches or the active branch (`branch: true`) without retaining them in memory.
- `getAdmissionKeys().has(key)`: test synchronously whether an admission key has already been persisted to prevent duplicate admission after resume.
- `getSessionRecoveryState()`: return persisted recovery state (admission keys and delivered Intercom message IDs) used to prevent duplicate deliveries after resume.
- `getHeader()`: return the session header metadata.
- `getSessionName()` and `getSessionNameState()`: return the display name (`undefined` if unset or cleared), or the durable name state (`{ hasName: false }`, `{ hasName: true }`, or `{ hasName: true, name }`).
- `getCwd()`, `getSessionDir()`, `getSessionId()`, `getSessionStore()`, `getSessionFile()`, and `isPersisted()`: inspect the session's working directory, JSONL directory (empty string for non-JSONL stores), exact ID, active `SessionStore`, optional JSONL file path, and whether the store is persisted rather than in-memory.
