# JSON Event Stream Mode

```bash
atomic --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating Atomic into other tools or custom UIs.

## Event Types

Events are defined in [`AgentSessionEvent`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/agent-session.ts#L152):

```typescript
type AgentSessionEvent =
  | AgentEvent
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "model_changed"; model: Model<Api>; previousModel: Model<Api> | undefined; source: "set" | "cycle" | "restore" }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "context_window_changed"; contextWindow: number }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: VerbatimCompactionResult | undefined; aborted: boolean; willRetry: boolean; unresolvedOverflow?: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
```

`queue_update` emits the full pending steering and follow-up queues whenever they change. `session_info_changed`, `model_changed`, `thinking_level_changed`, and `context_window_changed` report interactive session metadata changes. `context_window_changed` carries the active token budget after `AgentSession.setContextWindow()` or branch navigation replay applies a branch-scoped `context_window_change`; branch replay does not add another session journal entry or write settings. `compaction_start` and `compaction_end` cover manual and automatic verbatim line compaction: the model emits deleted ranges and Atomic mechanically reconstructs retained text.

For automatic compaction, `compaction_end.willRetry === true` means the agent is retrying the interrupted turn after compaction; `AgentSession.prompt()` waits for that continuation before resolving. This includes overflow recovery and live threshold compaction for retry-worthy interrupted work such as output-token truncation or OpenAI Responses output-budget underflow errors. Generic provider `invalid_request_body` failures still compact with `willRetry: false` when threshold compaction is warranted. If the same-model compact-and-retry overflow path is exhausted, `compaction_end` includes `unresolvedOverflow: true` plus an `errorMessage` so orchestration layers can fallback to another model instead of treating the prompt as successful.

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
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

## Message Types

Base messages come from `@earendil-works/pi-ai` (installed as an Atomic dependency):
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
{"type":"context_window_changed","contextWindow":1000000}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

## Example

```bash
atomic --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
