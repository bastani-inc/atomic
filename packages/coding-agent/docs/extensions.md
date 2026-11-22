---
title: Extensions
description: Extend Atomic with TypeScript modules that register tools, commands, event handlers, and custom UI.
---

# Extensions

Extensions are TypeScript modules that extend Atomic's behavior. They can subscribe to lifecycle events, register custom tools callable by the LLM, add commands, and render custom UI.

## Reloading and startup behavior

Put extensions in `~/.atomic/agent/extensions/` (global) or `.atomic/extensions/` (project-local) for auto-discovery; legacy `.pi` paths remain supported. Use `atomic -e ./path.ts` for quick tests.

Auto-discovered extensions hot-reload with `/reload`. Atomic evaluates each extension file and the local modules and JSON files it imports through its own transform, including plain JavaScript (`.mjs`, `.cjs`, and `.js`). ESM keeps `import.meta.url`, strict mode, top-level await, and package or Node built-in imports. CommonJS keeps `require`, `module.exports`, `__filename`, `__dirname`, and sloppy mode.

Under Bun, extensions also load through Atomic's extension loader on the first load (not only on `/reload`). That keeps `typebox` and Atomic package imports pointing to Atomic's own copies right away and matches native `import.meta` values (including Windows backslashes). Because the loader reads runtime globals through `globalThis`, modules that declare a top-level `globalThis` binding cannot be loaded this way under Node or Bun.

Packages imported by name resolve from the importing file as Node or Bun would, falling back to Atomic's copy of a host package only when none is installed. Named packages, files under `node_modules` outside the extension's own package, and modules loaded through `createRequire()` load once per process, so restart Atomic after editing them.

If `/reload` reports `Reload retiring cleanup failed`, the error includes the extension cleanup cause. The replacement extensions, updated settings, and joined Intercom groups stay active. Fix the cleanup error before reloading again.

If an optional extension fails to import or initialize during interactive startup or `/reload`, Atomic skips it and shows its path and reason under `[Extension issues]` while keeping the session usable. Fix the extension or its dependencies and run `/reload`. Print mode (`-p`) and standalone RPC mode (`--mode rpc`) report the named failure and exit with status 1 instead so scripts do not silently run without a requested extension. Required built-in failures and failed cleanup stop startup in every mode.

Legacy extensions can import the running host API from `@mariozechner/pi-coding-agent` or `@earendil-works/pi-coding-agent`, including in release-archive installs, without a separate installation.

Key capabilities:

- **Custom tools.** Register tools the LLM can call via `atomic.registerTool()`.
- **Event interception.** Block or modify tool calls, inject context, observe or replace compaction, and customize branch summaries.
- **User interaction.** Prompt users via `ctx.ui` (`select`, `confirm`, `input`, `editor`, `notify`).
- **Custom UI components.** Render interactive TUI components with keyboard input via `ctx.ui.custom()`.
- **Custom commands.** Register slash commands such as `/mycommand` via `atomic.registerCommand()`.
- **Session persistence.** Store durable state that survives restarts via `atomic.appendEntry()`.
- **Reload-surviving state.** Keep in-memory objects alive across `/reload` via `sessionScopedExtensionState()`.
- **Custom rendering.** Control how tool calls, tool results, and custom messages appear in the TUI.

Common use cases include permission gates, git checkpointing, path protection, compaction policies, conversation summaries (`summarize.ts`), interactive wizards, stateful tools, webhooks or file watchers, and waiting-time games (`snake.ts`). See [examples/extensions/](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions) for working implementations.

Atomic also ships an environment-gated [Herdr reporter](/herdr) that reports the parent session's activity, running tasks, and approval requests in its pane. It defers to loaded community or legacy reporters and can be disabled with `herdr.enabled` in settings. See [Herdr setup](/herdr#setup) and [status indicators](/herdr#status-indicators).

## Where to go next

Read this page for startup behavior, locations, imports, and a first extension, then continue:

- [Writing extensions](/extensions/authoring). Build an extension, manage its state, and register custom tools.
- [Extension events](/extensions/events). Look up every event, its payload, and its return contract.
- [Extension UI](/extensions/ui). Render dialogs, widgets, and custom UI components.
- [Extension API reference](/extensions/api-reference). Reference `ExtensionContext`, `ExtensionCommandContext`, `ExtensionAPI` methods, and error handling.
- [Extension examples](/extensions/examples). Browse runnable examples shipped with Atomic.
- [Security](/security). Review the project-trust boundary that controls whether a project's extensions load.

If an extension is heavier than you need, compare lighter options on [Build with Atomic](/build).

## Startup and lazy discovery

Built-in MCP, subagent, web-access, and Intercom commands are available at startup. Their first use may wait for discovery or connection.

Commands wait for the resources they need before returning results, including MCP tool calls and explicit reloads. Discovery scope depends on the operation:

- Enabled MCP servers connect in the background when a session starts. The first prompt waits up to 10 seconds for servers with direct tools.
- Codemode waits for the MCP namespaces a script names; `searchTools()` and `ALL_TOOLS` require all enabled servers. Tool search and resource tools also wait for discovery.
- `/mcp` provides server management; `/mcp login`, `/mcp logout`, and `/mcp reconnect` accept an optional server name. Completion lists actions and eligible servers.
- Autocomplete falls back to current and administrative completions when lazy discovery fails.

Failed connections can be retried with `/mcp reconnect`, and dropped MCP connections reconnect on the next call. Web-access batches with no successful items report a tool error; partial successes keep their completed items.

MCP `timeout` is an inactivity limit in seconds (default 60 seconds), reset by progress rather than a fixed total deadline. See [MCP servers](/mcp-servers) for configuration, exposure, resources, OAuth, and shell commands.

## Interactive callback isolation

Interactive sessions isolate extension callbacks from terminal input handling so a busy callback does not block keyboard input or spinners.

Escape requests cooperative cancellation from the engine and waits as long as the engine takes. There is no deadline on that wait, and Escape never terminates or replaces the engine, so an interrupt cannot discard in-flight tool state.

Ctrl+C is the host's escape hatch in two situations.

First, while an engine-owned `ctx.ui.custom()` component or overlay holds input, every key goes to the engine child. Ownership of Ctrl+C is declared per mount:

- A component mounted with `handlesCtrlC: true` receives the first Ctrl+C press and keeps its own skip, close, or cancel binding. If that same component still holds input on the next Ctrl+C press, the host closes it so no component can trap the keyboard.
- A component without `handlesCtrlC: true` is closed on the first Ctrl+C press through the ordinary close path: its `ctx.ui.custom()` promise resolves with `undefined`, the editor returns, and the engine keeps running (along with any other mounted component).

Declare `handlesCtrlC: true` whenever your component's hint row offers `ctrl+c`. Native host selectors, dialogs, input forms, session pickers, and unrelated native overlays keep Ctrl+C as their own cancel.

```typescript
await ctx.ui.custom<string | undefined>(
  (tui, theme, keybindings, done) => new PromptCard(tui, theme, done),
  { overlay: true, handlesCtrlC: true },
);
```

Both safety keys match by physical key identity rather than the configured `app.clear` action, so rebinding `app.clear` (even to Escape) cannot route Escape into engine replacement or disable Ctrl+C recovery. Rebinding `app.clear` to another key keeps normal editor clearing, and key-release events never act.

Second, if the engine is unresponsive, an abort or replacement has waited over one second, or replacement failed, Ctrl+C terminates and replaces the engine. This takes precedence over custom UI bindings. A failed replacement remains recoverable with another Ctrl+C; Atomic does not keep retrying automatically.

After an unexpected engine stop, Atomic closes custom UI and attempts one automatic restart. A clean restart prints nothing unless messages were still queued.

If messages were queued, main-chat messages return to the editor (steering first) with the warning `Engine restarted; 2 queued messages weren't sent and are back in the editor`, and subagent messages print `Engine restarted; 2 queued messages to <agent> weren't sent:`. None are sent twice, and unstarted submissions return as exact drafts while accepted work is not retried automatically. With debug logging enabled, the restart cause goes to the debug log. A failed restart leaves the editor usable and reports `Interactive engine restart failed: ...`.

If a saved tool call has no recorded result, reopening the session marks its result unavailable. **Inspect files or external systems before retrying because the tool may already have had side effects.**

When spawning processes from an extension, pass an explicit `env` derived from `process.env`. Engine-only bootstrap values are not exposed there.

Dialogs, `ctx.ui.custom()` components, and component-factory widgets run in the isolated engine child and proxy rendered lines to the host with asynchronous input forwarding. Custom UI results must be JSON-safe. APIs that require a synchronous callback in the terminal host (raw `onTerminalInput` transforms, synchronous `getEditorText`, custom editor factories, autocomplete wrappers, and custom header or footer factories) are unavailable in isolated interactive mode and produce a warning instead of running extension code in the host. Print and public RPC modes keep their own execution models.

Use `ctx.ui.hostSessionPicker(request)` for a session-style picker with local navigation and search. Pass JSON-safe `HostSessionPickerRow` values (`SessionInfo` with `createdAt` and `modifiedAt` in epoch milliseconds). The returned handle provides `result`, `update(rows)`, `error(message)`, and `close()`. `result` resolves to the selected `path` or `undefined` on cancel, and your `onDelete(path)` callback owns deletion. This API works in both interactive modes and is absent in print and headless RPC. See [Host-native session picker](/tui/reference#host-native-session-picker).

For structured forms, use `ctx.ui.hostInputForm(request)` with JSON-safe descriptors (`string`, `text`, `number`, `integer`, `boolean`, or `select`) and raw `initialValue` fields. It resolves to a raw string record or `undefined` on cancel, and rejects with `"The host could not read this input form."` if the host cannot read the form. Editing, navigation, validation, and configured keybindings run locally in both interactive modes. Print and headless RPC omit this API. See [Host-native input form](/tui/reference#host-native-input-form).

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
    async execute(toolCallId, params, signal, onUpdate, ctx) {
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

Test with `--extension` (or `-e`):

```bash
atomic -e ./my-extension.ts
```

## Extension locations

> **Security:** Extensions run with your full system permissions and can execute arbitrary code. Install only from sources you trust.

Extensions are auto-discovered from:

| Location | Scope |
|----------|-------|
| `~/.atomic/agent/extensions/*.ts` | Global (all projects) |
| `~/.atomic/agent/extensions/*/index.ts` | Global (subdirectory) |
| `.atomic/extensions/*.ts` | Project-local (trusted projects only) |
| `.atomic/extensions/*/index.ts` | Project-local subdirectory (trusted projects only) |

Atomic also discovers extensions and package resources inherited from legacy `~/.pi/agent` and `.pi` configuration. When an inherited extension uses the exact same tool, command, prompt, flag, or shortcut name as a bundled Atomic extension, Atomic keeps the bundled registration and ignores only the conflicting inherited registration while keeping its other resources. Interactive startup reports those overlaps in one yellow summary; print and RPC modes apply the same winners without editing legacy settings or package files.

This compatibility rule applies only to inherited legacy resources. Extensions configured through `.atomic` or passed with `--extension` keep the normal override and load-order rules.

Configure additional paths in `settings.json`:

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

### Built-in extension resources

Atomic exposes `builtin:llama.cpp`, `builtin:codemode`, and `builtin:tool-search` as extension resources rather than filesystem paths. Disable one in `settings.json`:

```json
{ "extensions": ["-builtin:codemode"] }
```

A trusted project `"+builtin:codemode"` entry can override a global exclusion. Explicit loading also works with `--no-extensions`: `atomic --no-extensions -e builtin:codemode --tools read,codemode`. Loading the resource registers the tool. Codemode is in the default selection, so a replacement tool list must name it; tool search is opt-in.

Codemode and tool search are replaceable: an extension that registers the same tool, command, or flag can take over, and Atomic reports the replacement and its owner. Disable that extension through `atomic config` when you want the built-in implementation instead.

These symbolic names do not replace Atomic's bundled MCP, subagent, web-access, or Intercom packages. There are no `builtin:mcp` or `builtin:subagents` aliases; keep using package settings and MCP configuration.

To share extensions via npm or git as Atomic packages, see [Atomic packages](/packages).

## Available imports

| Package | Purpose |
|---------|---------|
| `@bastani/atomic` | Extension types (`ExtensionAPI`, `ExtensionContext`, events) and helpers such as `StringEnum` |
| `typebox` | Schema definitions for tool parameters. Direct `typebox` imports (including subpaths such as `typebox/format`) resolve to Atomic's copy so formats registered with `Format.Set()` apply to tool validation |
| [`@bastani/atomic-ai`](/libraries/ai) | AI utilities (also exports `StringEnum`), provider APIs, and image generation helpers |
| [`@bastani/atomic-tui`](/libraries/tui) | TUI components for custom rendering |
| [`@bastani/atomic-agent-core`](/libraries/agent-core) | Agent loop types and helpers |
| [`@bastani/atomic-codemode`](/libraries/codemode) | Codemode sandbox and declaration helpers |
| [`@bastani/atomic-schema`](/libraries/schema) | JSON Schema builders and validation |
| [`@bastani/atomic-telemetry`](/libraries/telemetry) | Telemetry contracts |

Atomic maintains these packages directly; [Libraries](/libraries) documents each one. Legacy extension names (`@earendil-works/pi-*`, `@mariozechner/pi-*`, and `@bastani/pi-ai`) resolve to the same modules, including their subpaths. New extensions should import the `@bastani/atomic-*` names.

**Sharing TypeBox from dependencies and SDK apps.** Direct `typebox` imports inside an extension file are mapped to Atomic's copy automatically. If a separate package your extension depends on (or an SDK application) registers custom TypeBox formats, settings, or locales that must reach Atomic's tool validation, import from `@bastani/atomic/typebox` and its subpaths (`/compile`, `/error`, `/format`, `/guard`, `/schema`, `/system`, `/type`, `/value`) rather than from a separate `typebox` dependency.

Registry dependencies work too. Add a `package.json` next to your extension (or in a parent directory) and install dependencies with npm (or pnpm or Bun):

```bash
npm install
```

Imports from `node_modules/` resolve automatically.

For distributed Atomic packages installed with `atomic install` (npm or git), declare runtime dependencies in `dependencies`. Package installation installs production dependencies by default, so `devDependencies` are not available at runtime. When `npmCommand` is configured, git packages run a plain `install` for wrapper compatibility.

### Tool parameter schemas

A tool's `parameters` can be a TypeBox schema or any plain JSON Schema object. Atomic validates the model's arguments against it after coercing loosely typed values (such as a numeric string to a number, `"true"` to `true`, or dropping `null` in an optional property):

- **TypeBox schemas** are converted and checked by TypeBox, so TypeBox features outside JSON Schema (such as `Type.Refine()` and formats registered with `Format.Set()`) apply and validation errors use TypeBox's messages.
- **Plain JSON Schema** (such as an MCP server's tool schema or a schema built with `@bastani/atomic-schema`) is coerced and checked by `@bastani/atomic-schema`. A single value is wrapped into a one-item array when an array is expected, the `url` and `json-pointer-uri-fragment` formats are checked, and an unresolved `$ref` rejects only the argument at that field instead of every call. Validation errors use `@bastani/atomic-schema`'s messages, such as `- path: missing` or `- limit: expected number, got string`.

Node.js built-ins (`node:fs`, `node:path`, and the rest of `node:*`) are also available.

## Mode behavior

| Mode | UI methods | Notes |
|------|-----------|-------|
| Interactive | Full TUI | Normal operation |
| RPC (`--mode rpc`) | JSON protocol | Host handles UI; see [RPC mode](/rpc) |
| JSON (`--mode json`) | No-op | Event stream to stdout; see [JSON mode](/json) |
| Print (`-p`) | No-op | Extensions run without interactive prompts |

In non-interactive modes, check `ctx.hasUI` before using UI methods.

## Moved sections

<a id="writing-an-extension" />
<a id="async-factory-functions" />
<a id="long-lived-resources-and-shutdown" />
<a id="extension-styles" />
<a id="state-management" />
<a id="session-scoped-in-memory-state" />
<a id="custom-tools" />
<a id="tool-definition" />
<a id="constrained-sampling" />
<a id="fireworks-deferred-tool-loading" />
<a id="overriding-built-in-tools" />
<a id="remote-execution" />
<a id="output-truncation" />
<a id="multiple-tools" />
<a id="custom-rendering" />
<a id="tool-rendering" />
<a id="rendercall" />
<a id="renderresult" />
<a id="keybinding-hints" />
<a id="best-practices" />
<a id="fallback" />

- Extension structure, state management, custom tools, overrides, remote execution, truncation, and custom rendering moved to [Writing extensions](/extensions/authoring).

<a id="events" />
<a id="lifecycle-overview" />
<a id="startup-events" />
<a id="project_trust" />
<a id="resource-events" />
<a id="resources_discover" />
<a id="session-events" />
<a id="session_start" />
<a id="session_info_changed" />
<a id="session_before_switch" />
<a id="session_before_fork" />
<a id="session_before_compact-/-session_compact-/-session_compact_failed" />
<a id="session_before_tree-/-session_tree" />
<a id="session_shutdown" />
<a id="agent-events" />
<a id="before_agent_start" />
<a id="agent_start-/-agent_end-/-agent_before_settle-/-agent_settled" />
<a id="ui_prompt_start-/-ui_prompt_end" />
<a id="turn_start-/-turn_end" />
<a id="message_start-/-message_update-/-message_end" />
<a id="tool_execution_start-/-tool_execution_update-/-tool_execution_end" />
<a id="context" />
<a id="context_with_system" />
<a id="before_provider_headers" />
<a id="before_provider_request" />
<a id="after_provider_response" />
<a id="model-events" />
<a id="model_select" />
<a id="thinking_level_select" />
<a id="tool-events" />
<a id="tool_call" />
<a id="typing-custom-tool-input" />
<a id="tool_result" />
<a id="user-bash-events" />
<a id="user_bash" />
<a id="input-events" />
<a id="input" />

- Lifecycle diagrams, event payloads, and return contracts moved to [Extension events](/extensions/events).

<a id="custom-ui" />
<a id="dialogs" />
<a id="timed-dialogs-with-countdown" />
<a id="manual-dismissal-with-abortsignal" />
<a id="widgets-status-and-footer" />
<a id="autocomplete-providers" />
<a id="custom-components" />
<a id="overlay-mode-experimental" />
<a id="custom-editor" />
<a id="message-rendering" />
<a id="theme-colors" />

- Dialogs, widgets, autocomplete providers, custom components, overlays, custom editors, and theme helpers moved to [Extension UI](/extensions/ui).

<a id="extensioncontext" />
<a id="ctx-ui" />
<a id="ctx-hasui" />
<a id="ctx-cwd" />
<a id="ctx-isprojecttrusted" />
<a id="ctx-sessionmanager" />
<a id="ctx-modelregistry-/-ctx-model-/-ctx-scopedmodels" />
<a id="ctx-signal" />
<a id="ctx-isidle-/-ctx-abort-/-ctx-haspendingmessages" />
<a id="ctx-isprojecttrusted-2" />
<a id="ctx-shutdown" />
<a id="ctx-getcontextusage" />
<a id="ctx-compact" />
<a id="ctx-getsystemprompt" />
<a id="ctx-getskillcatalog" />
<a id="extensioncommandcontext" />
<a id="ctx-waitforidle" />
<a id="ctx-newsession-options" />
<a id="ctx-fork-entryid-options" />
<a id="ctx-navigatetree-targetid-options" />
<a id="ctx-switchsession-sessionid-options" />
<a id="session-replacement-lifecycle-and-footguns" />
<a id="ctx-reload" />
<a id="extensionapi-methods" />
<a id="pi-on-event-handler" />
<a id="pi-registertool-definition" />
<a id="built-in-tool-prompt-contributions" />
<a id="pi-sendmessage-message-options" />
<a id="pi-sendmessages-messages-options" />
<a id="pi-sendusermessage-content-options" />
<a id="pi-appendentry-customtype-data" />
<a id="pi-registerentryrenderer-customtype-renderer" />
<a id="pi-setsessionname-name" />
<a id="pi-getsessionname" />
<a id="pi-setlabel-entryid-label" />
<a id="pi-registercommand-name-options" />
<a id="pi-getcommands" />
<a id="pi-registermessagerenderer-customtype-renderer" />
<a id="pi-registermarkdowntransformer-transformer" />
<a id="pi-registershortcut-shortcut-options" />
<a id="pi-registerflag-name-options" />
<a id="pi-registeragentpanelsource-source" />
<a id="pi-exec-command-args-options" />
<a id="pi-getactivetools-/-pi-getalltools-/-pi-setactivetools-names" />
<a id="pi-setmodel-model" />
<a id="pi-getthinkinglevel-/-pi-setthinkinglevel-level" />
<a id="pi-events" />
<a id="native-providers" />
<a id="pi-registerprovider-name-config" />
<a id="pi-unregisterprovider-name" />
<a id="pi-registermcpserver-name-config" />
<a id="error-handling" />

- `ExtensionContext`, `ExtensionCommandContext`, `ExtensionAPI` methods, and error handling moved to [Extension API reference](/extensions/api-reference).

<a id="examples-reference" />

- Runnable extension examples moved to [Extension examples](/extensions/examples).
