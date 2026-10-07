---
title: Provider streaming API
description: "Implement a custom streaming API: events, content blocks, tool calls, stop reasons, and usage."
---

# Provider streaming API

## Custom Streaming API

For providers with non-standard APIs, implement `streamSimple`. Study the existing API implementations before writing your own:

**Reference implementations:**

Atomic uses provider implementations from its installed `@bastani/pi-ai` dependency. The streaming implementations behind the `api` field live under `node_modules/@bastani/pi-ai/dist/api/`, including:
- `anthropic-messages.d.ts` / `anthropic-messages.js` - Anthropic Messages API
- `mistral-conversations.d.ts` / `mistral-conversations.js` - Mistral Conversations/Chat streaming
- `openai-completions.d.ts` / `openai-completions.js` - OpenAI Chat Completions
- `openai-responses.d.ts` / `openai-responses.js` - OpenAI Responses API
- `google-generative-ai.d.ts` / `google-generative-ai.js` - Google Generative AI
- `bedrock-converse-stream.d.ts` / `bedrock-converse-stream.js` - Amazon Bedrock Converse API
Per-vendor provider configurations (base URLs, auth, model catalogs) live under `dist/providers/`, for example `anthropic.d.ts` / `anthropic.js` and `mistral.d.ts` / `mistral.js`.

### Stream Pattern

All providers follow the same pattern:

Return a stream from `createAssistantMessageEventStream()` or construct `AssistantMessageEventStream` directly. A plain `EventStream` subclass does not satisfy the response stream type.

The stream sets optional `durationMs` on the final assistant message using a monotonic clock. Set `timestamp` when the request starts. Existing durations are preserved; messages whose timestamps predate the stream, such as fetched deferred results, remain untimed.

```typescript
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@bastani/pi-ai";

function streamMyProvider(
  model: Model<any>,
  context: TranscriptContext,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const systemPrompt = getCurrentSystemPrompt(context.messages);
    const tools = getCurrentTools(context.messages);
    // Initialize output message
    // Initialize output message
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
      // Push start event
      stream.push({ type: "start", partial: output });

      // Make API request and process response...
      // Push content events as they arrive, and set output.stopReason from the
      // terminal event. A reason your provider sends that you do not map must
      // become an error, not a silent "stop".
      if (output.stopReason === "pending") {
        throw new Error("Provider stream ended without a stop reason");
      }
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error(output.errorMessage || "An unknown error occurred");
      }

      // Push done event
      stream.push({
        type: "done",
        reason: output.stopReason,
        message: output
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

### Event Types

Push events via `stream.push()` in this order:

1. `{ type: "start", partial: output }` - Stream started

2. Content events (repeatable, track `contentIndex` for each block):
   - `{ type: "text_start", contentIndex, partial }` - Text block started
   - `{ type: "text_delta", contentIndex, delta, partial }` - Text chunk
   - `{ type: "text_end", contentIndex, content, partial }` - Text block ended
   - `{ type: "thinking_start", contentIndex, partial }` - Thinking started
   - `{ type: "thinking_delta", contentIndex, delta, partial }` - Thinking chunk
   - `{ type: "thinking_end", contentIndex, content, partial }` - Thinking ended
   - `{ type: "toolcall_start", contentIndex, partial }` - Tool call started
   - `{ type: "toolcall_delta", contentIndex, delta, partial }` - Tool call JSON chunk
   - `{ type: "toolcall_end", contentIndex, toolCall, partial }` - Tool call ended

3. `{ type: "done", reason, message }` or `{ type: "error", reason, error }` - Stream ended

The `partial` field in each event contains the current `AssistantMessage` state. Update `output.content` as you receive data, then include `output` as the `partial`.

### Stop Reasons

`StopReason` is `"pending" | "stop" | "length" | "toolUse" | "error" | "aborted"`.

Start every in-flight partial message at `"pending"`. This means the terminal event has not arrived, not that the turn ended with `"stop"`. When the provider reports the end of the turn, set the real reason and push `done` with it.

Two checks belong immediately before `done`:

- a stream that reached the end while still `"pending"` never received a terminal event, so raise rather than report a stop that did not happen;
- `"error"` and `"aborted"` are failures, so raise them with `output.errorMessage` and let the `catch` push an `error` event.

`done` accepts only `"stop"`, `"length"`, and `"toolUse"`, which is exactly what those two checks leave, so the `as "stop" | "length" | "toolUse"` cast older implementations used is no longer needed.

Map each raw reason your provider can send onto one of the five terminal values, and **raise on one you do not recognise** rather than falling back to `"stop"`. This is what the built-in providers do: an unmapped reason becomes a provider error naming the raw value, so a new truncation or safety signal is visible instead of arriving as a turn that looks like it finished normally. The optional `rawStopReason` field on `AssistantMessage` is where the provider's own string belongs when you want to keep it.

### Content Blocks

Add content blocks to `output.content` as they arrive:

```typescript
// Text block
output.content.push({ type: "text", text: "" });
stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });

// As text arrives
const block = output.content[contentIndex];
if (block.type === "text") {
  block.text += delta;
  stream.push({ type: "text_delta", contentIndex, delta, partial: output });
}

// When block completes
stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
```

### Tool Calls

Tool calls require accumulating JSON and parsing:

```typescript
// Start tool call
output.content.push({
  type: "toolCall",
  id: toolCallId,
  name: toolName,
  arguments: {}
});
stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });

// Accumulate JSON
let partialJson = "";
partialJson += jsonDelta;
try {
  block.arguments = JSON.parse(partialJson);
} catch {}
stream.push({ type: "toolcall_delta", contentIndex, delta: jsonDelta, partial: output });

// Complete
stream.push({
  type: "toolcall_end",
  contentIndex,
  toolCall: { type: "toolCall", id, name, arguments: block.arguments },
  partial: output
});
```

### Usage and Cost

Update usage from API response and calculate cost:

```typescript
output.usage.input = response.usage.input_tokens;
output.usage.output = response.usage.output_tokens;
output.usage.cacheRead = response.usage.cache_read_tokens ?? 0;
output.usage.cacheWrite = response.usage.cache_write_tokens ?? 0;
output.usage.totalTokens = output.usage.input + output.usage.output +
                           output.usage.cacheRead + output.usage.cacheWrite;
calculateCost(model, output.usage);
```

`calculateCost()` selects one rate set for the whole request. Aggregate input is `usage.input + usage.cacheRead + usage.cacheWrite`; a tier applies only when that sum is strictly greater than `inputTokensAbove`, and the matching tier with the highest threshold wins. Every tier must provide complete `input`, `output`, `cacheRead`, and `cacheWrite` rates. Extension-registered models preserve these tiers, and matching `models.json` `modelOverrides` use the same replacement rules described in [Custom Models](/models/reference#request-wide-cost-tiers).

### Registration

Register your stream function:

```typescript
pi.registerProvider("my-provider", {
  baseUrl: "https://api.example.com",
  apiKey: "$MY_API_KEY",
  api: "my-custom-api",
  models: [...],
  streamSimple: streamMyProvider
});
```
