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
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: ContextCompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
```

`queue_update` emits the full pending steering and follow-up queues whenever they change. `session_info_changed`, `model_changed`, and `thinking_level_changed` report interactive session metadata changes. `compaction_start` and `compaction_end` cover both manual and automatic Verbatim Compaction, Atomic's deletion-only Context Compaction approach inspired by [Morph's Context Compaction](https://www.morphllm.com/context-compaction).

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
- `BashExecutionMessage` (line 29)
- `CustomMessage` (line 46)
- `BranchSummaryMessage` (line 55)
- `CompactionSummaryMessage` (line 62)

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
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

## Example

```bash
atomic --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
