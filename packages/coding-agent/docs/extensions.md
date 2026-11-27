---
title: "Build extensions"
sidebarTitle: "Overview"
description: "Build TypeScript extensions that add custom tools, slash commands, lifecycle hooks, and terminal UI to Atomic."
---

Extensions are TypeScript or JavaScript modules that customize how Atomic works. Use them to add custom tools, intercept lifecycle events, register slash commands, persist session state, or render custom terminal UI.

<Columns cols={2}>
  <Card title="Write an extension" href="/extensions/authoring">
    Structure an extension, manage state across reloads, register custom tools, and customize terminal rendering.
  </Card>
  <Card title="Extension events" href="/extensions/events">
    Look up every lifecycle event, payload shape, handler chaining rule, and return contract.
  </Card>
  <Card title="Build custom UI" href="/extensions/ui">
    Build dialogs, widgets, host-native pickers and forms, custom components, overlays, and message renderers.
  </Card>
  <Card title="Extension API reference" href="/extensions/api-reference">
    Reference `ExtensionContext`, `ExtensionToolContext`, `ExtensionCommandContext`, `ExtensionAPI` methods, and typed errors.
  </Card>
  <Card title="Extension examples" href="/extensions/examples">
    Browse runnable extensions shipped with Atomic for tools, gates, UI, sandboxes, and providers.
  </Card>
  <Card title="SDK extensions" href="/sdk/reference#extensions">
    Load extensions programmatically with `DefaultResourceLoader`, pass inline factories, or register standalone `customTools`.
  </Card>
</Columns>

If an extension is heavier than you need, compare skills, prompt templates, and themes on [Build with Atomic](/build). Before enabling project-local extensions in an unfamiliar repo, review Atomic's project-trust boundary in [Security](/security).

## What extensions can do

| Goal | Primary API |
| --- | --- |
| Add or override model-callable tools | `atomic.registerTool()` |
| Gate tool calls, edit context, or customize compaction | `atomic.on("tool_call" \| "context" \| "session_before_compact", ...)` |
| Prompt the user or show status and widgets | `ctx.ui.select()`, `confirm()`, `input()`, `custom()`, `setStatus()`, `setWidget()` |
| Add interactive slash commands and keyboard shortcuts | `atomic.registerCommand()`, `atomic.registerShortcut()` |
| Persist durable data or keep objects alive across `/reload` | `atomic.appendEntry()`, `sessionScopedExtensionState()` |
| Register custom model providers or runtime MCP servers | `atomic.registerProvider()`, `atomic.registerMcpServer()` |

## Quick start

Create `~/.atomic/agent/extensions/my-extension.ts` (the factory parameter can have any name; older extensions and examples call it `pi`):

```typescript
import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";

export default function (atomic: ExtensionAPI) {
  // React to lifecycle events
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

  // Register a slash command
  atomic.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

Test an extension for one session without installing it globally using `-e` (or `--extension`):

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

See [SDK extensions](/sdk/reference#extensions), [SDK custom tools](/sdk/reference#custom-tools), and [Structured decisions](/sdk/structured-decisions).

## Extension locations

<Warning>
Extensions run with your full system permissions and can execute arbitrary code. Install and trust extensions only from sources you control or verify.
</Warning>

Atomic auto-discovers extensions from these locations:

| Location | Scope |
| --- | --- |
| `~/.atomic/agent/extensions/*.{ts,js}` | Global single-file extensions (all projects) |
| `~/.atomic/agent/extensions/*/index.{ts,js}` | Global subdirectory extensions |
| `~/.atomic/agent/extensions/*/package.json` | Global subdirectories declaring `atomic.extensions` (or legacy `pi.extensions`) |
| `.atomic/extensions/*.{ts,js}` | Project single-file extensions (trusted projects only) |
| `.atomic/extensions/*/index.{ts,js}` | Project subdirectory extensions (trusted projects only) |
| `.atomic/extensions/*/package.json` | Project subdirectories declaring `atomic.extensions` (or legacy `pi.extensions`; trusted projects only) |

Discovery rules:

- Scanning respects `.gitignore`, `.ignore`, and `.fdignore` inside extension directories, and skips dotfiles, dot-directories, and `node_modules`.
- Disable auto-discovery with `--no-extensions` (`-ne`). Explicit `-e` paths and the mandatory bundled Intercom extension still load.
- Atomic also discovers extensions and packages inherited from legacy `~/.pi/agent` and `.pi` directories. If an inherited legacy extension registers the same tool, command, prompt, flag, or shortcut name as a bundled Atomic extension, Atomic keeps the bundled registration and skips only the conflicting registration (summarized in yellow on interactive startup). Extensions configured under `.atomic` or passed with `-e` follow normal override rules.

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

To share extensions over npm or git, see [Install and manage packages](/packages).

### Built-in extension resources

Atomic exposes `builtin:llama.cpp` ([llama.cpp](/llama-cpp)), `builtin:codemode` ([Codemode](/codemode)), and `builtin:tool-search` (which registers the [`tool_search`](/tools#tool_search) tool) as built-in extension resources rather than filesystem paths. Toggle them interactively in `atomic config`, or disable one in `settings.json`:

```json
{ "extensions": ["-builtin:codemode"] }
```

In global `settings.json`, `extensions` entries follow operator precedence (`!` < `+` < `-`); in a trusted project's `settings.json`, override entries are evaluated in array order (last match wins), so `"+builtin:codemode"` re-enables a globally excluded built-in. You can also load a built-in explicitly alongside `--no-extensions` (`-ne`):

```bash
atomic --no-extensions -e builtin:codemode --tools read,codemode
```

Passing an unrecognized `builtin:<name>` with `-e` stops with `Unknown built-in extension: builtin:<name>`.

Loading a built-in resource registers its tool. `codemode` is enabled in the default tool list (so a custom `--tools` list must name it), while `tool_search` is opt-in. Both `codemode` and `tool-search` are replaceable: a custom extension that registers the same tool, command, or flag takes over, and Atomic reports the replacement. Disable that extension in `atomic config` to restore the built-in version.

These built-in names do not replace Atomic's bundled MCP, subagent, web-access, or Intercom packages. There are no `builtin:mcp` or `builtin:subagents` aliases; configure those through package settings and [MCP servers](/mcp-servers).

## Available imports

Extensions can import Atomic's bundled packages without installing them in `node_modules`:

| Package | Purpose |
| --- | --- |
| [`@bastani/atomic`](/sdk) | Extension types (`ExtensionAPI`, `ExtensionContext`, events), helpers (`StringEnum`, `defineTool`, `boundOversizedText`, `installReactiveWidget`), and built-in tool factories |
| [`@bastani/atomic/storage`](/sdk/storage) | Storage adapter interfaces, `createSqliteDatabase()`, and storage errors |
| `@bastani/atomic/typebox` | Atomic's copy of TypeBox plus subpaths (`/compile`, `/error`, `/format`, `/guard`, `/schema`, `/system`, `/type`, `/value`) |
| `typebox` and `@sinclair/typebox` | Direct schema imports (including `typebox/*`, `@sinclair/typebox/compile`, and `@sinclair/typebox/value`) resolve to Atomic's copy so formats registered with `Format.Set()` apply to tool validation |
| [`@bastani/atomic-ai`](/libraries/ai) | AI utilities, provider APIs, image generation, and subpaths (`/compat`, `/oauth`, `/models`, `/providers/all`) |
| [`@bastani/atomic-tui`](/libraries/tui) | Terminal UI components and layout helpers for custom rendering |
| [`@bastani/atomic-agent-core`](/libraries/agent-core) | Agent loop types and helpers |
| [`@bastani/atomic-codemode`](/libraries/codemode) | Codemode sandbox and declaration helpers (`@bastani/atomic-codemode/*`) |
| [`@bastani/atomic-schema`](/libraries/schema) | JSON Schema builders, validation, and `/formats` |
| [`@bastani/atomic-telemetry`](/libraries/telemetry) | Telemetry contracts and `/render` |

Atomic maintains these packages directly; [Libraries](/libraries) documents each one. Legacy import names (`@earendil-works/pi-*`, `@mariozechner/pi-*`, and `@bastani/pi-ai`) resolve to the same modules, including in release-archive installs. New extensions should import the `@bastani/atomic-*` names.

Node.js built-ins (`node:fs`, `node:path`, and the rest of `node:*`) are always available.

<Tip>
**Sharing TypeBox from separate dependencies or SDK apps:** Direct `typebox` imports inside an extension file map to Atomic's copy automatically. If a separate dependency or SDK app registers custom TypeBox formats, settings, or locales that must reach Atomic's tool validation, import from `@bastani/atomic/typebox` rather than from an independent `typebox` dependency. See [Sharing Atomic's TypeBox registry](/sdk#sharing-atomics-typebox-registry).
</Tip>

**Third-party npm dependencies:** Add a `package.json` next to your extension (or in a parent directory) and install dependencies with `npm install` (or your package manager). Imports from `node_modules/` resolve automatically. For distributed packages installed with `atomic install`, declare runtime dependencies in `dependencies` (`devDependencies` are omitted by default; see [Install and manage packages](/packages) for `npmCommand` details).

### Tool parameter schemas

A tool's `parameters` can be a TypeBox schema or any plain JSON Schema object. Atomic validates arguments from the model after coercing loosely typed values (such as a numeric string to a number, `"true"` to `true`, or dropping `null` on an optional property):

- **TypeBox schemas** are validated by TypeBox, so TypeBox features outside JSON Schema (such as `Type.Refine()` and formats registered with `Format.Set()`) apply and errors use TypeBox's format.
- **Plain JSON Schema** (such as an MCP server's schema or one built with `@bastani/atomic-schema`) is coerced and checked by `@bastani/atomic-schema`. Single values wrap into one-item arrays when an array is expected, `url` and `json-pointer-uri-fragment` formats are checked, and an unresolved `$ref` rejects only that field instead of every call. Errors use `@bastani/atomic-schema`'s format, such as `- path: missing` or `- limit: expected number, got string`.

## Mode behavior

Extensions run in every Atomic mode, but UI availability differs:

| Mode | Display UI (`notify`, `setStatus`, `setWidget`, `setTitle`) | Prompts (`select`, `confirm`, `input`, `editor`) and `custom()` | Notes |
| --- | --- | --- | --- |
| Interactive CLI (default) | Supported (worker-isolated) | Supported (worker-isolated) | Extensions run in a background worker; some synchronous TUI APIs are unavailable. See [UI API compatibility matrix](/extensions/ui#ui-api-compatibility-matrix). |
| Embedded in-process TUI (SDK) | Full TUI | Full TUI | Extensions share the terminal UI process, enabling every `ctx.ui` API. |
| RPC (`--mode rpc`) | JSON protocol requests | Dialogs via JSON protocol; `custom()` resolves `undefined` | Host handles UI; component-factory `setWidget()` throws. See [RPC mode](/rpc). |
| JSON (`--mode json`) | No-op | Rejects with `HumanInputUnavailable` (unless a `humanInput` adapter is attached) | Event stream to stdout; `setTheme()` returns `{ success: false, error: "UI not available" }`. See [JSON mode](/json). |
| Print (`-p`) | No-op | Rejects with `HumanInputUnavailable` (unless a `humanInput` adapter is attached) | Single-run non-interactive execution; `setTheme()` returns `{ success: false, error: "UI not available" }`. |

Check `ctx.hasUI` (or `ctx.mode === "tui"`) before showing terminal UI, and check `ctx.hasHumanInput` before calling dialog methods in extensions that may run in print or JSON modes.

## Reloading and startup behavior

Auto-discovered extensions hot-reload when you run `/reload`. Atomic transpiles each extension file along with local TypeScript, JavaScript (`.mjs`, `.cjs`, `.js`), and JSON files it imports by relative path, so edits to those local files take effect on `/reload`.

- **Module format.** ESM files keep `import.meta.url`, strict mode, top-level `await`, and package or Node built-in imports. CommonJS files keep `require`, `module.exports`, `__filename`, and `__dirname`.
- **Caching on `/reload`.** Named npm packages, files under `node_modules` outside the extension's own package, and modules loaded via `createRequire()` are loaded once per process. Restart Atomic after editing those files.
- **Load failures.** If an optional extension fails to import or initialize during interactive startup or `/reload`, Atomic skips it, lists its path and error under `[Extension issues]`, and keeps the session open. Fix the issue and run `/reload`. In print (`-p`) and standalone RPC (`--mode rpc`) modes, any extension load failure prints the error and exits with code 1. Required built-in failures and cleanup failures stop startup in every mode.
- **Cleanup failures on `/reload`.** If a retiring extension's `session_shutdown` handler fails during `/reload`, Atomic reports the failing handler while keeping the replacement extensions and updated settings active. Fix the cleanup error before reloading again.

<Note>
Inside a [Herdr](/herdr) pane, Atomic reports parent session status automatically with its built-in integration. See [Herdr setup](/herdr#setup) if you previously installed a separate Herdr status extension.
</Note>

<div id="interactive-callback-isolation" />

## Responsive UI and crash recovery

In default interactive CLI mode, Atomic runs extensions in a separate background worker process so slow or stuck extension code does not freeze keyboard input or terminal spinners.

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

Dialogs, `ctx.ui.custom()` components, widget factories, status text, notifications, `setTitle()`, `setEditorText()`, and host-native pickers and forms (`hostSessionPicker()`, `hostInputForm()`) all work in default interactive CLI mode. Values returned from `ctx.ui.custom()` must be JSON-serializable because they cross the worker boundary.

Because extensions run outside the terminal UI process in default interactive mode, several `ctx.ui` APIs are unavailable or behave differently:

- **Warn and skip:** `onTerminalInput()`, `getEditorText()`, `setEditorComponent()`, `addAutocompleteProvider()`, `setHeader()`, and `setFooter()`.
- **Silent no-ops or stubs:** `setWorkingMessage()`, `setWorkingVisible()`, `setWorkingIndicator()`, `setHiddenThinkingLabel()`, `getAllThemes()`, `getTheme()`, `setTheme()` (returns `{ success: false, error: "Theme switching not supported in RPC mode" }`), and `atomic.registerMarkdownTransformer()`.
- **Degraded behavior:** `pasteToEditor()` falls back to `setEditorText()` (replacing text without paste collapse), `getToolsExpanded()`/`setToolsExpanded()` track only a worker-local boolean, `editor()` omits `timeout` countdowns, and `getChatRenderSettings()` returns static defaults for some display fields.

See the complete [UI API compatibility matrix](/extensions/ui#ui-api-compatibility-matrix) before designing interactive UI, and prefer [Host-native pickers and forms](/extensions/ui#host-native-pickers-and-forms) for fast lists and structured input.
