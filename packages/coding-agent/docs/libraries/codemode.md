---
title: "@bastani/atomic-codemode"
sidebarTitle: "@bastani/atomic-codemode"
description: "Run model-written JavaScript in a QuickJS WebAssembly sandbox whose only capability is calling injected tools."
---

Runs model-written JavaScript in a QuickJS VM (compiled to WebAssembly) where the only capability is calling injected tools. Nested tool calls never enter the LLM context; only the script's output and return value do. See [Standalone libraries](/libraries) for all standalone packages.

## Installation

```bash
npm install @bastani/atomic-codemode
```

Requires Node.js 24.20+ (or Bun / Cloudflare Workers via the portable subpaths). Available package entry points:

- `@bastani/atomic-codemode`: `CodemodeSandbox`, `loadQuickJSWasm`, `parseCodemodeSource`, `renderDeclarations`, and worker runtime for Node and Bun.
- `@bastani/atomic-codemode/portable`: `RemoteCodemodeSandbox` and `InlineCodemodeSandbox` with zero Node.js imports.
- `@bastani/atomic-codemode/cloudflare`: `CodemodeSandboxDurableObject` and `createInlineCodemodeSandbox` for Cloudflare Workers.
- `@bastani/atomic-codemode/declarations`: lightweight `renderDeclarations()` without worker or WebAssembly dependencies.
- `@bastani/atomic-codemode/source`: lightweight `parseCodemodeSource()`, `CodemodeSourceError`, and `CODEMODE_SOURCE_GRAMMAR`.
- `@bastani/atomic-codemode/node-options`: Node worker option helpers.
- `@bastani/atomic-codemode/worker`: worker entrypoint for bundled hosts.

Scripts use `tools`, `ALL_TOOLS`, `text`, `image`, `exit`, `store`, and `load`, and may start with a `// @options:` line. Atomic uses it for its built-in [`codemode` tool](/codemode). It has no dependency on the other Atomic packages and can be used on its own to expose any functions (remote APIs, MCP servers, application services) to model-written scripts.

The package runs in two kinds of environments. Each has its own sandbox class, but they share one API, one script environment, and one result format:

| Environment | Sandbox | Import from | Where scripts run |
| --- | --- | --- | --- |
| Node and Bun | `CodemodeSandbox` | `@bastani/atomic-codemode` | a worker thread per execution |
| Cloudflare Workers and Durable Objects | `RemoteCodemodeSandbox` | `@bastani/atomic-codemode/portable` | a Durable Object in a separately deployed Worker |

See [Usage on Node and Bun](#usage-on-node-and-bun) and [Usage on Cloudflare Workers](#usage-on-cloudflare-workers). A third sandbox, `InlineCodemodeSandbox`, runs scripts on the calling thread for other runtimes, or on Cloudflare when blocking the caller is acceptable.

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

`code` is the body of an async function, so `return` and top-level `await` work. Inside the script, every sandbox provides:

- `tools.<name>(args)` returns a promise. Arguments and results go through a JSON round trip. When a tool rejects with an `Error`, the script catches an `Error` with the same message plus any extra JSON-serializable own properties from that error (such as `code`, excluding `name`, `message`, and `stack`). Tool names are also exposed as identifiers with invalid characters replaced by `_` via `toCodemodeIdentifier`, so `my-tool` is available as both `tools.my_tool` and `tools["my-tool"]`.
- `ALL_TOOLS` lists `{ name, description }` for every tool, using the identifier form for `name`.
- `text(value)` appends a text item to `result.output`, JSON-stringifying non-string values. `console.log`, `info`, `warn`, `error`, and `debug` append text items with `console: true`.
- `image(urlOrItem)` appends an image item. It accepts a base64 `data:` URL, `{ image_url }`, or an image block (`{ type: "image", data, mimeType }`, as MCP tools and `@bastani/atomic-ai` produce). Remote URLs are rejected.
- `exit()` ends the script immediately with a successful result, keeping its output and store writes.
- `globals` passed to the sandbox are callable as top-level functions, such as a host helper `image(ref)`. They behave like tools but are not recorded in `result.calls`. Global names must be valid JavaScript identifiers (or dotted `namespace.member` forms, placing the function on a frozen namespace object) and cannot collide with reserved names: `tools`, `ALL_TOOLS`, `console`, `text`, `image`, `exit`, `globalThis`, `store`, or `load`. With `spread: true`, `execute` receives all call arguments as an array instead of only the first argument, and `signature` replaces the declaration generated from the schemas.
- `store(key, value)` and `load(key)` read and write JSON values synchronously. See [Store](#store).
- **Frozen built-in prototypes:** Before running scripts, the VM freezes built-in prototypes (`Object.prototype`, `Array.prototype`, and others, while still allowing instance overrides of `constructor`, `name`, `message`, `toString`, `toLocaleString`, `valueOf`, and `toJSON`). Scripts that attempt to monkey-patch built-in prototypes throw a `TypeError`.
- Nothing else is available. There are no timers, `fetch`, `process`, `require`, modules, or `WebAssembly`. `eval` and `Function` work, but they only evaluate code inside the same VM.

When `timeoutMs` is omitted, `CodemodeSandbox` uses `DEFAULT_TIMEOUT_MS` (`300_000` ms, or 5 minutes). Setting `timeoutMs: Infinity` disables the deadline so the script runs until it settles or `signal` aborts it. A script that awaits a promise nothing can settle (with no tool call pending and no timers or I/O in the VM) fails immediately instead of hanging.

`memoryLimitBytes` caps the VM heap. Allocations beyond that limit fail inside the script with `InternalError: out of memory`.

Aborts, timeouts, and `close()` request worker termination without waiting for the worker to exit. On Bun, a built-in such as a long `String.prototype.indexOf` may not poll QuickJS's interrupt handler, so its worker can continue computing until the built-in returns.

Stopping unrefs the worker after requesting termination because `terminate()` refs it internally. That does not guarantee computation has stopped, and on Bun a pending `terminate()` can still delay host process exit. Cancellation results and `close()` never wait for worker exit.

Hosts that limit concurrency can track actual worker lifetime with `onWorkerStarted(exited)`, called for each worker started by `execute()` or `start()`. Its promise resolves when that worker exits, not when the script result settles:

```ts
const workers = new Set<Promise<void>>();
const sandbox = new CodemodeSandbox({
	onWorkerStarted(exited) {
		workers.add(exited);
		void exited.then(() => workers.delete(exited));
	},
});
```

Keep a concurrency slot occupied until `exited` resolves. `close()` does not wait for these promises.

To enforce an admission limit, pass `acquireWorker()`. It runs synchronously after WASM loading, immediately before each worker is created. Throw to reject the execution without starting a worker; otherwise return a release callback. The sandbox calls it once on actual worker exit or if the worker constructor fails. Share reservation state across sandbox instances, and do not release it when a script result settles.

## Store

`store()` and `load()` let scripts keep values across executions. The sandbox does not persist anything itself. Pass the current values in `options.store`, and a successful result returns what the script changed in `result.storeWrites` (`{ set, delete }`). Failed executions report no writes.

```ts
const result = await sandbox.execute(`store("runs", (load("runs") ?? 0) + 1)`, { store: saved });
if (result.ok) {
	for (const key of result.storeWrites.delete) delete saved[key];
	Object.assign(saved, result.storeWrites.set);
}
```

`load()` returns a copy, so mutating it does not change the store. Storing `undefined` deletes the key. Each stored value may be at most `MAX_STORE_VALUE_CHARS` (256 Ki) characters of JSON, and all stored values together may be at most `MAX_STORE_TOTAL_CHARS` (1 Mi) characters. Larger writes throw a `RangeError` inside the script.

## Source format

`parseCodemodeSource()` accepts a script whose first line may be an options line:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
const source = await tools.read({ path: "package.json" });
text(JSON.parse(source).name);
```

Supported JSON fields on the `// @options:` header line are snake_case:

- `max_output_tokens`: non-negative safe integer (`>= 0`; `0` is valid), returned as `options.maxOutputTokens`.
- `timeout_ms`: positive safe integer from `1` to `2,147,483,647`, returned as `options.timeoutMs`.

`parseCodemodeSource()` returns `{ code, options: { maxOutputTokens?, timeoutMs? } }`. The sandbox does not enforce these limits itself; the caller decides how to apply them. The options line is replaced by a blank line so line numbers in stack traces still match the input.

Empty input, invalid JSON, unknown fields, an options line without code, or an options line after line 1 throw `CodemodeSourceError`. `CODEMODE_SOURCE_GRAMMAR` is a Lark grammar for providers that support grammar-constrained tool input. Both exports are also available from the lightweight `@bastani/atomic-codemode/source` entry.

## Bundled Node and Bun hosts

By default, `CodemodeSandbox` loads `quickjs-wasi/quickjs.wasm` from the installed package and starts the worker file next to this package's module. Neither exists on disk in a bundled host, so pass both explicitly:

```ts
import { CodemodeSandbox, loadQuickJSWasm } from "@bastani/atomic-codemode";

const sandbox = new CodemodeSandbox({
	tools,
	// Compiled once per path and cached.
	wasm: loadQuickJSWasm(pathToQuickJSWasm),
	// A file of your build containing `import "@bastani/atomic-codemode/worker";`
	workerUrl: new URL("./codemode-worker.js", import.meta.url),
});
```

`workerUrl` accepts a `URL` or string. For a Bun compiled executable, include the worker as an additional build entrypoint and pass its relative source path as a string, such as `"./src/codemode-worker.ts"`. Bun resolves that form from its embedded module graph.

## Usage on Cloudflare Workers

`CodemodeSandbox` requires Node or Bun because it starts a worker thread per script and reads the QuickJS binary from disk. Cloudflare Workers have neither, and they cannot compile WebAssembly at runtime. Two other sandboxes share the same API, script environment, and `CodemodeResult`, differing only in where the VM runs:

| Sandbox | Where the VM runs | Use it for |
| --- | --- | --- |
| `CodemodeSandbox` | A worker thread | Node and Bun |
| `RemoteCodemodeSandbox` | Another isolate, usually a Durable Object in a separate Worker | A Durable Object that runs an agent session |
| `InlineCodemodeSandbox` | The calling thread | Other runtimes with WebAssembly when blocking the caller is acceptable |

Import `RemoteCodemodeSandbox` and `InlineCodemodeSandbox` from `@bastani/atomic-codemode/portable`, which has no Node imports. On Cloudflare, `@bastani/atomic-codemode/cloudflare` adds the deployable Durable Object and the QuickJS module compiled by Wrangler.

### Why a separate Worker

QuickJS runs synchronously, so a script that computes holds its thread until it awaits a tool. Running the VM inside the session's Durable Object or inside a Dynamic Worker loaded by that object blocks other requests to the session object for the entire compute burst.

Running the VM in a Durable Object of a separately deployed Worker moves computation to another isolate and keeps the session object responsive. `RemoteCodemodeSandbox` keeps the tools and call records in the session and sends only the VM to the sandbox Worker. Each tool call travels back to the session over Workers RPC.

### Deploying the sandbox Worker

A complete setup is in [`packages/codemode/examples/cloudflare`](https://github.com/bastani-inc/atomic/tree/main/packages/codemode/examples/cloudflare). The sandbox Worker is one file:

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

Install `@bastani/atomic-codemode` in the sandbox Worker's project and run `npx wrangler deploy`. Wrangler bundles QuickJS (about 640 KB) as a compiled WebAssembly module. The object has no routes and keeps no state, and it never uses its storage.

### Using it from the agent's Worker

Bind the class with `script_name`. Binding a class exported from the agent's own Worker would bring back the blocking described above.

```jsonc
// agent/wrangler.jsonc
"durable_objects": {
	"bindings": [
		{ "name": "CODEMODE_SANDBOX", "class_name": "CodemodeSandbox", "script_name": "atomic-codemode-sandbox" }
	]
}
```

Then replace the sandbox. Tools, options other than the worker-specific `wasm`, `workerUrl`, `acquireWorker`, and `onWorkerStarted`, and results stay the same:

```ts
import type { CodemodeSandboxDurableObject } from "@bastani/atomic-codemode/cloudflare";
import { RemoteCodemodeSandbox } from "@bastani/atomic-codemode/portable";

interface Env {
	CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
}

// Before: new CodemodeSandbox({ tools, timeoutMs: 60_000 })
const sandbox = new RemoteCodemodeSandbox({
	tools,
	timeoutMs: 60_000,
	remote: () => env.CODEMODE_SANDBOX.getByName(sessionId),
});
const result = await sandbox.execute(code, { signal, store });
```

Import the sandbox from `/portable` in the agent's Worker. Importing `/cloudflare` would also bundle QuickJS there. `remote` is called once per execution and picks the Durable Object that runs it.

- **One object per session**, `getByName(sessionId)`, keeps a session's scripts together. Two scripts of the same session take turns on one thread.
- **One object per execution**, `getByName(crypto.randomUUID())`, runs every script on its own.

Run both Workers locally with `wrangler dev -c agent/wrangler.jsonc -c sandbox/wrangler.jsonc`.

### Limits on Cloudflare

- **Interrupt budget.** While a script computes without calling a tool, no timer runs and `Date.now()` does not advance. A script that never yields is bounded by the interrupt budget rather than `timeoutMs`. QuickJS polls an interrupt handler while running, and the sandbox counts polls. Past the budget, execution fails with `kind: "timeout"`.
   * The default `DEFAULT_INTERRUPT_BUDGET` of 100,000 polls allows roughly 10 seconds of a tight loop on Cloudflare Workers.
   * Keep the budget below the Worker's `cpu_ms` limit (30 seconds by default). Hitting that limit resets the Durable Object instead of failing only the script.
- **Memory.** Each VM may use up to 32 MiB by default. All VMs in one isolate share its 128 MB limit.
- **Changing the limits.** The Durable Object caps every request at its own limits regardless of what the client requests. Subclass it in the sandbox Worker to raise or lower those caps:

```ts
import { CodemodeSandboxDurableObject } from "@bastani/atomic-codemode/cloudflare";

export class CodemodeSandbox extends CodemodeSandboxDurableObject {
	protected maxInterruptBudget = 200_000;
	protected maxMemoryLimitBytes = 64 * 1024 * 1024;
}
```

- **Aborts and timeouts.** `timeoutMs` and `signal` end execution in the caller immediately with `kind: "timeout"` or `kind: "aborted"`. The remote VM stops at its next tool call, or keeps running until it calls a tool or exhausts its interrupt budget.
- **Billing.** Each execution is one Durable Object request. The sandbox object is billed for wall-clock duration while an execution runs, including time spent waiting on tools.

### On the calling thread

When blocking the caller is acceptable, such as in a stateless Worker serving a single request, run the VM on the caller's thread instead with no extra deployment:

```ts
import { createInlineCodemodeSandbox } from "@bastani/atomic-codemode/cloudflare";

const sandbox = createInlineCodemodeSandbox({ tools, timeoutMs: 60_000, interruptBudget: 50_000 });
const result = await sandbox.execute(code);
```

`createInlineCodemodeSandbox()` passes the Wrangler-compiled QuickJS module to `InlineCodemodeSandbox`. With another bundler, import `InlineCodemodeSandbox` from `/portable` and pass your own compiled module as `wasm`.

- **Blocking.** A script that computes blocks the caller until it awaits a tool or exhausts its `interruptBudget`.
- **Stack.** QuickJS's stack guard is lowered to 256 KiB so deep recursion trips before the caller's smaller stack overflows.

## Declarations for the model

Tools and globals can carry `description`, `inputSchema`, and `outputSchema` (JSON Schema). `renderDeclarations()` turns them into TypeScript declarations for a model-facing tool description:

```ts
renderDeclarations({ tools: sandbox.tools, globals: sandbox.globals });
// declare const tools: {
//   /** Read a file */
//   read(args: {
//     path: string;
//   }): Promise<string>;
// };
```

Property descriptions become `//` comments. Constraints the type cannot express follow as tags, such as `// @integer @minimum 1 @default 20`; they are dropped first when a type exceeds the size limit. Schemas only shape the declarations; values are not validated against them. Local references (`#/$defs/...`, `#/definitions/...`) are expanded; recursive and remote references render as `unknown`.

## Using with agent-core

To give an [`@bastani/atomic-agent-core`](/libraries/agent-core) `Agent` a codemode tool, expose its other tools to the sandbox and wrap `execute()` as an `AgentTool`:

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

`result.output` items already have the shape of `@bastani/atomic-ai`'s `TextContent` and `ImageContent`. Calling `tool.execute()` directly skips the agent's `beforeToolCall` and `afterToolCall` hooks. To apply them to nested calls too, run each call through `runToolCall()` from `@bastani/atomic-agent-core`. It runs argument validation and the agent's hooks as for a call the model makes, and returns failures as `isError: true` instead of throwing:

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

Call the runner from each sandbox tool's `execute` instead of `tool.execute()`, and throw when the outcome has `isError: true` so the script sees the failure.

## Deterministic runs

`sandbox.start(code, options)` runs a script so that a host can run it again after a restart and get the same behavior, for example to resume it from a durable log of its calls' results. `execute()` is unaffected.

The VM only runs when the host hands it something, and has no timers or I/O, so it is deterministic except for what it reads from its environment. `start()` fixes that:

- **Time.** `Date.now()` reads `startedAt`, then the `now` of each delivered result without ever going backwards. `performance.now()` counts from `startedAt`.
- **Randomness.** `Math.random()` and the VM's other randomness come from `seed`.
- **Timezone.** The VM always uses UTC, regardless of the host timezone.
- **Garbage collection.** `WeakRef` and `FinalizationRegistry` are absent.
- **Result order.** The host answers each call with a sequential result number (`1`, `2`, ...), and the VM applies results strictly in that order regardless of transport delivery order.

The run declares its own tools and globals, and the host answers every call itself:

```ts
const run = sandbox.start(code, {
	startedAt: Date.now(),
	seed: 7,
	tools: [{ name: "read", description: "Read a file" }],
	onStarted: (fingerprint) => {}, // what the VM is: engine versions, prelude hash, limits
	onCall: (call) => {
		// call.id is the VM's own number for the call, in the order the script made them.
		void readFile(call.args).then((text) => run.deliver(nextResult++, Date.now(), call.id, { ok: true, value: text }));
	},
	onIdle: (seq, issued) => {}, // after result `seq` (0: the first run), `issued` calls in total
});
const result = await run.result;
```

A run has no deadline unless `timeoutMs` is given. Result numbers must run 1, 2, ... without gaps. The same script, `startedAt`, `seed`, tools (with their `jsName`), globals and store, answered with the same results in the same order, makes the same calls with the same arguments and produces the same output on any VM with the same fingerprint. To end a run with an error the script cannot catch, abort its `signal`.

## Results

`execute()` never rejects for script failures. `result.error.kind` is one of:

| Kind | Meaning |
| --- | --- |
| `script` | The script threw or failed to parse. `stack` points at `codemode.js:<line>`. |
| `timeout` | The deadline expired or the interrupt budget ran out, and VM shutdown was requested. |
| `aborted` | `options.signal` fired or `close()` was called, and VM shutdown was requested. |
| `sandbox` | The VM or its transport failed, such as a WebAssembly trap, a missing worker file, or a failed remote. |

`result.output` holds text and image items in the order the script produced them, including for failed executions. Because the host retains all output until the script ends, output is capped at `MAX_OUTPUT_CHARS` (16 Mi) characters of text and base64 image data and `MAX_OUTPUT_ITEMS` (100,000) items. Past either limit, the script fails with a `RangeError` even if it catches the error.

`result.calls` lists every tool call with `status: "ok" | "error" | "cancelled"`. Any unawaited call still running when the script returns is aborted through its `signal` and reported as `cancelled`.

## How it works

This section describes `CodemodeSandbox`. The other sandboxes share the same host code, prelude, and VM, replacing only the worker thread. See [Usage on Cloudflare Workers](#usage-on-cloudflare-workers).

Each `execute()` starts a worker thread that instantiates a fresh QuickJS VM from the compiled WebAssembly module. Each VM is a separate WebAssembly instance with its own linear memory. Its only imports are a WASI shim (clock, random, and discarded stdout/stderr writes) and one host-call entry point, so the script can reach the host only through functions registered by the worker.

The worker evaluates a prelude inside the VM that holds the single host bridge in a closure and builds `tools`, `console`, and globals on top of it. The script compiles as an async function body.

Tool calls travel to the host thread as messages; the host runs each tool and posts the JSON result back. The host owns the deadline and abort signal. When either fires, it sets a shared interrupt flag that the VM polls and then calls `worker.terminate()`. The shared flag stops tight loops on Bun, where `terminate()` alone cannot stop a thread spinning inside WebAssembly.

Running scripts in a worker keeps execution off the host thread. Because QuickJS runs synchronously, a spinning script on the host thread would block its event loop.

## Runtime notes

- Node and Bun support memory limits, interrupts, and a catchable `RangeError` for deep recursion because QuickJS's stack guard is enabled. Bun may delay worker exit during non-interruptible built-ins, though script results do not wait for exit.
- Stack traces use QuickJS frames (`at f (codemode.js:2:31)`), prefixed with `Name: message` like V8. The wrapper prefix shares line 1 with the script, so line numbers are exact while column numbers on line 1 are shifted.
- QuickJS is an interpreter. Glue code and tool-result filtering run fast enough, while heavy computation is slower than in V8.
