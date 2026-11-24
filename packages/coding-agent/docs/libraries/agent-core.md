---
title: "@bastani/atomic-agent-core"
sidebarTitle: "@bastani/atomic-agent-core"
description: "Stateful agent loop with tool execution, event streaming, steering, and follow-up messages."
---

Stateful agent with tool execution and event streaming, built on [`@bastani/atomic-ai`](/libraries/ai) (requires Node.js 22.19+). Atomic's sessions run on this agent loop, and you can use it directly to build your own agent. Atomic's [TypeScript SDK](/sdk) wraps it with sessions, tools, extensions, and compaction, so prefer the SDK when you want Atomic's built-in behavior.

## Installation

```bash
npm install @bastani/atomic-agent-core
```

## Quick start

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
    // Stream just the new text chunk
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Hello!");
```

## Core concepts

### AgentMessage vs LLM Message

The agent works with `AgentMessage`, which can include:

- Standard LLM messages (`system`, `user`, `assistant`, and `toolResult`)
- Custom app-specific message types added through declaration merging

LLMs accept only `system`, `user`, `assistant`, and `toolResult` messages. `convertToLlm` filters and transforms custom message types before each LLM call.

### Message flow

```text
AgentMessage[] -> transformContext() -> AgentMessage[] -> convertToLlm() -> Message[] -> LLM
                    (optional)                           (required)
```

1. **`transformContext`.** Prune old messages or inject external context.
2. **`convertToLlm`.** Filter out UI-only messages and convert custom types to LLM messages.

## Event flow

The agent emits events as turns run so your interface can update incrementally.

### `prompt()` event sequence

When you call `prompt("Hello")`:

```text
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // Your prompt
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM starts responding
├─ message_update  { message: partial... }       // Streaming chunks
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // Complete response
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

### With tool calls

If the assistant calls tools, the loop continues:

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

Tool execution mode is configurable:

- `parallel` (default): preflight tool calls sequentially, run allowed tools concurrently, emit `tool_execution_end` as each tool finishes, then emit `toolResult` messages and `turn_end.toolResults` in assistant source order.
- `sequential`: run tool calls one at a time in assistant source order.

In parallel mode, `tool_execution_end` events follow tool completion order, while persisted `toolResult` messages still follow assistant source order.

Set the mode globally through `toolExecution` in `AgentOptions`, or per tool through `executionMode` on `AgentTool`. If any tool call in a batch targets a tool with `executionMode: "sequential"`, the entire batch runs sequentially regardless of the global setting.

`beforeToolCall` runs after `tool_execution_start` and argument validation. It can block execution and attach `terminate: true` to the blocked result. `afterToolCall` runs after tool execution finishes and before `tool_execution_end` and the final tool result message events are emitted.

**`afterToolCall` merge rules:** Overrides merge field-by-field (`content`, `details`, `structuredContent`, `isError`, `usage`, `terminate`) with no deep merge. Importantly, returning `content` **without** `structuredContent` drops the original `structuredContent` so the two cannot go out of sync; pass `structuredContent` alongside `content` if you want to keep it.

Tools, blocked `beforeToolCall` results, and `afterToolCall` overrides can return `terminate: true` to skip the automatic follow-up LLM call. The loop stops early only when every finalized tool result in that batch sets `terminate: true`. Mixed batches continue normally.

With the `Agent` class, assistant `message_end` processing finishes before tool preflight begins. That guarantees `beforeToolCall` sees agent state that already includes the assistant message requesting the tool call.

### Request preparation and turn finalization

`prepareRequest` runs immediately before every conversational provider request, including the first. Use it to install canonical persisted context after pending input has been emitted:

```typescript
agent.prepareRequest = async ({ context }) => ({
  context: { ...context, messages: await session.loadModelContext() },
});
```

`prepareRequest` does not poll queues. Steering messages queued while it runs wait for the next normal steering poll.

`finishTurn` runs after the assistant message and all tool results are finalized, before `turn_end`. It runs for normal, error, and aborted responses:

```typescript
agent.finishTurn = async ({ message }) => {
  if (message.stopReason === "error" || message.stopReason === "aborted") return;
  if (shouldEndRun(message)) return { action: "end" };
  return needsAnotherResponse(message) ? { action: "continue" } : undefined;
};
```

Returning `undefined` keeps normal scheduling. Returning `{ action: "end" }` stops immediately after `turn_end` without polling steering or follow-up queues or starting another request.

On a normal response, returning `{ action: "continue" }` guarantees one more provider request. If tool results, steering messages, or follow-up messages already schedule that request, no extra request is sent; otherwise the loop sends one context-only request. Error and aborted responses remain hard exits whose decisions are ignored. Because `finishTurn` runs again after the next request, returning `{ action: "continue" }` unconditionally creates an infinite loop.

To migrate from the removed `shouldStopAfterTurn` hook, return `{ action: "end" }`. Guard error and aborted responses so your predicate runs only on successful turns:

```typescript
finishTurn: async (turn, signal) => {
  if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return;
  return (await shouldStop(turn, signal)) ? { action: "end" } : undefined;
},
```

Each provider turn follows this order:

```text
selected input events
-> prepareRequest
-> provider response
-> tool results
-> finishTurn
-> turn_end
-> continuation scheduling or agent_end
```

### `continue()` and queued input

Empty and system-only transcripts reject `continue()` without consuming queues. A non-assistant tail continues from existing context. Steering is polled at startup, while follow-up input waits until the response stops naturally.

```typescript
agent.followUp({ role: "user", content: "After the retry", timestamp: Date.now() });
await agent.continue(); // The first request retries the existing user/toolResult tail.
```

An assistant tail cannot be sent directly, so `continue()` falls back to one queued steering batch, or else one queued follow-up batch. Queue mode still determines whether that batch takes one message or all queued messages:

```typescript
agent.steer({ role: "user", content: "Continue from here", timestamp: Date.now() });
await agent.continue(); // Uses the queued message only because the tail is assistant.
```

### Event types

| Event | Description |
|-------|-------------|
| `agent_start` | Agent begins processing |
| `agent_end` | Final event for the run. Awaited subscribers for this event still count toward settlement |
| `turn_start` | New turn begins (one LLM call + tool executions) |
| `turn_end` | Turn completes with assistant message and tool results |
| `message_start` | Any message begins (user, assistant, toolResult) |
| `message_update` | **Assistant only.** Includes `assistantMessageEvent` with delta |
| `message_end` | Message completes |
| `tool_execution_start` | Tool begins |
| `tool_execution_update` | Tool streams progress |
| `tool_execution_end` | Tool completes |

`Agent.subscribe()` listeners receive `(event, signal)` and are awaited in registration order. If a listener throws or rejects, the error propagates to the caller awaiting `prompt()` or `continue()`. `agent_end` means no more loop events will be emitted, and `await agent.waitForIdle()` and `await agent.prompt(...)` settle only after awaited `agent_end` listeners finish.

## Agent options

```typescript
const agent = new Agent({
  // Initial state. systemPrompt and tools become the leading system message
  // unless messages already starts with one.
  initialState: {
    systemPrompt: string,
    model: Model<any>,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // Convert AgentMessage[] to LLM Message[] (required for custom message types; must not throw or reject)
  convertToLlm: (messages) => messages.filter(...),

  // Transform context before convertToLlm (for pruning, compaction)
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // Steering mode: "one-at-a-time" (default) or "all"
  steeringMode: "one-at-a-time",

  // Follow-up mode: "one-at-a-time" (default) or "all"
  followUpMode: "one-at-a-time",

  // Required stream function. Receives a TranscriptContext: the prompt and tools
  // are in the transcript's system messages, not on the context.
  streamFn: models.streamSimple.bind(models),

  // Session ID for provider caching
  sessionId: "session-123",

  // How requests identify the app to providers (a ClientIdentity from @bastani/atomic-ai), merged over
  // DEFAULT_AGENT_IDENTITY ({ attribution: ATOMIC_ATTRIBUTION }: attribution headers name Atomic).
  // Pass { attribution: null } to send no attribution headers.
  identity: { attribution: { name: "my-app", url: "https://my-app.example" } },

  // Dynamic API key resolution (for expiring OAuth tokens)
  getApiKey: async (provider) => refreshToken(),

  // Optional provider transport, retry cap, and request/response inspection hooks
  transport: "sse",
  maxRetryDelayMs: 60_000,
  onPayload: (payload, model) => payload,
  onResponse: (response) => {},
  onProviderStreamEvent: (event) => {},

  // Tool execution mode: "parallel" (default) or "sequential"
  toolExecution: "parallel",

  // Custom error text when the model calls an unregistered tool name
  unknownToolMessage: (toolName) => `Tool "${toolName}" is not available.`,

  // Preflight each tool call after args are validated. Can block execution.
  beforeToolCall: async ({ toolCall, args, context }) => {
    if (toolCall.name === "bash") {
      return { block: true, reason: "bash is disabled", terminate: true };
    }
  },

  // Postprocess each tool result before final tool events are emitted.
  afterToolCall: async ({ toolCall, result, isError, context }) => {
    if (toolCall.name === "notify_done" && !isError) {
      return { terminate: true };
    }
    if (!isError) {
      return { details: { ...result.details, audited: true } };
    }
  },

  // Rebuild finalized context immediately before every provider request.
  prepareRequest: async ({ context }, signal) => {
    return { context: { ...context, messages: await loadCanonicalMessages(signal) } };
  },

  // Optional turn-boundary hooks that update model, tools, or system messages between turns.
  prepareNextTurn: async (signal) => undefined,
  prepareNextTurnWithContext: async (context, signal) => undefined,

  // Finalize a completed turn before turn_end is emitted.
  // `continue` ensures one next request; existing tool/queue scheduling can satisfy it.
  // `end` ends this run after turn_end without polling queues.
  finishTurn: async ({ message, toolResults }, signal) => {
    return shouldContinue(message, toolResults) ? { action: "continue" } : undefined;
  },

  // Custom thinking budgets for token-based providers
  thinkingBudgets: {
    minimal: 128,
    low: 512,
    medium: 1024,
    high: 2048,
  },
});
```

### `StreamFn`, `setDefaultStreamFn()`, and `convertToLlm` contracts

- **`StreamFn` must never throw or reject** for request, model, or runtime failures. Always return an `AssistantMessageEventStream` and encode failures via stream `error` events and a final `AssistantMessage` with `stopReason: "error"` or `"aborted"` and `errorMessage`.
- **`convertToLlm` must never throw or reject**; filter or normalize custom messages deterministically.
- **`setDefaultStreamFn(streamFn | undefined)`:** Sets a process-wide fallback `StreamFn` used when `Agent` or `agentLoop()` callers do not supply an explicit `streamFn`.

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

Access state through `agent.state`. Assigning `agent.state.tools = [...]` or `agent.state.messages = [...]` copies the top-level array before storing it, while mutating the returned array mutates current agent state.

The transcript owns the system prompt and tool declarations. The leading system message sets the prompt, and later system messages patch it (see `SystemMessage` in [`@bastani/atomic-ai`](/libraries/ai)). `agent.state.systemPrompt` is read-only and replays the transcript.

`agent.state.tools` holds the executable tools. Before every request, the loop compares `agent.state.tools` against the tools declared in the transcript and announces any difference in a system message, merging into a pending system message when one exists. `getCurrentSystemMessage(messages)` from `@bastani/atomic-ai` returns the replayed head, including declared tools, for any message array including agent transcripts with custom message roles.

To change the prompt mid-conversation, append a system message with `content` (added instructions) or `sections` (named replacements):

```typescript
await agent.prompt([
  { role: "system", content: "", sections: { skills: "<skills>...</skills>" }, timestamp: Date.now() },
  { role: "user", content: "Continue", timestamp: Date.now() },
]);
```

During streaming, `agent.state.streamingMessage` contains the current partial assistant message.

`agent.state.isStreaming` remains `true` until the run fully settles, including awaited `agent_end` subscribers.

## Methods

### Prompting

```typescript
// Text prompt
await agent.prompt("Hello");

// With images
await agent.prompt("What's in this image?", [
  { type: "image", data: base64Data, mimeType: "image/jpeg" }
]);

// AgentMessage directly
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

// Continue existing non-assistant input; an assistant tail may use queued input as fallback
await agent.continue();
```

### State management

```typescript
const nextModel = models.getModel("openai", "gpt-4o");
if (nextModel) agent.state.model = nextModel;
agent.state.thinkingLevel = "medium";
agent.state.tools = [myTool];
agent.toolExecution = "sequential";
agent.beforeToolCall = async ({ toolCall }) => undefined;
agent.afterToolCall = async ({ toolCall, result }) => undefined;
agent.prepareRequest = async ({ context }) => ({
  context: { ...context, messages: await loadCanonicalMessages() },
});
agent.finishTurn = async () => undefined;
agent.state.messages = newMessages; // top-level array is copied
agent.state.messages.push(message);
const nextQueuedMessages = agent.peekQueuedMessages(); // respects queue modes; does not consume
agent.reset();
```

### Session and thinking budgets

```typescript
agent.sessionId = "session-123";

agent.thinkingBudgets = {
  minimal: 128,
  low: 512,
  medium: 1024,
  high: 2048,
};
```

### Control

```typescript
agent.abort();           // Cancel current operation
await agent.waitForIdle(); // Wait for completion
```

### Events

```typescript
const unsubscribe = agent.subscribe(async (event, signal) => {
  if (event.type === "agent_end") {
    // Final barrier work for the run
    await flushSessionState(signal);
  }
});
unsubscribe();
```

## Steering and follow-up

Steering messages let you interrupt the agent while tools are running. Follow-up messages let you queue work after the agent would otherwise stop.

```typescript
agent.steeringMode = "one-at-a-time";
agent.followUpMode = "one-at-a-time";

// While agent is running tools
agent.steer({
  role: "user",
  content: "Stop! Do this instead.",
  timestamp: Date.now(),
});

// After the agent finishes its current work
agent.followUp({
  role: "user",
  content: "Also summarize the result.",
  timestamp: Date.now(),
});

const steeringMode = agent.steeringMode;
const followUpMode = agent.followUpMode;

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

Use `clearSteeringQueue()`, `clearFollowUpQueue()`, or `clearAllQueues()` to drop queued messages.

When steering messages are detected after a turn completes:

1. All tool calls from the current assistant message have already finished.
2. Steering messages are injected.
3. The LLM responds on the next turn.

Follow-up messages are checked only when there are no more tool calls and no steering messages. If any are queued, they are injected and another turn runs.

## Custom message types

Extend `AgentMessage` through declaration merging:

```typescript
declare module "@bastani/atomic-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}

// Now valid
const msg: AgentMessage = { role: "notification", text: "Info", timestamp: Date.now() };
```

Handle custom types in `convertToLlm`:

```typescript
const agent = new Agent({
  streamFn: models.streamSimple.bind(models),
  convertToLlm: (messages) => messages.flatMap(m => {
    if (m.role === "notification") return []; // Filter out
    return [m];
  }),
});
```

## Tools

Define tools with `AgentTool`. `parameters` is any JSON Schema object. When built with `@bastani/atomic-schema` builders, it also types `params` (other schemas produce `unknown`, and `AgentTool<any>` produces `any`):

```typescript
import { obj, str } from "@bastani/atomic-schema";

const readFileParameters = obj({
  path: str({ description: "File path" }),
});

const readFileTool: AgentTool<typeof readFileParameters> = {
  name: "read_file",
  label: "Read File",  // For UI display
  description: "Read a file's contents",
  parameters: readFileParameters,
  // Optional JSON Schema describing structuredContent returned to programmatic/codemode callers
  outputSchema: obj({ path: str(), content: str() }),
  // Override execution mode for this tool (optional).
  // "sequential" forces the entire batch to run one at a time.
  // "parallel" allows concurrent execution with other tool calls.
  // If omitted, the global toolExecution config applies.
  executionMode: "sequential",
  execute: async (toolCallId, params, signal, onUpdate) => {
    const content = await fs.readFile(params.path, "utf-8");

    // Optional: stream progress
    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

    // Optional: add `terminate: true` here to skip the automatic follow-up LLM call
    // when every finalized tool result in the batch does the same.
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

Throw an error or return a result with `isError: true` when a tool fails. Do not only describe the failure in `content`.

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  if (!fs.existsSync(params.path)) {
    throw new Error(`File not found: ${params.path}`);
  }
  // Return content only on success
  return { content: [{ type: "text", text: "..." }], details: {} };
}
```

The agent catches thrown errors and reports them to the LLM as tool errors with `isError: true`. Returning `{ content, details, structuredContent, isError: true }` reports the same error status to the model while keeping `details` and `structuredContent` for UI and programmatic callers.

Return `terminate: true` from `execute()`, a blocked `beforeToolCall`, or `afterToolCall` to skip the follow-up LLM call after the current tool batch. This takes effect only when every finalized tool result in the batch sets `terminate: true`. The hint is runtime-only, so emitted `toolResult` transcript messages remain standard LLM tool results.

### MCP, Codemode, and `runToolCall()`

[`@bastani/atomic-codemode`](/libraries/codemode) runs model-written JavaScript that calls tools. Wrap it as an `AgentTool` named `codemode` whose scripts invoke the agent's tools through `runToolCall(toolCall, options)` so argument validation, `beforeToolCall`, and `afterToolCall` apply to nested calls too.

```typescript
import { type AgentToolCall, type AgentToolCallOutcome, type RunToolCallOptions, runToolCall } from "@bastani/atomic-agent-core";

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

`runToolCall()` returns `{ result, isError, durationMs? }` (returning tool failures as `isError: true` rather than throwing). See [Using with agent-core](/libraries/codemode#using-with-agent-core). Tools that wrap an MCP server's tools work the same way. Atomic's own MCP support lives in the [MCP servers](/mcp-servers) extension.

## Proxy usage

For browser apps that proxy requests through a backend:

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

## Low-level API

For direct control without the `Agent` class:

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
  toolExecution: "parallel",  // overridden by per-tool executionMode if set
  beforeToolCall: async ({ toolCall, args, context }) => undefined,
  afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

const streamFn = models.streamSimple.bind(models);
for await (const event of agentLoop([userMessage], context, config, undefined, streamFn)) {
  console.log(event.type);
}

// Continue from existing context
for await (const event of agentLoopContinue(context, config, undefined, streamFn)) {
  console.log(event.type);
}
```

These low-level streams are observational. They preserve event order, but they do not wait for your async event handling to settle before later producer phases continue. If message processing must act as a barrier before tool preflight, use the `Agent` class instead of raw `agentLoop()` or `agentLoopContinue()`.
