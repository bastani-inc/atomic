---
title: "Extensions overview"
sidebarTitle: "Extensions overview"
description: "Build TypeScript extensions that add tools, slash commands, lifecycle hooks, and custom terminal UI to Atomic."
---

Extensions are TypeScript or JavaScript modules that customize how Atomic behaves. You can use them to add custom tools, intercept lifecycle events, register slash commands, store session state, or render custom terminal UI.

Key capabilities:

- **Custom tools.** Register tools the model can call with `atomic.registerTool()`.
- **Event hooks.** Block or modify tool calls, adjust context before requests, observe or replace compaction, and customize branch summaries.
- **User interaction.** Show interactive prompts and notifications via `ctx.ui` (`select`, `confirm`, `input`, `editor`, `notify`).
- **Custom UI components.** Render interactive terminal components and overlays with `ctx.ui.custom()`.
- **Custom commands.** Register slash commands such as `/mycommand` with `atomic.registerCommand()`.
- **Session persistence.** Store durable data across restarts with `atomic.appendEntry()`.
- **Reload-surviving state.** Keep in-memory objects alive across `/reload` with `sessionScopedExtensionState()`.
- **Custom rendering.** Control how tool calls, tool results, and custom messages appear in the terminal.

Common use cases include permission gates, git checkpointing, path protection, compaction policies, conversation summaries, interactive wizards, webhooks or file watchers, and waiting-time games. See [Extension examples](/extensions/examples) for runnable code.

## Where to go next

Read this overview for a working first extension, discovery locations, imports, and runtime behavior, then continue:

- [Write an extension](/extensions/authoring). Structure an extension, manage state, register custom tools, and customize rendering.
- [Extension events](/extensions/events). Look up every lifecycle event, its payload, and its return contract.
- [Extension UI](/extensions/ui). Build dialogs, widgets, host-native pickers and forms, custom components, and message renderers.
- [Extension API reference](/extensions/api-reference). Reference `ExtensionContext`, `ExtensionToolContext`, `ExtensionCommandContext`, `ExtensionAPI` methods, and error handling.
- [Extension examples](/extensions/examples). Browse runnable extensions shipped with Atomic.
- [SDK extensions](/sdk/reference#extensions) and [Structured decisions](/sdk/structured-decisions). Load extensions programmatically with `DefaultResourceLoader`, pass standalone `customTools`, or run schema-validated decisions.
- [Security](/security). Review the project-trust boundary that controls whether a project's extensions load.

If an extension is heavier than you need, compare lighter options on [Build with Atomic](/build).

## Quick start

Create `~/.atomic/agent/extensions/my-extension.ts` (the factory parameter can have any name; older extensions and examples call it `pi`):

```typescript
import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";

export default function (atomic: ExtensionAPI) {
  // React to events
  atomic.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });

  atomic.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Register a custom tool
  atomic.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // Register a command
  atomic.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

Test it for one run with `-e` (or `--extension`):

```bash
atomic -e ./my-extension.ts
```

### Loading in the SDK

Embedded apps can load extension files, pass inline factories through `DefaultResourceLoader`, or register standalone tools directly with `createAgentSession({ customTools })`:

```typescript
import { createAgentSession, DefaultResourceLoader, defineTool } from "@bastani/atomic";
import { Type } from "@bastani/atomic/typebox";

const loader = new DefaultResourceLoader({
  additionalExtensionPaths: ["./my-extension.ts"],
  extensionFactories: [
    (atomic) => {
      atomic.on("agent_start", () => console.log("Starting run"));
    },
  ],
});
await loader.reload();

const pingTool = defineTool({
  name: "ping",
  label: "Ping",
  description: "Return pong",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "pong" }], details: {} };
  },
});

const { session } = await createAgentSession({
  resourceLoader: loader,
  customTools: [pingTool],
});
```

See [SDK extensions](/sdk/reference#extensions) and [SDK custom tools](/sdk/reference#custom-tools).

## Extension locations

> **Security:** Extensions run with your full system permissions and can execute arbitrary code. Install only from sources you trust.

Atomic auto-discovers extensions from these locations:

| Location | Scope |
| --- | --- |
| `~/.atomic/agent/extensions/*.{ts,js}` | Global single-file extensions (all projects) |
| `~/.atomic/agent/extensions/*/index.{ts,js}` | Global subdirectory extensions |
| `~/.atomic/agent/extensions/*/package.json` | Global subdirectories declaring `atomic.extensions` (or legacy `pi.extensions`) |
| `.atomic/extensions/*.{ts,js}` | Project single-file extensions (trusted projects only) |
| `.atomic/extensions/*/index.{ts,js}` | Project subdirectory extensions (trusted projects only) |
| `.atomic/extensions/*/package.json` | Project subdirectories declaring `atomic.extensions` (trusted projects only) |

Discovery rules:

- Scanning respects `.gitignore`, `.ignore`, and `.fdignore` inside extension directories, and skips dotfiles, dot-directories, and `node_modules`.
- Disable extension discovery with `--no-extensions` (short flag `-ne`). Explicit `-e` paths and the mandatory bundled Intercom extension still load.
- Atomic also discovers extensions and packages inherited from legacy `~/.pi/agent` and `.pi` directories. If an inherited legacy extension registers the exact same tool, command, prompt, flag, or shortcut name as a bundled Atomic extension, Atomic keeps the bundled registration and skips only that conflicting registration (summarized in yellow on interactive startup). Extensions configured through `.atomic` or passed with `-e` follow normal override rules.

Configure extra paths or packages in `settings.json`:

```json
{
  "packages": [
    "npm:@foo/bar@1.0.0",
    "git:github.com/user/repo@v1"
  ],
  "extensions": [
    "/path/to/local/extension.ts",
    "/path/to/local/extension/dir"
  ]
}
```

To distribute extensions over npm or git, see [Install and manage packages](/packages).

### Built-in extension resources

Atomic exposes `builtin:llama.cpp` ([llama.cpp](/llama-cpp)), `builtin:codemode` ([Codemode](/codemode)), and `builtin:tool-search` (which registers the [`tool_search`](/tools#tool_search) tool) as built-in extension resources rather than filesystem paths. Toggle them interactively in `atomic config`, or disable one in `settings.json`:

```json
{ "extensions": ["-builtin:codemode"] }
```

A trusted project `"+builtin:codemode"` entry overrides a global exclusion. You can also load one explicitly alongside `--no-extensions` (`-ne`):

```bash
atomic --no-extensions -e builtin:codemode --tools read,codemode
```

Passing an unrecognized `builtin:<name>` with `-e` stops with `Unknown built-in extension: builtin:<name>`.

Loading a built-in resource registers its tool. `codemode` is enabled in the default tool list (so a custom `--tools` list must name it), while `tool_search` is opt-in. Both `codemode` and `tool-search` are replaceable: a custom extension that registers the same tool, command, or flag takes over, and Atomic reports the replacement. Disable that extension in `atomic config` to restore the built-in version.

These built-in names do not replace Atomic's bundled MCP, subagent, web-access, or Intercom packages. There are no `builtin:mcp` or `builtin:subagents` aliases; configure those through package settings and MCP configuration.

## Available imports

Extensions can import Atomic's bundled packages without installing them in `node_modules`:

| Package | Purpose |
| --- | --- |
| [`@bastani/atomic`](/sdk) | Extension types (`ExtensionAPI`, `ExtensionContext`, events), helpers (`StringEnum`, `defineTool`), and built-in tool factories |
| [`@bastani/atomic/storage`](/sdk/storage) | Storage adapter interfaces, `createSqliteDatabase()`, and storage errors |
| `@bastani/atomic/typebox` | Atomic's copy of TypeBox plus subpaths (`/compile`, `/error`, `/format`, `/guard`, `/schema`, `/system`, `/type`, `/value`) |
| `typebox` and `@sinclair/typebox` | Direct schema imports (including `typebox/*`, `@sinclair/typebox/compile`, and `@sinclair/typebox/value`) resolve to Atomic's copy so formats registered with `Format.Set()` apply to tool validation |
| [`@bastani/atomic-ai`](/libraries/ai) | AI utilities, provider APIs, image generation, and subpaths (`/oauth`, `/models`, `/providers/all`) |
| [`@bastani/atomic-tui`](/libraries/tui) | Terminal UI components for custom rendering |
| [`@bastani/atomic-agent-core`](/libraries/agent-core) | Agent loop types and helpers |
| [`@bastani/atomic-codemode`](/libraries/codemode) | Codemode sandbox and declaration helpers (`@bastani/atomic-codemode/*`) |
| [`@bastani/atomic-schema`](/libraries/schema) | JSON Schema builders, validation, and `/formats` |
| [`@bastani/atomic-telemetry`](/libraries/telemetry) | Telemetry contracts and `/render` |

Atomic maintains these packages directly; [Libraries](/libraries) documents each one. Legacy import names (`@earendil-works/pi-*`, `@mariozechner/pi-*`, and `@bastani/pi-ai`) resolve to the same modules, including in release-archive installs. New extensions should import the `@bastani/atomic-*` names.

Node.js built-ins (`node:fs`, `node:path`, and the rest of `node:*`) are always available.

**Sharing TypeBox from dependencies and SDK apps.** Direct `typebox` imports inside an extension file map to Atomic's copy automatically. If a separate dependency or SDK app registers custom TypeBox formats, settings, or locales that must reach Atomic's tool validation, import from `@bastani/atomic/typebox` and its subpaths rather than from a separate `typebox` dependency. See [Sharing Atomic's TypeBox registry](/sdk#sharing-atomics-typebox-registry).

**Third-party npm dependencies.** Add a `package.json` next to your extension (or in a parent directory) and install dependencies with npm, pnpm, or Bun:

```bash
npm install
```

Imports from `node_modules/` resolve automatically. For distributed packages installed with `atomic install` (npm or git), declare runtime dependencies in `dependencies`; `devDependencies` are omitted by default. When `npmCommand` is configured in `settings.json`, git package installs still detect `npm`, `pnpm`, or `bun` inside wrapper commands (such as `["mise", "exec", "node@20", "--", "npm"]`) and pass manager-specific flags to skip dev and peer dependencies. Plain `install` runs only for unrecognized package manager commands.

### Tool parameter schemas

A tool's `parameters` can be a TypeBox schema or any plain JSON Schema object. Atomic validates arguments from the model after coercing loosely typed values (such as a numeric string to a number, `"true"` to `true`, or dropping `null` on an optional property):

- **TypeBox schemas** are validated by TypeBox, so TypeBox features outside JSON Schema (such as `Type.Refine()` and formats registered with `Format.Set()`) apply and errors use TypeBox's format.
- **Plain JSON Schema** (such as an MCP server's schema or one built with `@bastani/atomic-schema`) is coerced and checked by `@bastani/atomic-schema`. Single values wrap into one-item arrays when an array is expected, `url` and `json-pointer-uri-fragment` formats are checked, and an unresolved `$ref` rejects only that field instead of every call. Errors use `@bastani/atomic-schema`'s format, such as `- path: missing` or `- limit: expected number, got string`.

## Mode behavior

| Mode | UI methods | Notes |
| --- | --- | --- |
| Interactive | Full TUI | Extensions run in a background worker so slow callbacks do not freeze the terminal |
| RPC (`--mode rpc`) | JSON protocol | Host handles UI; see [RPC mode](/rpc) |
| JSON (`--mode json`) | No-op | Event stream to stdout; see [JSON mode](/json) |
| Print (`-p`) | No-op | Extensions run without interactive prompts |

Check `ctx.hasUI` (or `ctx.mode === "tui"`) before using UI methods in extensions that may run outside interactive mode.

## Reloading and startup behavior

Auto-discovered extensions hot-reload when you run `/reload`. Atomic transpiles each extension file along with local TypeScript, JavaScript (`.mjs`, `.cjs`, `.js`), and JSON files it imports by relative path, so edits to those local files take effect on `/reload`.

- **Module format.** ESM files keep `import.meta.url`, strict mode, top-level `await`, and package or Node built-in imports. CommonJS files keep `require`, `module.exports`, `__filename`, and `__dirname`.
- **Caching on `/reload`.** Named npm packages, files under `node_modules` outside the extension's own package, and modules loaded via `createRequire()` are loaded once per process. Restart Atomic after editing those files.
- **Bun and `globalThis`.** Under Bun, extensions load through Atomic's loader on initial startup as well as `/reload`, keeping `typebox` and `@bastani/atomic-*` imports pinned to Atomic's own copies. Modules that declare a top-level variable named `globalThis` cannot be loaded under either Node or Bun.
- **Load failures.** If an optional extension fails to import or initialize during interactive startup or `/reload`, Atomic skips it, lists its path and error under `[Extension issues]`, and keeps the session open. Fix the issue and run `/reload`. In print (`-p`) and standalone RPC (`--mode rpc`) modes, any extension load failure prints the error and exits with code 1. Required built-in failures and cleanup failures stop startup in every mode.
- **Reload cleanup failures.** If `/reload` reports `Reload retiring cleanup failed`, the error names the failing cleanup callback while keeping the replacement extensions, updated settings, and Intercom groups active. Fix the cleanup bug before reloading again.
- **Built-in Herdr status reporter.** Inside a Herdr pane, Atomic automatically reports parent session status and resume commands with its built-in [Herdr integration](/herdr) and skips Herdr's legacy `herdr-agent-state.ts` or `.js` file (outside a Herdr pane, that legacy file loads normally). If you installed a separate `herdr-atomic-reporter` extension, disable either that extension or `herdr.enabled` in `settings.json` to prevent flickering status updates. See [Herdr setup](/herdr#setup).

## Startup and lazy discovery

Built-in [MCP](/mcp-servers), [subagent](/subagents), [web-access](/web-access), and [Intercom](/intercom) commands are available immediately at startup. Their first call may wait for background discovery or connection to finish:

- Enabled MCP servers connect in the background at startup. Your first prompt waits up to 10 seconds for servers that expose direct tools.
- Codemode waits for the MCP namespaces a script names; `searchTools()` and `ALL_TOOLS` wait for all enabled servers. Tool search and resource tools wait for discovery too.
- `/mcp` manages servers, and `/mcp login`, `/mcp logout`, and `/mcp reconnect` accept an optional server name. If lazy discovery fails, autocomplete falls back to currently known commands.
- Dropped MCP connections reconnect on the next call, and failed connections can be retried with `/mcp reconnect`. Web-access batches report a tool error when every item fails and keep completed items on partial success.

MCP `timeout` is an inactivity limit in seconds (default 60 seconds) that resets on progress rather than a fixed total deadline. See [MCP servers](/mcp-servers) for details.

<div id="interactive-callback-isolation" />

## Responsive UI and crash recovery

In default interactive mode, Atomic runs extensions in a separate background worker process so slow or stuck extension code does not freeze keyboard input or terminal spinners.

### Cancellation and Ctrl+C safety

- **Escape** asks the active turn or tool to cancel cooperatively and waits until it finishes. Escape never kills the worker process, so in-flight tool state is not discarded mid-operation.
- **Ctrl+C while custom UI is open:**
  - If a `ctx.ui.custom()` component sets `{ handlesCtrlC: true }`, it receives the first `Ctrl+C` press for its own skip, close, or cancel behavior. If the same component still holds input on a second `Ctrl+C`, Atomic closes it so no extension can trap your keyboard.
  - Without `handlesCtrlC: true`, the first `Ctrl+C` closes the component immediately, resolves its `ctx.ui.custom()` promise with `undefined`, and returns focus to the editor while the session keeps running.
  - Set `handlesCtrlC: true` whenever your component displays a `ctrl+c` hint. Built-in selectors, dialogs, input forms, and session pickers handle `Ctrl+C` directly.

```typescript
await ctx.ui.custom<string | undefined>(
  (tui, theme, keybindings, done) => new PromptCard(tui, theme, done),
  { overlay: true, handlesCtrlC: true },
);
```

- **Ctrl+C when the worker is hung:** If the extension worker stops responding, an abort or restart waits longer than one second, or a prior restart failed, `Ctrl+C` terminates and restarts the worker (taking priority over custom UI bindings). Both `Escape` and `Ctrl+C` match physical keys, so rebinding `app.clear` cannot disable recovery.

### Automatic restart and queued messages

If the extension worker crashes unexpectedly, Atomic closes open custom UI and attempts one automatic restart. A clean restart stays quiet unless messages were still queued:

- Queued main-chat messages return to the editor (steering messages first) with a warning such as `Engine restarted; 2 queued messages weren't sent and are back in the editor`.
- Queued subagent messages confirmed not yet sent return ahead of any draft in that subagent's editor (immediately if open and writable, or when reopened), or print a notice if the subagent view is read-only. They are never placed into the main chat editor or sent twice.
- Drafts that never started are restored verbatim; work that already started is not retried automatically. If a saved tool call has no recorded result, reopening the session marks its result unavailable. **Inspect affected files or external systems before retrying because the tool may already have had side effects.**
- If you spawn child processes from an extension, derive an explicit `env` object from `process.env`; internal startup variables are not exported there.

### UI APIs in default interactive mode

Dialogs, `ctx.ui.custom()` components, and widget factories run inside the extension worker and forward rendered output to the terminal. Values returned from `ctx.ui.custom()` must be JSON-serializable.

APIs that require synchronous access inside the terminal UI process (`ctx.ui.onTerminalInput`, synchronous `ctx.ui.getEditorText`, `ctx.ui.setEditorComponent`, `ctx.ui.addAutocompleteProvider`, `ctx.ui.setHeader`, and `ctx.ui.setFooter`) do not run in default interactive mode and emit a warning instead. For interactive pickers and structured forms that work natively in default interactive mode, use `ctx.ui.hostSessionPicker()` and `ctx.ui.hostInputForm()`. See [Host-native pickers and forms](/extensions/ui#host-native-pickers-and-forms).

## Moved sections

<div id="session-scoped-in-memory-state" />

<div id="custom-rendering" />

- Extension structure, state management, custom tools, overrides, remote execution, truncation, and custom rendering moved to [Write an extension](/extensions/authoring).

<div id="before_agent_start" />

<div id="message_start--message_update--message_end" />

<div id="before_provider_request" />

<div id="thinking_level_select" />

<div id="tool-call-events" />

<div id="user_bash" />

- Lifecycle diagrams, event payloads, and return contracts moved to [Extension events](/extensions/events).

<div id="widgets-status-and-footer" />

<div id="autocomplete-providers" />

- Dialogs, widgets, autocomplete providers, custom components, overlays, custom editors, and theme helpers moved to [Extension UI](/extensions/ui).

<div id="ctxsignal" />

<div id="pigetcommands" />

- `ExtensionContext`, `ExtensionCommandContext`, `ExtensionAPI` methods, and error handling moved to [Extension API reference](/extensions/api-reference).
