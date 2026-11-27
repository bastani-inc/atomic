---
title: "@bastani/atomic-agent-core"
sidebarTitle: "@bastani/atomic-agent-core"
description: "Stateful agent loop with tool execution, event streaming, steering, follow-up messages, and proxy streaming."
---

Stateful agent loop with tool execution and event streaming, built on [`@bastani/atomic-ai`](/libraries/ai) (requires Node.js 24.20+). Atomic's sessions run on this loop, and you can use it directly to build custom agents. Atomic's [TypeScript SDK](/sdk) wraps it with sessions, tools, extensions, and compaction, so prefer the SDK when you want Atomic's built-in behavior. See [Standalone libraries](/libraries) for all standalone packages.

## Installation

```bash
npm install @bastani/atomic-agent-core @bastani/atomic-ai
```

## Quick start

Export `ANTHROPIC_API_KEY` before running this example:

```typescript
import { Agent } from "@bastani/atomic-agent-core";
import { createModels } from "@bastani/atomic-ai";
import { anthropicProvider } from "@bastani/atomic-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Model not found");

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model,
  },
  streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Hello!");
```

## Core concepts

### AgentMessage vs LLM Message

The agent works with `AgentMessage`, which includes standard LLM messages (`system`, `user`, `assistant`, and `toolResult`) plus any custom app-specific message types added through declaration merging. Because LLMs accept only standard message roles, `convertToLlm` filters or transforms custom types before each request:

```text
AgentMessage[] -> transformContext() -> AgentMessage[] -> convertToLlm() -> Message[] -> LLM
                    (optional)                           (required)
```

1. **`transformContext`:** Prune old messages or inject external context.
2. **`convertToLlm`:** Filter out UI-only messages and convert custom types to LLM messages.

## Event flow

### `prompt()` event sequence

```text
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // Your prompt
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM starts responding
├─ message_update  { message: partial... }       // Streaming chunks
├─ message_end     { message: assistantMessage } // Complete response
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

### With tool calls

If the assistant calls tools, the loop executes them and starts another turn:

```text
prompt("Read config.json")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // If tool streams
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // Next turn
├─ message_start      { assistantMessage }           // LLM responds to tool result
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```

Tool execution mode is configurable globally via `toolExecution` in `AgentOptions` or per tool via `executionMode` on `AgentTool`:

- **`parallel` (default):** Preflights tool calls sequentially, runs allowed tools concurrently, emits `tool_execution_end` in completion order, then emits `toolResult` messages and `turn_end.toolResults` in assistant source order.
- **`sequential`:** Runs tool calls one at a time in assistant source order. If any call in a batch targets a tool with `executionMode: "sequential"`, the entire batch runs sequentially.

`beforeToolCall` runs after `tool_execution_start` and argument validation (and after assistant `message_end` processing settles on `Agent`, so agent state already contains the assistant message). It can block execution and attach `terminate: true`. `afterToolCall` runs after execution finishes and before `tool_execution_end` and final tool-result events.

**`afterToolCall` merge rules:** Overrides merge field-by-field (`content`, `details`, `structuredContent`, `isError`, `usage`, `terminate`) with no deep merge. Returning `content` **without** `structuredContent` drops the original `structuredContent` so the two cannot go out of sync; pass `structuredContent` alongside `content` to preserve it.

Tools, blocked `beforeToolCall` results, and `afterToolCall` overrides can return `terminate: true` to skip the automatic follow-up LLM call—taking effect only when every finalized tool result in that batch sets `terminate: true`.

### Turn lifecycle hooks

Each provider turn follows this exact sequence:

```text
selected input events
-> prepareRequest          (before every request, including turn 1)
-> provider response
-> tool results
-> finishTurn              (before turn_end; decides continue / end / default)
-> turn_end
-> continuation check
-> prepareNextTurn / prepareNextTurnWithContext (only when starting another turn)
-> next turn OR agent_end
```

| Hook | When it runs | Return shape | Use it for |
| --- | --- | --- | --- |
| `prepareRequest` | Immediately before **every** conversational provider request (including the first), after pending messages are emitted; does not poll queues. | `AgentRequestUpdate` (`{ context?, model?, thinkingLevel? }`) or `undefined` | Installing canonical persisted context, model, or thinking level for the request. |
| `finishTurn` | After the assistant message and all tool results finalize, before `turn_end` (runs on normal, error, and aborted responses). | `{ action: "continue" } \| { action: "end" } \| undefined` | Stopping a run immediately after `turn_end` without polling queues (`"end"`), or forcing one more request on a normal response (`"continue"`). |
| `prepareNextTurn` / `prepareNextTurnWithContext` | After `turn_end` only when the loop will continue to another turn, immediately before the next turn starts. | `AgentLoopTurnUpdate` (`{ context?, messages?, model?, thinkingLevel? }`) or `undefined` | Swapping context, model, thinking level, or appending lifecycle-emitted `messages` between turns (for example, post-turn compaction or dynamic tool/model transitions). |

```typescript
// Install canonical context right before every request
agent.prepareRequest = async ({ context }) => ({
  context: { ...context, messages: await session.loadModelContext() },
});

// Decide whether to stop or force continuation before turn_end
agent.finishTurn = async ({ message }) => {
  if (message.stopReason === "error" || message.stopReason === "aborted") return;
  if (shouldEndRun(message)) return { action: "end" };
  return needsAnotherResponse(message) ? { action: "continue" } : undefined;
};

// Update state or append messages between turns when another turn is scheduled
agent.prepareNextTurnWithContext = async (turn, signal) => {
  // turn: { message, toolResults, context, newMessages }
  const updated = await maybeCompactBetweenTurns(turn.context, signal);
  return updated ? { context: updated } : undefined;
};
```

On `Agent`, `prepareNextTurnWithContext(context, signal)` receives the completed turn's `PrepareNextTurnContext` (`{ message, toolResults, context, newMessages }`) and takes precedence over `prepareNextTurn(signal)` if both are set. On the low-level `agentLoop()` `AgentLoopConfig`, `prepareNextTurn(context)` always receives `PrepareNextTurnContext`.

On `finishTurn`, returning `{ action: "continue" }` on a normal response guarantees one more provider request (satisfied by tool results, steering, or follow-up scheduling when present, or a context-only request otherwise). Error and aborted responses remain hard exits whose `finishTurn` decisions are ignored. Do not return `{ action: "continue" }` unconditionally or the loop will run forever.

<Note>
**Migrating from `shouldStopAfterTurn`:** Replace the removed `shouldStopAfterTurn` hook with `finishTurn`, guarding `error`/`aborted` responses and returning `{ action: "end" }` when you want the run to stop after `turn_end`.
</Note>

### `continue()` and queued input

Empty and system-only transcripts reject `continue()` without consuming queues. A non-assistant tail continues from existing context (steering is polled at startup; follow-up input waits until the response stops naturally).

An assistant tail cannot be sent directly, so `continue()` falls back to one queued steering batch, or else one queued follow-up batch (respecting queue mode):

```typescript
agent.steer({ role: "user", content: "Continue from here", timestamp: Date.now() });
await agent.continue(); // Consumes the queued message because the tail is an assistant message
```

### Event types

| Event | Description |
| --- | --- |
| `agent_start` | Agent begins processing |
| `agent_end` | Final event for the run; awaited subscribers for this event still count toward settlement |
| `turn_start` | New turn begins (one LLM call + tool executions) |
| `turn_end` | Turn completes with assistant message and tool results |
| `message_start` | Any message begins (`user`, `assistant`, `toolResult`) |
| `message_update` | **Assistant only.** Includes `assistantMessageEvent` with streaming delta |
| `message_end` | Message completes |
| `tool_execution_start` | Tool begins |
| `tool_execution_update` | Tool streams progress |
| `tool_execution_end` | Tool completes |

`Agent.subscribe()` listeners receive `(event, signal)` and are awaited in registration order. Thrown or rejected listener errors propagate to the caller awaiting `prompt()` or `continue()`. `await agent.waitForIdle()` and `await agent.prompt(...)` settle only after awaited `agent_end` listeners finish.

## Agent options

```typescript
const agent = new Agent({
  // Initial state: systemPrompt and tools seed the leading system message
  // unless messages already starts with one.
  initialState: {
    systemPrompt: string,
    model: Model<any>,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // Convert AgentMessage[] to LLM Message[] (required for custom message types; must not throw)
  convertToLlm: (messages) => messages.filter(...),

  // Transform context before convertToLlm (for pruning or compaction)
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // Queue drain modes: "one-at-a-time" (default) or "all"
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",

  // Required stream function receiving a TranscriptContext
  streamFn: models.streamSimple.bind(models),

  // Session ID for provider caching
  sessionId: "session-123",

  // Client identity (merged over DEFAULT_AGENT_IDENTITY; pass { attribution: null } to omit attribution)
  identity: { attribution: { name: "my-app", url: "https://my-app.example" } },

  // Dynamic API key resolution (for expiring OAuth tokens)
  getApiKey: async (provider) => refreshToken(),

  // Transport, retry cap, and request/response inspection hooks
  transport: "sse",
  maxRetryDelayMs: 60_000,
  onPayload: (payload, model) => payload,
  onResponse: (response) => {},
  onProviderStreamEvent: (event) => {},

  // Tool execution mode ("parallel" default, or "sequential") and unknown-tool text
  toolExecution: "parallel",
  unknownToolMessage: (toolName) => `Tool "${toolName}" is not available.`,

  // Tool preflight and postprocessing hooks
  beforeToolCall: async ({ toolCall }) => {
    if (toolCall.name === "bash") return { block: true, reason: "bash is disabled", terminate: true };
  },
  afterToolCall: async ({ toolCall, result, isError }) => {
    if (toolCall.name === "notify_done" && !isError) return { terminate: true };
    if (!isError) return { details: { ...result.details, audited: true } };
  },

  // Turn lifecycle hooks (see "Turn lifecycle hooks" above)
  prepareRequest: async ({ context }, signal) => ({
    context: { ...context, messages: await loadCanonicalMessages(signal) },
  }),
  prepareNextTurn: async (signal) => undefined,
  prepareNextTurnWithContext: async (turn, signal) => undefined,
  finishTurn: async ({ message, toolResults }, signal) =>
    shouldContinue(message, toolResults) ? { action: "continue" } : undefined,

  // Custom thinking budgets for token-based providers
  thinkingBudgets: { minimal: 128, low: 512, medium: 1024, high: 2048 },
});
```

<Note>
**No-throw contracts (`StreamFn` and `convertToLlm`):**
- **`StreamFn`** must never throw or reject for request, model, or runtime failures. Always return an `AssistantMessageEventStream` and report failures via stream `error` events and a final `AssistantMessage` with `stopReason: "error"` or `"aborted"` and `errorMessage`.
- **`convertToLlm`** must never throw or reject; filter or normalize custom messages deterministically.
- **`setDefaultStreamFn(streamFn | undefined)`** sets a process-wide fallback `StreamFn` when callers omit `streamFn`.
</Note>

## Agent state

```typescript
interface AgentState {
  readonly systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

Assigning `agent.state.tools = [...]` or `agent.state.messages = [...]` copies the top-level array before storing it, while mutating the returned array mutates current state. `agent.state.isStreaming` stays `true` until awaited `agent_end` subscribers finish.

The transcript owns the system prompt and tool declarations: `agent.state.systemPrompt` is read-only and replays the transcript's system messages (see `SystemMessage` in [`@bastani/atomic-ai`](/libraries/ai)). Before each request, the loop diffs `agent.state.tools` against declared tools in the transcript and appends a system-message update when they change. To update the prompt mid-conversation, append a system message:

```typescript
await agent.prompt([
  { role: "system", content: "", sections: { skills: "<skills>...</skills>" }, timestamp: Date.now() },
  { role: "user", content: "Continue", timestamp: Date.now() },
]);
```

## Methods

```typescript
// Prompting and continuation
await agent.prompt("Hello");
await agent.prompt("Describe this", [{ type: "image", data: base64Data, mimeType: "image/jpeg" }]);
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });
await agent.continue();

// State and configuration
const nextModel = models.getModel("openai", "gpt-4o");
if (nextModel) agent.state.model = nextModel;
agent.state.thinkingLevel = "medium";
agent.state.tools = [myTool];
agent.sessionId = "session-123";
agent.thinkingBudgets = { minimal: 128, low: 512, medium: 1024, high: 2048 };
const queued = agent.peekQueuedMessages(); // inspects next batch without consuming
agent.reset();

// Lifecycle control and events
agent.abort();
await agent.waitForIdle();
const unsubscribe = agent.subscribe(async (event, signal) => {
  if (event.type === "agent_end") await flushSessionState(signal);
});
unsubscribe();
```

## Steering and follow-up

Steering messages interrupt the agent after the current turn's tool batch completes; follow-up messages run only after no tool calls or steering messages remain:

```typescript
agent.steeringMode = "one-at-a-time"; // or "all"
agent.followUpMode = "one-at-a-time"; // or "all"

agent.steer({ role: "user", content: "Stop! Do this instead.", timestamp: Date.now() });
agent.followUp({ role: "user", content: "Also summarize the result.", timestamp: Date.now() });

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

## Custom message types

Extend `AgentMessage` with declaration merging and handle your custom roles inside `convertToLlm`:

```typescript
declare module "@bastani/atomic-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}

const agent = new Agent({
  streamFn: models.streamSimple.bind(models),
  convertToLlm: (messages) => messages.flatMap((m) => (m.role === "notification" ? [] : [m])),
});
```

## Tools

Define tools with `AgentTool` using any JSON Schema (using `@bastani/atomic-schema` builders types `params` automatically):

```typescript
import { obj, str } from "@bastani/atomic-schema";

const readFileParameters = obj({ path: str({ description: "File path" }) });

const readFileTool: AgentTool<typeof readFileParameters> = {
  name: "read_file",
  label: "Read File",
  description: "Read a file's contents",
  parameters: readFileParameters,
  outputSchema: obj({ path: str(), content: str() }), // optional structuredContent schema
  executionMode: "sequential", // optional override ("sequential" forces the batch sequential)
  execute: async (_toolCallId, params, _signal, onUpdate) => {
    const content = await fs.readFile(params.path, "utf-8");
    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });
    return {
      content: [{ type: "text", text: content }],
      structuredContent: { path: params.path, content },
      details: { path: params.path, size: content.length },
    };
  },
};

agent.state.tools = [readFileTool];
```

### Error handling

Throw an error or return `{ content, details, structuredContent?, isError: true }` when a tool fails (do not only describe the failure in text). Returning `isError: true` preserves `details` and `structuredContent` for UI and programmatic callers.

### MCP, Codemode, and `runToolCall()`

When embedding [`@bastani/atomic-codemode`](/libraries/codemode) or MCP wrappers, invoke nested tools through `runToolCall()` so argument validation, `beforeToolCall`, and `afterToolCall` run consistently:

```typescript
import { type AgentToolCallOutcome, runToolCall } from "@bastani/atomic-agent-core";

const outcome: AgentToolCallOutcome = await runToolCall(toolCall, {
  tools,
  assistantMessage,
  context,
  beforeToolCall: agent.beforeToolCall,
  afterToolCall: agent.afterToolCall,
  signal,
});
// outcome: { result: AgentToolResult<unknown>, isError: boolean, durationMs?: number }
```

See [Using with agent-core](/libraries/codemode#using-with-agent-core) for a full example.

## Proxy usage

For browser apps that route LLM requests through a backend server without exposing provider API keys, pass `streamProxy()` as `streamFn`:

```typescript
import { Agent, streamProxy } from "@bastani/atomic-agent-core";

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server.com",
    }),
});
```

### Proxy server HTTP and SSE contract

Your backend must expose `POST <proxyUrl>/api/stream`:

- **Request headers:** `Authorization: Bearer <authToken>` and `Content-Type: application/json`.
- **Request JSON body:** `{ model, context, options }`, where `model` is the serialized `Model`, `context` is the `TranscriptContext`, and `options` contains the serializable `SimpleStreamOptions` fields (`temperature`, `samplingParams`, `maxTokens`, `reasoning`, `cacheRetention`, `sessionId`, `disableContinuation`, `headers`, `metadata`, `transport`, `thinkingBudgets`, `maxRetryDelayMs`).
- **Error responses:** On non-2xx HTTP responses, `streamProxy()` reads `{ "error": "..." }` from a JSON response body when present (otherwise using the HTTP status text) and surfaces a stream `error` event.
- **Streaming response (SSE):** Return newline-delimited `data: <JSON>` lines where each payload is a `ProxyAssistantMessageEvent` (the same event vocabulary as `AssistantMessageEvent`, with `partial` omitted to reduce bandwidth—`streamProxy()` reconstructs `partial` client-side):

| `type` | Required fields | Optional fields |
| --- | --- | --- |
| `start` | — | — |
| `text_start` / `thinking_start` | `contentIndex` | — |
| `text_delta` / `thinking_delta` | `contentIndex`, `delta` | — |
| `text_end` / `thinking_end` | `contentIndex` | `contentSignature` |
| `toolcall_start` | `contentIndex`, `id`, `toolName` | — |
| `toolcall_delta` | `contentIndex`, `delta` | — |
| `toolcall_end` | `contentIndex`, `toolCall` | — |
| `done` | `reason` (`"stop"` \| `"length"` \| `"toolUse"`), `usage` | `providerThinkingLevel` |
| `error` | `reason` (`"aborted"` \| `"error"`), `usage` | `errorMessage`, `providerThinkingLevel` |

If the server closes the HTTP stream cleanly without sending a terminal `done` or `error` event, `streamProxy()` synthesizes an `error` event (`"Connection closed by proxy server before the response completed"`) instead of hanging.

## Low-level API

Use `agentLoop()` and `agentLoopContinue()` directly when you do not want the stateful `Agent` wrapper:

```typescript
import {
  type AgentContext,
  type AgentLoopConfig,
  agentLoop,
  agentLoopContinue,
} from "@bastani/atomic-agent-core";
import { createModels } from "@bastani/atomic-ai";
import { openaiProvider } from "@bastani/atomic-ai/providers/openai";

const models = createModels();
models.setProvider(openaiProvider());
const model = models.getModel("openai", "gpt-4o");
if (!model) throw new Error("Model not found");

const context: AgentContext = {
  messages: [{ role: "system", content: "You are helpful.", timestamp: Date.now() }],
  tools: [],
};

const config: AgentLoopConfig = {
  model,
  convertToLlm: (msgs) =>
    msgs.filter((m) => ["system", "user", "assistant", "toolResult"].includes(m.role)),
  toolExecution: "parallel",
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };
const streamFn = models.streamSimple.bind(models);

for await (const event of agentLoop([userMessage], context, config, undefined, streamFn)) {
  console.log(event.type);
}

for await (const event of agentLoopContinue(context, config, undefined, streamFn)) {
  console.log(event.type);
}
```

Low-level streams are observational: they preserve event order without waiting for async consumer work before later producer phases continue. Use the `Agent` class when async event handling must act as a barrier before tool preflight or completion.
