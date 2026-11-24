---
title: "RPC client examples"
sidebarTitle: "RPC examples"
description: "Connect to Atomic RPC mode using the typed RpcClient in TypeScript or a standalone Node.js script."
---

## Typed TypeScript client (`RpcClient`)

Install `@bastani/atomic` and use `RpcClient` to spawn Atomic in a child process, send typed commands, stream events, answer extension UI requests, and wait for turns to settle.

By default `RpcClient` launches `bun dist/cli.js`. To launch the installed package under Node.js, pass `runtimeExecutable: process.execPath` and resolve `@bastani/atomic/rpc-entry`. To drive an `atomic` binary already on `PATH`, pass `runtimeExecutable: "atomic"` and `cliPath: ""`.

### `RpcClientOptions`

| Option | Default | Description |
| --- | --- | --- |
| `cliPath` | `"dist/cli.js"` | Path to the Atomic CLI entry script (pass `""` when `runtimeExecutable` is `"atomic"`). |
| `cwd` | `process.cwd()` | Working directory for the child process. |
| `env` | `undefined` | Extra environment variables merged into the child process environment. |
| `provider` | `undefined` | Passed as `--provider <provider>`. |
| `model` | `undefined` | Passed as `--model <model>`. |
| `args` | `[]` | Additional CLI flags forwarded to Atomic (for example `["--no-session"]`). |
| `runtimeExecutable` | `"bun"` | Executable used to spawn the child process. |
| `runtimeArgs` | `[]` | Arguments passed to `runtimeExecutable` before `cliPath`. |
| `requestTimeoutMs` | `30000` | Timeout in milliseconds for short metadata and control commands. |

**Request timeout exemptions:** `requestTimeoutMs` (default `30_000` ms) applies only to short metadata and control requests such as `get_state`, `get_available_models`, `set_model`, `get_entries`, and `list_sessions`. Long-lived or interaction-gated commands (`prompt`, `steer`, `follow_up`, `resume_queued_messages`, `bash`, `user_bash`, `compact`, `login_provider`, `fork`, `clone`, `switch_session`, `new_session`, `import_session`, `navigate_tree`, `invoke_shortcut`, `start_pending_recovery`, `start_pending_recovery_restore`) and cooperative cancellation commands (`abort`, `abort_bash`, `abort_compaction`, `abort_branch_summary`, `abort_retry`, `cancel_login_provider`) are exempt and never time out on the client timer. If the child exits or the transport breaks, pending requests reject immediately.

### Basic prompt and streaming

```typescript
import { fileURLToPath } from "node:url";
import { RpcClient } from "@bastani/atomic";

const client = new RpcClient({
  runtimeExecutable: process.execPath,
  cliPath: fileURLToPath(import.meta.resolve("@bastani/atomic/rpc-entry")),
  args: ["--no-session"],
  requestTimeoutMs: 30_000,
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

### Handling extension UI and questionnaires

Subscribe with `onExtensionUIRequest()` and reply with `respondExtensionUI()`. Opt in to `ask_user_question` questionnaires by calling `setExtensionUiCapabilities({ questionnaire: true })` right after `start()`:

```typescript
await client.start();
await client.setExtensionUiCapabilities({ questionnaire: true });

const unsubscribeUi = client.onExtensionUIRequest((request) => {
  if (request.method === "confirm") {
    void client.respondExtensionUI({
      type: "extension_ui_response",
      id: request.id,
      confirmed: true,
    });
  } else if (request.method === "select") {
    void client.respondExtensionUI({
      type: "extension_ui_response",
      id: request.id,
      value: request.options[0],
    });
  } else if (request.method === "questionnaire") {
    const answers = request.questions.map((q, questionIndex) => ({
      questionIndex,
      question: q.question,
      kind: "option" as const,
      answer: q.options[0].label,
    }));
    void client.respondExtensionUI({
      type: "extension_ui_response",
      id: request.id,
      answers,
    });
  }
});
```

More TypeScript examples live in the repository under [`examples/rpc-client.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/rpc-client.ts), [`examples/rpc-extension-ui.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/rpc-extension-ui.ts), and [`examples/extensions/rpc-demo.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/rpc-demo.ts).

## Standalone Node.js client

This ESM script spawns an installed `atomic --mode rpc` binary without importing `@bastani/atomic`, parses stdout with strict LF-only JSONL framing (avoiding Node's `readline`, which splits on `U+2028` and `U+2029`), aborts on `SIGINT`, and closes stdin cleanly when the turn finishes:

```javascript
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

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
      if (line.length > 0) onLine(line);
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

  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }

  if (event.type === "agent_end") {
    process.stdout.write("\n");
    agent.stdin.end();
  }
});

agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

process.on("SIGINT", () => {
  agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```
