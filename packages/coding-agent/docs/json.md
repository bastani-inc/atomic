---
title: "JSON event stream"
description: "Run one prompt and parse Atomic's output as newline-delimited events."
---

# JSON event stream mode

```bash
atomic --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Use this mode to integrate Atomic into scripts, pipelines, or custom UIs.

If a complete saved provider/model default names a provider that remains unsupported after provider registration, JSON mode writes a configuration diagnostic to stderr and exits nonzero before sending the prompt. It writes no diagnostic text to stdout, so stdout remains valid JSONL. Supported-provider model or authentication fallback still uses automatic model selection.

## Choosing an integration mode

JSON mode is one of three ways to drive Atomic from your software. Pick the smallest one that fits.

| You want | Use | Why |
| --- | --- | --- |
| One prompt, structured output, then exit | **JSON event stream mode** (this page) | One process, one prompt, newline-delimited events on stdout. Nothing to keep alive. |
| A long-lived process you send more input to | [RPC mode](/rpc) | Send further prompts, interrupt, switch models, and answer extension UI dialogs and OAuth prompts on a live process. |
| Atomic embedded inside a Node.js application | [SDK](/sdk) | The same engine as a library, with programmatic control over extensions, skills, tools, and session storage. |

If you need the full protocol contract rather than an overview, read the [RPC protocol](/rpc/protocol) or the [SDK API reference](/sdk/reference). [Programmatic use](/programmatic) compares all three modes side by side.

## Event types

Events follow the `AgentSessionEvent` type exported from `@bastani/atomic`:

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

A resumed session whose blueprint build runs behind its first turn (see [Start the first turn while the build runs](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs)) also gets one line when that build ends:

```json
{"type": "blueprint_build_finished", "sessionId": "...", "roots": ["/home/u/.atomic/agent/worktree-snapshots/worktrees/..."], "notices": [{"type": "warning", "message": "Partial build: ..."}]}
```

While a resume waits for another Atomic process's build of the same worktree, Atomic emits `{"type": "blueprint_build_waiting", "root": "...", "message": "Waiting for ..."}` once. This line can arrive before the session header. `notices` holds the warnings that a waiting resume prints, and is empty when the build finished cleanly. In text mode (`-p`), the same warnings go to stderr as `Warning: ...` lines.

### Key session events

- `queue_update`: emits the full pending steering and follow-up queues whenever they change.
- `session_info_changed`, `model_changed`, and `thinking_level_changed`: report session metadata changes.
- `compaction_start` and `compaction_end`: cover manual and automatic compaction. `compaction_end.result.form` is `cleared` when the context window was cleared and `compacted` when a compactor model or an extension replaced it.
- `compaction_usage`: reports the usage of the compactor model's request when it returns, including for a run that later fails. A clear makes no model call.
- `child_session_usage`: reports one model call of a child session created by this session, such as a subagent, or of that child's own children.
- `agent_end` and `agent_settled`: `agent_end` closes one low-level agent run while retries, compaction recovery, or queued work may still continue. `agent_settled` means no automatic work remains for the session-level run, and `aborted` is `true` when the run was cancelled.

For automatic compaction, `compaction_end.willRetry === true` means the interrupted turn will retry, and `AgentSession.prompt()` waits for that continuation. This includes overflow and retry-worthy threshold recovery, such as output-token truncation or OpenAI Responses output-budget underflow. Generic `invalid_request_body` failures use `willRetry: false` when threshold compaction is warranted.

If the compact-and-retry attempt for an overflow is exhausted, `unresolvedOverflow: true` and `errorMessage` let integrations choose another model instead of treating the prompt as successful. Check `result` and `errorMessage` independently: both can be present when the boundary was saved but the follow-up request exceeded the provider's hard input limit.

Branch summaries reuse the configured retry policy for transient provider failures. Their `summarization_retry_*` events report scheduling, each restarted request, and retry-loop completion to JSON, RPC, SDK, and interactive consumers. Compaction does not retry its compactor request; a failure clears the context instead.

Base events come from `AgentEvent` in `@bastani/atomic-agent-core` (installed as an Atomic dependency):

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean; durationMs?: number };
```

Final assistant and tool-result messages include optional `durationMs` timing. On `tool_execution_end`, `durationMs` records how long the tool's `execute()` took using a monotonic clock, and is absent when the tool did not run.

On the wire, each `message_update` record carries:

- The streaming delta in `assistantMessageEvent`, with its cumulative `partial` field stripped.
- The latest cumulative provider-reported `usage`. This may remain zero until completion if the provider reports usage only at the end.
- `endTurn`, only when the provider reported it. This is the provider's explicit end-of-turn signal (`AssistantMessage.endTurn` from `@bastani/atomic-ai`), for example OpenAI Codex `end_turn`.

A non-assistant message on `message_update` is a protocol violation. Atomic throws rather than emitting invented zeroed usage.

## Message types

Base messages come from `@bastani/atomic-ai` (installed as an Atomic dependency):
- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`

Importing `@bastani/atomic` augments `AgentMessage` from `@bastani/atomic-agent-core` with Atomic's extended message roles (documented in [RPC protocol types](/rpc/protocol#types)):
- `BashExecutionMessage`
- `CustomMessage`
- `BranchSummaryMessage`

## Output format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":4,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

## Example

```bash
atomic --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
