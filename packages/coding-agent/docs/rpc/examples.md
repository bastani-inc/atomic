---
title: RPC client examples
description: Additional RPC client implementations.
---

# RPC client examples

## Example: Interactive Client (Node.js)

See [`test/rpc-example.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/test/rpc-example.ts) for a complete interactive example, or [`src/modes/rpc/rpc-client.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/modes/rpc/rpc-client.ts) for a typed client implementation.

[`examples/rpc-client.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/rpc-client.ts) uses the exported `RpcClient` to run Atomic in a child process, stream events, and wait for the run to settle. Build the coding-agent package first, then run `node examples/rpc-client.ts "Explain this repository"` from a repository checkout. `RpcClient` launches the CLI under Bun by default; pass `runtimeExecutable: process.execPath` to run it under Node.

For a complete example of handling the extension UI protocol, see [`examples/rpc-extension-ui.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/rpc-extension-ui.ts) which pairs with the [`examples/extensions/rpc-demo.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/rpc-demo.ts) extension.

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
