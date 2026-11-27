---
title: "Connect with RPC clients"
sidebarTitle: "RPC client examples"
description: "Connect to Atomic RPC mode using the typed RpcClient in TypeScript or a standalone Node.js script."
---

## Typed TypeScript client (`RpcClient`)

Install `@bastani/atomic` and use `RpcClient` to spawn Atomic in a child process, send typed commands, stream events, and answer extension UI requests.

<Warning>
By default, `RpcClient` launches `bun dist/cli.js`, which fails under Node.js or npm installs. Always pass `runtimeExecutable: process.execPath` with `cliPath: fileURLToPath(import.meta.resolve("@bastani/atomic/rpc-entry"))` for Node.js apps, or `runtimeExecutable: "atomic"` with `cliPath: ""` to drive an installed `atomic` binary on `PATH`.
</Warning>

**About `@bastani/atomic/rpc-entry`:** This dedicated RPC entry script sets `process.title = "atomic-rpc"`, suppresses Node runtime warnings so stderr stays clean, and injects `--mode rpc` before any `--` terminator so caller `--mode` flags cannot accidentally switch away from RPC mode.

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

**Request timeout exemptions:** `requestTimeoutMs` (default `30_000` ms) applies only to short metadata and control requests such as `get_state`, `get_available_models`, `set_model`, `get_entries`, and `list_sessions`. Long-lived or interaction-gated commands (`prompt`, `steer`, `follow_up`, `resume_queued_messages`, `bash`, `user_bash`, `compact`, `login_provider`, `fork`, `clone`, `switch_session`, `new_session`, `import_session`, `navigate_tree`, `invoke_shortcut`, `start_pending_recovery`) and cooperative cancellation commands (`abort`, `abort_bash`, `abort_compaction`, `abort_branch_summary`, `abort_retry`, `cancel_login_provider`) are exempt and never time out on the client timer. If the child exits or the transport breaks, pending requests reject immediately.

**Startup and shutdown lifecycle:** In standalone mode, `client.start()` waits a fixed 100 ms after spawning the subprocess. `client.stop()` terminates the subprocess with `SIGTERM` and a **250 ms** grace period before escalating to `SIGKILL` (on Windows, `SIGTERM` terminates immediately). Wait for `agent_settled` and any pending writes before calling `stop()`.

### Prompting and waiting for turns to settle

<Warning>
**`promptAndWait()`, `waitForIdle()`, and `collectEvents()` stop on the first `agent_end`, not `agent_settled`:**
1. They resolve as soon as the first low-level `agent_end` event arrives — **before** automatic retries (`retryPending: true`), post-compaction continuations, or queued turns complete.
2. `promptAndWait()` does **not** inspect the `prompt` response's `disposition`. If an extension command or input hook returns `"handled"`, no turn starts and `promptAndWait()` hangs until its 60-second timeout fires.

For reliable turn completion in production clients, call `client.prompt()`, return early when `disposition === "handled"`, and wait for `event.type === "agent_settled"`.
</Warning>

```typescript
import { fileURLToPath } from "node:url";
import { RpcClient, type RpcEvent } from "@bastani/atomic";

async function runPromptUntilSettled(client: RpcClient, message: string): Promise<RpcEvent[]> {
  const events: RpcEvent[] = [];
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  const unsubscribe = client.onEvent((event) => {
    events.push(event);
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "agent_settled") resolveSettled();
  });

  try {
    const disposition = await client.prompt(message);
    if (disposition === "handled") return events;
    await settled;
    process.stdout.write("\n");
    return events;
  } finally {
    unsubscribe();
  }
}

const client = new RpcClient({
  runtimeExecutable: process.execPath,
  cliPath: fileURLToPath(import.meta.resolve("@bastani/atomic/rpc-entry")),
  args: ["--no-session"],
  requestTimeoutMs: 30_000,
});

try {
  await client.start();
  await runPromptUntilSettled(client, "Explain this repository");
} finally {
  await client.stop();
}
```

### Sending commands without a typed wrapper

`RpcClient` provides typed helpers for the most common commands plus several lower-level helpers:

- **`client.requestInternal<T>(command)`:** Sends any [`RpcCommand`](/rpc/protocol#commands) and unwraps its response `data`. Use this for protocol commands without a dedicated typed wrapper on `RpcClient` (`set_scoped_models`, `pause_queued_messages`, `resume_queued_messages`, `abort_compaction`, `abort_branch_summary`, `import_session`, `navigate_tree`, `set_label`, `reload`, `get_shortcuts`, `invoke_shortcut`, `stop_all_background`, and OAuth `login_provider` with `authType: "oauth"`).
- **`client.userBashWithUpdates(command, onUpdate, options?)`:** Streams correlated `stdout`/`stderr` deltas and supports `excludeFromContext` and `onRequestId` (by contrast, `client.bash(command)` does not expose `excludeFromContext`).
- **`client.getEntries({ windowOnly: true })`:** Sends `get_context_window` instead of `get_entries`.
- **`client.findQueuedMessages(query)`:** Checks which queued message IDs were committed to the session store after a sequence number.
- **`client.getStderr()`:** Returns bounded stderr text captured from the child process for diagnostics.

<Warning>
Do **not** call `client.loginProvider(provider)` in standalone RPC mode: it omits `authType` (defaulting to `"api_key"`), which requires Atomic's interactive input host and fails in standalone `atomic --mode rpc`. Save API keys with `await client.saveProviderCredential(provider, { type: "api_key", key })`, or start OAuth login with `await client.requestInternal({ type: "login_provider", provider, authType: "oauth", loginId })`.
</Warning>

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

### Isolating subprocess storage

Pass `--storage-file <path>`, `--session-store <path>`, or `ATOMIC_STORAGE` in `RpcClientOptions` to give each RPC subprocess its own session store without editing user settings (see [Selecting storage per process](/storage#selecting-storage-per-process) and [Configure session storage](/sdk/storage)):

```typescript
import { fileURLToPath } from "node:url";
import { RpcClient } from "@bastani/atomic";

const client = new RpcClient({
  runtimeExecutable: process.execPath,
  cliPath: fileURLToPath(import.meta.resolve("@bastani/atomic/rpc-entry")),
  args: ["--session-store", "./rpc-sessions.sqlite", "--session-prefix", "job_"],
  // Or select shared storage via env (or args: ["--storage-file", "/etc/atomic/storage.json"]):
  // env: { ...process.env, ATOMIC_STORAGE: JSON.stringify({ path: "./rpc-sessions.sqlite" }) },
});
```

Invalid storage flags or environment values fail subprocess startup with `StorageConfigError` before RPC commands are accepted.

### Catching rehydrated typed errors

`RpcClient` automatically rehydrates structured `errorCode` responses (`"compaction_error"`, `"missing_session_cwd"`, `"debug_error"`, and `"credential_synchronization"`; see [Error handling](/rpc/protocol#error-handling)) back into their exported error classes:

```typescript
import {
  CredentialSynchronizationError,
  isCompactionError,
  isDebugError,
  isMissingSessionCwdError,
} from "@bastani/atomic";

try {
  await client.switchSession(savedSessionId);
  await client.compact();
} catch (error) {
  if (isCompactionError(error) && error.code === "nothing-to-compact") {
    console.log("Nothing new to compact.");
  } else if (isMissingSessionCwdError(error)) {
    await client.switchSession(savedSessionId, error.issue.fallbackCwd);
  } else if (isDebugError(error) || error instanceof CredentialSynchronizationError) {
    console.error(error.message);
  } else {
    throw error;
  }
}
```

## Standalone Node.js client

This ESM script spawns an installed `atomic --mode rpc` binary without importing `@bastani/atomic`, parses stdout with strict LF-only JSONL framing (avoiding Node's `readline`, which splits on `U+2028` and `U+2029`), checks `disposition` on the `prompt` response, aborts on `SIGINT`, and closes stdin cleanly once `agent_settled` arrives:

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

  if (event.type === "response" && event.id === "p-1") {
    if (!event.success) {
      console.error(event.error);
      agent.stdin.end();
    } else if (event.data?.disposition === "handled") {
      agent.stdin.end();
    }
    return;
  }

  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }

  if (event.type === "agent_settled") {
    process.stdout.write("\n");
    agent.stdin.end();
  }
});

agent.stdin.write(JSON.stringify({ id: "p-1", type: "prompt", message: "Hello" }) + "\n");

process.on("SIGINT", () => {
  agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```
