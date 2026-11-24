---
title: "JSON event stream"
sidebarTitle: "JSON event stream"
description: "Run one or more prompts and parse Atomic session output as newline-delimited JSON events."
---

```bash
atomic --mode json "Your prompt"
```

JSON mode runs one or more positional prompts in sequence (`atomic --mode json "First prompt" "Second prompt"`), writes every session event as a JSON line to stdout, and exits. Use it for scripts, CI pipelines, and batch processors that do not need interactive follow-up commands.

Need to send follow-up commands to a live process or embed Atomic directly in Node.js? Compare JSON mode, [RPC mode](/rpc), and the [TypeScript SDK](/sdk) on [Programmatic integration](/programmatic).

If a saved default `provider/model` names a provider that stays unsupported after startup, JSON mode writes a configuration diagnostic to stderr and exits with code `1` before sending any prompt. Stdout stays empty so downstream parsers never receive non-JSON text. Supported providers with an unknown model or missing credentials still fall back through normal model selection.

## Output format

Each line on stdout is a single JSON object terminated by `\n`. The first line is always the session header (including when `--no-session` is passed, which emits the in-memory session header):

```json
{"type":"session","version":4,"id":"uuid","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/path"}
```

Session events follow as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[]}}
{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"toolResults":[]}
{"type":"agent_end","messages":[]}
```

Unlike RPC mode, JSON mode does not add `entryId` or `seq` fields to `message_end`.

### Streaming `message_update` wire format

On the wire, `message_update` omits large cumulative snapshots to keep streaming lines compact:

- The top-level `message` property is **stripped** on the wire (unlike the in-memory `AgentSessionEvent` delivered to SDK subscribers). Read final message content from `message_end`.
- `assistantMessageEvent.partial` is **stripped**.
- When `assistantMessageEvent.type` is `"toolcall_start"`, Atomic injects `id` and `toolName` directly on `assistantMessageEvent`.
- Top-level `usage` carries the latest cumulative provider-reported token usage (which may stay zero until completion if the provider reports usage only at the end).
- Top-level `endTurn` is included only when the provider reported an explicit end-of-turn signal (`AssistantMessage.endTurn` from `@bastani/atomic-ai`, such as OpenAI Codex `end_turn`).

A non-assistant message on `message_update` is treated as a protocol violation; Atomic throws an error instead of emitting fabricated usage.

## Event types

Events follow the `AgentSessionEvent` union exported from `@bastani/atomic`, with the wire adjustments on `message_update` described above:

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

Base events come from `AgentEvent` in `@bastani/atomic-agent-core`:

```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean; durationMs?: number };
```

Final assistant messages and tool results include optional `durationMs` timing. On `tool_execution_end`, `durationMs` records how long the tool's `execute()` ran using a monotonic clock and is omitted when the tool did not execute.

### Key session events

- `queue_update`: reports the full pending steering and follow-up queues whenever they change.
- `session_info_changed`, `model_changed`, and `thinking_level_changed`: report session metadata updates.
- `compaction_start` and `compaction_end`: bracket manual and automatic compaction. `compaction_end.result.form` is `"cleared"` when the context window was cleared and `"compacted"` when a compactor model or extension replaced it.
- `compaction_usage`: reports compactor model token usage when the request returns, even if the run later fails. Clearing context makes no model call.
- `child_session_usage`: reports one model call made by a child session (such as a subagent or nested subagent).
- `agent_end` and `agent_settled`: `agent_end` finishes one low-level agent loop while retries, compaction recovery, or queued messages may still continue. `agent_settled` fires once no automatic work remains, with `aborted: true` if cancelled.
- `blueprint_build_waiting` and `blueprint_build_finished`: emitted when resuming a session whose worktree blueprint build is running in the background (see [Start the first turn while the build runs](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs)).

```json
{"type":"blueprint_build_waiting","root":"...","message":"Waiting for ..."}
{"type":"blueprint_build_finished","sessionId":"...","roots":["/home/u/.atomic/agent/worktree-snapshots/worktrees/..."],"notices":[{"type":"warning","message":"Partial build: ..."}]}
```

`blueprint_build_waiting` can arrive before the session header when waiting on another process's build of the same worktree. `notices` is empty when the build completes cleanly (in `-p` text mode, those warnings go to stderr as `Warning: ...`).

For automatic compaction, `compaction_end.willRetry: true` indicates Atomic will automatically retry the interrupted turn (such as after context overflow or recoverable output truncation). When a non-retryable request error triggers threshold compaction, `willRetry` is `false`. If overflow recovery is exhausted, `unresolvedOverflow: true` and `errorMessage` are set; check `result` and `errorMessage` independently because both can be present when a compaction boundary was saved before the follow-up request still exceeded the provider's input limit.

Branch summaries use the configured retry policy for transient provider errors and emit `summarization_retry_*` events. Compaction does not retry its compactor call and clears context instead if it fails.

## Message types

Base messages come from `@bastani/atomic-ai`:

- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`

Importing `@bastani/atomic` augments `AgentMessage` with Atomic's extended roles (documented in [RPC protocol types](/rpc/protocol#types)):

- `BashExecutionMessage`
- `CustomMessage`
- `BranchSummaryMessage`

## Exit codes and signals

- **Exit `0`**: all prompts finished without fatal errors. Unlike `-p` text mode, an assistant response ending with `stopReason: "length"` still exits `0` in JSON mode.
- **Exit `1`**: configuration diagnostic for an unsupported provider, extension command failure, session persistence or claim conflict, final assistant `stopReason` of `"error"` or `"aborted"`, or an uncaught error.
- **Signals**: `SIGINT` exits with `130`, `SIGTERM` exits with `143`, and `SIGHUP` exits with `129` (skipped on Windows and when started with `SIGHUP` ignored, such as under `nohup`). A second signal forces immediate exit.
- **Background worktree builds**: JSON mode waits for in-progress blueprint builds to settle before exiting.

## Example

Filter completed messages with `jq`:

```bash
atomic --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
