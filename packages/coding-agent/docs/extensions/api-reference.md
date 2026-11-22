---
title: Extension API reference
sidebarTitle: "Extension API"
description: ExtensionContext, ExtensionCommandContext, ExtensionAPI methods, and error handling.
---

# Extension API reference

## ExtensionContext

All handlers receive `ctx: ExtensionContext`.

### ctx.ui

UI methods for user interaction. See [Custom UI](/extensions/ui#custom-ui) for full details.

### ctx.hasUI

`false` in print mode (`-p`) and JSON mode. `true` in interactive and RPC mode. In RPC mode, dialog methods (`select`, `confirm`, `input`, `editor`) work via the extension UI sub-protocol, and fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`) emit requests to the client. Some TUI-specific methods are no-ops or return defaults (see [RPC mode](/rpc/extension-ui#extension-ui-protocol)).

### ctx.isPresentationOnly

`true` in the local presentation host when the isolated interactive engine owns execution. Keep UI registration active, but skip background execution and durable recovery in lifecycle hooks in this context to avoid starting the same work in both processes. Normal SDK, print, RPC, and engine contexts leave this flag false or unset.

### ctx.cwd

Current working directory.

Built-in cwd-sensitive tools (`read`, `write`, `edit`, `search`, `find`, `ls`, `bash`, `powershell`) resolve relative paths against `ctx.cwd` when an extension invokes them, falling back to the cwd captured when the tool was created. An extension that registers a tool and forwards its own context therefore gets paths resolved against the live session cwd rather than a stale one.

Use `CONFIG_DIR_NAME` instead of hardcoding `.atomic` (or legacy `.pi`) when constructing project-local config paths. Rebranded distributions can use a different config directory name.

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

Returns whether project-local trust is active for the current session context. This includes temporary trust decisions and CLI trust overrides, not only saved decisions in the global trust store.

Use this before reading project-local extension configuration, loading project-local resources, or exposing actions that should only run after the user trusts the working directory.

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

For `tool_call`, this state is synchronized through the current assistant message before handlers run. In parallel tool execution mode it is not guaranteed to include sibling tool results from the same assistant message.

```typescript
ctx.sessionManager.getEntries()       // Entries held for the current window
ctx.sessionManager.getBranch()        // Current branch
ctx.sessionManager.getLeafId()        // Current leaf entry ID
```

Starting an extension does not load older conversation entries. Entries your extension saved with `atomic.appendEntry()` on the current branch stay in `getBranch()` and `getEntries()`, so restoring state in `session_start` works without extra loads.

To inspect older history without keeping the whole session in memory:

- Call `await ctx.sessionManager.readEntry(id)` to look up a single entry.
- Iterate `for await (const page of ctx.sessionManager.readHistory({ fromSeq, toSeq }))` to visit entries in append order. Each item in `page.items` is either `{ seq, entry }` or an oversized reference (`kind: "oversized"`, `seq`, `bytes`) that you stream with `ctx.sessionManager.readHistoryChunks(item)`.
- Break out of either loop once you have what you need; the manager does not retain read pages.
- `await ctx.sessionManager.loadFullHistory()` loads every stored entry into memory; prefer paged reads when possible.

### ctx.modelRegistry / ctx.model / ctx.scopedModels

Access models, authentication state, and provider-aware requests.

Use `ctx.modelRegistry.complete()` for an extension model request that uses Atomic's provider composition. It dispatches through the active `ModelRuntime`, keeping registered custom providers and resolved request authentication: the credential-specific `baseUrl`, headers (including `null` suppression markers), and environment values.

Use `ctx.modelRegistry.generateImages(model, context, options)` to run an image model with request-time authentication. It resolves to the generated image blocks and usage, and reports provider errors through `stopReason`, `errorMessage`, and `error` instead of rejecting.

For `openai-images` models, `options` accepts `size`, `quality`, `n`, `background`, `outputFormat` (`png`, `jpeg`, `webp`, `gif`, `svg`), `outputCompression`, `frameCount`, `frameDurationMs`, `complexity`, `svg`, `moderation`, and `safetyIdentifier`. An image block with `role: "markup"` or `role: "mask"` maps to the `markup` or `mask` field, and the first other image is the base image of an edit. GIF, SVG, `complexity`, and the frame options require a GPT Image 2.6 model that declares them in `model.capabilities`.

`outputFormat: "svg"` works without passing `svg`. When the API requires `svg.model` and your request omitted `svg`, Atomic retries once with `gpt-6.1-sol` (exported as `DEFAULT_SVG_AUTHOR_MODEL` from `@bastani/atomic-ai`), and `result.svgModel` reports the model that wrote the SVG.

Pass `svg: { model, reasoning }` to choose a specific authoring model; an explicit `svg` object is sent as given and never replaced. If the API rejects the retry's `svg` parameter as unsupported, Atomic retries once more without it (at most three requests total). Because SVG authoring can take up to two minutes on complex prompts, leave `timeoutMs` unset (the 10-minute default) or set it to at least `180000`.

```typescript
const flare = ctx.modelRegistry.getModelOfType("image", "openai-images", "gpt-image-2.6-flare");
if (!flare) throw new Error("gpt-image-2.6-flare is unavailable");
const input = [{ type: "text" as const, text: "A flat red paper lantern icon" }];

const logo = await ctx.modelRegistry.generateImages(flare, { input }, { outputFormat: "svg", signal: ctx.signal });
if (logo.stopReason !== "stop") throw new Error(logo.errorMessage);
const svgBlock = logo.output.find((block) => block.type === "image");
const svg = svgBlock?.type === "image" ? Buffer.from(svgBlock.data, "base64").toString("utf8") : undefined;
console.log(logo.svgModel, svg?.slice(0, 60)); // gpt-6.1-sol <svg ...

const motion = await ctx.modelRegistry.generateImages(
  flare,
  { input: [{ type: "text", text: "A paper lantern swinging gently, flat vector style" }] },
  { outputFormat: "gif", frameCount: 4, frameDurationMs: 200, size: "512x512", signal: ctx.signal },
);
if (motion.stopReason !== "stop") throw new Error(motion.errorMessage);
```

When image generation fails, `result.error` holds a JSON-safe `ImageGenerationErrorData`. Rebuild the typed error with `imageGenerationErrorFromData()` from `@bastani/atomic-ai` and branch on its class, type guard (`isImageGenerationError`, `isImageGenerationConfigError`, and related guards), or `code`, not on `message`. Use `findImageGenerationError(error, guard)` to inspect a `cause` chain and `isRetryableImageGenerationError()` to check retryability. A cancelled request resolves with `stopReason: "aborted"` and no `error`. See [Image generation](/libraries/ai#image-generation) for the full `ImageGenerationError` class table, `ImageGenerationConfigError` reasons, and `OPENAI_IMAGES_LIMITS` bounds.

For streaming requests, use `ctx.modelRegistry.streamSimple(model, context, options)` with provider-neutral options, or `stream()` with API-specific options. Both use configured providers and request-time authentication, including extension registrations. Iterate the returned `AssistantMessageEventStream` for events and await `.result()` for the final message. Setup failures produce error events and error results. The global compatibility streaming functions do not see extension provider registrations.

```typescript
const model = ctx.modelRegistry.find("github-copilot", "gpt-5.5");
if (!model) throw new Error("Model not found");

const response = await ctx.modelRegistry.complete(
  model,
  { messages },
  { signal: ctx.signal },
);
```

Use `getApiKeyAndHeaders()` only when an extension must inspect authentication before dispatch; normal requests resolve and apply authentication automatically.

OpenRouter Chat Completions and Anthropic Messages requests send `x-session-id` by default when `sessionId` is supplied and prompt caching is enabled. Set the model's `compat.sendSessionAffinityHeaders` to `false` to opt out, or set `cacheRetention: "none"` on the request to disable cache-related affinity. Explicit request headers override generated headers.

`await ctx.modelRegistry.refresh(options)` returns `{ aborted, errors }`, where `errors` is a per-provider map so extensions can report partial refresh failures. Calling `ModelRuntime.setRuntimeApiKey(providerId, apiKey, options)` records the runtime credential without refreshing the catalog; call `refresh({ providers: [providerId], signal })` explicitly when you need an updated catalog.

`ctx.scopedModels` is the read-only list of models scoped to the current session, matching `/scoped-models`. It resolves from `--models` and `enabledModels` against the available catalog and is empty when no scoping is configured (meaning every available model is usable). Each entry is `{ model, thinkingLevel? }`, where `thinkingLevel` is set only when a pattern pinned it (for example `anthropic/*:high`). Use it to build a model picker that matches Atomic's built-in scope.

The value resolves at access time, so it tracks session replacement and reflects the engine's catalog in isolated interactive mode. `ctx.scopedModels` is a getter with no setter (`readonly ScopedModel[]`), and each read returns fresh, frozen copies of the array, every entry, and each model so mutations throw. Change scope through the commands and settings that own it.

```typescript
for (const { model, thinkingLevel } of ctx.scopedModels) {
  console.log(`${model.provider}/${model.id}${thinkingLevel ? `:${thinkingLevel}` : ""}`);
}
```

Both `ScopedModel` and `ExtensionScopedModels` are exported from `@bastani/atomic`:

```typescript
import type { ExtensionScopedModels, ScopedModel } from "@bastani/atomic";

function firstScoped(scope: ExtensionScopedModels): ScopedModel | undefined {
  return scope[0];
}
```

### ctx.signal

The current agent abort signal, or `undefined` when no agent turn is active.

Use this for abort-aware nested work started by extension handlers, for example:
- `fetch(..., { signal: ctx.signal })`
- model calls that accept `signal`
- file or process helpers that accept `AbortSignal`

`ctx.signal` is typically defined during active turn events such as `tool_call`, `tool_result`, `message_update`, and `turn_end`.
It is usually `undefined` in idle or non-turn contexts such as session events, extension commands, and shortcuts fired while Atomic is idle.

```typescript
atomic.on("tool_result", async (event, ctx) => {
  const response = await fetch("https://example.com/api", {
    method: "POST",
    body: JSON.stringify(event),
    signal: ctx.signal,
  });

  const data = await response.json();
  return { details: data };
});
```

### ctx.sessionSignal

A read-only `AbortSignal` for the session lifetime, available even while the agent is idle. It aborts when reload or shutdown begins, **before** Atomic drains admitted commands and emits `session_shutdown`. Unlike `ctx.signal`, it does not end when an agent turn finishes. A replacement session generation receives a new signal.

Custom UI mounted through `ctx.ui.custom` is dismissed automatically when the session ends; an explicit caller signal can still dismiss it earlier. Use `ctx.sessionSignal` for other long-running command resources, such as browser windows, instead of waiting for `session_shutdown`, which cannot run until those commands settle. Cancellation should stop waiting for input, not abandon a session write already started: keep awaiting that write so teardown can drain it safely.

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

Control flow helpers.

`ctx.isIdle()` reports whether the agent is streaming a response. It stays `true` while the session compacts, because a `sendUserMessage()` sent then waits for compaction to end instead of starting a turn.

### ctx.shutdown()

Request a graceful shutdown of Atomic.

- **Interactive mode:** Deferred until the agent becomes idle (after processing all queued steering and follow-up messages).
- **RPC mode:** Runs when the session is idle and all command responses have been written. An idle request does not need another client command to trigger it. Requests during startup wait for input setup; requests during a turn wait for it to settle. If an extension starts compaction outside a turn, shutdown waits for the next command or turn after compaction finishes.
- **Print mode:** No-op. The process exits automatically when all prompts are processed.

Emits `session_shutdown` event to all extensions before exiting. Available in all contexts (event handlers, tools, commands, shortcuts).

```typescript
atomic.on("tool_call", (event, ctx) => {
  if (isFatal(event.input)) {
    ctx.shutdown();
  }
});
```

### ctx.getContextUsage()

Returns current context usage for the active model. Uses last assistant usage when available, then estimates tokens for trailing messages.

```typescript
const usage = ctx.getContextUsage();
if (usage && usage.tokens > 100_000) {
  // ...
}
```

### ctx.compact()

Trigger compaction without awaiting completion. By default it clears the context window so the agent recovers what it needs from session history; with a compactor model configured, the compactor's output replaces the context.

Options include `query` (added to the boundary message and passed to the compactor), `compactionModel` (`"auto"` or an exact model ID for this run without changing settings), and `onComplete` or `onError` callbacks. `compression_ratio` and `preserve_recent` are ignored if passed.

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

Extensions that need their own replacement text can return `compactedText` from `session_before_compact`. See [Compaction](/compaction) for both forms.

### ctx.getSystemPrompt()

Returns Atomic's current system prompt string.

- During `before_agent_start`, this reflects chained system-prompt changes made so far for the current turn.
- It does not include later `context` message mutations.
- It does not include `before_provider_request` payload rewrites.
- If later-loaded extensions run after yours, they can still change what is ultimately sent.

```typescript
atomic.on("before_agent_start", (event, ctx) => {
  const prompt = ctx.getSystemPrompt();
  console.log(`System prompt length: ${prompt.length}`);
});
```

### ctx.getSkillCatalog()

Returns the current loader-owned skill catalog when the host provides one. Use it to resolve exact skill selectors, including source-qualified names such as `tdd@builtin`, without falling back to the bare precedence winner.

```typescript
atomic.on("session_start", (_event, ctx) => {
  const catalog = ctx.getSkillCatalog?.();
  const resolved = catalog?.resolve("tdd@builtin");
  if (resolved?.ok) {
    ctx.ui.notify(`Using ${resolved.candidate.selector}`, "info");
  }
});
```

`atomic.getCommands()` already includes the same advertised `/skill:name` and `/skill:name@source` names. See [Skill Commands](/skills#skill-commands).

## ExtensionToolContext

Tool `execute` callbacks receive an `ExtensionToolContext`, which extends `ExtensionContext` with `tools`, `executeTool(name, args, options?)`, and `parentToolCallId` for nested invocations. Event and command contexts do not provide these tool-only methods. See [structured results and nested tools](/extensions/authoring#structured-results-and-nested-tools) for permissions, cancellation, result hooks, and exclusive-call requirements.

## ExtensionCommandContext

Command handlers receive `ExtensionCommandContext`, which extends `ExtensionContext` with session control methods. These are only available in commands because they can deadlock if called from event handlers.

### ctx.waitForIdle()

Wait for the agent to finish streaming:

```typescript
atomic.registerCommand("my-cmd", {
  handler: async (args, ctx) => {
    await ctx.waitForIdle();
    // Agent is now idle, safe to modify session
  },
});
```

### ctx.newSession(options?)

Create a new session:

```typescript
const parentSession = ctx.sessionManager.getSessionId();
const kickoff = "Continue in the replacement session";

const result = await ctx.newSession({
  parentSession,
  setup: async (sm) => {
    await sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Context from previous session..." }],
      timestamp: Date.now(),
    });
  },
  withSession: async (ctx) => {
    // Use only the replacement-session ctx here.
    await ctx.sendUserMessage(kickoff);
  },
});

if (result.cancelled) {
  // An extension cancelled the new session
}
```

Options:
- `parentSession`: parent session ID to record in the new session header
- `setup`: mutate the new session's `SessionManager` before `withSession` runs
- `withSession`: run post-switch work against a fresh replacement-session context. Do not use captured old `atomic` / command `ctx`; see [Session replacement lifecycle and footguns](#session-replacement-lifecycle-and-footguns).

### ctx.fork(entryId, options?)

Fork from a specific entry, creating a new session file:

```typescript
const result = await ctx.fork("entry-id-123", {
  withSession: async (ctx) => {
    // Use only the replacement-session ctx here.
    ctx.ui.notify("Now in the forked session", "info");
  },
});
if (result.cancelled) {
  // An extension cancelled the fork
}

const cloneResult = await ctx.fork("entry-id-456", { position: "at" });
if (cloneResult.cancelled) {
  // An extension cancelled the clone
}
```

Options:
- `position`: `"before"` (default) forks before the selected user message, restoring that prompt into the editor
- `position`: `"at"` duplicates the active path through the selected entry without restoring editor text
- `withSession`: run post-switch work against a fresh replacement-session context. Do not use captured old `atomic` / command `ctx`; see [Session replacement lifecycle and footguns](#session-replacement-lifecycle-and-footguns).

### ctx.navigateTree(targetId, options?)

Navigate to a different point in the session tree. Navigation rejects while a response, compaction, or branch summarization is active, even with `summarize: false`. Rejection leaves the active branch unchanged. Wait for the active operation to finish and retry.

```typescript
const result = await ctx.navigateTree("entry-id-456", {
  summarize: true,
  customInstructions: "Focus on error handling changes",
  replaceInstructions: false, // true = replace default prompt entirely
  label: "review-checkpoint",
});
```

Options:
- `summarize`: Whether to generate a summary of the abandoned branch
- `customInstructions`: Custom instructions for the summarizer
- `replaceInstructions`: If true, `customInstructions` replaces the default prompt instead of being appended
- `label`: Label to attach to the branch summary entry (or target entry if not summarizing)

### ctx.switchSession(sessionId, options?)

Switch to a different session by its exact ID:

```typescript
const result = await ctx.switchSession("my-session-id", {
  withSession: async (ctx) => {
    await ctx.sendUserMessage("Resume work in the replacement session");
  },
});
if (result.cancelled) {
  // An extension cancelled the switch via session_before_switch
}
```

Options:
- `withSession`: run post-switch work against a fresh replacement-session context. Do not use captured old `atomic` / command `ctx`; see [Session replacement lifecycle and footguns](#session-replacement-lifecycle-and-footguns).

If the session's recorded working directory does not exist, nothing is opened and the call rejects with a `MissingSessionCwdError` (`code: "session-cwd-missing"`; check it with `isMissingSessionCwdError`). Atomic asks the user whether to continue in the current directory or fork the session there only when it runs the session in the terminal's own process; the default interactive mode runs extensions in a separate process, so the rejection reaches your code. See [Sessions](/sessions#resuming-and-deleting-sessions).

To discover available sessions, use the static `SessionManager.list()` or `SessionManager.listAll()` methods:

```typescript
import { SessionManager } from "@bastani/atomic";

atomic.registerCommand("switch", {
  description: "Switch to another session",
  handler: async (args, ctx) => {
    const sessions = await SessionManager.list(ctx.cwd);
    if (sessions.length === 0) return;
    const choice = await ctx.ui.select(
      "Pick session:",
      sessions.map(s => s.id),
    );
    if (choice) {
      await ctx.switchSession(choice, {
        withSession: async (ctx) => {
          ctx.ui.notify("Switched session", "info");
        },
      });
    }
  },
});
```

### Session replacement lifecycle and footguns

`withSession` receives a fresh `ReplacedSessionContext`, which extends `ExtensionCommandContext` with async `sendMessage()` and `sendUserMessage()` helpers bound to the replacement session.

Lifecycle and footguns:
- `withSession` runs only after the old session has emitted `session_shutdown`, the old runtime has been torn down, the replacement session has been rebound, and the new extension instance has already received `session_start`.
- The callback still executes in the original closure, not inside the new extension instance. That means your old extension instance may already have run its shutdown cleanup before `withSession` starts.
- Captured old `atomic` / old command `ctx` session-bound objects are stale after replacement and will throw if used. Use only the `ctx` passed to `withSession` for session-bound work.
- Previously extracted raw objects are still your responsibility. For example, if you capture `const sm = ctx.sessionManager` before replacement, `sm` is still the old `SessionManager` object. Do not reuse it after replacement.
- Code in `withSession` should assume any state invalidated by your `session_shutdown` handler is already gone. Only capture plain data that survives shutdown cleanly, such as strings, ids, and serialized config.
- Long-lived callbacks that need to classify a stale API error should use `isStaleExtensionContextError(error)` from `@bastani/atomic`, not match the host's error message.

Safe pattern:

```typescript
atomic.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const kickoff = "Continue from the replacement session";
    await ctx.newSession({
      withSession: async (ctx) => {
        await ctx.sendUserMessage(kickoff);
      },
    });
  },
});
```

Unsafe pattern:

```typescript
atomic.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const oldSessionManager = ctx.sessionManager;
    await ctx.newSession({
      withSession: async (_ctx) => {
        // stale old objects: do not do this
        oldSessionManager.getSessionFile();
        atomic.sendUserMessage("wrong");
      },
    });
  },
});
```

### ctx.reload()

Run the same reload flow as `/reload`.

```typescript
atomic.registerCommand("reload-runtime", {
  description: "Reload extensions, skills, prompts, and themes",
  handler: async (_args, ctx) => {
    await ctx.reload();
    return;
  },
});
```

Important behavior:
- `await ctx.reload()` emits `session_shutdown` for the current extension runtime
- It then reloads resources and emits `session_start` with `reason: "reload"` and `resources_discover` with reason `"reload"`
- The currently running command handler still continues in the old call frame
- Code after `await ctx.reload()` still runs from the pre-reload version
- Code after `await ctx.reload()` must not assume old in-memory extension state is still valid
- After the handler returns, future commands/events/tool calls use the new extension version

For predictable behavior, treat reload as terminal for that handler (`await ctx.reload(); return;`).

Tools run with `ExtensionContext`, so they cannot call `ctx.reload()` directly. Use a command as the reload entrypoint, then expose a tool that queues that command as a follow-up user message.

Example tool the LLM can call to trigger reload:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";

export default function (atomic: ExtensionAPI) {
  atomic.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, and themes",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });

  atomic.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description: "Reload extensions, skills, prompts, and themes",
    parameters: Type.Object({}),
    async execute() {
      atomic.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
      };
    },
  });
}
```

## ExtensionAPI methods

### atomic.on(event, handler)

Subscribe to events. See [Events](/extensions/events#events) for event types and return values.

### atomic.registerTool(definition)

Register a custom tool callable by the LLM. See [Custom tools](/extensions/authoring#custom-tools) for full details.

`atomic.registerTool()` works both during extension load and after startup. You can call it inside `session_start`, command handlers, or other event handlers. New tools refresh immediately in the same session, so they appear in `atomic.getAllTools()` and are callable by the LLM without `/reload`.

If an extension registers the same tool name more than once while it loads, the last registration wins and Atomic shows a warning under `[Extension issues]`.

Use `atomic.setActiveTools()` to enable or disable registered tools, including dynamically added tools and Intercom. Tools suppressed by a session allowlist or exclusions cannot be activated this way.

Use `promptSnippet` to opt a custom tool into a one-line entry in `Available tools`, and `promptGuidelines` to append tool-specific bullets to the default `Guidelines` section when the tool is active. Because `promptGuidelines` bullets are appended flat without a tool name prefix, each guideline must name the tool it refers to (write "Use `my_tool` when..." instead of "Use this tool when...").

An orchestrating tool can adjust what the model sees by implementing `prepareLoadout(loadout)`. The hook receives declared, callable, and registered tools along with `getExposure()`, `getNamespace()`, and `getPromptGuidelines()`. Return replacement `descriptions` or `hiddenDeclarations` to hide active tools' declarations while keeping them callable from scripts. The default system prompt omits hidden tools from its tool list and rules, and names no tool in the skills hint when the file reader is hidden; the orchestrating tool should present those guidelines itself, as `codemode` does.

See [dynamic-tools.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/dynamic-tools.ts) for a full example.

#### Built-in tool prompt contributions

Atomic exports immutable prompt metadata for its built-in coding tools. Use these constants when an embedded application or tool registry needs the same prompt entries as the built-in factories:

```typescript
import {
  bashToolSystemPromptContribution,
  editToolSystemPromptContribution,
  findToolSystemPromptContribution,
  lsToolSystemPromptContribution,
  readToolSystemPromptContribution,
  searchToolSystemPromptContribution,
  writeToolSystemPromptContribution,
} from "@bastani/atomic";

const { snippet, guidelines } = readToolSystemPromptContribution;
```

Each contribution provides a readonly `snippet` for the `Available tools` section and readonly `guidelines` for the active tool's `Guidelines` entries. The seven exports cover `bash`, `edit`, `find`, `ls`, `read`, `search`, and `write`. The built-in factories use these values directly, so callers do not need to duplicate prompt text.

Import `StringEnum` from `@bastani/atomic` (also exported from `@bastani/atomic-ai`) for string enum parameters so the schema stays Google-compatible and typed against Atomic's TypeBox version.

```typescript
import { Type } from "typebox";
import { StringEnum } from "@bastani/atomic";

atomic.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does",
  promptSnippet: "Summarize or transform text according to action",
  promptGuidelines: ["Use my_tool when the user asks to summarize previously generated text."],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    // Optional compatibility shim. Runs before schema validation.
    // Return the current schema shape, for example to fold legacy fields
    // into the modern parameter object.
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Stream progress
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });

    return {
      content: [{ type: "text", text: "Done" }],
      details: { result: "..." },
    };
  },

  // Optional: Custom rendering
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
});
```

Stop promptly when `signal` aborts because the user interrupted the turn or the session is stopping. A call that has not returned 10 seconds after the abort (`ATOMIC_TOOL_ABORT_GRACE_MS`) receives an `Operation aborted` error result so the turn can finish and later tool calls stop waiting. Its late return value or error is discarded rather than added to the transcript or sent to the model. A call still waiting for an earlier call when the turn is interrupted never starts and gets `Operation aborted` immediately.

### atomic.sendMessage(message, options?)

Inject a custom message into the session. The call returns `void | Promise<void>` for compatibility with synchronous hosts; use `await Promise.resolve(atomic.sendMessage(...))` when admission or routing failure must be observed. Atomic's `AgentSession` runtime returns an admission receipt that settles once the message enters the local queue, without waiting for the resulting model turn to finish.

```typescript
atomic.sendMessage({
  customType: "my-extension",
  content: "Message text",
  display: true,
  details: { ... },
}, {
  triggerTurn: true,
  deliverAs: "steer",
});
```

`display: true` shows the message in the chat; `false`, or omitting `display`, keeps it out of the chat. `customType` must be a string and `content` a string or an array of content blocks; otherwise the call throws a `TypeError` and saves nothing.

Options:

- `deliverAs`. Delivery mode:
  - `"steer"` (default). Queues the message while streaming and delivers it after the current assistant turn finishes its tool calls, before the next LLM call.
  - `"followUp"`. Waits for the agent to finish all tool calls before delivering.
  - `"nextTurn"`. Queues for the next user prompt without interrupting or triggering a turn.
  - `"interrupt"`. With `triggerTurn: true`, aborts an active streaming turn and immediately starts a new turn with the custom message. When idle, behaves like a triggered custom message.
- `triggerTurn: true`. If the agent is idle, triggers an LLM response immediately. Required for `"interrupt"`; ignored for `"nextTurn"`.
- `excludeFromContext: true`. Renders and persists the custom message without adding it to LLM context. With no `deliverAs`, remains display-only even while the agent is streaming.
- `interruptAbortMessage`. Optional text replacing generic abort results (such as `Operation aborted`) when `deliverAs: "interrupt"` aborts an active turn.

A command can answer with `sendMessage()`, `sendMessages()`, or `sendUserMessage()` without awaiting it. In print mode (`-p`) and JSON event stream mode, Atomic waits for messages sent before the command handler returns and for the turns they start before printing the result or running the next prompt. Messages sent later from a timer or background task are not waited for. With text output (`-p` without `--mode json`), a command whose messages could not be saved and that sent nothing else prints nothing and exits with status `1`.

### atomic.sendMessages(messages, options?)

Atomically admit a batch of custom messages in array order. The call returns `void | Promise<void>` for compatibility with synchronous hosts; use `await Promise.resolve(atomic.sendMessages(...))` when admission or routing failure must be observed. The promise is an admission receipt and does not wait for the resulting model turn. Admission is indivisible, which keeps a prelude and terminal notice contiguous without globally serializing other extension work.

```typescript
atomic.sendMessages([
  { customType: "worker-update", content: "Ready", display: true },
  { customType: "worker-terminal", content: "Completed", display: true },
], { triggerTurn: true });
```

The batch supports `triggerTurn`, `excludeFromContext`, and `deliverAs: "steer" | "followUp" | "nextTurn"`. Interrupt delivery remains a single-message operation. Each message follows the `atomic.sendMessage()` rules; if any message breaks them, the call throws a `TypeError` and none are sent.

### atomic.sendUserMessage(content, options?)

Send a user message to the agent. Unlike `sendMessage()`, which sends custom messages, this sends an actual user message as if typed by the user and always triggers a turn.

```typescript
// Simple text message
atomic.sendUserMessage("What is 2+2?");

// With content array (text + images)
atomic.sendUserMessage([
  { type: "text", text: "Describe this image:" },
  { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } },
]);

// During streaming: specify delivery mode
atomic.sendUserMessage("Focus on error handling", { deliverAs: "steer" });
atomic.sendUserMessage("And then summarize", { deliverAs: "followUp" });

// Opt in to extension command dispatch and skill/prompt template expansion
atomic.sendUserMessage("/review src/index.ts", { expandPromptTemplates: true });
```

Options:

- `deliverAs`. Required when the agent is streaming:
  - `"steer"`. Queues the message for delivery after the current assistant turn finishes its tool calls.
  - `"followUp"`. Waits for the agent to finish all tools.
- `expandPromptTemplates`. Dispatches extension commands and expands skill commands and prompt templates instead of sending the text literally. Defaults to `false`, so an extension-authored message is sent as-is unless it opts in. An unknown command falls through to a literal send.

When idle, the message is sent immediately and triggers a new turn. When streaming without `deliverAs`, the call throws an error. While the session compacts, the message waits, shows as queued, and sends once compaction ends, after messages sent before it; if one of those has already started a turn, a message without `deliverAs` queues behind it as steering.

See [send-user-message.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/send-user-message.ts) for a complete example.

### atomic.appendEntry(customType, data?)

Persist extension state (does NOT participate in LLM context). `customType` must be a string; otherwise the returned promise rejects with a `TypeError` and nothing is saved.

```typescript
await atomic.appendEntry("my-state", { count: 42 });

// Restore on reload
atomic.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // Reconstruct from entry.data
    }
  }
});
```

Await `atomic.appendEntry` before using the new entry. The promise resolves after the write commits and rejects with the store's typed error if it fails. Setup entries also commit before the promise resolves. Appending emits `entry_appended` with the committed entry. This lets extensions react to session entries without polling.

During a transactional reload's `session_start` handler, `atomic.appendEntry`, `atomic.setSessionName`, and `atomic.setLabel` stage their writes instead. Awaiting them confirms staging; the writes and their notifications are published in call order only after reload succeeds. Rejected reloads discard these changes. Do not depend on reading the staged changes back during that handler.

### atomic.registerEntryRenderer(customType, renderer)

Register a TUI renderer for durable custom entries created by `atomic.appendEntry()`. These entries render in the transcript but do not enter model context. Ctrl+O, or a click on the entry in fullscreen mode, toggles `expanded`.

SDK hosts can inspect the original callback with `session.extensionRunner.getEntryRenderer(customType)`. To render through the owning session, call `session.extensionRunner.renderEntry(customType, entry, { expanded }, theme)`; retired runners reject rendering.

```typescript
import { Text } from "@bastani/atomic-tui";

atomic.registerEntryRenderer("status-card", (entry, { expanded }, theme) =>
  new Text(theme.fg("accent", `${expanded ? "Details" : "Status"}: ${JSON.stringify(entry.data)}`), 0, 0)
);
```


### atomic.setSessionName(name)

Set the session display name (shown in session selector instead of first message).

```typescript
await atomic.setSessionName("Refactor auth module");
```

### atomic.getSessionName()

Get the current session name, if set.

```typescript
const name = atomic.getSessionName();
if (name) {
  console.log(`Session: ${name}`);
}
```

### atomic.setLabel(entryId, label)

Set or clear a label on an entry. Labels are user-defined markers for bookmarking and navigation (shown in `/tree` selector). A label is a string, or `undefined` to clear it; any other value rejects with a `TypeError`.

```typescript
// Set a label
await atomic.setLabel(entryId, "checkpoint-before-refactor");

// Clear a label
await atomic.setLabel(entryId, undefined);

// Read labels via sessionManager
const label = ctx.sessionManager.getLabel(entryId);
```

Labels persist in the session and survive restarts. Use them to mark important points (turns, checkpoints) in the conversation tree.

### atomic.registerCommand(name, options)

Register a command.

If multiple extensions register the same command name, Atomic keeps them all and assigns numeric invocation suffixes in load order, for example `/review:1` and `/review:2`.

```typescript
atomic.registerCommand("stats", {
  description: "Show session statistics",
  handler: async (args, ctx) => {
    const count = ctx.sessionManager.getEntries().length;
    ctx.ui.notify(`${count} entries`, "info");
  }
});
```

Optional: add argument auto-completion for `/command ...`:

```typescript
import type { AutocompleteItem } from "@bastani/atomic-tui";

atomic.registerCommand("deploy", {
  description: "Deploy to an environment",
  getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
    const envs = ["dev", "staging", "prod"];
    const items = envs.map((e) => ({ value: e, label: e }));
    const filtered = items.filter((i) => i.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  },
  handler: async (args, ctx) => {
    ctx.ui.notify(`Deploying: ${args}`, "info");
  },
});
```

### atomic.getCommands()

Get the slash commands available for invocation via `prompt` in the current session. Includes extension commands, prompt templates, and skill commands.
The list matches the RPC `get_commands` ordering: extensions first, then templates, then skills.

```typescript
const commands = atomic.getCommands();
const bySource = commands.filter((command) => command.source === "extension");
const userScoped = commands.filter((command) => command.sourceInfo.scope === "user");
```

Each entry has this shape:

```typescript
{
  name: string; // Invokable command name without the leading slash. May be suffixed like "review:1"
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}
```

Use `sourceInfo` as the canonical provenance field. Do not infer ownership from command names or from ad hoc path parsing.

Built-in interactive commands (like `/model` and `/settings`) are not included here. They are handled only in interactive
mode and would not execute if sent via `prompt`.

### atomic.registerMessageRenderer(customType, renderer)

Register a custom TUI renderer for messages with your `customType`. The renderer options contain `expanded` and the current numeric `outputPad`, so custom output can align with built-in messages. The same options are provided in normal and isolated-engine rendering. A click on the message in fullscreen mode toggles `expanded` when that changes what the renderer draws, unless its in-process component handles the click itself. See [Custom UI](/extensions/ui#custom-ui).

### atomic.registerToolRenderer(resolver)

Register a resolver `(toolName, next) => renderers` that supplies `renderCall` and `renderResult` (and optional `renderShell`) for any tool in the interactive transcript and HTML exports, including MCP tools in resumed sessions before their server connects.

Resolvers run in extension load order. Calling `next()` returns the remaining resolvers' choice and then the registered tool's own renderers, so `next() ?? myRenderers` fills in only when no renderer exists. Extension `Image` components returned by tool renderers also display JPEG, GIF, and WebP images automatically on Kitty-protocol terminals. See [Custom rendering](/extensions/authoring#custom-rendering).

### atomic.registerMarkdownTransformer(transformer)

Register a synchronous, display-only transformer for Markdown before Atomic renders it in interactive mode. Atomic runs transformers in extension load order. Each extension keeps one transformer, so a later call from the same extension replaces its earlier transformer. Each transformer receives the Markdown returned by the previous one, and Atomic renders the final value with its built-in Markdown renderer.

The optional second argument, `atomic.registerMarkdownTransformer(transformer, options)`, accepts `options.messageTypes`. By default a transformer runs on normal user text, assistant text, and thinking blocks; `messageTypes` lists the message kinds it runs on instead:

| `messageType` | Rendered content |
| --- | --- |
| `"user"`, `"assistant"`, `"assistant-thinking"` | Transcript messages (default) |
| `"custom"` | Custom messages from `atomic.sendMessage()` without a registered message renderer, and expanded skill blocks (their content, without Atomic's header) |
| `"summary"` | Expanded branch summaries (the summary, without Atomic's header) |
| `"changelog"` | Atomic's changelog ("What's New" at startup and `/changelog`) |

The transformer receives the Markdown string and a context object:

- `messageType`. One of the rendered content kinds above.
- `isStreaming`. `true` for partial assistant updates; `false` otherwise.
- `availableWidth`. Exact terminal columns available for the transformed Markdown content.
- `messageId`. The session entry ID when rendering from the saved session (resume, `/tree`, or rebuilds); `undefined` for live messages and the changelog.
- `timestamp`. The session entry's ISO timestamp under the same conditions; `undefined` for live messages and the changelog.

Return the transformed Markdown:

```typescript
atomic.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
  if (isStreaming || messageType === "assistant-thinking") return markdown;
  return markdown.replaceAll("-->", "→");
});

// Show :warning: shortcodes in the changelog as a symbol.
atomic.registerMarkdownTransformer((markdown) => markdown.replaceAll(":warning:", "⚠"), {
  messageTypes: ["changelog"],
});
```

If a transformer throws, Atomic keeps the Markdown produced so far and continues with the next transformer. The hook never changes the original message, session transcript, or model context. It runs for new messages, assistant streaming updates, restored session messages, and terminal-width changes, so keep transformers synchronous and fast. Isolated-engine rendering does not run host-side display transformers.

### atomic.registerShortcut(shortcut, options)

Register a keyboard shortcut. See [Keybindings](/keybindings) for the shortcut format and built-in keybindings.

```typescript
atomic.registerShortcut("ctrl+shift+p", {
  description: "Toggle plan mode",
  handler: async (ctx) => {
    ctx.ui.notify("Toggled!");
  },
});
```

Set `preferEditor: true` to skip a shortcut when another resolved editor binding uses that key. Omitting it preserves the usual extension conflict policy. Optional `keybinding` selects the keys for an existing named action from `keybindings.json` instead of the literal registration key; an empty action binding disables it.

### atomic.registerFlag(name, options)

Register a CLI flag.

```typescript
atomic.registerFlag("plan", {
  description: "Start in plan mode",
  type: "boolean",
  default: false,
});

// Check value
if (atomic.getFlag("plan")) {
  // Plan mode enabled
}
```

### atomic.registerAgentPanelSource(source)

Add rows to the [agent panel](/background-tasks#the-agent-panel) below the prompt and to `/tasks`. The registration is released with the extension generation, and `/reload` re-registers it.

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

Here `showDeploy` stands for your extension's own view of an item. `items()` synchronously returns the source's current `AgentPanelItem`s. Call the `subscribe` listener whenever they may have changed; the host reads `items()` again and repaints. Apply pending changes before taking the snapshot `items()` returns, or notify after returning; a listener call made while `items()` runs is honoured once.

Keep `items()` and subscription callbacks short and synchronous. Compute `elapsedMs` when `items()` is called; Atomic advances a running row from that read until the next one and uses the reported value when it pauses or finishes. Publish a new change notification when that state changes.

Return at most 10,000 rows per source. Atomic ignores additional rows and warns once per registration. A row with more than 128 choices is hidden; keep longer lists in the view opened by `open()`. Each item has:

| Field | Meaning |
| --- | --- |
| `id` | Unique in the session. Prefix it with your source's name, for example `deploys:42`; `main` and the `task:` prefix are reserved. |
| `kind` | `"agent"` or `"shell"`. It decides the row's layout. A `"shell"` item is listed in `/tasks` only; the main chat's footer counts it while it is not finished. |
| `state` | `running`, `queued`, `input` (waits for an answer), `paused`, `stopping`, `waiting` (not working, and wakes by itself when what it waits on finishes), `done`, `failed` or `stopped`. It decides the glyph, the state word, the `/tasks` group and whether `x` stops or dismisses. |
| `name`, `task` | The name and what it works on, for example `stage build`. |
| `model`, `thinking` | Optional: the model the item runs on now, as `provider/model-id`, and its reasoning level, shown after its name as for a subagent. Leave `thinking` out for a model without reasoning levels. Update them when the item switches model. A value that is not a string is ignored. |
| `elapsedMs`, `tokens` | Shown on the right. `elapsedMs` is finite, non-negative milliseconds. `tokens` is a non-negative safe integer, at most `Number.MAX_SAFE_INTEGER`. Between your updates, the panel and `/tasks` share the advancing time of running, waiting and stopping items. Paused and finished items keep their last elapsed time. |
| `progress` | Finite, non-negative `{ done, total }` stages, drawn as a bar. |
| `question`, `choices` | What an `input` item asks, and its numbered choices. |
| `promptId` | Optional opaque identity of that pending question. Change it for each new question, even when its text and choices repeat. |
| `reason` | A failed item's one-line reason. |
| `waitingOn` | What a `waiting` item waits on, shown as `waiting on <waitingOn>`. |
| `queued` | Messages typed to it that it has not taken yet. A non-negative safe integer. |
| `endedAt` | When a finished item finished, in finite, non-negative epoch milliseconds. |
| `runGeneration` | Optional opaque identity of the item's latest run. Use a per-item counter rather than a timestamp: two attempts can start in the same millisecond. Advance it whenever the item runs again (resumed, woken or sent a follow-up), not when the source republishes the same attempt. A `stopped` or `paused` row that left the panel is listed again while other work runs once this changes, even if it ran only briefly between two updates. Without it, such a row comes back only after the panel has seen it in another state. |

Atomic strips terminal control sequences from the text fields before drawing them. An item with invalid fields is skipped, and `items()` or `subscribe` throwing is reported as an extension error. The source's other items, and the other sources, are still shown.

The actions are optional:

- `open(id, options)` runs on Enter or Right on the row. Return `false` (or throw) when the item cannot be opened; `/tasks` stays open and shows `Could not open <name>`, and the focused agent panel reports the same warning. A failed open does not mark the item viewed, and a throw is also reported as an extension error. When your view returns one level, call `options.onReturn()` so the panel or `/tasks` appears again.
- `stop(id)` runs on the second `x` for an unfinished item. Finished items are dismissed by the host without calling your source.
- `answer(id, text, options)` delivers a reply typed in an `input` item's `/tasks` peek card. Offer `question` and `answer` only for questions that typed text can answer. `options` carries the `promptId`, `question`, and `choices` shown when the reply started, plus a zero-based `choiceIndex` for numbered choices. Use `choiceIndex` after checking prompt identity and bounds rather than matching display labels, which may lose terminal controls or share text. An empty draft follows a newly shown question, whereas a nonempty draft keeps its original identity even after closing and reopening the card. Compare `options.promptId` against the current pending question and return `{ ok: false, reason }` when they differ so an earlier reply cannot answer a replacement question.

`stop` and `answer` resolve to `{ ok: true }`, or `{ ok: false, reason }` to show `reason` to the user.

The exported types from `@bastani/atomic` are `AgentPanelSource`, `AgentPanelItem`, `AgentPanelState`, `AgentPanelActionResult`, `AgentPanelOpenOptions`, `AgentPanelAnswerOptions`, `AgentPanelSourceRegistration`, and `AgentPanelSession`.

The same rows are also available outside extensions: `agentPanelItems(session)` returns the session's tasks and every source's items; `subscribeAgentPanel(session, listener)` notifies on any change (including after reload); `openAgentPanelItem`, `stopAgentPanelItem`, and `answerAgentPanelItem` run actions by item ID; `dismissedAgentPanelItems(session)` returns dismissed IDs; and `agentPanelTaskId(id)` returns the task ID of a `task:` item. Obtain the item from `agentPanelItems(session)` before acting on it, and pass the question's captured `AgentPanelAnswerOptions` to `answerAgentPanelItem()`.

### atomic.exec(command, args, options?)

Execute a command without a shell.

```typescript
const result = await atomic.exec("git", ["status"], { signal, timeout: 5000 });
// result.stdout, result.stderr, result.code, result.killed, result.truncated
```

On Windows, a bare `command` without a path (such as `git`) runs only from absolute directories on `PATH`, never from the working directory or Atomic's own directory, so a project folder cannot shadow it. A `command` with a path (such as `.\tools\build.exe`) runs as written.

Options include `signal`, `timeout`, `cwd`, and `maxBuffer` (default 256 MiB for combined stdout and stderr). Exceeding `maxBuffer` terminates the command and returns the output captured so far with `truncated: true`, `killed: true`, and a nonzero `code`. `killed` is `true` whenever Atomic terminates the command (timeout, abort, `maxBuffer`, or quitting the interactive app). A command terminated by a signal reports `128 + signal` as `code`, matching shell conventions (`143` for `SIGTERM`, `137` for `SIGKILL`).

Process-tree termination rules:

- **Timeout, abort, or `maxBuffer`.** Atomic terminates the command and child processes it started. On Linux and macOS, the command and its process group receive `SIGTERM`, followed by `SIGKILL` 5 seconds later; processes that started their own session (`setsid`) keep running. On Windows, descendant processes end immediately before the command itself (descendants whose parent already exited cannot be found).
- **Quitting the interactive app.** Running commands and their process groups receive `SIGTERM` followed by `SIGKILL` after 1 second (immediate termination on Windows) so they cannot delay `session_shutdown` handlers. Commands started inside a `session_shutdown` handler are not terminated this way. Print mode and SDK `dispose()` wait for running commands instead.
- **Forced exit (`SIGKILL` to Atomic).** The interactive engine kills running commands and their process groups with `SIGKILL`. On Linux, the OS also ends direct child commands (though not their descendants) when the owning Atomic process exits. On macOS, a command running in Atomic's own process keeps running. On Windows, the command ends with Atomic, while its children keep running unless the command placed them in its own job object (as Node.js commands do).

### atomic.getActiveTools() / atomic.getAllTools() / atomic.setActiveTools(names)

Manage active tools. This works for both built-in tools and dynamically registered tools. `atomic.getActiveTools()` returns the active tool names as `string[]`; `atomic.getAllTools()` returns metadata for all configured tools.

```typescript
const active = atomic.getActiveTools(); // ["read", "bash", ...]
const all = atomic.getAllTools();
// all = [{
//   name: "read",
//   description: "Read file contents...",
//   parameters: ...,
//   promptGuidelines: ["Use read to examine files instead of cat or sed."],
//   sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" }
// }, ...]
const builtinTools = all.filter((t) => t.sourceInfo.source === "builtin");
const extensionTools = all.filter((t) => t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk");
atomic.setActiveTools([...new Set([...active, "my_custom_tool"])]); // Keep current tools and enable my_custom_tool
atomic.setActiveTools(["read", "bash"]); // Switch to read-only
```

`atomic.getAllTools()` returns `name`, `description`, `parameters`, `promptGuidelines`, `exposure`, `namespace`, `annotations`, and `sourceInfo`. `explicitDefaultOptOut: true` means a `-name` modifier explicitly removed that tool from the defaults; respect it when considering automatic activation. See [tool exposure](/extensions/authoring#tool-exposure) before changing activation for script-callable tools.

Typical `sourceInfo.source` values:
- `builtin` for built-in tools
- `sdk` for tools passed via `createAgentSession({ customTools })`
- extension source metadata for tools registered by extensions

### atomic.setModel(model)

Set the model for the current session. The change is recorded in session history and restored when that session is resumed, but it does not change the configured `defaultProvider` or `defaultModel` used by new sessions. Returns `false` if authentication is not configured for the model's provider. See [Custom models](/models) for configuring custom models.

```typescript
const model = ctx.modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (model) {
  const success = await atomic.setModel(model);
  if (!success) {
    ctx.ui.notify("No API key for this model", "error");
  }
}
```

### atomic.getThinkingLevel() / atomic.setThinkingLevel(level)

Get the current thinking level. Level is clamped to model capabilities (non-reasoning models always use `"off"`; `"xhigh"` and `"max"` require model support). Changes emit `thinking_level_select`.

`atomic.setThinkingLevel()` changes the thinking level for the current session. The change is recorded in session history and restored when that session is resumed, but it does not change the configured default used by new sessions.

```typescript
const current = atomic.getThinkingLevel();  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
await atomic.setThinkingLevel("high");
```

### atomic.events

Shared event bus for communication between active extensions. A subscription made with `on()` is removed automatically when its extension reloads or the session disposes. Use the returned function if you need to stop listening sooner:

```typescript
const unsubscribe = atomic.events.on("my:event", (data) => { ... });
atomic.events.emit("my:event", { ... });
unsubscribe();
```

`atomic.events` belongs to the extension instance that received it. Register listeners again when that instance reloads, and do not retain the object for later use: calling `on()` or `emit()` through a captured handle after reload or disposal throws. To keep in-memory state across `/reload`, pass this facade to [`sessionScopedExtensionState`](/extensions/authoring#session-scoped-in-memory-state); do not capture the facade itself.

If you implement an `ExtensionRuntime` for an embedded host, provide `trackEventBusSubscription(unsubscribe)` and retain each returned subscription until that extension runtime is reloaded or disposed. `ExtensionUIContext.getChatRenderSettings()` must return `markdownTransformers`; it may also return `renderLatex` to control terminal math rendering, and `fullscreenScrollbar` and `fullscreenWheelScrollLines` for transcripts that an overlay scrolls itself. These fields keep event subscriptions and display transforms scoped to the active extension instance.


### Native providers

In addition to `registerProvider(name, config)`, extensions can register a complete native `Provider` from `@bastani/atomic-ai` with `atomic.registerProvider(provider)`. Use the native overload for provider-owned authentication, catalog refresh, and transport behavior; use the config overload for ordinary proxies and custom endpoints.

### atomic.registerProvider(name, config)

Register or override a model provider dynamically. Await registration, aliases, and removal before starting dependent work. Use this for proxies, custom endpoints, or team-wide model configurations.

Calls made during the extension factory function are queued and applied once the runner initializes. Calls made afterward (for example from a command handler after a setup flow) take effect immediately without `/reload`.

If you need to discover models from a remote endpoint, prefer an async extension factory over deferring the fetch to `session_start`. Atomic waits for the factory before startup continues, so the registered models are available immediately, including to `atomic --list-models`.

```typescript
// Register a new provider with custom models
await atomic.registerProvider("my-proxy", {
  name: "My Proxy",
  baseUrl: "https://proxy.example.com",
  apiKey: "$PROXY_API_KEY",  // env var reference; omit $ for a literal
  api: "anthropic-messages",
  models: [
    {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5 (proxy)",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});

// Override baseUrl for an existing provider (keeps all models)
await atomic.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// Register provider with OAuth support for /login
await atomic.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com",
  api: "openai-responses",
  models: [...],
  oauth: {
    name: "Corporate AI (SSO)",
    async login(callbacks, signal) {
      // Custom OAuth flow
      callbacks.onAuth({ url: "https://sso.corp.com/..." });
      const code = await callbacks.onPrompt({ message: "Enter code:" });
      signal.throwIfAborted();
      return { refresh: code, access: code, expires: Date.now() + 3600000 };
    },
    async refreshToken(credentials, signal) {
      // Pass `signal` through, but add no timeout or abort of your own (see below).
      return refreshCorporateToken(credentials.refresh, { signal });
    },
    getApiKey(credentials) {
      return credentials.access;
    }
  }
});

// Register provider-owned API-key setup for /login
await atomic.registerProvider("local-server", {
  name: "Local Server",
  auth: {
    apiKey: {
      name: "Local server connection",
      async login({ signal, prompt }) {
        const baseUrl = await prompt({
          type: "text",
          message: "Server URL",
          placeholder: "http://localhost:9931"
        });
        if (signal.aborted) throw new Error("Login cancelled");
        return { type: "api_key", env: { LOCAL_SERVER_URL: baseUrl } };
      }
    }
  }
});
```

OAuth `refreshToken` receives a signal that Atomic does not abort on a timeout because the provider may have already rotated the refresh token once the request is sent. The caller stops waiting after 60 seconds, while the exchange keeps running and saves its result when it arrives.

On normal exit, Atomic waits up to 3 seconds for an exchange still in flight, and cancelling a request or model refresh stops only that caller's wait. Do not add your own timeout or abort to the token request, and do not send the same refresh token twice after the provider may have received it. Always return the rotated credentials even if the initiating caller stopped waiting.

Config options:

- `name`. Display name for the provider in UI such as `/login`.
- `baseUrl`. API endpoint URL. Required when defining models.
- `apiKey`. API key literal or explicit environment variable reference (`$ENV_VAR` or `${ENV_VAR}`). Required when defining models unless `oauth` is provided.
- `api`. API type such as `"anthropic-messages"`, `"openai-completions"`, or `"openai-responses"`.
- `headers`. Custom headers to include in requests.
- `authHeader`. When `true`, adds an `Authorization: Bearer` header automatically.
- `models`. Array of model definitions; replaces all existing models for this provider. Individual model definitions can set `baseUrl` to override the provider endpoint.
- `oauth`. OAuth provider config for `/login` support.
- `auth.apiKey`. Provider-owned API-key or connection setup for `/login`. Its `name` appears in the provider list, and `login({ signal, prompt })` returns the credential Atomic persists. Providers registered in the isolated interactive engine child sync into the host's `/login` list; their callbacks run in the child while prompts render in the terminal host.
- `streamSimple`. Custom streaming implementation for non-standard APIs.

See [Custom providers](/custom-provider) for custom streaming APIs, OAuth details, and the model definition reference.

### atomic.unregisterProvider(name)

Remove a previously registered provider and its models. Built-in models that were overridden by the provider are restored. Calling this for an unregistered name is a no-op.

Like `registerProvider`, this takes effect immediately after the initial load phase without requiring `/reload`.

```typescript
atomic.registerCommand("my-setup-teardown", {
  description: "Remove the custom proxy provider",
  handler: async (_args, _ctx) => {
    await atomic.unregisterProvider("my-proxy");
  },
});
```

### atomic.registerMcpServer(name, config)

Contribute an MCP server whose configuration is computed at runtime, such as the URL of a local service the extension starts. `config` uses the same schema as an entry in [`mcp.json`](/mcp-servers#configure-servers), including `url`, `command`, `args`, `env`, `cwd`, `headers`, OAuth settings, `exposure`, and per-request `timeout` in seconds. URLs support `${VAR}` and `$env:VAR` interpolation.

```typescript
export default function (atomic: ExtensionAPI) {
  atomic.on("session_start", async () => {
    const port = await startLocalService();
    atomic.registerMcpServer("local-service", { url: `http://127.0.0.1:${port}/mcp`, exposure: "direct" });
  });
}
```

Call `atomic.registerMcpServer()` from the extension factory or from `session_start`. Load order does not matter: registrations made after the MCP adapter has started connect without a reload, and registering the same name again replaces the earlier registration.

Registered servers connect like file-configured servers and appear in `/mcp` with the registering extension as their source. They replace a same-named server from a package manifest, while user or trusted-project `mcp.json` entries take precedence over them. Set `"enabled": false` on a complete file-configured entry to keep it without connecting.

Enabled-state and exposure changes to extension-registered servers apply only to the current session and are not saved to `mcp.json`. Shell `atomic mcp` commands do not load extensions. Provider-token authentication (`auth.provider`) is allowed for extension registrations and global configuration, not project configuration or package manifests.

`atomic.getMcpServerContributions()` returns the package-manifest and registered servers for the session, each with its `name`, `config`, `origin` (`"package"` or `"extension"`), and `sourceInfo`.

## Error handling

- Extension errors are logged and the agent continues.
- In the interactive terminal, a `session_start` or `resources_discover` handler that throws during startup, `-c` or `--resume`, `/new`, `/resume`, `/fork`, or `/reload` is shown once with the extension's path and error, and the session keeps working. The extension stays loaded, so its commands, tools, and other handlers still run. Print mode (`-p`), standalone RPC mode (`--mode rpc`), and SDK sessions instead fail startup with `ExtensionStartupError`, which names each failing extension.
- `tool_call` errors block the tool (fail-safe).
- Tool `execute` errors must be signaled by throwing; Atomic catches the error, reports it to the LLM with `isError: true`, and continues execution.

### Typed errors from built-in tools and providers

These classes are exported from `@bastani/atomic`. Branch on the class, its guard, or `code`, not on `message`. Each error has `hint` (what to do next), `retryable`, and `toJSON()`, which returns `{ name, code, message, hint, retryable, fields, cause }` for relaying across a process boundary.

Use `rehydrateShellToolError()` and `rehydrateLlamaServerError()` to rebuild the same class on the receiving side. Type guards (`isShellTimeoutError()`, `isLlamaServerError()`, and related guards) accept relayed errors directly. User names and passwords in URLs are stripped from `detail`, `message`, and serialized causes. `isRetryableLlamaServerError()` checks retryability by `code` through the error and its cause chain, including relayed errors.

| Class | `code` | When | Fields | What to do |
| --- | --- | --- | --- | --- |
| `ShellTimeoutError` (family `ShellToolError`) | `shell-timeout` | The local shell backend of `createLocalBashOperations()` hit the command's timeout. `phase` is `draining-output` when the shell had already exited and background processes it started kept output open; `shellExit` then holds the shell's exit code. | `timeoutMs`, `elapsedMs`, `phase`, `shellExit` | Redirect background output or raise `timeout`. Its `message` stays `timeout:<seconds>`, matching custom `BashOperations`. |
| `LlamaServerUnreachableError` (family `LlamaServerError`) | `server-unreachable` | A `llama.cpp` router request failed before the server answered (connection refused, nothing listening on the port, DNS failure, or `https` against a plain-HTTP server). Cancellation and the request timeout are rethrown unchanged. | `serverUrl` (without user information), `detail` (the network-level reason) | Start `llama serve`, or fix the URL with `/login llama.cpp` or `LLAMA_BASE_URL`. `retryable` is `true`. |
| `LlamaServerRequestError` (family `LlamaServerError`) | `request-rejected` | The runtime refused to send a `llama.cpp` router request, so the server was never contacted (for example Node's `fetch` rejecting a URL with credentials or a blocked port such as `6000`). | `serverUrl` (without user information), `detail` (the runtime's reason, URL credentials removed) | Use a plain `http` or `https` URL without credentials (pass an API key separately) on a port `fetch` allows. `retryable` is `false`. |
