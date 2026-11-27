---
title: "Parse JSON event streams"
sidebarTitle: "JSON event stream"
description: "Run one or more prompts with atomic --mode json and parse newline-delimited JSON session events in scripts and CI."
---

```bash
atomic --mode json "Your prompt"
```

JSON mode runs one or more positional prompts in sequence (`atomic --mode json "First prompt" "Second prompt"`), writes every session event as one JSON line to stdout, and exits. Use it for shell scripts, CI pipelines, and batch jobs that need structured output without interactive follow-up commands.

Need to send follow-up commands to a live process or embed Atomic in Node.js? Compare Print mode, JSON mode, [RPC mode](/rpc), and the [TypeScript SDK](/sdk) on [Choose an integration mode](/programmatic).

## Input, prompts, and storage isolation

- **Piped stdin and `@file` attachments:** Like [Print mode](/guides/non-interactive), JSON mode accepts piped stdin (`git diff | atomic --mode json "Review this diff"`) and `@file` or image arguments, merging piped stdin ahead of positional prompt text.
- **Extension commands as prompts:** Positional prompts may invoke extension commands (such as `"/mycommand"`). If an extension command queues turns through `atomic.sendMessage()`, JSON mode waits for those queued turns to settle before continuing to the next prompt or exiting.
- **Per-process storage isolation:** Pass `--storage '<json>'`, `--storage-file <path>`, or `--session-store <path>` (with optional `--session-prefix <prefix>`), or set `ATOMIC_STORAGE` or `ATOMIC_SESSIONS_STORAGE` in the environment, to isolate script or CI runs without changing saved settings. See [Selecting storage per process](/storage#selecting-storage-per-process).

<Note>
If a saved default `provider/model` names an unsupported provider or a storage override fails with `StorageConfigError`, JSON mode writes the diagnostic to stderr, leaves stdout completely empty so downstream JSON parsers never see non-JSON text, and exits with code `1`. Supported providers with an unknown model or missing credentials fall back through normal model selection.
</Note>

## Output format

Each line on stdout is one JSON object terminated by `\n`. Atomic emits the session header before session events (including when `--no-session` is passed, which emits the in-memory session header):

```json
{"type":"session","version":4,"id":"uuid","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/path"}
```

When resuming a session whose worktree blueprint build is running in another process, a runner-level `blueprint_build_waiting` event can arrive **before** the session header.

Session events follow as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[]}}
{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"toolResults":[]}
{"type":"agent_end","messages":[]}
{"type":"agent_settled","aborted":false}
```

Unlike RPC mode, JSON mode does not add `entryId` or `seq` fields to `message_end`.

### Streaming `message_update` wire format

On the wire, `message_update` omits cumulative snapshots to keep streaming lines compact:

- The top-level `message` property is **stripped** (unlike the in-memory `AgentSessionEvent` delivered to SDK subscribers). Read the final message from `message_end`.
- `assistantMessageEvent.partial` is **stripped**.
- `parentToolCallId` is **omitted** on `message_update` wire lines (`message_update` carries only `type`, `usage`, `assistantMessageEvent`, and optional `endTurn`).
- When `assistantMessageEvent.type` is `"toolcall_start"`, Atomic injects `id` and `toolName` directly on `assistantMessageEvent`.
- Top-level `usage` carries the latest cumulative provider-reported token usage (which may stay zero until completion if the provider reports usage only at the end).
- Top-level `endTurn` is included only when the provider reported an explicit end-of-turn signal (`AssistantMessage.endTurn`, such as OpenAI Codex `end_turn`).

A non-assistant message on `message_update` is treated as a protocol violation; Atomic throws instead of emitting fabricated usage.

## Event reference

### Session and agent events

| `type` | When emitted | Key JSON fields |
| --- | --- | --- |
| `session` | Once at startup (session header) | `version`, `id`, `createdAt`, `cwd` |
| `agent_start` | An agent attempt begins | `turnStartedAt?`, `parentToolCallId?` |
| `agent_end` | One low-level agent loop finishes (retries or continuations may still follow) | `messages`, `retryPending?`, `parentToolCallId?` |
| `agent_settled` | No automatic retries, compaction continuations, or queued turns remain | `aborted` |
| `turn_start` | One assistant turn begins | `parentToolCallId?` |
| `turn_end` | One assistant turn finishes | `message`, `toolResults`, `parentToolCallId?` |
| `message_start` | A message begins streaming or is recorded | `message`, `parentToolCallId?` |
| `message_update` | Streaming text, thinking, or tool-call delta | `usage`, `assistantMessageEvent`, `endTurn?` |
| `message_end` | A message completes (authoritative final message) | `message`, `parentToolCallId?` |
| `tool_execution_start` | A tool call begins | `toolCallId`, `toolName`, `args`, `parentToolCallId?` |
| `tool_execution_update` | A tool emits accumulated partial output | `toolCallId`, `toolName`, `args`, `partialResult`, `parentToolCallId?` |
| `tool_execution_end` | A tool call finishes | `toolCallId`, `toolName`, `result`, `isError`, `durationMs?`, `parentToolCallId?` |
| `queue_update` | Pending steering or follow-up queues change | `steering`, `followUp` |
| `entry_appended` | A durable session entry is appended | `entry` |
| `session_released` | An idle session is released to storage | `released` |
| `session_storage_reconnect` | An ordered PostgreSQL session save is waiting to reconnect (~10 s, then every 60 s) or recovered after a reported wait | `state` (`"waiting" \| "recovered"`), `elapsedMs`, `reconnecting` |
| `session_info_changed` | Session display name changes | `name` |
| `model_changed` | Active model changes | `model`, `previousModel`, `source` (`"set" \| "cycle" \| "restore" \| "fallback"`) |
| `thinking_level_changed` | Active thinking level changes | `level` |
| `compaction_start` | Manual or automatic compaction starts | `reason` (`"manual" \| "threshold" \| "overflow"`), `midTurn?` |
| `compaction_end` | Compaction completes, fails, or aborts | `reason`, `result`, `aborted`, `willRetry`, `unresolvedOverflow?`, `errorMessage?`, `midTurn?`, `manualTakeoverPending?` |
| `compaction_usage` | Compactor model returns token usage (emitted once per request, even if the run fails) | `reason`, `usage` |
| `child_session_usage` | A child session (such as a subagent) completes one model call | `usage` |
| `agent_continue_error` | Post-compaction continuation failed to start | `source` (`"post_compaction"`), `errorMessage` |
| `auto_retry_start` | Automatic retry scheduled after a transient provider error | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` |
| `auto_retry_end` | Automatic retry loop completes or exhausts retries | `success`, `attempt`, `finalError?` |
| `model_fallback_start` | Automatic fallback to another model is scheduled | `from`, `to`, `fromThinkingLevel?`, `toThinkingLevel?`, `reason`, `attempt` |
| `model_fallback_end` | Model fallback loop succeeds or exhausts fallbacks | `success`, `from?`, `to?`, `finalError?` |
| `summarization_retry_scheduled` | Branch-summary retry scheduled | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` |
| `summarization_retry_attempt_start` | Retried branch-summary request starts | `source` (`"branchSummary"` or `"compaction"` + `reason`) |
| `summarization_retry_finished` | Branch-summary retry loop ends | — |
| `bash_execution_update` | Direct user bash stdout/stderr delta | `id?`, `channel` (`"stdout" \| "stderr"`), `delta` |
| `task_cleanup_quarantined` | Background task cleanup failed and was quarantined | `taskId`, `resources` |
| `worktree_snapshot_unavailable` | A worktree snapshot could not be captured | `reason` |

Final assistant messages and tool results include optional `durationMs` timing. On `tool_execution_end`, `durationMs` measures how long `execute()` ran with a monotonic clock and is omitted when the tool did not execute.

### PostgreSQL storage reconnection (`session_storage_reconnect`)

When session storage is backed by PostgreSQL and a connection drops or refuses writes, Atomic holds the session's ordered write queue until PostgreSQL reconnects. After 10 seconds (and every 60 seconds thereafter), it emits `session_storage_reconnect` with `state: "waiting"`; once saved after a reported wait, it emits `state: "recovered"`:

```json
{"type":"session_storage_reconnect","state":"waiting","elapsedMs":10012,"reconnecting":true}
{"type":"session_storage_reconnect","state":"recovered","elapsedMs":14380,"reconnecting":true}
```

In `--mode json`, Atomic also writes a human-readable `Warning:` or `Info:` line to stderr while keeping stdout strictly JSONL.

### Runner-level blueprint build events

When resuming a session whose worktree blueprint build is running in the background (see [Start the first turn while the build runs](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs)), the CLI runner emits two events outside `AgentSessionEvent`:

```json
{"type":"blueprint_build_waiting","root":"/path/to/worktree","message":"Waiting for ..."}
{"type":"blueprint_build_finished","sessionId":"uuid","roots":["/home/u/.atomic/agent/worktree-snapshots/worktrees/..."],"notices":[{"type":"warning","message":"Partial build: ..."}]}
```

`blueprint_build_waiting` can arrive before the session header when waiting on another process's build of the same worktree. `notices` is empty when the build completes cleanly (in `-p` text mode, those warnings go to stderr as `Warning: ...`).

### Compaction and retry details

- **Automatic compaction:** `compaction_end.result.form` is `"cleared"` when the context window was cleared and `"compacted"` when a compactor model or extension replaced it. `willRetry: true` means Atomic will automatically retry the interrupted turn (for example after context overflow). If overflow recovery is exhausted, `unresolvedOverflow: true` and `errorMessage` are set; check `result` and `errorMessage` independently because both can appear when a boundary saved before the next request still exceeded the provider's input limit.
- **Branch summaries vs. compaction:** Branch summaries use the retry policy and emit `summarization_retry_*` events. Compaction does not retry a failing compactor call; it clears context instead and emits no `compaction_usage` when clearing.
- **`agent_end` vs. `agent_settled`:** `agent_end` finishes one low-level agent loop while automatic retries (`retryPending: true`), compaction recovery, or queued messages may still continue. Wait for `agent_settled` when tracking full turn-chain completion.

<Accordion title="TypeScript AgentSessionEvent union (SDK reference)">
In-memory SDK events follow `AgentSessionEvent` exported from `@bastani/atomic`. On the `--mode json` wire, `message_update` is rewritten to `{ type: "message_update", usage, assistantMessageEvent, endTurn? }` (stripping `message`, `assistantMessageEvent.partial`, and `parentToolCallId`):

```typescript
type AgentSessionEvent =
  | ((
      | Exclude<AgentEvent, { type: "agent_start" | "agent_end" }>
      | (Extract<AgentEvent, { type: "agent_start" }> & { turnStartedAt?: number })
      | (Extract<AgentEvent, { type: "agent_end" }> & { retryPending?: true })
    ) & { parentToolCallId?: string })
  | { type: "agent_settled"; aborted: boolean }
  | { type: "session_released"; released: ReleasedAgentSession }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "session_storage_reconnect"; state: "waiting" | "recovered"; elapsedMs: number; reconnecting: boolean }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow"; midTurn?: boolean }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "model_changed"; model: Model<Api>; previousModel: Model<Api> | undefined; source: "set" | "cycle" | "restore" | "fallback" }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: VerbatimCompactionResult | undefined; aborted: boolean; willRetry: boolean; unresolvedOverflow?: boolean; errorMessage?: string; midTurn?: boolean; manualTakeoverPending?: boolean }
  | { type: "compaction_usage"; reason: "manual" | "threshold" | "overflow"; usage: Usage }
  | { type: "child_session_usage"; usage: Usage }
  | { type: "agent_continue_error"; source: "post_compaction"; errorMessage: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "summarization_retry_attempt_start"; source: "branchSummary" }
  | { type: "summarization_retry_attempt_start"; source: "compaction"; reason: "manual" | "threshold" | "overflow" }
  | { type: "summarization_retry_finished" }
  | { type: "bash_execution_update"; id?: string; channel: "stdout" | "stderr"; delta: string }
  | { type: "model_fallback_start"; from: string; to: string; fromThinkingLevel?: ThinkingLevel; toThinkingLevel?: ThinkingLevel; reason: string; attempt: number }
  | { type: "model_fallback_end"; success: boolean; from?: string; to?: string; finalError?: string }
  | { type: "task_cleanup_quarantined"; taskId: TaskId; resources: readonly ResourceFailure[] }
  | { type: "worktree_snapshot_unavailable"; reason: SerializedWorkspaceError };
```
</Accordion>

## Message types

Base messages come from `@bastani/atomic-ai`: `UserMessage`, `AssistantMessage`, and `ToolResultMessage`.

Atomic extends `AgentMessage` with three additional roles (documented with full JSON shapes in [RPC protocol types](/rpc/protocol#types) and [Session format](/session-format)):

- `BashExecutionMessage` (`role: "bashExecution"`)
- `CustomMessage` (`role: "custom"`)
- `BranchSummaryMessage` (`role: "branchSummary"`)

## Exit codes and signals

| Exit code | Meaning |
| --- | --- |
| `0` | All prompts finished without fatal errors. Unlike `-p` text mode, an assistant response ending with `stopReason: "length"`, a lost queued extension-command answer, or an error in a non-command extension hook (written to stderr) still exits `0`. |
| `1` | Unsupported configured provider, invalid storage selection (`StorageConfigError`), extension command error, session save (`message_end`) failure or writer conflict, final assistant `stopReason` of `"error"` or `"aborted"`, or an uncaught error. |
| `75` | Target `--session` is already open in another live Atomic process. |
| `129` | Stopped by `SIGHUP` (skipped on Windows and when inherited as `SIG_IGN`, such as under `nohup`). |
| `130` | Stopped by `SIGINT`. |
| `143` | Stopped by `SIGTERM`. |

A second termination signal forces immediate exit. JSON mode waits for in-progress background worktree blueprint builds to settle before exiting.

## Filtering examples

Extract final assistant text with `jq`:

```bash
atomic --mode json "List the packages in this repo" 2>/dev/null \
  | jq -r 'select(.type == "message_end" and .message.role == "assistant") | .message.content[] | select(.type == "text") | .text'
```

Stream text deltas live as they arrive:

```bash
atomic --mode json "Explain this error" 2>/dev/null \
  | jq -r --unbuffered 'select(.type == "message_update" and .assistantMessageEvent.type == "text_delta") | .assistantMessageEvent.delta'
```
