<p align="center">
  <a href="https://github.com/bastani-inc/atomic">
    <img alt="Atomic logo" src="https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/docs/logo.svg" width="324">
  </a>
</p>

<p align="center">
  <b>@bastani/atomic-ai</b><br>
  One API for every LLM provider: models, auth, streaming, tools, images, classification, and thinking.
</p>

<p align="center">
  <a href="https://docs.bastani.ai/libraries/ai"><img alt="Docs" src="https://img.shields.io/badge/docs-atomic-blue?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@bastani/atomic-ai"><img alt="npm" src="https://img.shields.io/npm/v/@bastani/atomic-ai?style=flat-square" /></a>
  <a href="https://github.com/bastani-inc/atomic"><img alt="GitHub" src="https://img.shields.io/badge/github-bastani--inc%2Fatomic-181717?style=flat-square&logo=github" /></a>
</p>

---

`@bastani/atomic-ai` is the LLM client library that powers Atomic. Build a `Models` collection of providers to stream, complete, generate images, or classify with token and cost tracking, automatic credential resolution, and portable conversation contexts you can move between models mid-session.

[Atomic](https://github.com/bastani-inc/atomic) runs on this package and publishes it with every release at the same version.

## Install

```bash
npm install @bastani/atomic-ai
```

Inside an Atomic extension, you can import it without installing it because the running Atomic process provides it. See [Libraries](https://docs.bastani.ai/libraries).

## Quick start

Export `OPENAI_API_KEY` before running these examples. Import a single provider (such as `@bastani/atomic-ai/providers/openai`) in production bundles to avoid pulling in every built-in provider, or use `builtinModels()` to load the full catalog.

### Streaming with tool calls

```typescript
import { type Context, createModels, type Tool, Type } from "@bastani/atomic-ai";
import { openaiProvider } from "@bastani/atomic-ai/providers/openai";

const models = createModels();
models.setProvider(openaiProvider());

const model = models.getModel("openai", "gpt-4o-mini");
if (!model) throw new Error("Model not found");

const tools: Tool[] = [
	{
		name: "get_time",
		description: "Get the current time.",
		parameters: Type.Object({
			timezone: Type.Optional(Type.String({ description: "Optional IANA timezone, such as America/New_York" })),
		}),
	},
];

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "What time is it in UTC?", timestamp: Date.now() }],
	tools,
};

const stream = models.stream(model, context);

for await (const event of stream) {
	switch (event.type) {
		case "text_delta":
			process.stdout.write(event.delta);
			break;
		case "thinking_delta":
			process.stdout.write(event.delta);
			break;
		case "toolcall_delta": {
			const partialCall = event.partial.content[event.contentIndex];
			if (partialCall?.type === "toolCall") {
				console.log(`[Streaming args for ${partialCall.name}]`);
			}
			break;
		}
		case "toolcall_end":
			console.log(`\nTool called: ${event.toolCall.name}(${JSON.stringify(event.toolCall.arguments)})`);
			break;
		case "error":
			console.error(`Error: ${event.error.errorMessage}`);
			break;
	}
}

const finalMessage = await stream.result();
context.messages.push(finalMessage);

const toolCalls = finalMessage.content.filter((block) => block.type === "toolCall");
for (const call of toolCalls) {
	const timeZone = typeof call.arguments.timezone === "string" ? call.arguments.timezone : "UTC";
	const result =
		call.name === "get_time"
			? new Date().toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "long" })
			: "Unknown tool";

	context.messages.push({
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: result }],
		isError: false,
		timestamp: Date.now(),
	});
}

if (toolCalls.length > 0) {
	const continuation = await models.complete(model, context);
	context.messages.push(continuation);
	console.log("After tool execution:", continuation.content);
}

console.log(`Tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);
```

### Non-streaming completion

```typescript
import { type Context, createModels } from "@bastani/atomic-ai";
import { openaiProvider } from "@bastani/atomic-ai/providers/openai";

const models = createModels();
models.setProvider(openaiProvider());
const model = models.getModel("openai", "gpt-4o-mini");
if (!model) throw new Error("Model not found");

const context: Context = {
	systemPrompt: "You are a concise assistant.",
	messages: [{ role: "user", content: "Summarize HTTP 429 in one sentence.", timestamp: Date.now() }],
};

const response = await models.complete(model, context);
for (const block of response.content) {
	if (block.type === "text") console.log(block.text);
}
```

## OAuth helper CLI

The package exposes an `atomic-ai` binary (with `pi-ai` kept as a legacy alias) for interactive OAuth login that saves credentials to `auth.json`:

```bash
npx @bastani/atomic-ai login
```

## Documentation

The full guide and API reference are in Atomic's docs: **[@bastani/atomic-ai](https://docs.bastani.ai/libraries/ai)**.

## License

MIT. See [LICENSE](LICENSE).

Derived from pi by Mario Zechner and Earendil Works; see [NOTICE.md](NOTICE.md).
