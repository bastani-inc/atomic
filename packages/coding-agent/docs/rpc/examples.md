---
title: RPC client examples
description: Additional RPC client implementations.
---

# RPC client examples

## Typed TypeScript client (`RpcClient`)

Install `@bastani/atomic` and use the exported `RpcClient` to launch Atomic in a child process, send typed commands, stream events, and wait for turns to settle. By default `RpcClient` runs `bun dist/cli.js`; pass `runtimeExecutable: process.execPath` and resolve `@bastani/atomic/rpc-entry` to launch the installed package under Node.js (or pass `runtimeExecutable: "atomic"` with `cliPath: ""` to drive an `atomic` binary on `PATH`).

```typescript
import { fileURLToPath } from "node:url";
import { RpcClient } from "@bastani/atomic";

const client = new RpcClient({
  runtimeExecutable: process.execPath,
  cliPath: fileURLToPath(import.meta.resolve("@bastani/atomic/rpc-entry")),
  args: ["--no-session"],
});

const unsubscribe = client.onEvent((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await client.start();
  await client.promptAndWait("Explain this repository");
  process.stdout.write("\n");
} finally {
  unsubscribe();
  await client.stop();
}
```

More TypeScript examples live in the repository under [`examples/rpc-client.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/rpc-client.ts), [`examples/rpc-extension-ui.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/rpc-extension-ui.ts), and [`examples/extensions/rpc-demo.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/rpc-demo.ts).

## Example: interactive client (Node.js)

This standalone Node.js script spawns an installed `atomic --mode rpc` binary directly and reads stdout with strict LF-only JSONL framing (avoiding Node's `readline`, which splits on `U+2028` and `U+2029`).

```javascript
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const agent = spawn("atomic", ["--mode", "rpc", "--no-session"]);

function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    }
  });
}

attachJsonlReader(agent.stdout, (line) => {
  const event = JSON.parse(line);

  if (event.type === "message_update") {
    const { assistantMessageEvent } = event;
    if (assistantMessageEvent.type === "text_delta") {
      process.stdout.write(assistantMessageEvent.delta);
    }
  }
});

// Send prompt
agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// Abort on CTRL+C
process.on("SIGINT", () => {
  agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```
