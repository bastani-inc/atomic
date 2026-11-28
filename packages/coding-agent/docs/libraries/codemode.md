---
title: "@bastani/atomic-codemode"
sidebarTitle: "@bastani/atomic-codemode"
description: "Run model-written JavaScript in a QuickJS WebAssembly sandbox whose only capability is calling injected tools."
---

Runs model-written JavaScript inside a QuickJS WebAssembly VM whose only capability is calling injected tools. Nested tool calls stay outside the LLM context; only the script's output and return value enter the conversation. Atomic uses this library for its built-in [`codemode` tool](/codemode), and it has zero dependencies on other Atomic packages. See [Standalone libraries](/libraries) for all standalone packages.

## Installation

```bash
npm install @bastani/atomic-codemode
```

Requires Node.js 24.20+ (or Bun / Cloudflare Workers via the portable subpaths). Public entry points:

- **`@bastani/atomic-codemode`:** `CodemodeSandbox`, `loadQuickJSWasm`, `parseCodemodeSource`, `renderDeclarations`, and worker runtime for Node and Bun.
- **`@bastani/atomic-codemode/portable`:** `RemoteCodemodeSandbox` and `InlineCodemodeSandbox` with zero Node.js imports.
- **`@bastani/atomic-codemode/cloudflare`:** `CodemodeSandboxDurableObject` and `createInlineCodemodeSandbox` for Cloudflare Workers.
- **`@bastani/atomic-codemode/declarations`:** Lightweight `renderDeclarations()` with no worker or WebAssembly dependencies.
- **`@bastani/atomic-codemode/source`:** Lightweight `parseCodemodeSource()`, `CodemodeSourceError`, and `CODEMODE_SOURCE_GRAMMAR`.
- **`@bastani/atomic-codemode/worker`:** Worker entrypoint for bundled Node/Bun hosts.

Three sandbox classes share the same API, script environment, and result format:

| Environment | Sandbox | Import from | Where scripts run |
| --- | --- | --- | --- |
| Node and Bun | `CodemodeSandbox` | `@bastani/atomic-codemode` | A worker thread per execution |
| Cloudflare Workers / Durable Objects | `RemoteCodemodeSandbox` | `@bastani/atomic-codemode/portable` | A Durable Object in a separately deployed Worker |
| Other WASM runtimes / single-request Workers | `InlineCodemodeSandbox` | `@bastani/atomic-codemode/portable` (or `/cloudflare`) | The calling thread (blocks caller during compute) |

## Usage on Node and Bun

```ts
import { readFile } from "node:fs/promises";
import { CodemodeSandbox } from "@bastani/atomic-codemode";

const sandbox = new CodemodeSandbox({
  timeoutMs: 60_000,
  tools: [
    {
      name: "read",
      execute: async (args, { signal }) => {
        const { path } = args as { path: string };
        return await readFile(path, { encoding: "utf8", signal });
      },
    },
  ],
});

const result = await sandbox.execute(`
  const source = await tools.read({ path: "package.json" });
  text("bytes " + source.length);
  return JSON.parse(source).name;
`);

console.log(result.output); // [{ type: "text", text: "bytes 1234" }]
if (result.ok) console.log(result.value); // "@bastani/atomic-codemode"
else console.error(result.error.kind, result.error.message);

await sandbox.close();
```

`code` runs as the body of an async function, so `return` and top-level `await` work. Inside the script, every sandbox provides:

- **`tools.<name>(args)`:** Returns a promise; arguments and results pass through JSON round trips. Rejected `Error` instances cross into the script with the same message plus any extra JSON-serializable own properties (such as `code`, excluding `name`, `message`, and `stack`). Hyphenated or special names are also exposed via `toCodemodeIdentifier`, so `my-tool` works as both `tools.my_tool` and `tools["my-tool"]`.
- **`ALL_TOOLS`:** Array of `{ name, description }` for every tool, using the identifier form for `name`.
- **`text(value)` and `console.*`:** `text()` appends a text item to `result.output` (JSON-stringifying non-strings); `console.log`/`info`/`warn`/`error`/`debug` append text items with `console: true`.
- **`image(urlOrItem)`:** Appends an image item from a base64 `data:` URL, `{ image_url }`, or an image block (`{ type: "image", data, mimeType }`). Remote URLs are rejected.
- **`exit()`:** Ends the script immediately with a successful result, preserving output and store writes.
- **`globals`:** Optional host helpers callable as top-level functions (or dotted `namespace.member` on a frozen object) that are not recorded in `result.calls`. Reserved names (`tools`, `ALL_TOOLS`, `console`, `text`, `image`, `exit`, `globalThis`, `store`, `load`) cannot be shadowed. Set `spread: true` to pass all arguments as an array, and `signature` to customize the generated declaration.
- **`store(key, value)` / `load(key)`:** Synchronous JSON key-value store across runs (see [Store](#store)).
- **Frozen built-in prototypes:** Built-in prototypes (`Object.prototype`, `Array.prototype`, etc.) are frozen before execution; monkey-patching throws a `TypeError` (instance overrides of `constructor`, `name`, `message`, `toString`, `toLocaleString`, `valueOf`, and `toJSON` remain allowed).
- **No ambient capabilities:** No timers, `fetch`, `process`, `require`, modules, or `WebAssembly`. `eval` and `Function` evaluate only inside the same VM.

When `timeoutMs` is omitted, `CodemodeSandbox` defaults to `300,000` ms (5 minutes). Pass `timeoutMs: Infinity` to disable the deadline so scripts run until completion or `signal` abort. A script that awaits a promise nothing can settle fails immediately instead of hanging. `memoryLimitBytes` caps the VM heap (`InternalError: out of memory` when exceeded).

<Note>
**Worker termination and concurrency limits:** Aborts, timeouts, and `close()` request worker termination and unref the worker without waiting for it to exit. On Bun, long-running built-ins such as `String.prototype.indexOf` may not poll QuickJS's interrupt handler and can delay process exit until the built-in returns. Use `onWorkerStarted(exited)` to hold concurrency slots until actual worker exit, or `acquireWorker()` (synchronous callback called immediately before creating each worker; throw to reject admission, or return a release callback) to enforce shared admission limits across sandbox instances.
</Note>

## Store

`store()` and `load()` let scripts carry JSON state across executions without the sandbox persisting anything itself. Pass saved values in `options.store`, and apply `result.storeWrites` (`{ set, delete }`) when `result.ok` is `true` (failed executions report no writes):

```ts
const result = await sandbox.execute(`store("runs", (load("runs") ?? 0) + 1)`, { store: saved });
if (result.ok) {
  for (const key of result.storeWrites.delete) delete saved[key];
  Object.assign(saved, result.storeWrites.set);
}
```

`load()` returns a copy so mutations do not affect the store, and storing `undefined` deletes a key. Individual values cap at `MAX_STORE_VALUE_CHARS` (256 Ki) JSON characters, and total stored data caps at `MAX_STORE_TOTAL_CHARS` (1 Mi) characters (`RangeError` inside the script when exceeded).

## Source format

`parseCodemodeSource()` accepts an optional `// @options:` JSON header on line 1:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
const source = await tools.read({ path: "package.json" });
text(JSON.parse(source).name);
```

Supported header fields (snake_case):

- `max_output_tokens`: non-negative safe integer (`>= 0`), returned as `options.maxOutputTokens`.
- `timeout_ms`: positive safe integer, returned as `options.timeoutMs`.

`parseCodemodeSource()` returns `{ code, options: { maxOutputTokens?, timeoutMs? } }` and replaces line 1 with a blank line so stack-trace line numbers match the input. Empty input, invalid JSON, unknown fields, header-only input, or a header after line 1 throws `CodemodeSourceError`. `CODEMODE_SOURCE_GRAMMAR` exports a Lark grammar for grammar-constrained tool calling (both also exported from `@bastani/atomic-codemode/source`). The sandbox does not enforce these parsed options automatically; your caller applies them.

## Declarations for the model

Tools and globals can carry `description`, `inputSchema`, and `outputSchema` (JSON Schema). `renderDeclarations()` generates compact TypeScript declarations for a model-facing tool description:

```ts
renderDeclarations({ tools: sandbox.tools, globals: sandbox.globals });
// declare const tools: {
//   /** Read a file */
//   read(args: {
//     path: string;
//   }): Promise<string>;
// };
```

Property descriptions render as `//` comments, and extra JSON Schema constraints render as tags (`// @integer @minimum 1 @default 20`, dropped first if a declaration hits the size limit). Local `$ref`s (`#/$defs/...`, `#/definitions/...`) expand inline; recursive and remote references render as `unknown`. Schemas shape declarations only—they do not validate runtime values.

## Results

`execute()` never rejects for script failures. When `result.ok` is `false`, `result.error.kind` is one of:

| Kind | Meaning |
| --- | --- |
| `script` | The script threw or failed to parse (`stack` references `codemode.js:<line>`). |
| `timeout` | The deadline expired or the interrupt budget ran out, and VM shutdown was requested. |
| `aborted` | `options.signal` fired or `close()` was called, and VM shutdown was requested. |
| `sandbox` | The VM or its transport failed (WebAssembly trap, missing worker file, or failed remote). |

`result.output` holds text and image blocks in production order (including on failures), capped at `MAX_OUTPUT_CHARS` (16 Mi characters) and `MAX_OUTPUT_ITEMS` (100,000 items)—exceeding either fails the script with an uncatchable `RangeError`.

`result.calls` records every tool call with `status: "ok" | "error" | "cancelled"`. Any unawaited call still running when the script returns is aborted via its `signal` and recorded as `"cancelled"`.

## Using with agent-core

Expose an [`@bastani/atomic-agent-core`](/libraries/agent-core) `Agent`'s tools to a sandbox and wrap `execute()` as an `AgentTool`:

```ts
import type { AgentTool } from "@bastani/atomic-agent-core";
import {
  type CodemodeJsonSchema,
  CodemodeSandbox,
  type CodemodeTool,
  renderDeclarations,
} from "@bastani/atomic-codemode";
import { obj, str } from "@bastani/atomic-schema";

const sandboxTools: CodemodeTool[] = agentTools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.parameters as CodemodeJsonSchema,
  outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
  execute: async (args, { signal }) => {
    const result = await tool.execute("nested", args as never, signal);
    if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
    return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  },
}));

const codemodeTool: AgentTool = {
  name: "codemode",
  label: "Codemode",
  description: `Run JavaScript that calls tools as \`await tools.<name>(args)\`. Output with text() or return.\n\n${renderDeclarations({ tools: sandboxTools })}`,
  parameters: obj({ code: str() }),
  execute: async (_toolCallId, { code }, signal) => {
    const sandbox = new CodemodeSandbox({ tools: sandboxTools });
    try {
      const result = await sandbox.execute(code, { signal });
      const content = [...result.output];
      if (result.ok && result.value !== undefined) content.push({ type: "text", text: JSON.stringify(result.value) });
      if (!result.ok) content.push({ type: "text", text: result.error.stack ?? result.error.message });
      return { content, details: undefined, isError: !result.ok };
    } finally {
      await sandbox.close();
    }
  },
};
```

`result.output` items already match `@bastani/atomic-ai`'s `TextContent` and `ImageContent`. Calling `tool.execute()` directly bypasses `beforeToolCall` and `afterToolCall`; route nested calls through `runToolCall()` from `@bastani/atomic-agent-core` so argument validation and hooks apply consistently:

```ts
import { type Agent, type AgentToolCallOutcome, runToolCall } from "@bastani/atomic-agent-core";
import type { JsonObject } from "@bastani/atomic-ai";

function createNestedToolRunner(
  agent: Agent,
): (name: string, args: unknown, signal: AbortSignal) => Promise<AgentToolCallOutcome> {
  let nextId = 1;
  return (name, args, signal) => {
    const assistantMessage = agent.state.messages.findLast((message) => message.role === "assistant");
    if (assistantMessage?.role !== "assistant") throw new Error("Nested tool calls need an assistant message");
    const tools = agent.state.tools;
    return runToolCall(
      { type: "toolCall", id: `nested-${nextId++}`, name, arguments: (args ?? {}) as JsonObject },
      {
        tools,
        assistantMessage,
        context: { messages: agent.state.messages, tools },
        beforeToolCall: agent.beforeToolCall,
        afterToolCall: agent.afterToolCall,
        signal,
      },
    );
  };
}
```

Invoke the runner from each sandbox tool's `execute`, throwing when `outcome.isError` is `true` so the script catches the failure.

## Deterministic runs

`sandbox.start(code, options)` runs a script deterministically so a durable host can replay it after restarts from a log of call results (`execute()` is unaffected):

- **Time:** `Date.now()` starts at `startedAt` and advances monotonically from each delivered result's `now`; `performance.now()` counts from `startedAt`.
- **Randomness, timezone, and GC:** `Math.random()` uses `seed`, timezone is fixed to UTC, and `WeakRef`/`FinalizationRegistry` are absent.
- **Strict result order:** Results are delivered with sequential numbers (`1`, `2`, ...) and applied in exact order regardless of transport arrival.

```ts
const run = sandbox.start(code, {
  startedAt: Date.now(),
  seed: 7,
  tools: [{ name: "read", description: "Read a file" }],
  onStarted: (_fingerprint) => {}, // engine versions, prelude hash, limits
  onCall: (call) => {
    void readFile(call.args).then((content) =>
      run.deliver(nextResult++, Date.now(), call.id, { ok: true, value: content }),
    );
  },
  onIdle: (_seq, _issued) => {},
});
const result = await run.result;
```

Deterministic runs have no deadline unless `timeoutMs` is passed. Replaying the same script, `startedAt`, `seed`, tools, globals, store, and ordered results produces identical calls and output on any VM with the same fingerprint. Abort `signal` to terminate a run with an uncatchable error.

## Bundled Node and Bun hosts

By default, `CodemodeSandbox` reads `quickjs-wasi/quickjs.wasm` and starts its worker file next to this package. In bundled executables, pass both explicitly:

```ts
import { CodemodeSandbox, loadQuickJSWasm } from "@bastani/atomic-codemode";

const sandbox = new CodemodeSandbox({
  tools,
  wasm: loadQuickJSWasm(pathToQuickJSWasm), // compiled once per path and cached
  workerUrl: new URL("./codemode-worker.js", import.meta.url), // file containing `import "@bastani/atomic-codemode/worker";`
});
```

For Bun compiled executables, include the worker as an additional build entrypoint and pass its relative source path as a string (such as `"./src/codemode-worker.ts"`).

## Usage on Cloudflare Workers

Cloudflare Workers cannot spawn Node worker threads or compile WebAssembly at runtime. Use `RemoteCodemodeSandbox` (from `@bastani/atomic-codemode/portable`, which has zero Node imports) paired with `CodemodeSandboxDurableObject` (from `@bastani/atomic-codemode/cloudflare`) in a **separate** Worker so synchronous QuickJS compute bursts never block your agent session's Durable Object.

A complete deployment example lives in [`packages/codemode/examples/cloudflare`](https://github.com/bastani-inc/atomic/tree/main/packages/codemode/examples/cloudflare).

### Deploying the sandbox Worker

```ts
// sandbox/src/index.ts
export { CodemodeSandboxDurableObject as CodemodeSandbox } from "@bastani/atomic-codemode/cloudflare";

export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
```

```jsonc
// sandbox/wrangler.jsonc
{
  "name": "atomic-codemode-sandbox",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-22",
  "workers_dev": false,
  "preview_urls": false,
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["CodemodeSandbox"] }],
  "limits": { "cpu_ms": 60000 }
}
```

Install `@bastani/atomic-codemode` and run `npx wrangler deploy`. Wrangler bundles QuickJS (~640 KB) as a precompiled WebAssembly module; the Durable Object stores no state.

### Calling it from the agent Worker

Bind the class using `script_name` (binding a class in the agent's own Worker would reintroduce main-thread blocking):

```jsonc
// agent/wrangler.jsonc
"durable_objects": {
  "bindings": [
    { "name": "CODEMODE_SANDBOX", "class_name": "CodemodeSandbox", "script_name": "atomic-codemode-sandbox" }
  ]
}
```

```ts
import type { CodemodeSandboxDurableObject } from "@bastani/atomic-codemode/cloudflare";
import { RemoteCodemodeSandbox } from "@bastani/atomic-codemode/portable";

interface Env {
  CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
}

const sandbox = new RemoteCodemodeSandbox({
  tools,
  timeoutMs: 60_000,
  remote: () => env.CODEMODE_SANDBOX.getByName(sessionId), // or crypto.randomUUID() for one DO per execution
});
const result = await sandbox.execute(code, { signal, store });
```

Import `RemoteCodemodeSandbox` from `/portable` in the agent Worker so QuickJS is not bundled there. Run both Workers locally with `wrangler dev -c agent/wrangler.jsonc -c sandbox/wrangler.jsonc`.

### Cloudflare limits and inline execution

- **Interrupt budget:** Tight loops without tool calls are bounded by `DEFAULT_INTERRUPT_BUDGET` (`100,000` polls, ~10 seconds on Workers) and fail with `kind: "timeout"`. Keep this below the Worker's `cpu_ms` limit so scripts fail cleanly instead of resetting the Durable Object.
- **Memory & caps:** Default 32 MiB per VM (shared within the isolate's 128 MB cap). Subclass `CodemodeSandboxDurableObject` and override `protected maxInterruptBudget` / `protected maxMemoryLimitBytes` to adjust caps.
- **Aborts, timeouts, and billing:** `timeoutMs` and `signal` settle immediately in the caller (`kind: "timeout"` or `"aborted"`); the remote VM stops at its next tool call or interrupt budget. Each execution bills one Durable Object request for wall-clock duration.
- **Calling thread (`InlineCodemodeSandbox`):** When blocking a stateless request Worker is acceptable, use `createInlineCodemodeSandbox({ tools, timeoutMs, interruptBudget })` from `@bastani/atomic-codemode/cloudflare` (lowers QuickJS's stack guard to 256 KiB; blocks the caller during compute).

## How it works

Each `CodemodeSandbox.execute()` spawns a worker thread that instantiates a fresh QuickJS WebAssembly instance with its own linear memory, importing only a minimal WASI shim (clock, random, discarded stdio) and one host-call bridge. Tool calls travel to the host thread over worker messages; timeouts and aborts set a shared interrupt flag polled by QuickJS and call `worker.terminate()`.

### Runtime notes

- Node and Bun enforce memory limits, interrupts, and catchable `RangeError` stack guards for deep recursion.
- Stack traces use QuickJS frames (`at f (codemode.js:2:31)`), prefixed with `Name: message` like V8; line numbers match the script (column numbers on line 1 are shifted by the async wrapper prefix).
- QuickJS is an interpreter: glue code and result filtering run quickly, while heavy CPU computation is slower than in V8.
