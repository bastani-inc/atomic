---
title: "JSON event stream"
description: "Run one prompt and parse Atomic's output as newline-delimited events."
---

# JSON Event Stream Mode

```bash
atomic --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating Atomic into other tools or custom UIs.

If a complete saved provider/model default names a provider that remains unsupported after provider registration, JSON mode writes the generic configuration diagnostic to stderr and exits nonzero before sending the prompt. It writes no human diagnostic to stdout, so any stdout records remain valid JSONL. This differs from ordinary supported-provider model or authentication fallback, which retains normal automatic model selection.

## Choosing an integration mode

JSON mode is one of three ways to drive Atomic from your own software. Pick the smallest one that does the job.

| You want | Use | Why |
| --- | --- | --- |
| One prompt, structured output, then exit | **JSON event stream mode** (this page) | One process, one prompt, newline-delimited events on stdout. Nothing to keep alive. |
| A long-lived process you send more input to | [RPC mode](/rpc) | Send further prompts, interrupt, switch models, and answer tool permission prompts on a live process. |
| Atomic embedded inside a Node.js application | [SDK](/sdk) | The same engine as a library, with programmatic control over extensions, skills, tools, and session storage. |

If you need the event contract rather than a walkthrough, go to the [RPC protocol](/rpc/protocol) or the [SDK API reference](/sdk/reference). [Programmatic use](/programmatic) compares all three modes side by side.

## Event Types

Events are defined in [`AgentSessionEvent`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/agent-session.ts#L152):

```typescript
type AgentSessionEvent =
  | AgentEvent
  | { type: "agent_settled"; aborted: boolean }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "model_changed"; model: Model<Api>; previousModel: Model<Api> | undefined; source: "set" | "cycle" | "restore" }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: VerbatimCompactionResult | undefined; aborted: boolean; willRetry: boolean; unresolvedOverflow?: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "summarization_retry_attempt_start"; source: "branchSummary" }
  | { type: "summarization_retry_attempt_start"; source: "compaction"; reason: "manual" | "threshold" | "overflow" }
  | { type: "summarization_retry_finished" };
```

`queue_update` emits the full pending steering and follow-up queues whenever they change. `session_info_changed`, `model_changed`, and `thinking_level_changed` report interactive session metadata changes. `compaction_start` and `compaction_end` cover manual and automatic verbatim line compaction: the model emits deleted ranges and Atomic mechanically reconstructs retained text.

`agent_end` closes one low-level agent run; retries, compaction recovery, or queued work may still continue. `agent_settled` means no automatic work remains for the session-level run. Its `aborted` field is `true` when the run was cancelled.

For automatic compaction, `compaction_end.willRetry === true` means the interrupted turn will retry; `AgentSession.prompt()` waits for that continuation. This includes overflow and retry-worthy threshold recovery, such as output-token truncation or OpenAI Responses output-budget underflow. Generic `invalid_request_body` failures still use `willRetry: false` when threshold compaction is warranted.

If same-model compact-and-retry recovery is exhausted, `unresolvedOverflow: true` and `errorMessage` let integrations choose another model rather than treating the prompt as successful.

Check `result` and `errorMessage` independently. Both can be present when the boundary was saved but the follow-up request exceeded the provider's hard input limit.

Compaction planning and branch summaries reuse the configured retry policy for transient provider failures. Their `summarization_retry_*` events expose scheduling, each restarted request (including whether it belongs to branch summarization or a compaction reason), and retry-loop completion to JSON, RPC, SDK, and interactive consumers.

Base events come from `AgentEvent` in `@earendil-works/pi-agent-core` (installed as an Atomic dependency):

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
  | { type: "message_update"; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean; durationMs?: number };
```

Final assistant and tool-result messages include optional `durationMs` timing. On `tool_execution_end`, it records how long the tool's `execute()` took using a monotonic clock; it is absent when the tool did not run.

On the wire, each `message_update` record carries:

- The streaming delta in `assistantMessageEvent`, with its cumulative `partial` field stripped.
- The latest cumulative provider-reported `usage`. This may remain zero until completion if the provider reports usage only at the end.
- `endTurn`, only when the provider reported it. This is the provider's explicit end-of-turn signal, pi-ai's `AssistantMessage.endTurn`, for example OpenAI Codex `end_turn`.

A non-assistant message on this event is a protocol violation. Atomic throws rather than emitting invented zeroed usage.

## Message Types

Base messages come from `@bastani/pi-ai` (installed as an Atomic dependency):
- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`

Extended messages from [`packages/coding-agent/src/core/messages.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/messages.ts#L29):
- `BashExecutionMessage`
- `CustomMessage`
- `BranchSummaryMessage`

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
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
