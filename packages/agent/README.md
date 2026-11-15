<p align="center">
  <a href="https://github.com/bastani-inc/atomic">
    <img alt="Atomic" src="https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/docs/logo.svg" width="324">
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

The agent loop Atomic's sessions run on, built on `@bastani/atomic-ai`: tool execution with before and after hooks, event streaming, steering and follow-up messages, and custom message types.

[Atomic](https://github.com/bastani-inc/atomic), the verifiable coding agent runtime, is built on it, and it is published with every Atomic release at Atomic's version.

## Install

```bash
npm install @bastani/atomic-agent-core
```

Inside an Atomic extension, import it without installing it: the running Atomic provides it. See [Libraries](https://docs.bastani.ai/libraries).

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

## Documentation

The full guide and API reference are in Atomic's docs: **[@bastani/atomic-agent-core](https://docs.bastani.ai/libraries/agent-core)**.

## License

MIT. See [LICENSE](LICENSE).

Derived from pi by Mario Zechner and Earendil Works; see [NOTICE.md](NOTICE.md).
