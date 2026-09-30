> Atomic can create extensions. Ask it to build one for your use case.

# Extensions

Extensions are TypeScript modules that extend Atomic's behavior. They can subscribe to lifecycle events, register custom tools callable by the LLM, add commands, and more.

> **Placement for /reload:** Put extensions in `~/.atomic/agent/extensions/` (global) or `.atomic/extensions/` (project-local) for auto-discovery; legacy `.pi` paths remain supported. Use `atomic -e ./path.ts` only for quick tests. Extensions in auto-discovered locations can be hot-reloaded with `/reload`.

**Key capabilities:**
- **Custom tools** - Register tools the LLM can call via `pi.registerTool()`
- **Event interception** - Block or modify tool calls, inject context, observe/cancel deletion-only compaction, and customize branch summaries
- **User interaction** - Prompt users via `ctx.ui` (select, confirm, input, notify)
- **Custom UI components** - Full TUI components with keyboard input via `ctx.ui.custom()` for complex interactions
- **Custom commands** - Register commands like `/mycommand` via `pi.registerCommand()`
- **Session persistence** - Store state that survives restarts via `pi.appendEntry()`
- **Reload-surviving state** - Keep in-memory objects alive across `/reload` via `sessionScopedExtensionState()`
- **Custom rendering** - Control how tool calls/results and messages appear in TUI

**Example use cases:**
- Permission gates (confirm before `rm -rf`, `sudo`, etc.)
- Git checkpointing (stash at each turn, restore on branch)
- Path protection (block writes to `.env`, `node_modules/`)
- Compaction policies (cancel compaction or provide exact deletion targets)
- Conversation summaries (see `summarize.ts` example)
- Interactive tools (questions, wizards, custom dialogs)
- Stateful tools (todo lists, connection pools)
- External integrations (file watchers, webhooks, CI triggers)
- Games while you wait (see `snake.ts` example)

See [examples/extensions/](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions) for working implementations.

Atomic also ships an environment-gated [Herdr reporter](/herdr). It combines settled agent activity, extension prompt events, and observed workflow roots under one parent pane owner. It defers to loaded community or legacy reporters and can be disabled with `herdr.enabled` in settings. See [Herdr setup](/herdr#setup) for the supported version and [status indicators](/herdr#status-indicators) for reported activity.

## Where to go next

Extensions are TypeScript modules that add tools, commands, event handlers, and custom UI. Read this page for startup behavior, locations, imports, and a first extension, then continue:

- [Writing extensions](/extensions/authoring) — build one, manage its state, and register custom tools.
- [Extension events](/extensions/events) — every event, its payload, and its return contract.
- [Extension UI](/extensions/ui) — render custom UI from an extension.
- [Extension API reference](/extensions/api-reference) — `ExtensionContext`, `ExtensionCommandContext`, `ExtensionAPI` methods, and error handling.
- [Extension examples](/extensions/examples) — runnable examples shipped with Atomic.
- [Security](/security) — the project-trust boundary that decides whether a project's extensions load, and what an extension can reach once it does. Read this before installing an extension you did not write.

If an extension is heavier than you need, compare the lighter mechanisms on [Build with Atomic](/build).

## Table of Contents

- [Startup and lazy discovery](/extensions#startup-and-lazy-discovery)
- [Interactive callback isolation](/extensions#interactive-callback-isolation)
- [Quick Start](/extensions#quick-start)
- [Extension Locations](/extensions#extension-locations)
- [Available Imports](/extensions#available-imports)
- [Writing an Extension](/extensions/authoring#writing-an-extension)
  - [Extension Styles](/extensions/authoring#extension-styles)
- [Events](/extensions/events#events)
  - [Lifecycle Overview](/extensions/events#lifecycle-overview)
  - [Resource Events](/extensions/events#resource-events)
  - [Session Events](/extensions/events#session-events)
  - [Agent Events](/extensions/events#agent-events)
  - [Model Events](/extensions/events#model-events)
  - [Tool Events](/extensions/events#tool-events)
- [Workflow activity and lifecycle hooks](/extensions/events#workflow-activity-and-lifecycle-hooks)
- [ExtensionContext](/extensions/api-reference#extensioncontext)
- [ExtensionCommandContext](/extensions/api-reference#extensioncommandcontext)
- [ExtensionAPI Methods](/extensions/api-reference#extensionapi-methods)
- [State Management](/extensions/authoring#state-management)
  - [Session-scoped in-memory state](/extensions/authoring#session-scoped-in-memory-state)
- [Custom Tools](/extensions/authoring#custom-tools)
- [Custom UI](/extensions/ui#custom-ui)
- [Error Handling](/extensions/api-reference#error-handling)
- [Mode Behavior](/extensions#mode-behavior)
- [Examples Reference](/extensions/examples#examples-reference)

## Startup and lazy discovery

Built-in MCP, workflow, subagent, web-access, and Intercom commands are available at startup. Their first use may wait for discovery or connection.

Commands still wait for the resources they need before returning results. These include `/workflow list`, named workflow runs/inputs, failed or durable workflow resume, `/mcp`, direct MCP tool calls, `mcp({ search })`, `mcp({ describe })`, `mcp({ server })`, and explicit reload/setup flows.

Discovery scope depends on the operation:

- Cold-cache MCP proxy `describe` loads metadata only for prefix-matched or explicitly requested servers. A prefix-directed miss does not start unrelated servers.
- Cold-cache unscoped MCP proxy `search` loads metadata from all uncached lazy servers to search the full configured tool set.
- Env-selected MCP direct tools warm only their selected servers and refresh live tool registration when ready.
- Paused live-workflow resume and pickers bypass full workflow discovery.
- Autocomplete falls back to current/admin completions when lazy discovery fails.

Failed first-use initialization can be retried. Cancelling one caller does not cancel initialization needed by others. Web-access batches with no successful items report a tool error; partial successes retain their completed items.

MCP tool `timeoutMs` is an inactivity limit, not a total deadline: progress resets it. Omit it to use the MCP SDK default.

## Interactive callback isolation

Interactive sessions isolate extension callbacks from terminal input handling, so a busy callback does not stop keyboard handling or spinners.

Escape requests the engine's own cooperative cancellation and waits for it, for as long as the engine takes. There is no deadline on that wait, and Escape never terminates or replaces the engine, so an interrupt cannot discard in-flight tool state.

Ctrl+C is the host's escape hatch, and it applies in two distinct situations.

The first is a remote custom UI. While an engine-owned `ctx.ui.custom()` component or overlay holds input, every key is forwarded to the engine child, so a component that never resolves would trap Ctrl+C too. Ownership of the key is declared per mount:

- A component mounted with `handlesCtrlC: true` receives the press and keeps its own Skip, Close, or cancel binding. If that same component is still holding input on the next press, that press closes it, so a declared component cannot trap the keyboard either.
- A component that did not declare it is closed by the first press, through the ordinary close path: its `ctx.ui.custom()` promise resolves with `undefined`, the child is told the component closed, the editor comes back, and the engine keeps running — including any other component that generation has mounted below or above this one.

Declare `handlesCtrlC` whenever your component's hint row offers `ctrl+c` for anything. This is a migration for existing components: an extension that already bound Ctrl+C keeps that binding only by adding the option. The bundled workflow surfaces and the `/mcp`, `/mcp setup`, and MCP OAuth panels declare it. Native host selectors, dialogs, input forms, session pickers, and unrelated native overlays are unaffected: they keep Ctrl+C as their own cancel.

```typescript
await ctx.ui.custom<string | undefined>(
  (tui, theme, keybindings, done) => new PromptCard(tui, theme, done),
  { overlay: true, handlesCtrlC: true },
);
```

Both safety keys are matched by physical identity rather than by the configured `app.clear` action, so rebinding `app.clear` — even to Escape — can neither route Escape into a stop/restart branch nor take the host route away from Ctrl+C. A configured `app.clear` on any other key keeps its ordinary editor-clear behavior, and key-release events never act.

If the engine is unresponsive, an abort or replacement has waited over one second, or replacement failed, Ctrl+C terminates and replaces it. This takes precedence over custom UI bindings. A failed replacement remains recoverable with another Ctrl+C; Atomic does not keep retrying automatically.

After an unexpected engine stop, Atomic closes its custom UI and makes one automatic restart attempt. A failed restart leaves the editor usable and reports `Interactive engine restart failed: …`. A submission that never started returns as an exact draft, including pasted content and queued submissions in order. Accepted work is not offered for automatic retry.

If a saved tool call has no recorded result, reopening the session shows that its result is unavailable. **Inspect files or external systems before retrying: the tool may already have had side effects.**

When spawning processes from an extension, pass an explicit `env` derived from `process.env`. Engine-only bootstrap values are not exposed in that environment.

Dialogs and `ctx.ui.custom()` components are proxied to the host as rendered lines with asynchronous input forwarding. Custom UI results must be JSON-safe. APIs that require a synchronous callback in the terminal process—raw `onTerminalInput` transforms, synchronous `getEditorText`, custom editor factories, autocomplete wrappers, component-factory widgets, and custom header/footer factories—are unavailable in isolated interactive mode and produce a warning rather than executing extension code in the host. Print and public RPC modes retain their existing execution model.

Use `ctx.ui.hostSessionPicker(request)` for a session-style picker with responsive local navigation and search. Supply JSON-safe `HostSessionPickerRow` values: `SessionInfo` with `createdAt` and `modifiedAt` in epoch milliseconds.

The returned handle provides `result`, `update(rows)`, `error(message)`, and `close()`. `result` resolves to the selected `path`, or `undefined` on cancel. Your `onDelete(path)` callback owns deletion; the row remains until you call `update` or `error`. The API works in both interactive modes and is absent in print and headless RPC. See [Host-native session picker](/tui/reference#host-native-session-picker).

For structured forms, use `ctx.ui.hostInputForm(request)`. Supply JSON-safe descriptors of type `string`, `text`, `number`, `integer`, `boolean`, or `select`, each with a raw `initialValue`. It resolves to a raw string record or `undefined` on cancellation. Editing, navigation, validation, and configured keybindings work locally in both interactive modes. Print and headless RPC omit this optional API. See [Host-native input form](/tui/reference#host-native-input-form).

## Quick Start

Create `~/.atomic/agent/extensions/my-extension.ts`:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // React to events
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Register a custom tool
  pi.registerTool({
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
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

Test with `--extension` (or `-e`) flag:

```bash
atomic -e ./my-extension.ts
```

## Extension Locations

> **Security:** Extensions run with your full system permissions and can execute arbitrary code. Only install from sources you trust.

Extensions are auto-discovered from:

| Location | Scope |
|----------|-------|
| `~/.atomic/agent/extensions/*.ts` | Global (all projects) |
| `~/.atomic/agent/extensions/*/index.ts` | Global (subdirectory) |
| `.atomic/extensions/*.ts` | Project-local |
| `.atomic/extensions/*/index.ts` | Project-local (subdirectory) |

Atomic also discovers extensions and package resources inherited from legacy `~/.pi/agent` and `.pi` configuration. When an inherited Pi extension uses the exact same tool, command, prompt, flag, or shortcut name as an extension bundled with Atomic, Atomic keeps the bundled registration and ignores only that conflicting inherited registration. Other resources from the inherited extension remain available. Interactive startup reports all such overlaps in one yellow summary; print and RPC modes apply the same winners without changing the Pi settings or package files.

This compatibility rule applies only to inherited Pi resources. Extensions configured through `.atomic` or passed explicitly with `--extension` retain the normal intentional override and load-order behavior described below.

Additional paths via `settings.json`:

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

Atomic exposes `builtin:llama.cpp`, `builtin:codemode`, and `builtin:tool-search` as extension resources, not filesystem paths. Disable one in the `extensions` setting, for example:

```json
{ "extensions": ["-builtin:codemode"] }
```

A trusted project `"+builtin:codemode"` entry can override a global exclusion. Explicit loading also works with `--no-extensions`: `atomic --no-extensions -e builtin:codemode --tools read,codemode`. Loading the resource registers the tool; activating it still requires `defaultTools` or `--tools` because codemode and tool search are inactive by default.

Codemode and tool search are replaceable: an extension that registers the same tool, command, or flag can take over. Atomic reports the replacement and names its owner. Disable that extension through `atomic config` when you want the built-in implementation instead.

These symbolic names do not replace Atomic's bundled MCP, workflow, subagent, web-access, or Intercom resources. There are no corresponding `builtin:mcp`, `builtin:workflows`, or `builtin:subagents` aliases. Keep using the existing package controls and MCP configuration.

To share extensions via npm or git as Atomic packages, see [Atomic packages](/packages).

## Available Imports

| Package | Purpose |
|---------|---------|
| `@bastani/atomic` | Extension types (`ExtensionAPI`, `ExtensionContext`, events) |
| `typebox` | Schema definitions for tool parameters |
| `@bastani/pi-ai` | AI utilities (`StringEnum` for Google-compatible enums) |
| `@earendil-works/pi-tui` | TUI components for custom rendering |

Registry dependencies work too. Add a `package.json` next to your extension (or in a parent directory), then install dependencies with Bun:

```bash
bun install
```

Imports from `node_modules/` are resolved automatically.

For distributed Atomic packages installed with `atomic install` (npm or git), runtime deps must be in `dependencies`. Package installation uses production dependency installs by default, so `devDependencies` are not available at runtime; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers.

Node.js built-ins (`node:fs`, `node:path`, etc.) are also available.

## Writing an Extension

Moved to [Writing extensions](/extensions/authoring#writing-an-extension).

### Async factory functions

Moved to [Writing extensions](/extensions/authoring#async-factory-functions).

### Long-lived resources and shutdown

Moved to [Writing extensions](/extensions/authoring#long-lived-resources-and-shutdown).

### Extension Styles

Moved to [Writing extensions](/extensions/authoring#extension-styles).

## Events

Moved to [Extension events](/extensions/events#events).

### Lifecycle Overview

Moved to [Extension events](/extensions/events#lifecycle-overview).

### Startup Events

Moved to [Extension events](/extensions/events#startup-events).

#### project_trust

Moved to [Extension events](/extensions/events#project_trust).

### Resource Events

Moved to [Extension events](/extensions/events#resource-events).

#### resources_discover

Moved to [Extension events](/extensions/events#resources_discover).

### Session Events

Moved to [Extension events](/extensions/events#session-events).

#### session_start

Moved to [Extension events](/extensions/events#session_start).

#### session_info_changed

Moved to [Extension events](/extensions/events#session_info_changed).

#### session_before_switch

Moved to [Extension events](/extensions/events#session_before_switch).

#### session_before_fork

Moved to [Extension events](/extensions/events#session_before_fork).

#### session_before_compact / session_compact / session_compact_failed

Moved to [Extension events](/extensions/events#session_before_compact-/-session_compact-/-session_compact_failed).

#### session_before_tree / session_tree

Moved to [Extension events](/extensions/events#session_before_tree-/-session_tree).

#### session_shutdown

Moved to [Extension events](/extensions/events#session_shutdown).

### Agent Events

Moved to [Extension events](/extensions/events#agent-events).

#### before_agent_start

Moved to [Extension events](/extensions/events#before_agent_start).

#### agent_start / agent_end / agent_before_settle / agent_settled

Moved to [Extension events](/extensions/events#agent_start-/-agent_end-/-agent_before_settle-/-agent_settled).

#### ui_prompt_start / ui_prompt_end

Moved to [Extension events](/extensions/events#ui_prompt_start-/-ui_prompt_end).

#### turn_start / turn_end

Moved to [Extension events](/extensions/events#turn_start-/-turn_end).

#### message_start / message_update / message_end

Moved to [Extension events](/extensions/events#message_start-/-message_update-/-message_end).

#### tool_execution_start / tool_execution_update / tool_execution_end

Moved to [Extension events](/extensions/events#tool_execution_start-/-tool_execution_update-/-tool_execution_end).

#### context

Moved to [Extension events](/extensions/events#context).

#### context_with_system

Moved to [Extension events](/extensions/events#context_with_system).

#### before_provider_headers

Moved to [Extension events](/extensions/events#before_provider_headers).

#### before_provider_request

Moved to [Extension events](/extensions/events#before_provider_request).

#### after_provider_response

Moved to [Extension events](/extensions/events#after_provider_response).

### Model Events

Moved to [Extension events](/extensions/events#model-events).

#### model_select

Moved to [Extension events](/extensions/events#model_select).

#### thinking_level_select

Moved to [Extension events](/extensions/events#thinking_level_select).

### Tool Events

Moved to [Extension events](/extensions/events#tool-events).

#### tool_call

Moved to [Extension events](/extensions/events#tool_call).

#### Typing custom tool input

Moved to [Extension events](/extensions/events#typing-custom-tool-input).

#### tool_result

Moved to [Extension events](/extensions/events#tool_result).

### User Bash Events

Moved to [Extension events](/extensions/events#user-bash-events).

#### user_bash

Moved to [Extension events](/extensions/events#user_bash).

### Input Events

Moved to [Extension events](/extensions/events#input-events).

#### input

Moved to [Extension events](/extensions/events#input).

## ExtensionContext

Moved to [Extension API reference](/extensions/api-reference#extensioncontext).

### ctx.ui

Moved to [Extension API reference](/extensions/api-reference#ctx-ui).

### ctx.hasUI

Moved to [Extension API reference](/extensions/api-reference#ctx-hasui).

### ctx.cwd

Moved to [Extension API reference](/extensions/api-reference#ctx-cwd).

### ctx.isProjectTrusted()

Moved to [Extension API reference](/extensions/api-reference#ctx-isprojecttrusted).

### ctx.sessionManager

Moved to [Extension API reference](/extensions/api-reference#ctx-sessionmanager).

### ctx.modelRegistry / ctx.model / ctx.scopedModels

Moved to [Extension API reference](/extensions/api-reference#ctx-modelregistry-/-ctx-model-/-ctx-scopedmodels).

### ctx.signal

Moved to [Extension API reference](/extensions/api-reference#ctx-signal).

### ctx.isIdle() / ctx.abort() / ctx.hasPendingMessages()

Moved to [Extension API reference](/extensions/api-reference#ctx-isidle-/-ctx-abort-/-ctx-haspendingmessages).

### ctx.isProjectTrusted()

Moved to [Extension API reference](/extensions/api-reference#ctx-isprojecttrusted-2).

### ctx.shutdown()

Moved to [Extension API reference](/extensions/api-reference#ctx-shutdown).

### ctx.getContextUsage()

Moved to [Extension API reference](/extensions/api-reference#ctx-getcontextusage).

### ctx.compact()

Moved to [Extension API reference](/extensions/api-reference#ctx-compact).

### ctx.getSystemPrompt()

Moved to [Extension API reference](/extensions/api-reference#ctx-getsystemprompt).

### ctx.getSkillCatalog()

Moved to [Extension API reference](/extensions/api-reference#ctx-getskillcatalog).

## ExtensionCommandContext

Moved to [Extension API reference](/extensions/api-reference#extensioncommandcontext).

### ctx.waitForIdle()

Moved to [Extension API reference](/extensions/api-reference#ctx-waitforidle).

### ctx.newSession(options?)

Moved to [Extension API reference](/extensions/api-reference#ctx-newsession-options).

### ctx.fork(entryId, options?)

Moved to [Extension API reference](/extensions/api-reference#ctx-fork-entryid-options).

### ctx.navigateTree(targetId, options?)

Moved to [Extension API reference](/extensions/api-reference#ctx-navigatetree-targetid-options).

### ctx.switchSession(sessionPath, options?)

Moved to [Extension API reference](/extensions/api-reference#ctx-switchsession-sessionpath-options).

### Session replacement lifecycle and footguns

Moved to [Extension API reference](/extensions/api-reference#session-replacement-lifecycle-and-footguns).

### ctx.reload()

Moved to [Extension API reference](/extensions/api-reference#ctx-reload).

## ExtensionAPI Methods

Moved to [Extension API reference](/extensions/api-reference#extensionapi-methods).

### pi.on(event, handler)

Moved to [Extension API reference](/extensions/api-reference#pi-on-event-handler).

### pi.registerTool(definition)

Moved to [Extension API reference](/extensions/api-reference#pi-registertool-definition).

#### Built-in tool prompt contributions

Moved to [Extension API reference](/extensions/api-reference#built-in-tool-prompt-contributions).

### pi.sendMessage(message, options?)

Moved to [Extension API reference](/extensions/api-reference#pi-sendmessage-message-options).

### pi.sendMessages(messages, options?)

Moved to [Extension API reference](/extensions/api-reference#pi-sendmessages-messages-options).

### pi.sendUserMessage(content, options?)

Moved to [Extension API reference](/extensions/api-reference#pi-sendusermessage-content-options).

### pi.appendEntry(customType, data?)

Moved to [Extension API reference](/extensions/api-reference#pi-appendentry-customtype-data).

### pi.registerEntryRenderer(customType, renderer)

Moved to [Extension API reference](/extensions/api-reference#pi-registerentryrenderer-customtype-renderer).

### pi.setSessionName(name)

Moved to [Extension API reference](/extensions/api-reference#pi-setsessionname-name).

### pi.getSessionName()

Moved to [Extension API reference](/extensions/api-reference#pi-getsessionname).

### pi.setLabel(entryId, label)

Moved to [Extension API reference](/extensions/api-reference#pi-setlabel-entryid-label).

### pi.registerCommand(name, options)

Moved to [Extension API reference](/extensions/api-reference#pi-registercommand-name-options).

### pi.getCommands()

Moved to [Extension API reference](/extensions/api-reference#pi-getcommands).

### pi.registerMessageRenderer(customType, renderer)

Moved to [Extension API reference](/extensions/api-reference#pi-registermessagerenderer-customtype-renderer).

### pi.registerMarkdownTransformer(transformer)

Moved to [Extension API reference](/extensions/api-reference#pi-registermarkdowntransformer-transformer).

### pi.registerShortcut(shortcut, options)

Moved to [Extension API reference](/extensions/api-reference#pi-registershortcut-shortcut-options).

### pi.registerFlag(name, options)

Moved to [Extension API reference](/extensions/api-reference#pi-registerflag-name-options).

### pi.exec(command, args, options?)

Moved to [Extension API reference](/extensions/api-reference#pi-exec-command-args-options).

### pi.getActiveTools() / pi.getAllTools() / pi.setActiveTools(names)

Moved to [Extension API reference](/extensions/api-reference#pi-getactivetools-/-pi-getalltools-/-pi-setactivetools-names).

### pi.setModel(model)

Moved to [Extension API reference](/extensions/api-reference#pi-setmodel-model).

### pi.getThinkingLevel() / pi.setThinkingLevel(level)

Moved to [Extension API reference](/extensions/api-reference#pi-getthinkinglevel-/-pi-setthinkinglevel-level).

### pi.events

Moved to [Extension API reference](/extensions/api-reference#pi-events).

### Native providers

Moved to [Extension API reference](/extensions/api-reference#native-providers).

### pi.registerProvider(name, config)

Moved to [Extension API reference](/extensions/api-reference#pi-registerprovider-name-config).

### pi.unregisterProvider(name)

Moved to [Extension API reference](/extensions/api-reference#pi-unregisterprovider-name).

### pi.registerMcpServer(name, config)

Contribute an MCP server computed at runtime from the factory or `session_start`. See [Extension API reference](/extensions/api-reference#pi-registermcpserver-name-config).

## State Management

Moved to [Writing extensions](/extensions/authoring#state-management).

### Session-scoped in-memory state

Moved to [Writing extensions](/extensions/authoring#session-scoped-in-memory-state).

## Custom Tools

Moved to [Writing extensions](/extensions/authoring#custom-tools).

### Tool Definition

Moved to [Writing extensions](/extensions/authoring#tool-definition).

#### Constrained sampling

Moved to [Writing extensions](/extensions/authoring#constrained-sampling).

### Fireworks deferred tool loading

Moved to [Writing extensions](/extensions/authoring#fireworks-deferred-tool-loading).

### Overriding Built-in Tools

Moved to [Writing extensions](/extensions/authoring#overriding-built-in-tools).

### Remote Execution

Moved to [Writing extensions](/extensions/authoring#remote-execution).

### Output Truncation

Moved to [Writing extensions](/extensions/authoring#output-truncation).

### Multiple Tools

Moved to [Writing extensions](/extensions/authoring#multiple-tools).

### Custom Rendering

Moved to [Writing extensions](/extensions/authoring#custom-rendering).

#### renderCall

Moved to [Writing extensions](/extensions/authoring#rendercall).

#### renderResult

Moved to [Writing extensions](/extensions/authoring#renderresult).

#### Keybinding Hints

Moved to [Writing extensions](/extensions/authoring#keybinding-hints).

#### Best Practices

Moved to [Writing extensions](/extensions/authoring#best-practices).

#### Fallback

Moved to [Writing extensions](/extensions/authoring#fallback).

## Custom UI

Moved to [Extension UI](/extensions/ui#custom-ui).

### Dialogs

Moved to [Extension UI](/extensions/ui#dialogs).

#### Timed Dialogs with Countdown

Moved to [Extension UI](/extensions/ui#timed-dialogs-with-countdown).

#### Manual Dismissal with AbortSignal

Moved to [Extension UI](/extensions/ui#manual-dismissal-with-abortsignal).

### Widgets, Status, and Footer

Moved to [Extension UI](/extensions/ui#widgets-status-and-footer).

### Autocomplete Providers

Moved to [Extension UI](/extensions/ui#autocomplete-providers).

### Custom Components

Moved to [Extension UI](/extensions/ui#custom-components).

#### Overlay Mode (Experimental)

Moved to [Extension UI](/extensions/ui#overlay-mode-experimental).

### Custom Editor

Moved to [Extension UI](/extensions/ui#custom-editor).

### Message Rendering

Moved to [Extension UI](/extensions/ui#message-rendering).

### Theme Colors

Moved to [Extension UI](/extensions/ui#theme-colors).

## Error Handling

Moved to [Extension API reference](/extensions/api-reference#error-handling).

## Mode Behavior

| Mode | UI Methods | Notes |
|------|-----------|-------|
| Interactive | Full TUI | Normal operation |
| RPC (`--mode rpc`) | JSON protocol | Host handles UI, see [RPC mode](/rpc) |
| JSON (`--mode json`) | No-op | Event stream to stdout, see [JSON mode](/json) |
| Print (`-p`) | No-op | Extensions run but can't prompt |

In non-interactive modes, check `ctx.hasUI` before using UI methods.

## Examples Reference

Moved to [Extension examples](/extensions/examples#examples-reference).

## Workflow activity and lifecycle hooks

Moved to [Extension events](/extensions/events#workflow-activity-and-lifecycle-hooks).
