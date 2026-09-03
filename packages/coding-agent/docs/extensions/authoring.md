---
title: Writing extensions
description: Write an extension, manage its state, and register custom tools.
---

# Writing extensions

## Writing an Extension

An extension exports a default factory function that receives `ExtensionAPI`. The factory can be synchronous or asynchronous:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default function (pi: ExtensionAPI) {
  // Subscribe to events
  pi.on("event_name", async (event, ctx) => {
    // ctx.ui for user interaction
    const ok = await ctx.ui.confirm("Title", "Are you sure?");
    ctx.ui.notify("Done!", "info");
    ctx.ui.setStatus("my-ext", "Processing...");  // Footer status
    ctx.ui.setWidget("my-ext", ["Line 1", "Line 2"]);  // Widget above editor (default)
  });

  // Register tools, commands, shortcuts, flags
  pi.registerTool({ ... });
  pi.registerCommand("name", { ... });
  pi.registerShortcut("ctrl+x", { ... });
  pi.registerFlag("my-flag", { ... });
}
```

Editable user, project, and package extensions and user workflows are loaded through [jiti](https://github.com/unjs/jiti), so TypeScript works without compilation. `/reload` uses content-hash invalidation across the complete imported file graph: an unchanged graph can reuse its evaluated factory, while a direct edit or a transitive dependency edit re-evaluates that extension's modules.

Imports from Atomic's supplied core packages keep the running host's classes and shared state across `/reload`, including on Windows. The supported `@earendil-works/pi-coding-agent` compatibility import shares those exports with `@bastani/atomic`, so class comparisons and `instanceof` checks work across both names after reload. Edits to your extension and its imported local helpers still take effect; restart Atomic after updating Atomic itself.

In Bun compiled or bundled single-file builds, Atomic's six fixed installed builtin extension bundles (workflows, subagents, MCP, web access, Intercom, and feedback) take a separate startup path. Atomic installs its live host-module bridge, imports each precompiled bundle natively once, and reuses the evaluated factory across `/reload`. This avoids jiti source reads, transforms, hashing, and graph manifests for immutable shipped code. A builtin bundle's module-scoped state is therefore **not** re-evaluated by `/reload` in those builds. This optimization is limited to exact installed entries of identity-verified Atomic packages; editable extensions and workflows retain the dynamic behavior above.

If the factory returns a `Promise`, Atomic awaits it before continuing startup. That means async initialization completes before `session_start`, before `resources_discover`, and before provider registrations queued via `pi.registerProvider()` are flushed.

### Async factory functions

Use an async factory for one-time startup work such as fetching remote configuration or dynamically discovering available models.

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_window?: number;
      max_tokens?: number;
    }>;
  };

  pi.registerProvider("local-openai", {
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

This pattern makes the fetched models available during normal startup and to `atomic --list-models`.

### Long-lived resources and shutdown

Extension factories may run in invocations that never start a session, such as metadata commands or early configuration checks. Do not start background resources such as processes, sockets, file watchers, or timers from the factory.

Defer background resource startup until `session_start` or the command/tool/event that needs the resource. Register an idempotent `session_shutdown` handler to close any session-scoped resources you start.

### Extension Styles

**Single file** - simplest, for small extensions:

```
~/.atomic/agent/extensions/
└── my-extension.ts
```

**Directory with index.ts** - for multi-file extensions:

```
~/.atomic/agent/extensions/
└── my-extension/
    ├── index.ts        # Entry point (exports default function)
    ├── tools.ts        # Helper module
    └── utils.ts        # Helper module
```

**Package with dependencies** - for extensions that need npm packages:

```
~/.atomic/agent/extensions/
└── my-extension/
    ├── package.json    # Declares dependencies and entry points
    ├── bun.lock
    ├── node_modules/   # After dependency install
    └── src/
        └── index.ts
```

```json
// package.json
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

The manifest key is the configured Atomic app name (`atomic` here, from the running Atomic package/config), not the extension package's own `"name"` field. The legacy `pi` key is still accepted as a compatibility shim. Run `bun install` in the extension directory, then imports from `node_modules/` work automatically.

## State Management

Choose the store that matches the lifetime you need:

- **Tool result `details`** — reconstructs across `/branch` and `/resume` from the transcript.
- **`pi.appendEntry()`** — durable custom entries that survive process restart. They do not enter model context.
- **`sessionScopedExtensionState()`** — in-memory objects that survive `/reload` for the current process. They do not survive process restart.

In Bun single-file builds, an editable file extension whose imported graph is unchanged can reuse its evaluated factory, so its module-scoped variables may survive `/reload`. An edit anywhere in that graph re-evaluates its modules and resets those singletons. The six fixed installed builtin bundles always reuse their evaluated factories and module state across `/reload`, as described above.

Extensions with state that must follow conversation branches should store it in tool result `details`:

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  // Reconstruct state from session
  pi.on("session_start", async (_event, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "my_tool") {
          items = entry.message.details?.items ?? [];
        }
      }
    }
  });

  pi.registerTool({
    name: "my_tool",
    // ...
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      items.push("new item");
      return {
        content: [{ type: "text", text: "Added" }],
        details: { items: [...items] },  // Store for reconstruction
      };
    },
  });
}
```

### Session-scoped in-memory state

Import `sessionScopedExtensionState` from `@bastani/atomic` when an extension must keep a live object across `/reload` — registries, abort controllers, connection pools, or any other handle that cannot be rebuilt from the transcript.

```typescript
import { sessionScopedExtensionState, type ExtensionAPI } from "@bastani/atomic";

interface CounterState {
  count: number;
}

export default function (pi: ExtensionAPI) {
  const state = sessionScopedExtensionState(pi.events, "my-extension:counter:v1", () => ({
    count: 0,
  }));

  pi.registerCommand("bump", {
    description: "Increment a counter that survives /reload",
    handler: async (_args, ctx) => {
      state.count += 1;
      ctx.ui.notify(`count=${state.count}`, "info");
    },
  });
}
```

**Required scope.** Pass the extension's `pi.events` facade (or the session `EventBus` itself). The host resolves that facade to the canonical session bus, so every load generation of one session re-binds to the same object. Two in-process sessions with distinct buses stay isolated. Do not pass an arbitrary object: an unregistered scope is treated as its own bus and will not re-bind after reload.

**Session-wide key namespace.** Keys are not automatically namespaced by extension. Two extensions that pass the same key on the same session receive the first extension's object; the later factory is not called. Prefix every key with a stable extension identity.

**Key-versioning.** Append a version suffix and bump it when the stored shape changes, for example `"my-extension:counter:v1"` → `"my-extension:counter:v2"`. The new key declines the incompatible predecessor instead of reusing it under a new type.

**Reload behavior.** `/reload` builds a new `pi.events` facade that still forwards to the same bus. Calling `sessionScopedExtensionState` again with the same namespaced key returns the existing object and does not invoke `create`. The reload transaction does not clone this object or roll back mutations that extension factory code makes to it. Keep factory setup idempotent, and mutate durable state only after the new generation starts when failed reloads must not affect it. Entries live exactly as long as that bus. They are not written to the session file; use `pi.appendEntry()` when the data must survive process restart.

**Shutdown.** `session_shutdown` still runs for resources you opened. If the object holds sockets, watchers, or timers, close them there. The next `session_start` or first use can recreate them inside the same session-scoped object.


## Custom Tools

Register tools the LLM can call via `pi.registerTool()`. Tools appear in the system prompt and can have custom rendering.

Use `promptSnippet` for a short one-line entry in the `Available tools` section in the default system prompt. If omitted, custom tools are left out of that section.

Use `promptGuidelines` to add tool-specific bullets to the default system prompt `Guidelines` section. These bullets are included only while the tool is active (for example, after `pi.setActiveTools([...])`).

**Important:** `promptGuidelines` bullets are appended flat to the `Guidelines` section with no tool name prefix or grouping. Each guideline must name the tool it refers to — avoid "Use this tool when..." because the LLM cannot tell which tool "this" means. Write "Use my_tool when..." instead.

Note: Some models are idiots and include the @ prefix in tool path arguments. Built-in tools strip a leading @ before resolving paths. If your custom tool accepts a path, normalize a leading @ as well.

If your custom tool mutates files, use `withFileMutationQueue()` so it participates in the same per-file queue as built-in `edit` and `write`. This matters because tool calls run in parallel by default. Without the queue, two tools can read the same old file contents, compute different updates, and then whichever write lands last overwrites the other.

Example failure case: your custom tool edits `foo.ts` while built-in `edit` also changes `foo.ts` in the same assistant turn. If your tool does not participate in the queue, both can read the original `foo.ts`, apply separate changes, and one of those changes is lost.

Pass the real target file path to `withFileMutationQueue()`, not the raw user argument. Resolve it to an absolute path first, relative to `ctx.cwd` or your tool's working directory. For existing files, the helper canonicalizes through `realpath()`, so symlink aliases for the same file share one queue. For new files, it falls back to the resolved absolute path because there is nothing to `realpath()` yet.

Queue the entire mutation window on that target path. That includes read-modify-write logic, not just the final write.

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

### Tool Definition

`parameters` is required, including for no-argument tools (use `Type.Object({})`). Registration rejects missing, null, array, and primitive schema values before they can break a provider request. This checks the schema container, not its JSON Schema `type`: object-valued union and non-object-type schemas remain accepted and unchanged.

```typescript
import { Type } from "typebox";
import { StringEnum } from "@bastani/atomic";
import { Text } from "@earendil-works/pi-tui";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  promptSnippet: "List or add items in the project todo list",
  promptGuidelines: [
    "Use my_tool for todo planning instead of direct file edits when the user asks for a task list."
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // Atomic's Pi-compatible TypeBox helper
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

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Check for cancellation
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }

    // Stream progress updates
    onUpdate?.({
      content: [{ type: "text", text: "Working..." }],
      details: { progress: 50 },
    });

    // Run commands via pi.exec (captured from extension closure)
    const result = await pi.exec("some-command", [], { signal });

    // Return result
    return {
      content: [{ type: "text", text: "Done" }],  // Sent to LLM
      details: { data: result },                   // For rendering & state
      // Optional: stop after this tool batch when every finalized tool result
      // in the batch also returns terminate: true.
      terminate: true,
    };
  },

  // Optional: Custom rendering
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
});
```

**Signaling errors:** To mark a tool execution as failed (sets `isError: true` on the result and reports it to the LLM), throw an error from `execute`. Returning a value never sets the error flag regardless of what properties you include in the return object.

**Early termination:** Return `terminate: true` from `execute()` to hint that the automatic follow-up LLM call should be skipped after the current tool batch. This only takes effect when every finalized tool result in that batch is terminating. Atomic does not register `structured_output` in normal agent sessions by default; use `createStructuredOutputTool({ schema, capture, output, name })` when an extension, SDK session, or workflow stage needs a schema-backed final-answer tool. The factory uses the supplied schema as the tool parameters directly, captures the tool arguments as whatever JSON value matches the schema, emits the same pretty-printed JSON as the terminating tool-result text for `atomic -p`, optionally writes them to the configured `output.outputPath`, and terminates the turn. In text print mode, a terminating result from a factory-created structured-output tool is emitted to stdout as the final response. Custom factory names are opt-in tools: if you register `final_decision`, include `final_decision` in any explicit `tools` allowlist; if you register the default `structured_output` name, it is available only to that session/runtime.

```typescript
// Correct: throw to signal an error
async execute(toolCallId, params) {
  if (!isValid(params.input)) {
    throw new Error(`Invalid input: ${params.input}`);
  }
  return { content: [{ type: "text", text: "OK" }], details: {} };
}
```

**Important:** Use `StringEnum` from `@bastani/atomic` for string enums. It retains Pi's Google-compatible schema and composes with Atomic's direct TypeBox types; `Type.Union`/`Type.Literal` doesn't work with Google's API.

#### Constrained sampling

`ToolDefinition.constrainedSampling` is preserved for extension tools, SDK `customTools`, wrappers, and isolated execution. It accepts `false` or the exported `ConstrainedSamplingConfig`:

```typescript
pi.registerTool({
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

Exact modes:

- `{ type: "json_schema", strict: "prefer" }` requests strict provider enforcement and falls back to ordinary tool calling when unavailable.
- `{ type: "json_schema", strict: "require" }` fails the request rather than silently weakening the constraint.
- `{ type: "grammar", variants: { openai_lark?: string, openai_regex?: string } }` requests an OpenAI custom grammar tool; Lark wins when both non-empty variants are present.
- `false` explicitly opts out. Its runtime effect matches omission, but public tool inspection preserves `false` as a present property.

Built-in `read`, `edit`, `write`, `bash`, and its Windows PowerShell variant request strict JSON-schema sampling with `prefer` by default. This is a provider hint, not a schema rewrite or a sandbox. Unsupported providers retain ordinary tool calling. Other experimental tool hints still follow the experimental environment flag.

Atomic preserves the optional property's exact own-key state across wrappers, active-session inspection, staged extension inspection, bundled tools, and isolated transport: omission stays absent; explicitly present `undefined` stays present; `false` and config objects remain unchanged. This distinction matters to SDK/extension code that uses `Object.hasOwn()` rather than an ordinary property read.

Grammar tools require an object schema with exactly one required string property. They are emitted only when model metadata advertises `supportsOpenAIGrammarTools` (also exposed as Atomic's `supportsGrammarTools` alias); otherwise provider handling falls back to the normal function/JSON-schema path. Older OpenAI models and gateways that rewrite schemas cannot honor custom grammar tools. Typed RPC clients receive these claims through optional `ModelInfo.compat`. See [Custom Models](/models/reference#constrained-tool-sampling) and [RPC](/rpc/protocol#get_available_models).

**Argument preparation:** `prepareArguments(args)` is optional. If defined, it runs before schema validation and before `execute()`. Use it only when a custom tool must normalize arguments before validation. Return the object you want validated against `parameters`, keep the public schema strict, and avoid advertising deprecated fields.

```typescript
pi.registerTool({
  name: "deploy_plan",
  label: "Deploy Plan",
  description: "Create a deployment plan for one target environment",
  parameters: Type.Object({
    environment: Type.String(),
    dryRun: Type.Optional(Type.Boolean()),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;
    const input = args as { env?: unknown; environment?: unknown; dryRun?: unknown };
    if (typeof input.environment === "string") return args;
    if (typeof input.env !== "string") return args;
    return { environment: input.env, dryRun: input.dryRun };
  },
  async execute(toolCallId, params) {
    return {
      content: [{ type: "text", text: `Planning deploy to ${params.environment}` }],
      details: {},
    };
  },
});
```

### Fireworks deferred tool loading

Extensions making requests directly through `@bastani/pi-ai` can use native deferred tool loading with Fireworks `anthropic-messages` models. Supply the tool definitions in `context.tools` and record newly loaded tool names in the loader result's `addedToolNames` field. The provider serializes deferred definitions with `defer_loading` and inserts `tool_reference` content at the load point.

Name the loader `ToolSearch` or `tool_search` to keep deferred schemas out of the initial prompt prefix. Other names work, but Fireworks includes the schemas in the prefix and loses that cache benefit. Fireworks GLM models and Kimi K3 still use Chat Completions; this feature does not change their routing.

This is an AI SDK capability. Atomic's `pi.setActiveTools()` updates the active tool list but does not automatically populate `addedToolNames`. See the [AI SDK deferred tool-loading guide](https://github.com/bastani-inc/atomic/blob/main/packages/ai/README.md#fireworks-deferred-tools) for details.

### Overriding Built-in Tools

Extensions can override built-in tools (`read`, `bash`, `powershell`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`) by registering a tool with the same name. Interactive mode displays a warning when this happens.

```bash
# Extension's read tool replaces built-in read
atomic -e ./tool-override.ts
```

Alternatively, use `--no-builtin-tools` to start without any built-in tools while keeping extension tools enabled:
```bash
# No built-in tools, only extension tools
atomic --no-builtin-tools -e ./my-extension.ts
```

See [examples/extensions/tool-override.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/tool-override.ts) for a complete example that overrides `read` with logging and access control.

**Rendering:** Built-in renderer inheritance is resolved per slot. Execution override and rendering override are independent. If your override omits `renderCall`, the built-in `renderCall` is used. If your override omits `renderResult`, the built-in `renderResult` is used. If your override omits both, the built-in renderer is used automatically (syntax highlighting, diffs, etc.). This lets you wrap built-in tools for logging or access control without reimplementing the UI.

**Prompt metadata:** `promptSnippet` and `promptGuidelines` are not inherited from the built-in tool. If your override should keep those prompt instructions, define them on the override explicitly.

**Your implementation must match the exact result shape**, including the `details` type. The UI and session logic depend on these shapes for rendering and state tracking.

Built-in tool implementations:
- [read.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/tools/read.ts) - `ReadToolDetails`
- [bash.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/tools/bash.ts) - `BashToolDetails`
- [edit.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/tools/edit.ts)
- [write.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/tools/write.ts)
- [grep.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/tools/grep.ts) - `GrepToolDetails`
- [find.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/tools/find.ts) - `FindToolDetails`
- [ls.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/tools/ls.ts) - `LsToolDetails`

### Remote Execution

Built-in tools support pluggable operations for delegating to remote systems (SSH, containers, etc.):

```typescript
import { createReadTool, createBashTool, type ReadOperations } from "@bastani/atomic";

// Create tool with custom operations
const remoteRead = createReadTool(cwd, {
  operations: {
    readFile: (path) => sshExec(remote, `cat ${path}`),
    access: (path) => sshExec(remote, `test -r ${path}`).then(() => {}),
  }
});

// Register, checking flag at execution time
pi.registerTool({
  ...remoteRead,
  async execute(id, params, signal, onUpdate, _ctx) {
    const ssh = getSshConfig();
    if (ssh) {
      const tool = createReadTool(cwd, { operations: createRemoteOps(ssh) });
      return tool.execute(id, params, signal, onUpdate);
    }
    return localRead.execute(id, params, signal, onUpdate);
  },
});
```

`ReadOperations` may also provide `stat` and `listDir` to keep directory-tree reads on the injected filesystem. The Harness factory supplies both. A custom read backend without both members keeps the existing file-only remote behavior. Archive, SQLite, internal-resource, notebook, and path-variant helpers still use Atomic's local filesystem unless the tool gains dedicated remote seams.

**Operations interfaces:** `ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, `LsOperations`, `GrepOperations`, `FindOperations`

For `user_bash`, extensions can reuse atomic's local shell backend via `createLocalBashOperations()` instead of reimplementing local process spawning, shell resolution, and process-tree termination.

The bash tool also supports a spawn hook to adjust the command, cwd, or env before execution:

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

See [examples/extensions/ssh.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/ssh.ts) for a complete SSH example with `--ssh` flag.

### Output Truncation

**Tools MUST truncate their output** to avoid overwhelming the LLM context. Large outputs can cause:
- Context overflow errors (prompt too long)
- Compaction failures
- Degraded model performance

The built-in limit is **50KB** (~10k tokens) and **2000 lines**, whichever is hit first. Use the exported truncation utilities:

```typescript
import {
  truncateHead,      // Keep first N lines/bytes (good for file reads, search results)
  truncateTail,      // Keep last N lines/bytes (good for logs, command output)
  truncateLine,      // Truncate a single line to maxBytes with ellipsis
  formatSize,        // Human-readable size (e.g., "50KB", "1.5MB")
  DEFAULT_MAX_BYTES, // 50KB
  DEFAULT_MAX_LINES, // 2000
} from "@bastani/atomic";

async execute(toolCallId, params, signal, onUpdate, ctx) {
  const output = await runCommand();

  // Apply truncation
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let result = truncation.content;

  if (truncation.truncated) {
    // Write full output to temp file
    const tempFile = writeTempFile(output);

    // Inform the LLM where to find complete output
    result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
    result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    result += ` Full output saved to: ${tempFile}]`;
  }

  return { content: [{ type: "text", text: result }] };
}
```

**Key points:**
- Use `truncateHead` for content where the beginning matters (search results, file reads)
- Use `truncateTail` for content where the end matters (logs, command output)
- Always inform the LLM when output is truncated and where to find the full version
- Document the truncation limits in your tool's description

See [examples/extensions/truncated-tool.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/truncated-tool.ts) for a complete example wrapping `rg` (ripgrep) with proper truncation.

### Multiple Tools

One extension can register multiple tools with shared state:

```typescript
export default function (pi: ExtensionAPI) {
  let connection = null;

  pi.registerTool({ name: "db_connect", ... });
  pi.registerTool({ name: "db_query", ... });
  pi.registerTool({ name: "db_close", ... });

  pi.on("session_shutdown", async () => {
    connection?.close();
  });
}
```

### Custom Rendering

Tools can provide `renderCall` and `renderResult` for custom TUI display. See [TUI components](/tui) for the full component API and [tool-execution.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/modes/interactive/components/tool-execution.ts) for how tool rows are composed.

By default, tool output is wrapped in a `Box` that handles padding and background. A defined `renderCall` or `renderResult` must return a `Component`. If a slot renderer is not defined, `tool-execution.ts` uses fallback rendering for that slot.

Set `renderShell: "self"` when the tool should render its own shell instead of using the default `Box`. This is useful for tools that need complete control over framing or background behavior, for example large previews that must stay visually stable after the tool settles.

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "Custom shell example",
  parameters: Type.Object({}),
  renderShell: "self",
  async execute() {
    return { content: [{ type: "text", text: "ok" }], details: undefined };
  },
  renderCall(args, theme, context) {
    return new Text(theme.fg("accent", "my custom shell"), 0, 0);
  },
});
```

`renderCall` and `renderResult` each receive a `context` object with:
- `args` - the current tool call arguments
- `state` - shared row-local state across `renderCall` and `renderResult`
- `lastComponent` - the previously returned component for that slot, if any
- `invalidate()` - request a rerender of this tool row
- `toolCallId`, `cwd`, `executionStarted`, `argsComplete`, `isPartial`, `expanded`, `showImages`, `isError`

Use `context.state` for cross-slot shared state. Keep slot-local caches on the returned component instance when you want to reuse and mutate the same component across renders.

#### renderCall

Renders the tool call or header:

```typescript
import { Text } from "@earendil-works/pi-tui";

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

Renders the tool result or output:

```typescript
renderResult(result, { expanded, isPartial }, theme, context) {
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

If a slot intentionally has no visible content, return an empty `Component` such as an empty `Container`.

#### Keybinding Hints

Use `keyHintIfBound()` when an affordance should disappear if the action has no effective keybinding. Add surrounding punctuation only when the helper returns text:

```typescript
import { keyHintIfBound } from "@bastani/atomic";

renderResult(result, { expanded }, theme, context) {
  let text = theme.fg("success", "✓ Done");
  const expandHint = keyHintIfBound("app.tools.expand", "to expand");
  if (!expanded && expandHint) {
    text += ` (${expandHint})`;
  }
  return new Text(text, 0, 0);
}
```

Available functions:
- `keyHint(keybinding, description)` - Formats a configured keybinding id such as `"app.tools.expand"` or `"tui.select.confirm"`; use it when the binding is required by the surrounding UI
- `keyHintIfBound(keybinding, description)` - Formats the hint only when the action has an effective key list; use it for optional affordances and conditionally compose parentheses or separators
- `keyText(keybinding)` - Returns the raw configured key text for a keybinding id
- `rawKeyHint(key, description)` - Format a raw key string

Use namespaced keybinding ids:
- Coding-agent ids use the `app.*` namespace, for example `app.tools.expand`, `app.editor.external`, `app.session.rename`
- Shared TUI ids use the `tui.*` namespace, for example `tui.select.confirm`, `tui.select.cancel`, `tui.input.tab`

For the exhaustive list of keybinding ids and defaults, see [Keybindings](/keybindings). `keybindings.json` uses those same namespaced ids.

Custom editors and `ctx.ui.custom()` components receive `keybindings: KeybindingsManager` as an injected argument. They should use that injected manager directly instead of calling `getKeybindings()` or `setKeybindings()`.

#### Best Practices

- Use `Text` with padding `(0, 0)`. The default Box handles padding.
- Use `\n` for multi-line content.
- Handle `isPartial` for streaming progress.
- Support `expanded` for detail on demand.
- Keep default view compact.
- Read `context.args` in `renderResult` instead of copying args into `context.state`.
- Use `context.state` only for data that must be shared across call and result slots.
- Reuse `context.lastComponent` when the same component instance can be updated in place.
- Use `renderShell: "self"` only when the default boxed shell gets in the way. In self-shell mode the tool is responsible for its own framing, padding, and background.

#### Fallback

If a slot renderer is not defined or throws:
- `renderCall`: Shows the tool name
- `renderResult`: Shows raw text from `content`

## Next steps

Continue with [extension events](/extensions/events) to hook into the session lifecycle. Use the [Extension API reference](/extensions/api-reference) to look up context properties and registration methods.
