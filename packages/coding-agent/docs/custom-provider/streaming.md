---
title: "Implement provider streaming"
sidebarTitle: "Implement Streaming"
description: "Build a custom streamSimple handler with stream events, content blocks, tool calls, stop reasons, and cost calculation."
---

When a provider uses a protocol that none of Atomic's built-in APIs speak, supply a `streamSimple` handler in `atomic.registerProvider()`. Your handler converts upstream chunks into normalized Atomic stream events so the UI, retries, compaction, and tool execution work identically to built-in providers.

<Steps>
  <Step title="Create the event stream and output message">
    Construct an `AssistantMessageEventStream` via `createAssistantMessageEventStream()` and initialize an `AssistantMessage` with `stopReason: "pending"`, `timestamp: Date.now()`, and zeroed `usage`.
  </Step>
  <Step title="Emit start and send the request">
    Push `{ type: "start", partial: output }`, read the system prompt and tools from `context.messages`, and open the upstream request while forwarding `options?.signal`.
  </Step>
  <Step title="Stream content blocks">
    Append text, thinking, and tool-call blocks to `output.content` and push matching `*_start`, `*_delta`, and `*_end` events as chunks arrive.
  </Step>
  <Step title="Compute usage and map the stop reason">
    Populate `output.usage`, call `calculateCost(model, output.usage)`, and map the provider's terminal finish reason onto Atomic's `StopReason` union (throwing on unrecognized values).
  </Step>
  <Step title="Emit done or error and end the stream">
    Push `{ type: "done", reason, message: output }` on success — or `{ type: "error", reason, error: output }` in `catch` — then call `stream.end()`.
  </Step>
</Steps>

## Stream pattern

Return a stream created by `createAssistantMessageEventStream()` (or `new AssistantMessageEventStream()`). A plain `EventStream` subclass does not satisfy Atomic's response stream contract.

`AssistantMessageEventStream` automatically fills `output.durationMs` using a monotonic clock when you push `done` or `error`. Set `timestamp: Date.now()` when the request starts; existing durations are preserved, and messages whose timestamps predate the stream (such as fetched deferred results) remain untimed.

<Note>
`ProviderConfig.streamSimple` types `context` as `Context`, and Atomic passes a normalized transcript where `getCurrentSystemPrompt(context.messages)` and `getCurrentTools(context.messages)` resolve the active system prompt and tool definitions.
</Note>

```typescript
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@bastani/atomic-ai";

function streamMyProvider(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const systemPrompt = getCurrentSystemPrompt(context.messages);
    const tools = getCurrentTools(context.messages);

    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      stream.push({ type: "start", partial: output });

      // Send your upstream request using systemPrompt, tools, context.messages, and options.
      // Push content block events as chunks arrive, populate output.usage, call
      // calculateCost(model, output.usage), and set output.stopReason from the terminal event.
      // Throw on any unrecognized provider stop reason instead of defaulting to "stop".

      if (output.stopReason === "pending") {
        throw new Error("Provider stream ended without a stop reason");
      }
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error(output.errorMessage || "An unknown error occurred");
      }

      stream.push({
        type: "done",
        reason: output.stopReason,
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
```

### Common `SimpleStreamOptions` fields

| Option | Purpose |
| --- | --- |
| `apiKey`, `headers`, `env` | Resolved request credentials, merged headers, and provider-scoped environment overrides |
| `signal` | `AbortSignal` for user cancellation or deadlines; forward to `fetch()` |
| `fetch` | Optional custom `fetch` implementation |
| `reasoning`, `thinkingBudgets` | Requested thinking level (`off` through `max`) and optional per-level token budgets |
| `toolChoice` | Provider-neutral tool selection preference |
| `temperature`, `maxTokens`, `samplingParams` | Generation parameters and custom request-body sampling overrides |
| `sessionId`, `cacheRetention`, `transport` | Session affinity ID, prompt-cache retention tier, and transport preference |
| `timeoutMs`, `websocketConnectTimeoutMs`, `streamDeadlineMs`, `retryDeadline` | Request setup and response headers, WebSocket handshake, stream content progress, and retry admission limits. See [When a provider stops responding](/settings#when-a-provider-stops-responding) |
| `onPayload`, `onResponse`, `onProviderStreamEvent` | Lifecycle hooks to inspect or modify payloads, inspect HTTP responses, and observe parsed raw stream chunks before normalization |

## Event types

Push events through `stream.push()` in this order:

1. `{ type: "start", partial: output }` — stream started.
2. Content block events (repeatable; `contentIndex` is the block's index in `output.content`):
   - Text: `text_start`, `text_delta` (`delta`), `text_end` (`content`)
   - Thinking: `thinking_start`, `thinking_delta` (`delta`), `thinking_end` (`content`)
   - Tool calls: `toolcall_start`, `toolcall_delta` (`delta`), `toolcall_end` (`toolCall`)
3. Terminal event: `{ type: "done", reason, message }` or `{ type: "error", reason, error }`, followed by `stream.end()`.

`partial` always carries the current `AssistantMessage` state. Mutate `output.content` before pushing each event, then pass `output` as `partial`.

## Stop reasons

`StopReason` is `"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"` (`"deferred"` is for asynchronous batch APIs).

Initialize every in-flight message to `"pending"`. Assign the mapped reason when the provider emits its terminal event, and run two checks before pushing `done`:

- If `output.stopReason` is still `"pending"`, throw an error so a stream that drops before its terminal event does not appear complete.
- If `output.stopReason` is `"error"` or `"aborted"`, throw `output.errorMessage` so the `catch` block emits an `error` event.

After those two checks, the remaining terminal reasons (`"stop"`, `"length"`, `"toolUse"`, and `"deferred"`) are all valid for `done`.

Map every upstream finish reason explicitly and **throw on any unrecognized value** instead of falling back to `"stop"`. Store the provider's original string in `output.rawStopReason` when helpful for diagnostics.

## Content blocks

Append each new block to `output.content`, update it as deltas arrive, and emit its closing event:

```typescript
// Start text block
output.content.push({ type: "text", text: "" });
const contentIndex = output.content.length - 1;
stream.push({ type: "text_start", contentIndex, partial: output });

// Append text delta
const block = output.content[contentIndex];
if (block.type === "text") {
  block.text += delta;
  stream.push({ type: "text_delta", contentIndex, delta, partial: output });
}

// Complete text block
if (block.type === "text") {
  stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
}
```

Thinking blocks follow the same lifecycle with `{ type: "thinking", thinking: "" }` and `thinking_start` / `thinking_delta` / `thinking_end`.

## Tool calls

Tool call arguments stream as JSON fragments. Use `ToolCallArgumentsStream` from `@bastani/atomic-ai` to parse deltas incrementally rather than re-parsing the entire buffer on every chunk:

```typescript
import { ToolCallArgumentsStream } from "@bastani/atomic-ai";

// Start tool call
const block = {
  type: "toolCall" as const,
  id: toolCallId,
  name: toolName,
  arguments: {},
};
output.content.push(block);
const contentIndex = output.content.length - 1;
stream.push({ type: "toolcall_start", contentIndex, partial: output });

const args = new ToolCallArgumentsStream();

// Append each JSON delta
block.arguments = args.append(jsonDelta);
stream.push({ type: "toolcall_delta", contentIndex, delta: jsonDelta, partial: output });

// Finalize: full parse; malformed JSON records `argumentsError` on `block`
Object.assign(block, args.finish());
stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
```

## Usage and cost

Populate `output.usage` from the provider response and call `calculateCost()`:

```typescript
output.usage.input = response.usage.input_tokens;
output.usage.output = response.usage.output_tokens;
output.usage.cacheRead = response.usage.cache_read_tokens ?? 0;
output.usage.cacheWrite = response.usage.cache_write_tokens ?? 0;
output.usage.totalTokens =
  output.usage.input +
  output.usage.output +
  output.usage.cacheRead +
  output.usage.cacheWrite;
calculateCost(model, output.usage);
```

`calculateCost(model, output.usage)` mutates `output.usage.cost` in place and returns it, applying any long-context `cost.tiers` configured on the model. See [Request-wide cost tiers](/models/reference#request-wide-cost-tiers) for threshold matching and `modelOverrides` rules.

## Registration

Pass `streamSimple` alongside a provider-level `api` string in `atomic.registerProvider()`. Supplying `streamSimple` requires `api` at the provider level and suppresses derived `-fast` variants for that `api`:

```typescript
await atomic.registerProvider("my-provider", {
  baseUrl: "https://api.example.com",
  apiKey: "$MY_API_KEY",
  api: "my-custom-api",
  models: [
    {
      id: "my-model-1",
      name: "My Model 1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    },
  ],
  streamSimple: streamMyProvider,
});
```

<Tip>
For general streaming utilities, transcript helpers, and standalone `@bastani/atomic-ai` usage outside extensions, see the [AI library reference](/libraries/ai).
</Tip>
