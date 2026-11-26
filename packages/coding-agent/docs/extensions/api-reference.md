---
title: "Extension API reference"
sidebarTitle: "Extension API"
description: "Reference for ExtensionContext, ExtensionToolContext, ExtensionCommandContext, ExtensionAPI methods, and typed errors."
---

This page documents `ExtensionContext`, `ExtensionToolContext`, `ExtensionCommandContext`, `ExtensionAPI` methods, and typed errors. For setup and discovery, see [Extensions overview](/extensions). For patterns and custom tools, see [Write an extension](/extensions/authoring). For embedding Atomic and loading inline extension factories, see [SDK overview](/sdk), [SDK extensions](/sdk/reference#extensions), and [Structured decisions](/sdk/structured-decisions).

## ExtensionContext

All event handlers, tool callbacks, and command handlers receive `ctx: ExtensionContext`.

### ctx.ui

UI methods for user interaction. See [Extension UI](/extensions/ui#custom-ui) for full details.

### ctx.mode

Current run mode: `"tui" | "rpc" | "json" | "print"`. Use `ctx.mode === "tui"` to guard terminal-only UI such as custom components or host-native pickers.

### ctx.hasUI

`false` in print mode (`-p`) and JSON mode; `true` in interactive and RPC modes. In RPC mode, dialog methods (`select`, `confirm`, `input`, `editor`) run through the extension UI sub-protocol and fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`) send requests to the client. Some TUI-specific methods are no-ops or return defaults (see [RPC extension UI](/rpc/extension-ui#extension-ui-protocol)).

### ctx.hasHumanInput

`boolean` indicating whether a human-input adapter is available independently of terminal rendering.

### ctx.isPresentationOnly

`true` when Atomic loads an extension in the terminal UI process while running session execution in a separate worker process. Keep UI registration active, but skip background work and recovery hooks so both processes do not start the same work. Normal SDK, print, RPC, and worker contexts leave this flag `false` or `undefined`.

### ctx.cwd

Current working directory.

Built-in cwd-sensitive tools (`read`, `write`, `edit`, `search`, `find`, `ls`, `bash`, `powershell`) resolve relative paths against `ctx.cwd` when an extension invokes them, falling back to the directory captured when the tool was created.

Use `CONFIG_DIR_NAME` instead of hardcoding `.atomic` (or legacy `.pi`) when building project config paths:

```typescript
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@bastani/atomic";
import { join } from "node:path";

export default function (atomic: ExtensionAPI) {
  atomic.on("session_start", (_event, ctx) => {
    const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "my-extension.json");
    // ...
  });
}
```

### ctx.isProjectTrusted()

Returns whether project-local trust is active for the current session, including temporary trust decisions and CLI overrides as well as saved decisions in `trust.json`. Check this before reading project-local config files or running project-scoped automation.

```typescript
atomic.registerCommand("project-status", {
  description: "Show trust state",
  handler: async (_args, ctx) => {
    ctx.ui.notify(ctx.isProjectTrusted() ? "Project is trusted" : "Project is not trusted", "info");
  },
});
```

### ctx.sessionManager

Read-only access to session state. See [Session format](/session-format) for the full `SessionManager` API and entry types.

For `tool_call`, `ctx.sessionManager` is synchronized through the current assistant tool-calling message; in parallel tool mode it may not include sibling tool results from the same assistant message.

```typescript
ctx.sessionManager.getEntries() // Entries held in the active window
ctx.sessionManager.getBranch()  // Current branch
ctx.sessionManager.getLeafId()  // Current leaf entry ID
```

Custom entries saved with `atomic.appendEntry()` on the current branch remain in `getBranch()` and `getEntries()`, so restoring state in `session_start` does not require extra loads.

To inspect older history without loading the entire session into memory:

- `await ctx.sessionManager.readEntry(id)` fetches a single entry.
- `for await (const page of ctx.sessionManager.readHistory({ fromSeq, toSeq }))` iterates entries in append order. Oversized items (`kind: "oversized"`) stream via `ctx.sessionManager.readHistoryChunks(item)`.
- `await ctx.sessionManager.loadFullHistory()` loads every stored entry into memory; prefer paged reads for large sessions.

### ctx.modelRegistry / ctx.model / ctx.scopedModels {#ctx-modelregistry-ctx-model-ctx-scopedmodels}

Access models, authentication state, and provider-aware requests.

Use `ctx.modelRegistry.complete()` for non-streaming model calls and `ctx.modelRegistry.streamSimple()` or `ctx.modelRegistry.stream()` for streaming calls. All three run through Atomic's active provider configuration and request-time authentication, including extension-registered providers (global standalone helpers do not see extension providers):

```typescript
const model = ctx.modelRegistry.find("github-copilot", "gpt-5.5");
if (!model) throw new Error("Model not found");

const response = await ctx.modelRegistry.complete(model, { messages }, { signal: ctx.signal });
```

Use `ctx.modelRegistry.generateImages(model, context, options)` to call an image model with request-time authentication. It returns generated blocks and usage and reports provider failures via `stopReason`, `errorMessage`, and `error` instead of rejecting.

For `openai-images` models, `options` accepts `size`, `quality`, `n`, `background`, `outputFormat` (`png`, `jpeg`, `webp`, `gif`, `svg`), `outputCompression`, `frameCount`, `frameDurationMs`, `complexity`, `svg`, `moderation`, and `safetyIdentifier`. Image inputs with `role: "markup"` or `role: "mask"` map to those edit roles, and the first remaining image is the base image. GIF, SVG, `complexity`, and frame options require a GPT Image 2.6 model declaring those capabilities.

`outputFormat: "svg"` works without passing `svg`: when an account requires `svg.model`, Atomic retries once with `gpt-6.1-sol` (`DEFAULT_SVG_AUTHOR_MODEL` from `@bastani/atomic-ai`) and reports it in `result.svgModel`, retrying once more without `svg` if rejected as unsupported. An explicit `svg: { model, reasoning }` object is sent verbatim. Leave `timeoutMs` unset (10-minute default) or set at least `180000` for SVG requests.

```typescript
const flare = ctx.modelRegistry.getModelOfType("image", "openai-images", "gpt-image-2.6-flare");
if (!flare) throw new Error("gpt-image-2.6-flare is unavailable");

const logo = await ctx.modelRegistry.generateImages(
  flare,
  { input: [{ type: "text", text: "A flat red paper lantern icon" }] },
  { outputFormat: "svg", signal: ctx.signal },
);
if (logo.stopReason !== "stop") throw new Error(logo.errorMessage);
```

When image generation fails, rebuild `result.error` (`ImageGenerationErrorData`) with `imageGenerationErrorFromData()` from `@bastani/atomic-ai` and branch on its class, type guards (`isImageGenerationError`, `isImageGenerationConfigError`, `findImageGenerationError`, `isRetryableImageGenerationError`), or `code`. Cancelled requests resolve with `stopReason: "aborted"` and no `error`. See [Image generation](/libraries/ai#image-generation).

Use `getApiKeyAndHeaders()` only when inspecting credentials before dispatch. `await ctx.modelRegistry.refresh(options)` returns `{ aborted, errors }` with per-provider errors. Calling `ModelRuntime.setRuntimeApiKey(providerId, apiKey, options)` stores a runtime credential without refreshing the catalog; call `refresh({ providers: [providerId], signal })` explicitly if needed (see [API keys and OAuth in the SDK](/sdk/reference#api-keys-and-oauth)).

OpenRouter Chat Completions and Anthropic Messages requests send `x-session-id` by default when `sessionId` is supplied and prompt caching is active; set `compat.sendSessionAffinityHeaders: false` or `cacheRetention: "none"` to opt out.

`ctx.scopedModels` is the read-only list of models scoped to the current session (matching `/scoped-models`, resolved from `--models` and `enabledModels`; empty when unscoped). Each entry is `{ model, thinkingLevel? }`, resolved at access time so it stays current in default interactive mode as well as embedded sessions. Every read returns fresh frozen copies (`ScopedModel` and `ExtensionScopedModels` are exported from `@bastani/atomic`):

```typescript
import type { ExtensionScopedModels, ScopedModel } from "@bastani/atomic";

function formatScope(scope: ExtensionScopedModels): string[] {
  return scope.map(
    ({ model, thinkingLevel }: ScopedModel) =>
      `${model.provider}/${model.id}${thinkingLevel ? `:${thinkingLevel}` : ""}`,
  );
}
```

### ctx.thinkingLevel

Current `ThinkingLevel` (`"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`) or `undefined`, resolved from the active session at access time.

### ctx.getDecisionModel()

Returns the session's configured `decisionModel` (`"provider/model"`, `"auto"`, or `""`). Atomic uses this for `structured_output` calls that omit `model`, steer readiness checks, and `decide()`, without changing the chat model (see [Structured decisions](/sdk/structured-decisions)). Throws `DecisionModelUnavailableError` (`reason: "host-unsupported"`) if the host does not support decision models.

### ctx.signal

The active turn's `AbortSignal`, or `undefined` when idle. Forward it to `fetch()`, model calls, or process helpers inside turn hooks (`tool_call`, `tool_result`, `message_update`, `turn_end`) so Escape cancels your async work too:

```typescript
atomic.on("tool_result", async (event, ctx) => {
  const response = await fetch("https://example.com/api", {
    method: "POST",
    body: JSON.stringify(event),
    signal: ctx.signal,
  });
  return { details: await response.json() };
});
```

### ctx.sessionSignal

A read-only `AbortSignal` for the session's lifetime, available even while idle. It aborts when reload or shutdown starts, **before** Atomic finishes active commands and emits `session_shutdown`. After a reload or session switch, the new session receives a fresh signal.

Custom UI mounted with `ctx.ui.custom()` closes automatically when the session ends. Use `ctx.sessionSignal` to cancel long-lived command watchers instead of waiting for `session_shutdown`, while still awaiting any in-progress session write so teardown drains cleanly:

```typescript
import { Text } from "@bastani/atomic-tui";

atomic.registerCommand("monitor", {
  description: "Keep a monitor open until the session ends",
  handler: async (_args, ctx) => {
    await ctx.ui.custom(() => new Text("Monitoring; reload or quit to close."), {
      signal: ctx.sessionSignal,
    });
  },
});
```

### ctx.isIdle() / ctx.abort() / ctx.hasPendingMessages()

Control-flow helpers. `ctx.isIdle()` reports whether the agent is streaming a response (it remains `true` during compaction, when `sendUserMessage()` queues behind compaction instead of starting a turn).

### ctx.shutdown()

Request a graceful shutdown of Atomic (emits `session_shutdown` before exiting):

- **Interactive mode:** Deferred until the agent becomes idle after processing queued messages.
- **RPC mode:** Runs once idle and after pending command responses are written.
- **Print mode:** No-op (the process exits automatically after finishing prompts).

### ctx.getContextUsage()

Returns current context usage `{ tokens, contextWindow, percent }` for the active model, or `undefined` when no model is active. Both `tokens` and `percent` are `number | null` (`null` immediately after compaction before the next assistant response arrives), so check for `null` before comparing:

```typescript
const usage = ctx.getContextUsage();
if (usage && usage.tokens !== null && usage.tokens > 100_000) {
  ctx.ui.notify(`Context at ${usage.tokens} tokens`, "warning");
}
```

### ctx.compact()

Trigger compaction without awaiting completion. By default it clears the active context window so the agent recovers details from session history; when a compactor model is configured, the compactor's output replaces the context.

Options: `query` (passed to the boundary message and compactor), `compactionModel` (`"auto"` or an exact model ID for this run only), `onComplete`, and `onError`.

```typescript
ctx.compact({
  query: "keep active migration details",
  onComplete: (result) => {
    ctx.ui.notify(`Context ${result.form}: ${result.stats.tokensBefore} to ${result.stats.tokensAfter} tokens`, "info");
  },
  onError: (error) => {
    ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
  },
});
```

See [Compaction](/compaction).

### ctx.getSystemPrompt()

Returns Atomic's current system prompt string. Inside `before_agent_start`, it reflects changes made by earlier handlers; it does not include `context` or `before_provider_request` payload rewrites.

### ctx.getSkillCatalog()

Optional method returning the loader-owned `SkillCatalog`. Use `catalog.resolve(selector)` to look up exact skill selectors.

Note that source-qualified selectors such as `"tdd@builtin"` exist **only** when two or more distinct skill files collide on `"tdd"`. When only one file defines `"tdd"`, `catalog.resolve("tdd@builtin")` returns `{ ok: false, kind: "unknown" }` and you should resolve `"tdd"` instead:

```typescript
atomic.on("session_start", (_event, ctx) => {
  const catalog = ctx.getSkillCatalog?.();
  const resolved = catalog?.resolve("tdd");
  if (resolved?.ok) {
    ctx.ui.notify(`Using ${resolved.candidate.selector}`, "info");
  }
});
```

`atomic.getCommands()` returns the same advertised `/skill:name` and `/skill:name@source` names. See [Skill commands](/skills#skill-commands).

### Additional optional context getters

These optional methods are present when supported by the host:

- **`ctx.getHttpIdleTimeoutMs?(): number`:** Returns the session's `httpIdleTimeoutMs` setting in milliseconds (`0` means idle timeout is disabled).
- **`ctx.getPackageAgents?(): readonly PackageAgentFile[]`:** Returns enabled subagent definition files contributed by installed packages (only from project packages when the project is trusted).
- **`ctx.getExtensionPaths?(): string[]`:** Returns the file paths of loaded extensions.
- **`ctx.isSessionSummaryEnabled?(): boolean`:** Returns whether background session summaries are enabled.

## ExtensionToolContext

Tool `execute` callbacks receive `ExtensionToolContext`, extending `ExtensionContext` with `tools`, `executeTool(name, args, options?)`, and `parentToolCallId` for nested tool invocations. See [Structured results and nested tools](/extensions/authoring#structured-results-and-nested-tools).

## ExtensionCommandContext

Command handlers receive `ExtensionCommandContext`, extending `ExtensionContext` with session-control methods that would deadlock if called from event handlers.

### ctx.getSystemPromptOptions()

Returns the current base `BuildSystemPromptOptions` used to construct the session's system prompt.

### ctx.waitForIdle()

Wait for the agent to finish streaming before modifying session state:

```typescript
atomic.registerCommand("my-cmd", {
  handler: async (_args, ctx) => {
    await ctx.waitForIdle();
  },
});
```

### ctx.newSession(options?)

Create a new session. Options: `parentSession`, `setup(sessionManager)` (runs before switching), and `withSession(ctx)` (runs post-switch work against a fresh `ReplacedSessionContext`):

```typescript
const result = await ctx.newSession({
  parentSession: ctx.sessionManager.getSessionId(),
  setup: async (sm) => {
    await sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Context from previous session..." }],
      timestamp: Date.now(),
    });
  },
  withSession: async (nextCtx) => {
    await nextCtx.sendUserMessage("Continue in the new session");
  },
});
if (result.cancelled) {
  // Cancelled by session_before_switch
}
```

### ctx.fork(entryId, options?)

Fork from an entry into a new session file. Options: `position` (`"before"` default, restoring that user prompt into the editor; `"at"` clones through that entry without restoring editor text) and `withSession(ctx)`:

```typescript
const forkResult = await ctx.fork("entry-id-123", {
  withSession: async (nextCtx) => {
    nextCtx.ui.notify("Now in the forked session", "info");
  },
});

const cloneResult = await ctx.fork("entry-id-456", { position: "at" });
```

### ctx.navigateTree(targetId, options?)

Navigate to another point in the session tree. Rejects while streaming, compacting, or summarizing without changing the active branch. Options: `summarize`, `customInstructions`, `replaceInstructions`, and `label`:

```typescript
await ctx.navigateTree("entry-id-456", {
  summarize: true,
  customInstructions: "Focus on error handling changes",
  replaceInstructions: false,
  label: "review-checkpoint",
});
```

### ctx.switchSession(sessionId, options?)

Switch to another session by exact ID. Options: `withSession(ctx)`.

If the target session's recorded working directory no longer exists, `switchSession()` rejects with `MissingSessionCwdError` (`code: "session-cwd-missing"`; guard with `isMissingSessionCwdError`). Use `SessionManager.list(cwd)` or `SessionManager.listAll()` to discover session IDs:

```typescript
import { SessionManager } from "@bastani/atomic";

atomic.registerCommand("switch", {
  description: "Switch to another session",
  handler: async (_args, ctx) => {
    const sessions = await SessionManager.list(ctx.cwd);
    if (sessions.length === 0) return;
    const choice = await ctx.ui.select("Pick session:", sessions.map((s) => s.id));
    if (choice) {
      await ctx.switchSession(choice, {
        withSession: async (nextCtx) => {
          nextCtx.ui.notify("Switched session", "info");
        },
      });
    }
  },
});
```

### Session replacement lifecycle and footguns

`withSession` receives a fresh `ReplacedSessionContext`, which extends `ExtensionCommandContext` with async `sendMessage()` and `sendUserMessage(): Promise<void>` bound to the replacement session.

- `withSession` runs after the old session has emitted `session_shutdown`, reloaded extensions, and emitted `session_start` on the new session.
- Because `withSession` executes inside your original closure, old `atomic` handles, old `ctx`, and extracted objects like `const sm = ctx.sessionManager` are stale and throw if used. Use only the `nextCtx` parameter passed to `withSession`, and capture only plain serializable data (strings, IDs, config).
- Use `isStaleExtensionContextError(error)` from `@bastani/atomic` to detect stale-context errors in long-lived callbacks.

### ctx.reload()

Runs the same reload sequence as `/reload` (emits `session_shutdown`, reloads resources, emits `session_start` and `resources_discover` with `reason: "reload"`). Code after `await ctx.reload()` still executes in the pre-reload function frame, so return immediately (`await ctx.reload(); return;`).

Tools receive `ExtensionContext` and cannot call `ctx.reload()` directly; register a command and have a tool queue it with `atomic.sendUserMessage("/reload-runtime", { deliverAs: "followUp" })`.

## ExtensionAPI methods

### atomic.getSettings()

Returns a snapshot of effective `Settings`. Available after the session runtime binds (call from `session_start`, commands, tools, or event handlers rather than top-level factory code).

### atomic.on(event, handler)

Subscribe to a lifecycle event and return an unsubscribe function `() => void`. See [Extension events](/extensions/events#events) for all event types, payloads, and return contracts:

```typescript
const unsubscribe = atomic.on("turn_end", (event) => {
  if (event.turnIndex >= 5) unsubscribe();
});
```

### atomic.registerTool(definition)

Register a custom tool callable by the model. Works both during extension load and dynamically afterward (inside `session_start`, commands, or event handlers), taking effect immediately without `/reload`. See [Custom tools](/extensions/authoring#custom-tools).

Collision rules:

- Within one extension, registering the same tool name twice keeps the last registration and shows a warning under `[Extension issues]`.
- Across multiple extensions, the **first** loaded extension wins. The mandatory bundled `intercom` tool cannot be shadowed.

Stop promptly when `signal` aborts. A tool call that does not settle within 10 seconds after abort (`ATOMIC_TOOL_ABORT_GRACE_MS`) gets an `Operation aborted` error result and any late return value is discarded.

#### Built-in tool prompt contributions

Atomic exports immutable `{ snippet, guidelines }` constants for built-in coding tools (`bashToolSystemPromptContribution`, `editToolSystemPromptContribution`, `findToolSystemPromptContribution`, `lsToolSystemPromptContribution`, `readToolSystemPromptContribution`, `searchToolSystemPromptContribution`, `writeToolSystemPromptContribution`) so overrides can reuse built-in prompt text without duplicating it.

### atomic.sendMessage(message, options?)

Queue a custom message into the session. Returns `void | Promise<void>`; wrap with `await Promise.resolve(atomic.sendMessage(...))` to catch validation or routing failures. In Atomic's standard session runtime, the returned promise resolves once the message is queued (without waiting for the resulting model turn to finish).

`customType` must be a string and `content` a string or content-block array, or the call throws `TypeError` and saves nothing.

```typescript
await Promise.resolve(
  atomic.sendMessage(
    {
      customType: "my-extension",
      content: "Message text",
      display: true,
      details: { step: 1 },
    },
    { triggerTurn: true, deliverAs: "steer" },
  ),
);
```

Options (`SendMessageOptions`):

- `deliverAs`: `"steer"` (default; queues after current turn's tool calls), `"followUp"` (waits until all tool calls finish), `"nextTurn"` (attaches to the next user prompt without triggering a turn), or `"interrupt"` (with `triggerTurn: true`, aborts the active turn and starts a new turn immediately).
- `triggerTurn`: start a model turn immediately if idle (required for `"interrupt"`, ignored for `"nextTurn"`).
- `excludeFromContext`: render and persist the message without adding it to model context.
- `interruptAbortMessage`: custom abort text when `deliverAs: "interrupt"` stops an active turn.
- `persistWhenStreaming`: persist the custom message immediately even while a turn is streaming.
- `stageAdmissionKey`: optional deduplication key for staged recovery deliveries.

In print (`-p`) and JSON modes, Atomic waits for messages queued before a command handler returns (and the turns they trigger) before exiting.

### atomic.sendMessages(messages, options?)

Queue a batch of custom messages together in array order so no other message can split them. Returns `void | Promise<void>` (resolving once queued, not when the turn finishes). Supports `triggerTurn`, `excludeFromContext`, and `deliverAs: "steer" | "followUp" | "nextTurn"` (not `"interrupt"`). If any message fails validation, throws `TypeError` and queues none.

```typescript
await Promise.resolve(
  atomic.sendMessages(
    [
      { customType: "worker-update", content: "Ready", display: true },
      { customType: "worker-terminal", content: "Completed", display: true },
    ],
    { triggerTurn: true },
  ),
);
```

### atomic.sendUserMessage(content, options?)

Send an actual user message (always triggering a turn). Returns `void` on `ExtensionAPI` (whereas `ReplacedSessionContext.sendUserMessage()` inside `withSession` returns `Promise<void>`).

```typescript
atomic.sendUserMessage("What is 2+2?");
atomic.sendUserMessage("Focus on error handling", { deliverAs: "steer" });
atomic.sendUserMessage("/review src/index.ts", { expandPromptTemplates: true });
```

Options:

- `deliverAs`: `"steer"` or `"followUp"` (required when the agent is streaming; omitting it while streaming throws an error).
- `expandPromptTemplates`: defaults to `false`; set `true` to dispatch extension commands and expand `/skill:` and prompt templates.

While the session is compacting, the message waits in the queue and sends once compaction ends.

### atomic.appendEntry(customType, data?)

Persist durable extension state without adding it to model context. `customType` must be a string (otherwise rejects with `TypeError`). Await the returned promise before reading the entry; appending emits `entry_appended`.

During `session_start` on `/reload`, `appendEntry()`, `setSessionName()`, and `setLabel()` stage writes until reload succeeds (a failed reload discards them), so do not read staged writes back inside that `session_start` handler.

```typescript
await atomic.appendEntry("my-state", { count: 42 });
```

### atomic.registerEntryRenderer(customType, renderer)

Register a TUI renderer for durable custom entries created by `atomic.appendEntry()`. `Ctrl+O` or clicking the entry in fullscreen mode toggles `expanded`.

```typescript
import { Text } from "@bastani/atomic-tui";

atomic.registerEntryRenderer("status-card", (entry, { expanded }, theme) =>
  new Text(theme.fg("accent", `${expanded ? "Details" : "Status"}: ${JSON.stringify(entry.data)}`), 0, 0),
);
```

### atomic.setSessionName(name) / atomic.getSessionName()

Set (`Promise<void>`) or read (`string | undefined`) the session display name shown in `/resume` and the session selector.

### atomic.setLabel(entryId, label)

Set a string bookmark label on an entry (shown in `/tree`), or pass `undefined` to clear it. Any other value rejects with `TypeError`. Read labels with `ctx.sessionManager.getLabel(entryId)`.

### atomic.registerCommand(name, options)

Register a slash command. If multiple extensions register the same command name, **all** colliding commands receive numeric suffixes in load order (`/review:1`, `/review:2`), and no bare `/review` command remains.

`getArgumentCompletions(prefix)` may return `AutocompleteItem[] | null` or `Promise<AutocompleteItem[] | null>`:

```typescript
import type { AutocompleteItem } from "@bastani/atomic-tui";

atomic.registerCommand("deploy", {
  description: "Deploy to an environment",
  getArgumentCompletions: async (prefix: string): Promise<AutocompleteItem[] | null> => {
    const envs = ["dev", "staging", "prod"];
    const items = envs.filter((e) => e.startsWith(prefix)).map((e) => ({ value: e, label: e }));
    return items.length > 0 ? items : null;
  },
  handler: async (args, ctx) => {
    ctx.ui.notify(`Deploying: ${args}`, "info");
  },
});
```

### atomic.getCommands()

Returns all slash commands invocable via prompts (`extension`, `prompt`, and `skill` sources, in that order; excludes interactive-only built-in commands like `/model` and `/settings`). Each item contains:

```typescript
{
  name: string;        // Without leading slash; may be suffixed like "review:1"
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
    configurationOrigin?: "atomic" | "inherited-pi" | "bundled";
  };
}
```

### atomic.registerMessageRenderer(customType, renderer)

Register a TUI renderer for custom messages with `customType`. Options include `expanded`, `outputPad`, `keyHint()`, and `keyText()` in both interactive and embedded rendering. Returning a `Component` renders it, returning `null` suppresses the message completely (zero rows, no box), and returning `undefined` falls back to the default boxed rendering. Clicking the message in fullscreen mode toggles `expanded` unless a custom mouse handler consumes the click. See [Message rendering](/extensions/ui#message-rendering).

### atomic.registerToolRenderer(resolver)

Register a resolver `(toolName, next) => renderers` supplying `renderCall`, `renderResult`, and optional `renderShell` for any tool (including MCP tools in resumed sessions before their server connects). Resolvers run in extension load order; `next()` returns the remaining resolvers' choice and then the tool's own renderers. See [Custom rendering](/extensions/authoring#custom-rendering).

<div id="pi-registermarkdowntransformer-transformer" />

### atomic.registerMarkdownTransformer(transformer, options?)

Register a synchronous, display-only Markdown transformer for interactive rendering. Transformers run in load order (one per extension; a second call replaces the first). Optional `options.messageTypes` selects which message kinds to transform (default `["user", "assistant", "assistant-thinking"]`; also supports `"custom"`, `"summary"`, `"changelog"`).

Context fields passed to the transformer: `messageType`, `isStreaming`, `availableWidth`, `messageId` (`undefined` for live messages and changelog), and `timestamp` (`undefined` for live messages and changelog). Display transformers do not run when extensions execute in the separate interactive worker process.

```typescript
atomic.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
  if (isStreaming || messageType === "assistant-thinking") return markdown;
  return markdown.replaceAll("-->", "→");
});
```

### atomic.registerShortcut(shortcut, options)

Register a keyboard shortcut. See [Keybindings](/keybindings) for shortcut syntax.

```typescript
atomic.registerShortcut("ctrl+shift+p", {
  description: "Toggle plan mode",
  handler: async (ctx) => {
    ctx.ui.notify("Toggled!", "info");
  },
});
```

Conflict policy:

- **17 reserved built-in actions cannot be overridden** (`app.interrupt`, `app.clear`, `app.exit`, `app.suspend`, `app.thinking.cycle`, `app.model.cycleForward`, `app.model.cycleBackward`, `app.model.select`, `app.tools.expand`, `app.thinking.toggle`, `app.editor.external`, `app.message.followUp`, `tui.input.submit`, `tui.select.confirm`, `tui.select.cancel`, `tui.input.copy`, `tui.editor.deleteToLineEnd`). Registering their keys skips with a warning.
- **Non-reserved built-in shortcuts** are overridden by extensions (with a warning) unless `preferEditor: true` is set, which yields to the editor binding.
- **Between two extensions**, the **last** registered shortcut wins (with a warning).
- Optional `keybinding` selects keys from an existing named action in `keybindings.json` instead of a hardcoded key; an empty action binding disables the shortcut.

### atomic.registerFlag(name, options) / atomic.getFlag(name)

Register and read a custom CLI flag (`type: "boolean" | "string"`):

```typescript
atomic.registerFlag("plan", {
  description: "Start in plan mode",
  type: "boolean",
  default: false,
});

if (atomic.getFlag("plan")) {
  // Plan mode enabled
}
```

Flag rules:

- `default`, if supplied, must match `type` (`boolean` or `string`) or `registerFlag()` throws.
- Across extensions, the **first** extension registering a flag name wins.
- `atomic.getFlag(name)` reads **only** flags registered by that same extension; it returns `undefined` for other extensions' flags or built-in CLI flags.

<div id="pi-registeragentpanelsource-source" />

### atomic.registerAgentPanelSource(source)

Add rows to the [agent panel](/background-tasks#the-agent-panel) below the prompt and to `/tasks`. Registrations are removed automatically when the extension reloads or the session closes.

```typescript
import type { AgentPanelItem, ExtensionAPI } from "@bastani/atomic";

declare function showDeploy(id: string, options: { onBack: () => void }): void;

export default function (atomic: ExtensionAPI) {
  const listeners = new Set<() => void>();
  let items: AgentPanelItem[] = [
    { id: "deploys:42", kind: "agent", state: "running", name: "deployer", task: "build", progress: { done: 1, total: 3 } },
  ];
  const changed = () => { for (const listener of listeners) listener(); };

  atomic.registerAgentPanelSource({
    items: () => items,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open(id, options) {
      showDeploy(id, { onBack: () => options?.onReturn?.() });
      return true;
    },
    async stop(id) {
      items = items.map((item) => (item.id === id ? { ...item, state: "stopped", endedAt: Date.now() } : item));
      changed();
      return { ok: true };
    },
  });
}
```

Keep `items()` and `subscribe()` fast and synchronous. Return at most 10,000 rows per source (extra rows are ignored with one warning), and keep `choices` to 128 items or fewer.

| Field | Meaning |
| --- | --- |
| `id` | Unique in the session (prefix with your source name; `main` and `task:` are reserved). |
| `kind` | `"agent"` or `"shell"` (`"shell"` appears in `/tasks` and main footer count only). |
| `state` | `running`, `queued`, `input`, `paused`, `stopping`, `waiting`, `done`, `failed`, or `stopped`. |
| `name`, `task` | Display name and active task description. |
| `model`, `thinking` | Optional `provider/model-id` string and reasoning level string. |
| `elapsedMs`, `tokens` | Finite non-negative milliseconds and safe integer token count. |
| `progress` | Finite non-negative `{ done, total }` stage progress bar. |
| `question`, `choices`, `promptId` | Prompt details for `input` items (change `promptId` for every new question). |
| `reason`, `waitingOn`, `queued`, `endedAt`, `runGeneration` | Failure summary, waiting label, queued message count, finish timestamp (epoch ms), and monotonic per-item run counter. |

Optional actions (`open`, `stop`, `answer`) return `{ ok: true }` or `{ ok: false, reason }` (for `open`, `false` keeps `/tasks` open and shows `Could not open <name>`). Check `options.promptId` and `options.choiceIndex` in `answer()` rather than matching display labels.

Exported types and standalone helpers: `AgentPanelSource`, `AgentPanelItem`, `AgentPanelState`, `AgentPanelActionResult`, `AgentPanelOpenOptions`, `AgentPanelAnswerOptions`, `AgentPanelSourceRegistration`, `AgentPanelSession`, `agentPanelItems(session)`, `subscribeAgentPanel(session, listener)`, `openAgentPanelItem`, `stopAgentPanelItem`, `answerAgentPanelItem`, `dismissedAgentPanelItems(session)`, and `agentPanelTaskId(id)`.

### atomic.exec(command, args, options?)

Execute a command directly without a shell:

```typescript
const result = await atomic.exec("git", ["status"], { signal, timeout: 5000 });
// result.stdout, result.stderr, result.code, result.killed, result.truncated
```

- On Windows, bare command names (like `git`) resolve only from absolute directories on `PATH`, never from `cwd` or Atomic's own directory.
- Options: `signal`, `timeout`, `cwd`, `maxBuffer` (default 256 MiB combined stdout/stderr). Exceeding `maxBuffer` kills the process and sets `truncated: true`, `killed: true`, and nonzero `code`. Signal terminations report `128 + signal`.
- On timeout, abort, or `maxBuffer`: terminates the process tree (`SIGTERM`, then `SIGKILL` after 5 s on Unix; immediate descendant termination on Windows).
- On interactive quit: kills running commands after 1 s (`SIGTERM` then `SIGKILL` on Unix; immediate on Windows) before `session_shutdown` runs; commands started inside `session_shutdown` are not killed this way. When Atomic is killed (`SIGKILL`), running commands and the processes they started in their process group receive `SIGKILL` on Linux and macOS, also in a session that runs in Atomic's own process; a program a command started detached keeps running.

### atomic.getActiveTools() / atomic.getAllTools() / atomic.setActiveTools(names)

Inspect or change the active tool list (including dynamically registered tools and Intercom; tools excluded by a session allowlist or exclusions cannot be activated):

```typescript
const active = atomic.getActiveTools();
const all = atomic.getAllTools();
atomic.setActiveTools([...new Set([...active, "my_custom_tool"])]);
```

Each entry from `atomic.getAllTools()` includes `name`, `description`, `parameters`, `promptGuidelines`, `exposure`, `namespace`, `annotations`, `constrainedSampling`, `explicitDefaultOptOut`, and `sourceInfo` (`source: "builtin" | "sdk" | ...`). Respect `explicitDefaultOptOut: true` before re-enabling a tool automatically. See [Tool exposure](/extensions/authoring#tool-exposure).

### atomic.setModel(model)

Set the active model for the current session (recorded in session history; does not modify `defaultProvider` or `defaultModel` in settings). Returns `false` if the provider lacks credentials.

### atomic.getThinkingLevel() / atomic.setThinkingLevel(level)

Get or set the session's thinking level (`"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`), clamped to model capabilities. Changes emit `thinking_level_select`.

### atomic.events

Shared event bus between active extensions in the same session. Subscriptions created with `atomic.events.on()` are cleaned up automatically on reload or disposal and return an unsubscribe function:

```typescript
const unsubscribe = atomic.events.on("my:event", (data) => { /* ... */ });
atomic.events.emit("my:event", { ok: true });
unsubscribe();
```

Do not retain `atomic.events` across `/reload` (calling `on()` or `emit()` on a retired handle throws). Pass `atomic.events` to [`sessionScopedExtensionState`](/extensions/authoring#session-scoped-in-memory-state) to preserve in-memory state across reloads.

Embedded hosts implementing `ExtensionRuntime` must implement `trackEventBusSubscription(unsubscribe)` and return `markdownTransformers` (plus optional `renderLatex`, `fullscreenScrollbar`, `fullscreenWheelScrollLines`) from `ExtensionUIContext.getChatRenderSettings()`. See [SDK extensions](/sdk/reference#extensions).

### Native providers

Pass a complete native `Provider` from `@bastani/atomic-ai` to `await atomic.registerProvider(provider)` when you need provider-owned API-key login flows, custom transport, or native catalog refresh:

```typescript
import type { Provider } from "@bastani/atomic-ai";

const localServerProvider: Provider = {
  id: "local-server",
  name: "Local Server",
  auth: {
    apiKey: {
      name: "Local server connection",
      async login({ signal, prompt }) {
        const baseUrl = await prompt({
          type: "text",
          message: "Server URL",
          placeholder: "http://localhost:9931",
        });
        if (signal.aborted) throw new Error("Login cancelled");
        return { type: "api_key", env: { LOCAL_SERVER_URL: baseUrl } };
      },
    },
  },
  // ...models and transport methods
};

await atomic.registerProvider(localServerProvider);
```

Provider-owned `auth.apiKey` (`{ name, login, check?, resolve? }`) is supported **only** on native `Provider` objects passed to single-argument `atomic.registerProvider(provider)`, not on two-argument `ProviderConfig`. Providers registered in interactive extensions appear in `/login`; their callbacks run in the extension worker while prompts render in the terminal.

### atomic.registerProvider(name, config)

Register or override a provider dynamically using a `ProviderConfig` object (for proxies, custom endpoints, OAuth flows, or custom models). Await registration, aliases, and unregistration before dependent work. Calls during an async factory complete before startup continues and appear in `atomic --list-models`; calls afterward take effect immediately without `/reload`.

```typescript
// Register a new provider with custom models
await atomic.registerProvider("my-proxy", {
  name: "My Proxy",
  baseUrl: "https://proxy.example.com",
  apiKey: "$PROXY_API_KEY",
  api: "anthropic-messages",
  models: [
    {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5 (proxy)",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    },
  ],
});

// Override baseUrl for an existing provider (keeps existing models)
await atomic.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com",
});

// Register a provider with OAuth login
await atomic.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com",
  api: "openai-responses",
  models: [...],
  oauth: {
    name: "Corporate AI (SSO)",
    loginLabel: "Sign in with SSO",
    usesCallbackServer: false,
    async login(callbacks, signal) {
      callbacks.onAuth({ url: "https://sso.corp.com/..." });
      const code = await callbacks.onPrompt({ message: "Enter code:" });
      signal.throwIfAborted();
      return { refresh: code, access: code, expires: Date.now() + 3600000 };
    },
    async refreshToken(credentials, signal) {
      // Throw OAuthRefreshRejectedError on permanent rejection (for example invalid_grant)
      return refreshCorporateToken(credentials.refresh, { signal });
    },
    getApiKey(credentials) {
      return credentials.access;
    },
  },
});
```

`ProviderConfig` options:

- `name`: display name in UI such as `/login`.
- `aliasOf`: ID of an existing provider to alias.
- `baseUrl`: API endpoint URL (required when defining models).
- `apiKey`: literal key or environment variable reference (`$ENV_VAR` or `${ENV_VAR}`; required when defining models unless `oauth` is set).
- `api`: API protocol (`"anthropic-messages"`, `"openai-completions"`, `"openai-responses"`, etc.).
- `headers`, `authHeader`: extra headers, or `authHeader: true` to send `Authorization: Bearer`.
- `models`: array of `ProviderModelConfig` entries (`type?: "chat" | "image" | "classifier"`, defaulting to `"chat"`). Chat models support `reasoning`, `thinkingLevelMap`, `contextWindow`, `maxTokens`, `samplingParams`, `samplingParamsByThinkingLevel`, `promptCache`, and `compat`; image models support `output` and `capabilities`; classifier models support `contextWindow` and `compat`. Individual models may set `baseUrl`.
- `refreshModels?(context)`: dynamically refresh the provider's model catalog (replaces extension-provided models on success).
- `images`, `classifiers`: custom image or classifier API handlers keyed by API name.
- `streamSimple`: custom streaming implementation for non-standard APIs.
- `oauth`: OAuth configuration with `name`, optional `loginLabel`, optional `usesCallbackServer`, `login(callbacks, signal)`, `refreshToken(credentials, signal)`, `getApiKey(credentials)`, and optional `modifyModels(models, credentials)`.

**OAuth refresh contract:** Atomic does not abort the `refreshToken` `signal` on timeout because a provider may already have rotated the refresh token once sent. Callers stop waiting after 60 seconds while the exchange keeps running and saves rotated credentials when done (on normal exit, Atomic waits up to 3 seconds). Do not add your own timeout or retry a rotated refresh token. If the provider permanently rejects the login (such as `invalid_grant`), throw `OAuthRefreshRejectedError` (exported from `@bastani/atomic`) so Atomic instructs the user to run `/login <provider>`.

See [Custom providers](/custom-provider) for full details.

### atomic.registerProviderAlias(config)

Register an alias pointing to an existing provider (for example, multiple accounts on the same provider). Returns `Promise<void>`:

```typescript
await atomic.registerProviderAlias({
  id: "openai-work",
  name: "OpenAI (Work)",
  provider: "openai",
});
```

See [examples/extensions/provider-accounts.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/provider-accounts.ts).

### atomic.unregisterProvider(name)

Remove a previously registered provider and its models, restoring any built-in models it overrode. No-op for unknown names. Takes effect immediately without `/reload`.

### atomic.registerMcpServer(name, config) {#atomic-registermcpserver-name-config}

Contribute an MCP server whose configuration is computed at runtime (for example, a dynamically bound local port). `name` must match `^[A-Za-z0-9_-]+$`, and `config` follows the [`mcp.json`](/mcp-servers#configure-servers) schema (`url`, `command`, `args`, `env`, `cwd`, `headers`, OAuth settings, `exposure`, positive `timeout` in seconds, `${VAR}` / `$env:VAR` URL interpolation). `type: "sse"` is rejected (use streamable HTTP).

```typescript
export default function (atomic: ExtensionAPI) {
  atomic.on("session_start", async () => {
    const port = await startLocalService();
    atomic.registerMcpServer("local-service", {
      url: `http://127.0.0.1:${port}/mcp`,
      exposure: "direct",
    });
  });
}
```

Call from the extension factory or `session_start`; servers connect immediately without `/reload`, and re-registering the same name replaces the previous registration. Extension-registered servers override package-manifest servers while user and trusted-project `mcp.json` entries take precedence over both (set `"enabled": false` on a file-configured entry to disable it).

`auth.provider` is allowed on extension-registered servers (requiring HTTPS or a loopback URL) and global `mcp.json`, not project config or package manifests. Shell `atomic mcp` commands do not load extensions. Call `atomic.getMcpServerContributions()` to inspect all package and extension server contributions.

## Error handling

- Uncaught errors in most event handlers are logged and the session continues.
- In interactive mode, an error thrown in `session_start` or `resources_discover` is shown once with the extension's path and error while keeping the session open and the extension loaded. In print mode (`-p`), standalone RPC mode (`--mode rpc`), and SDK sessions, startup fails with `ExtensionStartupError` naming each failing extension.
- If a `tool_call` handler throws an error, Atomic blocks the tool call and reports the error to the model instead of running the tool.
- Inside tool `execute()`, throw an `Error` to report failure; Atomic catches it, sends it to the model with `isError: true`, and continues.

### Typed errors from built-in tools and providers

These error classes and type guards are exported from `@bastani/atomic` (see [Session and storage errors](/sdk/reference#session-and-storage-errors) for session, storage, and startup errors). Branch on the class, its type guard, or `code` rather than `message`. Each tool/provider error includes `hint`, `retryable`, and `toJSON()` for cross-process serialization (credentials in URLs are stripped). Use `rehydrateShellToolError()` and `rehydrateLlamaServerError()` to rebuild serialized instances.

| Class | `code` | When | Key fields / notes |
| --- | --- | --- | --- |
| `ShellTimeoutError` (`ShellToolError`) | `shell-timeout` | `createLocalBashOperations()` hit the command timeout (`phase: "draining-output"` means the shell exited while background children kept stdout/stderr open). | `timeoutMs`, `elapsedMs`, `phase`, `shellExit`. Redirect background output or increase `timeout`. |
| `LlamaServerUnreachableError` (`LlamaServerError`) | `server-unreachable` | A `llama.cpp` router request failed before any response (connection refused, DNS error, TLS mismatch). | `serverUrl`, `detail`; `retryable: true`. Start `llama serve` or fix URL with `/login llama.cpp` / `LLAMA_BASE_URL`. |
| `LlamaServerRequestError` (`LlamaServerError`) | `request-rejected` | The runtime refused to send a `llama.cpp` request (credentials in URL or blocked port such as `6000`). | `serverUrl`, `detail`; `retryable: false`. Use a plain `http`/`https` URL without embedded credentials. |
| `OAuthRefreshRejectedError` | *(OAuth refresh)* | Thrown by an extension's `oauth.refreshToken()` when the provider permanently rejects stored credentials (such as `invalid_grant`). | Prompts the user to re-authenticate with `/login <provider>`. |
| `DecisionModelUnavailableError` | *(decision model)* | `ctx.getDecisionModel()` called in a host without decision-model support (`reason: "host-unsupported"`). | Check host support or handle gracefully before invoking decision helpers. |
| `NativeModuleUnavailableError` | *(native addon)* | Optional native N-API bindings (`@bastani/atomic-natives`) are unavailable on the host runtime. | Exported from `@bastani/atomic` for callers checking native-module fallbacks. |
| `MissingSessionCwdError` | `session-cwd-missing` | `ctx.switchSession()` targeted a session whose recorded working directory no longer exists. | Guard with `isMissingSessionCwdError(error)`. |
