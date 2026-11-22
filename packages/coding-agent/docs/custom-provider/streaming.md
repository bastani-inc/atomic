---
title: Provider streaming API
description: "Implement a custom streaming API: events, content blocks, tool calls, stop reasons, and usage."
---

# Provider streaming API

## Custom streaming API

For providers with non-standard APIs, implement `streamSimple`. Study the existing API implementations before writing your own.

**Reference implementations:**

Atomic uses provider implementations from its installed `@bastani/atomic-ai` dependency. The streaming implementations behind the `api` field live under `node_modules/@bastani/atomic-ai/dist/api/`, including:
- `anthropic-messages.d.ts` / `anthropic-messages.js` - Anthropic Messages API
- `mistral-conversations.d.ts` / `mistral-conversations.js` - Mistral Conversations/Chat streaming
- `openai-completions.d.ts` / `openai-completions.js` - OpenAI Chat Completions
- `openai-responses.d.ts` / `openai-responses.js` - OpenAI Responses API
- `google-generative-ai.d.ts` / `google-generative-ai.js` - Google Generative AI
- `bedrock-converse-stream.d.ts` / `bedrock-converse-stream.js` - Amazon Bedrock Converse API
Per-vendor provider configurations (base URLs, auth, model catalogs) live under `dist/providers/`, for example `anthropic.d.ts` / `anthropic.js` and `mistral.d.ts` / `mistral.js`.

### Stream Pattern

Return a stream from `createAssistantMessageEventStream()` or construct `AssistantMessageEventStream` directly. A plain `EventStream` subclass does not satisfy the response stream type.

The stream records optional `durationMs` on the final assistant message using a monotonic clock. Set `timestamp` when the request starts. Existing durations stay intact, and messages whose timestamps predate the stream (such as fetched deferred results) remain untimed.

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
  ToolCallArgumentsStream,
} from "@bastani/atomic-ai";

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

      // Send API request, push content events, and set output.stopReason from
      // the terminal event. Throw on any unmapped stop reason instead of falling
      // back to "stop".
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

### Event types

Push events with `stream.push()` in this order:

1. `{ type: "start", partial: output }`: stream started.
2. Content events (repeatable; track `contentIndex` for each block):
   - `{ type: "text_start", contentIndex, partial }`: text block started.
   - `{ type: "text_delta", contentIndex, delta, partial }`: text chunk.
   - `{ type: "text_end", contentIndex, content, partial }`: text block ended.
   - `{ type: "thinking_start", contentIndex, partial }`: thinking block started.
   - `{ type: "thinking_delta", contentIndex, delta, partial }`: thinking chunk.
   - `{ type: "thinking_end", contentIndex, content, partial }`: thinking block ended.
   - `{ type: "toolcall_start", contentIndex, partial }`: tool call started.
   - `{ type: "toolcall_delta", contentIndex, delta, partial }`: tool call JSON chunk.
   - `{ type: "toolcall_end", contentIndex, toolCall, partial }`: tool call ended.
3. `{ type: "done", reason, message }` or `{ type: "error", reason, error }`: stream ended.

`partial` holds the current `AssistantMessage` state. Update `output.content` as chunks arrive, then pass `output` as `partial`.

### Stop reasons

`StopReason` is `"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"` (`"deferred"` is for deferred batch APIs).

Initialize every in-flight message to `"pending"`. When the provider emits its terminal event, assign the mapped reason before pushing `done`.

Run two checks before `done`:

- If `output.stopReason` is still `"pending"`, throw an error so a stream without a terminal event does not appear complete.
- If `output.stopReason` is `"error"` or `"aborted"`, throw `output.errorMessage` so the `catch` block emits an `error` event.

`done` accepts only `"stop"`, `"length"`, and `"toolUse"`, which matches what remains after those two checks.

Map every raw stop reason your provider sends onto one of the terminal values, and **throw on any unrecognized reason** instead of falling back to `"stop"`. Store the provider's original string in `rawStopReason` when needed.

### Content blocks

Append content blocks to `output.content` as they arrive:

```typescript
// Start text block
output.content.push({ type: "text", text: "" });
stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });

// Append text delta
const block = output.content[contentIndex];
if (block.type === "text") {
  block.text += delta;
  stream.push({ type: "text_delta", contentIndex, delta, partial: output });
}

// Complete text block
stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
```

### Tool calls

Tool call arguments stream as JSON text. `ToolCallArgumentsStream` from `@bastani/atomic-ai` parses each delta incrementally instead of re-parsing the full text on every chunk:

```typescript
// Start tool call
output.content.push({
  type: "toolCall",
  id: toolCallId,
  name: toolName,
  arguments: {}
});
stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });

const args = new ToolCallArgumentsStream();

// Append each JSON delta
block.arguments = args.append(jsonDelta);
stream.push({ type: "toolcall_delta", contentIndex, delta: jsonDelta, partial: output });

// Finalize: full parse; malformed arguments record `argumentsError`
Object.assign(block, args.finish());
stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
```

### Usage and cost

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

`calculateCost()` applies one rate set to the whole request. Aggregate input is `usage.input + usage.cacheRead + usage.cacheWrite`; a tier applies only when that total strictly exceeds `inputTokensAbove`, and the highest matching threshold wins. Every tier must define `input`, `output`, `cacheRead`, and `cacheWrite`. Extension-registered models keep these tiers, and `models.json` `modelOverrides` follow the rules in [Request-wide cost tiers](/models/reference#request-wide-cost-tiers).

### Registration

Register your stream handler with `pi.registerProvider()`:

```typescript
await pi.registerProvider("my-provider", {
  baseUrl: "https://api.example.com",
  apiKey: "$MY_API_KEY",
  api: "my-custom-api",
  models: [],
  streamSimple: streamMyProvider
});
```
