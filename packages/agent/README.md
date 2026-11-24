<p align="center">
  <a href="https://github.com/bastani-inc/atomic">
    <img alt="Atomic logo" src="https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/docs/logo.svg" width="324">
  </a>
</p>

<p align="center">
  <b>@bastani/atomic-agent-core</b><br>
  A stateful agent loop with tool execution and event streaming.
</p>

<p align="center">
  <a href="https://docs.bastani.ai/libraries/agent-core"><img alt="Docs" src="https://img.shields.io/badge/docs-atomic-blue?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@bastani/atomic-agent-core"><img alt="npm" src="https://img.shields.io/npm/v/@bastani/atomic-agent-core?style=flat-square" /></a>
  <a href="https://github.com/bastani-inc/atomic"><img alt="GitHub" src="https://img.shields.io/badge/github-bastani--inc%2Fatomic-181717?style=flat-square&logo=github" /></a>
</p>

---

`@bastani/atomic-agent-core` provides the stateful agent loop behind Atomic sessions, built on `@bastani/atomic-ai`. It handles tool execution with before and after hooks, event streaming, steering and follow-up message queues, and custom message types.

[Atomic](https://github.com/bastani-inc/atomic) runs on this package and publishes it with every release at the same version.

## Install

```bash
npm install @bastani/atomic-agent-core @bastani/atomic-ai
```

Inside an Atomic extension, you can import both packages without installing them because the running Atomic process provides them. See [Libraries](https://docs.bastani.ai/libraries).

## Quick start

Export `ANTHROPIC_API_KEY` before running this example:

```typescript
import { Agent, type AgentTool } from "@bastani/atomic-agent-core";
import { createModels, Type } from "@bastani/atomic-ai";
import { anthropicProvider } from "@bastani/atomic-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Model not found");

const clockParams = Type.Object({
	timeZone: Type.Optional(Type.String({ description: "IANA time zone, such as UTC" })),
});

const getTimeTool: AgentTool<typeof clockParams> = {
	name: "get_time",
	label: "Get time",
	description: "Return the current date and time.",
	parameters: clockParams,
	execute: async (_toolCallId, params) => ({
		content: [
			{
				type: "text",
				text: new Date().toLocaleString("en-US", {
					timeZone: params.timeZone ?? "UTC",
					dateStyle: "full",
					timeStyle: "long",
				}),
			},
		],
		details: undefined,
	}),
};

const agent = new Agent({
	initialState: {
		systemPrompt: "You are a helpful assistant.",
		model,
		tools: [getTimeTool],
	},
	streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await agent.prompt("What time is it in UTC?");
```

## Documentation

The full guide and API reference are in Atomic's docs: **[@bastani/atomic-agent-core](https://docs.bastani.ai/libraries/agent-core)**.

## License

MIT. See [LICENSE](LICENSE).

Derived from pi by Mario Zechner and Earendil Works; see [NOTICE.md](NOTICE.md).
