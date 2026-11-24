---
title: "Write an extension"
sidebarTitle: "Write an extension"
description: "Structure an extension, persist state across reloads and restarts, register custom tools, and customize terminal rendering."
---

An extension exports a default factory function that receives `ExtensionAPI`. The parameter can have any name; older extensions and examples call it `pi`. The factory can be synchronous or asynchronous:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default function (atomic: ExtensionAPI) {
  // Subscribe to events
  atomic.on("event_name", async (event, ctx) => {
    const ok = await ctx.ui.confirm("Title", "Are you sure?");
    ctx.ui.notify("Done!", "info");
    ctx.ui.setStatus("my-ext", "Processing...");      // Footer status
    ctx.ui.setWidget("my-ext", ["Line 1", "Line 2"]); // Widget above editor (default)
  });

  // Register tools, commands, shortcuts, flags
  atomic.registerTool({ ... });
  atomic.registerCommand("name", { ... });
  atomic.registerShortcut("ctrl+x", { ... });
  atomic.registerFlag("my-flag", { ... });
}
```

Editable extensions support TypeScript without a separate build step. Running `/reload` picks up edits to your extension and local modules it imports; unchanged modules may retain module-scoped state.

Imports from Atomic's bundled core packages keep the running host's classes and shared state across `/reload`, including on Windows. The `@earendil-works/pi-coding-agent` compatibility import shares those exports with `@bastani/atomic`, so `instanceof` checks work across both names after reload. Restart Atomic after updating Atomic itself.

In Bun single-file builds, bundled built-in packages keep their module-scoped state across `/reload`. Restart Atomic to reload shipped code.

If your factory returns a `Promise`, Atomic awaits it before continuing startup. Async initialization completes before `session_start`, before `resources_discover`, and before provider registrations queued with `atomic.registerProvider()` are flushed.

## Async factory functions

Use an async factory for one-time startup work such as fetching remote configuration or discovering available models:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default async function (atomic: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_window?: number;
      max_tokens?: number;
    }>;
  };

  await atomic.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window ?? 128000,
      maxTokens: model.max_tokens ?? 4096,
    })),
  });
}
```

Models registered here become available during normal startup and in `atomic --list-models`.

## Long-lived resources and shutdown

Extension factories can run during commands that never start a full session, such as metadata commands or early configuration checks. Do not start child processes, sockets, file watchers, or timers directly inside the factory function.

Start background resources inside `session_start` or inside the command, tool, or event handler that needs them. Register an idempotent `session_shutdown` handler to close every resource you open.

## Extension layouts

**Single file.** Best for small extensions:

```text
~/.atomic/agent/extensions/
└── my-extension.ts
```

**Directory with `index.ts`.** Best for multi-file extensions:

```text
~/.atomic/agent/extensions/
└── my-extension/
    ├── index.ts        # Entry point (exports default function)
    ├── tools.ts        # Helper module
    └── utils.ts        # Helper module
```

**Package with dependencies.** Best for extensions that need npm packages:

```text
~/.atomic/agent/extensions/
└── my-extension/
    ├── package.json    # Declares dependencies and entry points
    ├── package-lock.json
    ├── node_modules/   # After dependency install
    └── src/
        └── index.ts
```

```json
{
  "name": "my-extension",
  "dependencies": {
    "zod": "^3.0.0",
    "chalk": "^5.0.0"
  },
  "atomic": {
    "extensions": ["./src/index.ts"]
  }
}
```

Use `"atomic"` as the manifest key (legacy `"pi"` is also accepted). Run `npm install` (or your package manager's install command) in the extension directory so imports from `node_modules/` resolve automatically.

## State management

Choose the store that matches the lifetime you need:

- **Tool result `details`.** Rebuilds state across `/branch`, `/tree`, and `/resume` from the conversation transcript.
- **`atomic.appendEntry()`.** Stores durable custom entries that survive process restarts without entering model context.
- **`sessionScopedExtensionState()`.** Keeps live in-memory objects alive across `/reload` within the current process (lost on process restart).

In Bun single-file builds, an editable file extension whose imported files have not changed can reuse its evaluated factory and keep module-scoped variables across `/reload`. Editing any file in that import graph re-evaluates its modules and resets those variables.

Extensions whose state must follow conversation branches should store a snapshot in tool result `details`:

```typescript
export default function (atomic: ExtensionAPI) {
  let items: string[] = [];

  // Reconstruct state from the active branch
  atomic.on("session_start", async (_event, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "my_tool") {
          items = entry.message.details?.items ?? [];
        }
      }
    }
  });

  atomic.registerTool({
    name: "my_tool",
    // ...
    async execute(_toolCallId, _params) {
      items.push("new item");
      return {
        content: [{ type: "text", text: "Added" }],
        details: { items: [...items] },
      };
    },
  });
}
```

### Session-scoped in-memory state

Import `sessionScopedExtensionState` from `@bastani/atomic` when an extension must keep a live object across `/reload`, such as a registry, abort controller, connection pool, or handle that cannot be rebuilt from the transcript:

```typescript
import { sessionScopedExtensionState, type ExtensionAPI } from "@bastani/atomic";

interface CounterState {
  count: number;
}

export default function (atomic: ExtensionAPI) {
  const state = sessionScopedExtensionState<CounterState>(atomic.events, "my-extension:counter:v1", () => ({
    count: 0,
  }));

  atomic.registerCommand("bump", {
    description: "Increment a counter that survives /reload",
    handler: async (_args, ctx) => {
      state.count += 1;
      ctx.ui.notify(`count=${state.count}`, "info");
    },
  });
}
```

- **Required scope.** Pass the extension's `atomic.events` object (or the session `EventBus` directly). Every `/reload` of the same session reconnects to the same stored object, while separate sessions stay independent. Do not pass a random object; an unregistered scope will not reconnect after reload.
- **Session-wide key namespace.** Keys are shared across all extensions in the session. Two extensions passing the same key receive the first extension's object, and the second factory does not run. Prefix every key with a unique extension identifier.
- **Key versioning.** Append a version suffix and bump it when the stored shape changes (for example `"my-extension:counter:v1"` to `"my-extension:counter:v2"`). The new key ignores older incompatible state.
- **Reload behavior.** `/reload` creates a new `atomic.events` wrapper backed by the same session bus. Calling `sessionScopedExtensionState()` with the same key returns the existing object without running `create` again. Failed reloads do not undo mutations made to this object during factory setup. Keep factory setup idempotent and avoid mutating shared state until `session_start`. Use `atomic.appendEntry()` when data must survive a full restart.
- **Shutdown.** `session_shutdown` still runs for resources you opened. Close sockets, watchers, or timers there; the next `session_start` or first use can recreate them inside the same session-scoped object.

## Custom tools

Register tools the model can call with `atomic.registerTool()`. Use the `defineTool(tool)` helper from `@bastani/atomic` when storing tool definitions in variables or arrays so TypeScript preserves parameter type inference.

Tool name collisions follow two rules:

- Within a single extension, registering the same tool name twice keeps the last registration and emits a warning.
- Across multiple extensions, the **first** loaded extension wins. The mandatory bundled `intercom` tool cannot be shadowed.

Prompt metadata options:

- **`promptSnippet`:** Adds a short one-line entry in the `Available tools` section of the default system prompt. If omitted, the tool is left out of that list.
- **`promptGuidelines`:** Adds tool-specific bullets to the default system prompt `Guidelines` section while the tool is active. Because guidelines are appended flat without grouping, always name the tool explicitly (write `"Use my_tool when..."`, not `"Use this tool when..."`).

Some models include a leading `@` prefix in file path arguments. Built-in tools strip a leading `@` before resolving paths; normalize it in your custom path-taking tools as well.

### Serializing file mutations

If your tool edits files, wrap the full read-modify-write operation in `withFileMutationQueue()` so it shares the same per-file lock as built-in `edit` and `write`. Because tool calls run concurrently by default, unqueued tools can read stale contents and overwrite each other's changes.

Resolve the target path to an absolute path relative to `ctx.cwd` before calling `withFileMutationQueue()`. For existing files, Atomic canonicalizes the path with `realpath()` so symlinks share the same queue; for new files, it uses the resolved absolute path. If your callback throws, the queue releases automatically so waiting mutations can proceed.

```typescript
import { withFileMutationQueue } from "@bastani/atomic";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const absolutePath = resolve(ctx.cwd, params.path);

  return withFileMutationQueue(absolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    const current = await readFile(absolutePath, "utf8");
    const next = current.replace(params.oldText, params.newText);
    await writeFile(absolutePath, next, "utf8");

    return {
      content: [{ type: "text", text: `Updated ${params.path}` }],
      details: {},
    };
  });
}
```

### Tool definition

`parameters` is required, including for no-argument tools (`Type.Object({})`). Registration rejects missing, null, array, and primitive values before they can break provider requests.

If a root schema is an `anyOf` or `oneOf` union, give every branch an explicit `type: "object"` (xAI rejects non-object root branches with `tool parameter root must be an object type`). Prefer a plain `Type.Object` root with optional properties when a union is unnecessary.

Use `StringEnum` from `@bastani/atomic` (also exported from `@bastani/atomic-ai`) for string enums instead of `Type.Union` with `Type.Literal`, which Google's API rejects.

```typescript
import { Type } from "typebox";
import { defineTool, StringEnum } from "@bastani/atomic";

const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to the model)",
  promptSnippet: "List or add items in the project todo list",
  promptGuidelines: [
    "Use my_tool for todo planning instead of direct file edits when the user asks for a task list.",
  ],
  maxResultSizeChars: 40_000, // Per-tool cap for persisted model-visible output (Infinity opts out)
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;
    const input = args as { action?: string; oldAction?: string };
    if (typeof input.oldAction === "string" && input.action === undefined) {
      return { ...input, action: input.oldAction };
    }
    return args;
  },

  async execute(_toolCallId, params, signal, onUpdate) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }

    onUpdate?.({
      content: [{ type: "text", text: "Working..." }],
      details: { progress: 50 },
    });

    const result = await atomic.exec("some-command", [], { signal });

    return {
      content: [{ type: "text", text: "Done" }], // Sent to model
      details: { data: result },                  // For rendering and state
      // Optional: end the turn without a follow-up model call when every
      // finalized tool result in the batch also returns terminate: true.
      terminate: true,
    };
  },

  renderCall(args, theme, context) { /* optional */ },
  renderResult(result, options, theme, context) { /* optional */ },
});

atomic.registerTool(myTool);
```

Additional `ToolDefinition` fields:

- **`maxResultSizeChars?: number`:** Sets a per-tool character cap for model-visible result persistence. Pass `Infinity` to opt out for self-bounded tools.
- **`prepareArguments(args)`:** Optional normalizer that runs before schema validation and `execute()`. Keep the public schema clean instead of advertising deprecated fields.
- **`terminate: true`:** Return on a tool result to skip the automatic follow-up model call when every finalized result in the batch also sets `terminate: true`.
- **Signaling errors:** Throw an `Error` from `execute()` to report a failure. When a failure also carries structured data, return `{ isError: true, content, structuredContent }`.

```typescript
async execute(_toolCallId, params) {
  if (!isValid(params.input)) {
    throw new Error(`Invalid input: ${params.input}`);
  }
  return { content: [{ type: "text", text: "OK" }], details: {} };
}
```

#### Structured output tool helper

For a schema-backed decision, use `createStructuredOutputTool({ schema, name?, capture?, output?, timeoutMs? })`. Atomic does not register `structured_output` in normal sessions by default. Include any custom `name` (such as `"final_decision"`) in explicit tool allowlists.

- **`capture`:** Pass `createStructuredOutputCapture()` to inspect `{ called, value }` in memory after the call finishes.
- **`output`:** Pass `{ outputPath }` to write the validated JSON result to disk with `0o600` file permissions.
- **`timeoutMs`:** Overrides the default wall-clock deadline (`httpIdleTimeoutMs`) covering every repair attempt, transport retry, and model fallback.

When the model calls the tool, it supplies `instructions`, nonempty named `state`, and optional `model` and `fallbackModels`:

- Omitting `model` uses the session's configured **`decisionModel`** (via `ctx.getDecisionModel()`, which defaults to the current chat model when unset or `""`), then any explicit `fallbackModels`, and finally the current chat model as the terminal fallback.
- A registered classifier runs only for a finite Choice schema and is skipped for incompatible schemas.
- Provider errors (including refusals) advance to the next model. Plain-text responses without a valid structured value are repaired up to three times before advancing. Cancellation stops the call immediately.

#### Constrained sampling

`ToolDefinition.constrainedSampling` is preserved for extension tools, SDK `customTools`, wrappers, and default interactive mode. It accepts `false` or a `ConstrainedSamplingConfig`:

```typescript
atomic.registerTool({
  name: "strict_edit",
  label: "Strict edit",
  description: "Edit one file",
  parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  constrainedSampling: { type: "json_schema", strict: "prefer" },
  async execute(_id, params) {
    return { content: [{ type: "text", text: params.path }], details: {} };
  },
});
```

Supported values:

- `{ type: "json_schema", strict: "prefer" }`: requests strict provider enforcement and falls back to ordinary tool calling when unavailable.
- `{ type: "json_schema", strict: "require" }`: fails the request instead of weakening the constraint.
- `{ type: "grammar", variants: { openai_lark?: string, openai_regex?: string } }`: requests an OpenAI custom grammar tool (Lark wins when both non-empty variants are set).
- `false`: explicitly opts out while preserving `false` during public tool inspection.

If Anthropic rejects a request because strict tools exceed its grammar-size, tool-count, or union-parameter limits, Atomic retries once with `prefer` tools using ordinary schemas while keeping `require` tools strict (never retried after streaming starts).

Built-in `read`, `edit`, `write`, `bash`, and `powershell` default to `{ type: "json_schema", strict: "prefer" }`. Grammar tools require an object schema with one required string property and apply only when model metadata advertises `supportsOpenAIGrammarTools` (alias `supportsGrammarTools`). See [Custom models](/models/reference#constrained-tool-sampling) and [RPC](/rpc/protocol#get_available_models).

#### Concurrency, sequential execution, and detachable waits

When one assistant message contains multiple tool calls, Atomic runs them concurrently by default unless configured otherwise:

- **`concurrency: "shared"` (default):** May overlap other shared calls, starting only after any earlier `"exclusive"` call finishes.
- **`concurrency: "exclusive"`:** Waits for every earlier call in the message to finish, and blocks later calls until it completes.
- **`concurrency: (args) => "shared" | "exclusive"`:** Decides per call. If the function throws, the call runs exclusively.
- **`executionMode: "sequential" | "parallel"`:** Setting `executionMode: "sequential"` forces every call in the message to execute strictly one at a time in order (see `examples/extensions/tic-tac-toe.ts`).

Built-in `edit`, `write`, `todo`, and `ask_user_question` are exclusive, and `bash` is exclusive when `pty: true`. Other `bash` calls are shared, so declare `"exclusive"` on custom tools that modify state later calls depend on:

```typescript
atomic.registerTool({
  name: "apply_migration",
  label: "Apply Migration",
  description: "Apply one database migration",
  parameters: Type.Object({ name: Type.String(), dryRun: Type.Optional(Type.Boolean()) }),
  concurrency: (args) => (args.dryRun === true ? "shared" : "exclusive"),
  async execute(_toolCallId, params) {
    return { content: [{ type: "text", text: `Applied ${params.name}` }], details: {} };
  },
});
```

**Detachable long waits:** A tool that only waits on external work (such as a CI job or deployment) can set `detachable: true` or `(args) => boolean`, plus optional `detachmentRequiresReady?: boolean`. When running inside a background subagent that suspends while waiting, a call still running after the delay continues independently, releases the subagent, and wakes it when the result arrives.

Once a call detaches, `onUpdate` progress updates are dropped and `ctx` only answers `cwd`. Because a restarted session can re-run a detached call with the same ID and arguments, mark a tool `detachable` only when re-running it is safe. Built-in `bash` detaches only `{ action: "wait" }` calls without `budgetMs`.

### Structured results and nested tools

Declare `outputSchema` when a tool returns machine-readable data, and return a matching `structuredContent` alongside model-facing `content`. Script callers receive `structuredContent`; tools without an `outputSchema` return text to scripts. A `tool_result` handler that redacts text must also replace `structuredContent`; replacing only `content` drops `structuredContent` so redacted data cannot leak.

Inside `execute()`, `ctx` is an `ExtensionToolContext`:

- `ctx.tools` lists callable tools allowed by the session.
- `ctx.executeTool(name, args, { signal, onUpdate })` invokes another tool through the normal argument preparation, validation, permission hooks, and result hooks, returning an `AgentToolCallOutcome`. Nested calls cannot bypass session allowlists, exclusions, or `model-only` exposure.
- If your orchestrator calls a tool with `concurrency: "exclusive"`, mark the orchestrator `concurrency: "exclusive"` as well. A shared tool cannot upgrade a nested call to exclusive access and receives an error before the target runs.

Nested execution events and the nested tool's `ctx` include `parentToolCallId`. Nested calls do not create separate transcript messages; the parent reports their outcomes and may attach bounded `nestedCalls` metadata. Report only the parent's own usage because nested usage aggregates automatically.

### Tool exposure

`ToolDefinition.exposure` controls whether a tool is declared to the model or callable from another tool. Omitting it defaults to `"direct"`:

| Exposure | Model declaration | Callable from another tool |
| --- | --- | --- |
| `direct` | While active | While active |
| `model-only` | While active | Only its permitted `scriptAccess` subset while active |
| `codemode` | Only if explicitly activated | When registered and permitted by the session |
| `deferred` | Only if explicitly activated | When registered and permitted by the session |
| `hidden` | Never | Never |

- Use `model-only` for interactive or orchestration tools that scripts should not invoke freely. You can expose a restricted subset to scripts with `scriptAccess: { description, outputSchema?, refuse(params) }`. `refuse` runs after validation and before permission hooks, returning an error reason string or `undefined` to allow execution. Direct model calls are unaffected.
- `codemode` tools appear in the codemode tool catalog; `deferred` tools stay discoverable without occupying the inline catalog. Session allowlists and exclusions always take precedence.
- `direct` and `model-only` tools activate by default. Set `defaultActive: false` to keep a tool inactive until activated with `atomic.setActiveTools()`.
- `namespace: { name, description, instructions? }` groups related tools and optional namespace-level guidance.
- Optional `annotations` carry advisory hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) that do not enforce permissions.
- Set `writesFiles: true` on tools that modify files so turns calling them record a [worktree snapshot](/worktree-snapshots) like `bash`, `edit`, and `write`.
- An active orchestrator tool can implement `prepareLoadout(loadout)` to adjust how tools are described or hidden from the model (returning `descriptions` or `hiddenDeclarations`). This changes model presentation only, not authorization.

**Fireworks deferred tool loading:** Extensions calling `@bastani/atomic-ai` directly can use native deferred tool loading on Fireworks `anthropic-messages` models. See [Libraries: AI](/libraries/ai) and the [AI SDK deferred tool-loading guide](https://github.com/bastani-inc/atomic/blob/main/packages/ai/README.md#fireworks-deferred-tools).

### Overriding built-in tools

Extensions can override built-in tools (`read`, `bash`, `powershell`, `kill`, `edit`, `write`, `find`, `search`, `ls`, `ask_user_question`, `todo`) by registering a tool with the same name. Interactive mode displays a warning when a built-in tool is overridden:

```bash
# Extension's read tool replaces built-in read
atomic -e ./tool-override.ts
```

Use `--no-builtin-tools` (short flag `-nbt`) to start with no built-in tools while keeping extension tools enabled:

```bash
atomic --no-builtin-tools -e ./my-extension.ts
```

See [examples/extensions/tool-override.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/tool-override.ts) for a complete override example.

- **Renderer inheritance:** Execution and rendering overrides are independent per slot. If your override omits `renderCall` or `renderResult`, Atomic keeps the built-in renderer for that slot (syntax highlighting, diffs, and framing).
- **Prompt metadata:** `promptSnippet` and `promptGuidelines` are not inherited from the built-in tool. Set them explicitly or reuse the exported `*ToolSystemPromptContribution` constants from `@bastani/atomic`.
- **Matching `details` shapes:** Match the built-in tool's `details` type so built-in renderers and session logic work. Import detail types and factories from `@bastani/atomic`:
  - `read`: `ReadToolDetails` (`createReadToolDefinition`)
  - `bash`: `BashToolDetails` (`createBashToolDefinition`)
  - `powershell`: `PowerShellToolDetails` (`createPowerShellToolDefinition`)
  - `edit`: `EditToolDetails` (`createEditToolDefinition`)
  - `find`: `FindToolDetails` (`createFindToolDefinition`)
  - `search`: `SearchToolDetails` (`createSearchToolDefinition`)
  - `ls`: `LsToolDetails` (`createLsToolDefinition`)
  - `write`, `kill`, `ask_user_question`, `todo`: `createWriteToolDefinition`, `createKillToolDefinition`, `createAskUserQuestionToolDefinition`, `createTodoToolDefinition`

### Remote execution

Built-in tools accept pluggable operations objects for SSH, containers, and sandboxes:

```typescript
import { createReadTool, type ReadOperations } from "@bastani/atomic";

const remoteRead = createReadTool(cwd, {
  operations: {
    readFile: (path) => sshExec(remote, `cat ${path}`),
    access: (path) => sshExec(remote, `test -r ${path}`).then(() => {}),
  },
});

atomic.registerTool({
  ...remoteRead,
  async execute(id, params, signal, onUpdate) {
    const ssh = getSshConfig();
    if (ssh) {
      const tool = createReadTool(cwd, { operations: createRemoteOps(ssh) });
      return tool.execute(id, params, signal, onUpdate);
    }
    return localRead.execute(id, params, signal, onUpdate);
  },
});
```

- `ReadOperations` can provide `stat` and `listDir` for remote directory reads, and optional `createReadStream` (returning an async iterable of `Uint8Array` chunks, such as a Node `Readable` without encoding) so line ranges of large files stream without reading the whole file into memory. `:conflicts` views and notebooks still read the full file. Archive, SQLite, internal-resource, and notebook helpers stay local.
- **Operations interfaces:** `ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, `PowerShellOperations`, `LsOperations`, `GrepOperations`, `FindOperations`.
- `GrepOperations` checks only directories because search scans the local filesystem with native search or `rg`; its optional `readFile` callback is deprecated and ignored. Override `execute()` to search a remote host.
- For `user_bash` handlers, call `createLocalBashOperations()` to reuse Atomic's local shell spawning and process-tree cleanup.
- `createBashTool()` supports `spawnHook` to modify `command`, `cwd`, or `env` before launch:

```typescript
import { createBashTool } from "@bastani/atomic";

const bashTool = createBashTool(cwd, {
  spawnHook: ({ command, cwd, env }) => ({
    command: `source ~/.profile\n${command}`,
    cwd: `/mnt/sandbox${cwd}`,
    env: { ...env, CI: "1" },
  }),
});
```

See [examples/extensions/ssh.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/ssh.ts) for a full SSH example.

### Output truncation

**Tools must truncate large output** to avoid context overflow errors, compaction failures, and degraded responses. The built-in limit is **50 KB** (~10k tokens) and **2,000 lines**, whichever comes first:

```typescript
import {
  truncateHead,      // Keep first N lines/bytes (file reads, search results)
  truncateTail,      // Keep last N lines/bytes (logs, command output)
  truncateLine,      // Truncate a single line to maxBytes with ellipsis
  formatSize,        // Human-readable size ("50KB", "1.5MB")
  DEFAULT_MAX_BYTES, // 50KB
  DEFAULT_MAX_LINES, // 2000
} from "@bastani/atomic";

async execute() {
  const output = await runCommand();
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let result = truncation.content;
  if (truncation.truncated) {
    const tempFile = writeTempFile(output);
    result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
    result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    result += ` Full output saved to: ${tempFile}]`;
  }

  return { content: [{ type: "text", text: result }] };
}
```

Use `truncateHead` when the beginning matters, `truncateTail` when the end matters, inform the model where full output was saved, and document truncation limits in the tool description. See [examples/extensions/truncated-tool.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/truncated-tool.ts).

### Multiple tools

One extension can register multiple tools sharing one resource and release it on `session_shutdown`:

```typescript
export default function (atomic: ExtensionAPI) {
  let connection: DbConnection | null = null;

  atomic.registerTool({ name: "db_connect", /* ... */ });
  atomic.registerTool({ name: "db_query", /* ... */ });
  atomic.registerTool({ name: "db_close", /* ... */ });

  atomic.on("session_shutdown", async () => {
    connection?.close();
    connection = null;
  });
}
```

### Custom rendering

Tools can provide `renderCall` and `renderResult` for custom display in the interactive transcript and HTML exports. See [TUI components](/tui) for the full component API.

To select renderers dynamically for any tool (including MCP tools in resumed sessions before their server connects), register a resolver with `atomic.registerToolRenderer((toolName, next) => renderers)`. Resolvers run in extension load order; `next()` returns the remaining resolvers' choice and then the tool's own renderers, so `next() ?? mine` acts as a fallback. See [`atomic.registerToolRenderer()`](/extensions/api-reference#atomic-registertoolrenderer-resolver).

Extension `Image` components render JPEG, GIF, and WebP images on Kitty-protocol terminals automatically.

By default, tool output wraps in a `Box` handling padding and background. Each defined `renderCall` or `renderResult` must return a `Component`; an omitted slot falls back to Atomic's default renderer. Set `renderShell: "self"` when the tool draws its own outer framing and background:

```typescript
atomic.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "Custom shell example",
  parameters: Type.Object({}),
  renderShell: "self",
  async execute() {
    return { content: [{ type: "text", text: "ok" }], details: undefined };
  },
  renderCall(_args, theme) {
    return new Text(theme.fg("accent", "my custom shell"), 0, 0);
  },
});
```

`renderCall` and `renderResult` receive a `ToolRenderContext` object with:

- `args`: current tool call arguments
- `state`: shared row-local state across `renderCall` and `renderResult`
- `lastComponent`: previously returned component for that slot, if any
- `invalidate()`: request a rerender of this tool row
- `toolCallId`, `cwd`, `executionStarted`, `argsComplete`, `isPartial`, `expanded`, `showImages`, `isError`
- `durationMs`: recorded execution time of the final result (`undefined` while running, when skipped, or on older saved results)
- `outputPad`: configured horizontal padding (apply it yourself when `renderShell: "self"`)
- `keyText()`, `keyHint()`: format the user's configured keybindings (see [Keybinding hints](#keybinding-hints))
- Optional helpers `getTaskRecord?()`, `getElapsedMs?()`, and `getToolDefinition?()` when exposed by the host

#### renderCall

Renders the tool call header:

```typescript
import { Text } from "@bastani/atomic-tui";

renderCall(args, theme, context) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  let content = theme.fg("toolTitle", theme.bold("my_tool "));
  content += theme.fg("muted", args.action);
  if (args.text) {
    content += " " + theme.fg("dim", `"${args.text}"`);
  }
  text.setText(content);
  return text;
}
```

#### renderResult

Renders the tool output:

```typescript
renderResult(result, { expanded, isPartial }, theme) {
  if (isPartial) {
    return new Text(theme.fg("warning", "Processing..."), 0, 0);
  }

  if (result.details?.error) {
    return new Text(theme.fg("error", `Error: ${result.details.error}`), 0, 0);
  }

  let text = theme.fg("success", "✓ Done");
  if (expanded && result.details?.items) {
    for (const item of result.details.items) {
      text += "\n  " + theme.fg("dim", item);
    }
  }
  return new Text(text, 0, 0);
}
```

Return an empty `Container` when a slot intentionally displays nothing.

#### Keybinding hints

Use `context.keyHint()` and `context.keyText()` (or `options.keyHint()` and `options.keyText()` in message and entry renderers) so hints match the user's `keybindings.json`. Test `keyText()` for an empty string before adding punctuation when a keybinding may be unbound:

```typescript
renderResult(result, { expanded }, theme, context) {
  let text = theme.fg("success", "✓ Done");
  if (!expanded && context.keyText("app.tools.expand")) {
    text += ` (${context.keyHint("app.tools.expand", "to expand")})`;
  }
  return new Text(text, 0, 0);
}
```

Do not import `keyHint()`, `keyHintIfBound()`, or `keyText()` from `@bastani/atomic` inside renderers; use the injected context methods so they read Atomic's active keybinding config. `rawKeyHint(key, description)` formats a literal key string and is safe to import.

In fullscreen mode, clicking a hint from `keyHint()` or `rawKeyHint()` sends the named key (except `app.tools.expand` inside an expandable block, which toggles that block alone). Hints embed zero-width markers that the renderer strips before writing to the terminal; use `keyText()` for plain text such as notifications or logs.

To make a plain-text hint clickable, pass it through `clickableHintText()` from `@bastani/atomic-tui` (for example `clickableHintText("↑↓ select · enter choose · esc cancel")`), or use `clickableKeysHint([{ text: "a", key: "a" }], "\u00a0accept")` for bare keys. When a label contains `/`, pass extra bare keys in the second argument (for example `clickableHintText("1/2 / esc pick", ["1", "2"])`).

Use namespaced keybinding IDs (`app.*` for coding-agent actions and `tui.*` for shared TUI actions; see [Keybindings](/keybindings)). Custom editors and `ctx.ui.custom()` components receive `keybindings: KeybindingsManager` as an argument; use it directly instead of calling `getKeybindings()` or `setKeybindings()`.

#### Best practices

- Use `Text` with padding `(0, 0)` because the default `Box` adds padding.
- Handle `isPartial` for streaming progress and `expanded` for details on demand (`Ctrl+O` toggles all blocks; clicking toggles one block).
- Read `context.args` in `renderResult` instead of copying arguments into `context.state`.
- Reuse `context.lastComponent` when updating the same component across renders.
- Use `renderShell: "self"` only when you need custom outer framing, padding, and background.

#### Fallback

If a slot renderer is omitted or throws:

- `renderCall`: shows the tool name
- `renderResult`: shows raw text from `content`

## Next steps

Continue with [Extension events](/extensions/events) to hook into the session lifecycle, or look up context properties and registration methods in the [Extension API reference](/extensions/api-reference).
