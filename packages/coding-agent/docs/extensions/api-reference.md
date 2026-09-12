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

### ctx.cwd

Current working directory.

Built-in cwd-sensitive tools (`read`, `write`, `edit`, `search`, `find`, `ls`, `bash`, `powershell`) resolve relative paths against `ctx.cwd` when an extension invokes them, falling back to the cwd captured when the tool was created. An extension that registers a tool and forwards its own context therefore gets paths resolved against the live session cwd rather than a stale one.

Use `CONFIG_DIR_NAME` instead of hardcoding `.atomic` (or legacy `.pi`) when constructing project-local config paths. Rebranded distributions can use a different config directory name.

```typescript
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@bastani/atomic";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "my-extension.json");
    // ...
  });
}
```

### ctx.isProjectTrusted()

Returns whether project-local trust is active for the current session context. This includes temporary trust decisions and CLI trust overrides, not just saved decisions in the global trust store.

Use this before reading project-local extension configuration that should only be honored for trusted projects.


### ctx.sessionManager

Read-only access to session state. See [Session Format](/session-format) for the full SessionManager API and entry types.

For `tool_call`, this state is synchronized through the current assistant message before handlers run. In parallel tool execution mode it is still not guaranteed to include sibling tool results from the same assistant message.

```typescript
ctx.sessionManager.getEntries()       // All entries
ctx.sessionManager.getBranch()        // Current branch
ctx.sessionManager.getLeafId()        // Current leaf entry ID
```

### ctx.modelRegistry / ctx.model / ctx.scopedModels

Access models, auth state, and provider-aware requests.

Use `ctx.modelRegistry.complete()` for an extension model request that must use Atomic's provider composition. It dispatches through the active `ModelRuntime`, retaining registered custom providers and resolved request auth: the credential-specific `baseUrl`, headers (including `null` suppression markers), and environment values.

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

Use `getApiKeyAndHeaders()` only when an extension must inspect auth before dispatch; normal requests do not need to resolve or overlay auth themselves.

OpenRouter Chat Completions and Anthropic Messages requests send `x-session-id` by default when `sessionId` is supplied and prompt caching is enabled. Set the model's `compat.sendSessionAffinityHeaders` to `false` to opt out, or set `cacheRetention: "none"` on the request to disable cache-related affinity. Explicit request headers override generated headers.

`await ctx.modelRegistry.refresh(options)` returns `{ aborted, errors }`, not just completion. `errors` is a per-provider map, so extensions can report partial refresh failures; `aborted` reports cancellation. Host integrations that call `ModelRuntime.setRuntimeApiKey(providerId, apiKey, options)` must note that it records the runtime credential but does not refresh the catalog; call `refresh({ providers: [providerId], signal })` explicitly when a fresh catalog is needed.

`ctx.scopedModels` is the read-only list of models scoped to the current session — the same set the `/scoped-models` command shows. It is resolved from the `--models` CLI flag and the `enabledModels` setting, matched against the available catalogue. It is empty when no scoping is configured, meaning every available model is usable. Each entry is `{ model, thinkingLevel? }`, where `thinkingLevel` is set only when a pattern pinned it (for example `anthropic/*:high`). Use it to populate a model picker that mirrors the built-in one instead of enumerating the whole catalogue.

The value is resolved at access time, so it tracks session replacement. Under the isolated interactive engine it reflects the engine's catalogue rather than a stale host snapshot.

It reports the scope and cannot change it. `ctx.scopedModels` is a getter with no setter, typed `readonly ScopedModel[]`, so assigning to it or pushing an entry is a compile error. The guarantee also holds at runtime, where the type does not reach: each read returns a fresh copy — of the array, of every `{ model, thinkingLevel }` entry in it, and of each entry's model — and all three are frozen. A JavaScript extension, or one that asserts the `readonly` away, therefore cannot widen the set of models the session may use by pushing an entry, nor change which model it selects by swapping one in place; the attempt throws rather than quietly working. Read it, and change scope through the commands and settings that own it.

```typescript
for (const { model, thinkingLevel } of ctx.scopedModels) {
  console.log(`${model.provider}/${model.id}${thinkingLevel ? `:${thinkingLevel}` : ""}`);
}
```

Both types are exported: `ScopedModel` for one entry, `ExtensionScopedModels` for the accessor's own type. They are declared at the public extension type path (`core/extensions/types.ts`) and re-exported from the package root, so an extension never reaches into an internal module to describe what it just read.

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
pi.on("tool_result", async (event, ctx) => {
  const response = await fetch("https://example.com/api", {
    method: "POST",
    body: JSON.stringify(event),
    signal: ctx.signal,
  });

  const data = await response.json();
  return { details: data };
});
```

### ctx.isIdle() / ctx.abort() / ctx.hasPendingMessages()

Control flow helpers.

### ctx.isProjectTrusted()

Returns whether project-local trust is active for the current extension context. Use this before reading project-local config, loading project-local resources, or exposing actions that should only run after the user has trusted the cwd.

```typescript
pi.registerCommand("project-status", {
  description: "Show trust state",
  handler: async (_args, ctx) => {
    ctx.ui.notify(ctx.isProjectTrusted() ? "Project is trusted" : "Project is not trusted", "info");
  },
});
```

### ctx.shutdown()

Request a graceful shutdown of Atomic.

- **Interactive mode:** Deferred until the agent becomes idle (after processing all queued steering and follow-up messages).
- **RPC mode:** Deferred until the next idle state (after completing the current command response, when waiting for the next command).
- **Print mode:** No-op. The process exits automatically when all prompts are processed.

Emits `session_shutdown` event to all extensions before exiting. Available in all contexts (event handlers, tools, commands, shortcuts).

```typescript
pi.on("tool_call", (event, ctx) => {
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

Trigger Atomic's verbatim line compactor without awaiting completion. The planner emits numbered deleted-line ranges only; Atomic validates them and reconstructs retained text mechanically. Use `compression_ratio` (fraction of compactable lines to keep), client-side `preserve_recent` (an exact context-visible message count), and `query` to tune the run, and `onComplete`/`onError` for follow-up actions.

```typescript
ctx.compact({
  compression_ratio: 0.5, // fraction of compactable lines to keep
  preserve_recent: 2,    // protect exactly the newest two context-visible messages
  query: "keep active migration details",
  onComplete: (result) => {
    ctx.ui.notify(`Compaction kept ${result.stats.linesKept}/${result.stats.linesBefore} lines`, "info");
  },
  onError: (error) => {
    ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
  },
});
```

The planner cannot author context text: only validated line ranges enter the mechanical reconstruction path. The `query` parameter guides relevance selection inside the fixed prompt; it is not replacement prose. Extensions that need an offline replacement can return `compactedText` from `session_before_compact`.

### ctx.getSystemPrompt()

Returns Atomic's current system prompt string.

- During `before_agent_start`, this reflects chained system-prompt changes made so far for the current turn.
- It does not include later `context` message mutations.
- It does not include `before_provider_request` payload rewrites.
- If later-loaded extensions run after yours, they can still change what is ultimately sent.

```typescript
pi.on("before_agent_start", (event, ctx) => {
  const prompt = ctx.getSystemPrompt();
  console.log(`System prompt length: ${prompt.length}`);
});
```

### ctx.getSkillCatalog()

Returns the current loader-owned skill catalog when the host provides one. Use it to resolve exact skill selectors, including source-qualified names such as `tdd@builtin`, without falling back to the bare precedence winner.

```typescript
pi.on("session_start", (_event, ctx) => {
  const catalog = ctx.getSkillCatalog?.();
  const resolved = catalog?.resolve("tdd@builtin");
  if (resolved?.ok) {
    ctx.ui.notify(`Using ${resolved.candidate.selector}`, "info");
  }
});
```

`pi.getCommands()` already includes the same advertised `/skill:name` and `/skill:name@source` names. See [Skill Commands](/skills#skill-commands).

## ExtensionCommandContext

Command handlers receive `ExtensionCommandContext`, which extends `ExtensionContext` with session control methods. These are only available in commands because they can deadlock if called from event handlers.

### ctx.waitForIdle()

Wait for the agent to finish streaming:

```typescript
pi.registerCommand("my-cmd", {
  handler: async (args, ctx) => {
    await ctx.waitForIdle();
    // Agent is now idle, safe to modify session
  },
});
```

### ctx.newSession(options?)

Create a new session:

```typescript
const parentSession = ctx.sessionManager.getSessionFile();
const kickoff = "Continue in the replacement session";

const result = await ctx.newSession({
  parentSession,
  setup: async (sm) => {
    sm.appendMessage({
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
- `parentSession`: parent session file to record in the new session header
- `setup`: mutate the new session's `SessionManager` before `withSession` runs
- `withSession`: run post-switch work against a fresh replacement-session context. Do not use captured old `pi` / command `ctx`; see [Session replacement lifecycle and footguns](#session-replacement-lifecycle-and-footguns).

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
- `withSession`: run post-switch work against a fresh replacement-session context. Do not use captured old `pi` / command `ctx`; see [Session replacement lifecycle and footguns](#session-replacement-lifecycle-and-footguns).

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

### ctx.switchSession(sessionPath, options?)

Switch to a different session file:

```typescript
const result = await ctx.switchSession("/path/to/session.jsonl", {
  withSession: async (ctx) => {
    await ctx.sendUserMessage("Resume work in the replacement session");
  },
});
if (result.cancelled) {
  // An extension cancelled the switch via session_before_switch
}
```

Options:
- `withSession`: run post-switch work against a fresh replacement-session context. Do not use captured old `pi` / command `ctx`; see [Session replacement lifecycle and footguns](#session-replacement-lifecycle-and-footguns).

To discover available sessions, use the static `SessionManager.list()` or `SessionManager.listAll()` methods:

```typescript
import { SessionManager } from "@bastani/atomic";

pi.registerCommand("switch", {
  description: "Switch to another session",
  handler: async (args, ctx) => {
    const sessions = await SessionManager.list(ctx.cwd);
    if (sessions.length === 0) return;
    const choice = await ctx.ui.select(
      "Pick session:",
      sessions.map(s => s.file),
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
- Captured old `pi` / old command `ctx` session-bound objects are stale after replacement and will throw if used. Use only the `ctx` passed to `withSession` for session-bound work.
- Previously extracted raw objects are still your responsibility. For example, if you capture `const sm = ctx.sessionManager` before replacement, `sm` is still the old `SessionManager` object. Do not reuse it after replacement.
- Code in `withSession` should assume any state invalidated by your `session_shutdown` handler is already gone. Only capture plain data that survives shutdown cleanly, such as strings, ids, and serialized config.
- Long-lived callbacks that need to classify a stale API error should use `isStaleExtensionContextError(error)` from `@bastani/atomic`, not match the host's error message.

Safe pattern:

```typescript
pi.registerCommand("handoff", {
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
pi.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const oldSessionManager = ctx.sessionManager;
    await ctx.newSession({
      withSession: async (_ctx) => {
        // stale old objects: do not do this
        oldSessionManager.getSessionFile();
        pi.sendUserMessage("wrong");
      },
    });
  },
});
```

### ctx.reload()

Run the same reload flow as `/reload`.

```typescript
pi.registerCommand("reload-runtime", {
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

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, and themes",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });

  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description: "Reload extensions, skills, prompts, and themes",
    parameters: Type.Object({}),
    async execute() {
      pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
      };
    },
  });
}
```

## ExtensionAPI Methods

### pi.on(event, handler)

Subscribe to events. See [Events](/extensions/events#events) for event types and return values.

### pi.registerTool(definition)

Register a custom tool callable by the LLM. See [Custom Tools](/extensions/authoring#custom-tools) for full details.

`pi.registerTool()` works both during extension load and after startup. You can call it inside `session_start`, command handlers, or other event handlers. New tools are refreshed immediately in the same session, so they appear in `pi.getAllTools()` and are callable by the LLM without `/reload`.

Use `pi.setActiveTools()` to enable or disable tools (including dynamically added tools) at runtime. Atomic always restores mandatory ordinary `intercom`; other tool behavior is unchanged.

Use `promptSnippet` to opt a custom tool into a one-line entry in `Available tools`, and `promptGuidelines` to append tool-specific bullets to the default `Guidelines` section when the tool is active.

**Important:** `promptGuidelines` bullets are appended flat to the `Guidelines` section with no tool name prefix. Each guideline must name the tool it refers to — avoid "Use this tool when..." because the LLM cannot tell which tool "this" means. Write "Use my_tool when..." instead.

See [dynamic-tools.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/dynamic-tools.ts) for a full example.

#### Built-in tool prompt contributions

Atomic exports immutable prompt metadata for its built-in coding tools. Use these constants when a custom harness or tool registry needs the same prompt entries as the built-in factories:

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

Each contribution has a readonly `snippet` for the `Available tools` section and readonly `guidelines` for the active tool's `Guidelines` entries. The seven exports are `bash`, `edit`, `find`, `ls`, `read`, `search`, and `write`; Atomic's public `search` export is the corresponding surface for pi's upstream `grep` tool. The built-in factories use these values directly, so consumers do not need to duplicate prompt text.

Use Atomic's export rather than importing `StringEnum` directly from Pi. It preserves Pi's Google-compatible runtime schema while keeping the schema typed against Atomic's direct TypeBox version.

```typescript
import { Type } from "typebox";
import { StringEnum } from "@bastani/atomic";

pi.registerTool({
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

### pi.sendMessage(message, options?)

Inject a custom message into the session. The call returns `void | Promise<void>` for compatibility with synchronous hosts; use `await Promise.resolve(pi.sendMessage(...))` when admission or routing failure must be observed. Atomic's AgentSession runtime returns an admission receipt: it settles after the message is accepted by the local queue or workflow late-message route, without waiting for the resulting model turn to finish.

```typescript
pi.sendMessage({
  customType: "my-extension",
  content: "Message text",
  display: true,
  details: { ... },
}, {
  triggerTurn: true,
  deliverAs: "steer",
});
```

**Options:**
- `deliverAs` - Delivery mode:
  - `"steer"` (default) - Queues the message while streaming. Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
  - `"followUp"` - Waits for agent to finish. Delivered only when agent has no more tool calls.
  - `"nextTurn"` - Queued for next user prompt. Does not interrupt or trigger anything.
  - `"interrupt"` - With `triggerTurn: true`, aborts an active streaming turn and immediately starts a new turn with the custom message. When idle, behaves like a triggered custom message.
- `triggerTurn: true` - If agent is idle, trigger an LLM response immediately. Required for `"interrupt"`; ignored for `"nextTurn"`.
- `excludeFromContext: true` - Render and persist the custom message without adding it to LLM context. With no `deliverAs`, this remains display-only even while the agent is streaming.
- `interruptAbortMessage` - Optional text used to replace generic abort results (for example `Operation aborted`) when `deliverAs: "interrupt"` aborts an active turn.

### pi.sendMessages(messages, options?)

Atomically admit a batch of custom messages in array order. The call returns `void | Promise<void>` for compatibility with synchronous hosts; use `await Promise.resolve(pi.sendMessages(...))` when admission or routing failure must be observed. The promise is an admission receipt and does not wait for the resulting model turn. Admission is indivisible; use this when a prelude and terminal notice must stay contiguous without globally serializing other extension work.

```typescript
pi.sendMessages([
  { customType: "worker-update", content: "Ready", display: true },
  { customType: "worker-terminal", content: "Completed", display: true },
], { triggerTurn: true });
```

The batch supports `triggerTurn`, `excludeFromContext`, and `deliverAs: "steer" | "followUp" | "nextTurn"`. Interrupt delivery remains a single-message operation.

### pi.sendUserMessage(content, options?)

Send a user message to the agent. Unlike `sendMessage()` which sends custom messages, this sends an actual user message that appears as if typed by the user. Always triggers a turn.

```typescript
// Simple text message
pi.sendUserMessage("What is 2+2?");

// With content array (text + images)
pi.sendUserMessage([
  { type: "text", text: "Describe this image:" },
  { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } },
]);

// During streaming - must specify delivery mode
pi.sendUserMessage("Focus on error handling", { deliverAs: "steer" });
pi.sendUserMessage("And then summarize", { deliverAs: "followUp" });

// Opt in to extension command dispatch and skill/prompt template expansion
pi.sendUserMessage("/review src/index.ts", { expandPromptTemplates: true });
```

**Options:**
- `deliverAs` - Required when agent is streaming:
  - `"steer"` - Queues the message for delivery after the current assistant turn finishes executing its tool calls
  - `"followUp"` - Waits for agent to finish all tools

- `expandPromptTemplates` - Dispatch extension commands and expand skill commands and prompt templates instead of sending the text literally. Defaults to `false`, so an extension-authored message is sent as-is unless it opts in; an unknown command falls through to a literal send.

When not streaming, the message is sent immediately and triggers a new turn. When streaming without `deliverAs`, throws an error.

See [send-user-message.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/send-user-message.ts) for a complete example.

### pi.appendEntry(customType, data?)

Persist extension state (does NOT participate in LLM context).

```typescript
pi.appendEntry("my-state", { count: 42 });

// Restore on reload
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // Reconstruct from entry.data
    }
  }
});
```

Appending emits `entry_appended` with the durable entry. This lets extensions react to session entries without polling.

### pi.registerEntryRenderer(customType, renderer)

Register a TUI renderer for durable custom entries created by `pi.appendEntry()`. These entries render in the transcript but do not enter model context.

```typescript
import { Text } from "@earendil-works/pi-tui";

pi.registerEntryRenderer("status-card", (entry, { expanded }, theme) =>
  new Text(theme.fg("accent", `${expanded ? "Details" : "Status"}: ${JSON.stringify(entry.data)}`), 0, 0)
);
```


### pi.setSessionName(name)

Set the session display name (shown in session selector instead of first message).

```typescript
pi.setSessionName("Refactor auth module");
```

### pi.getSessionName()

Get the current session name, if set.

```typescript
const name = pi.getSessionName();
if (name) {
  console.log(`Session: ${name}`);
}
```

### pi.setLabel(entryId, label)

Set or clear a label on an entry. Labels are user-defined markers for bookmarking and navigation (shown in `/tree` selector).

```typescript
// Set a label
pi.setLabel(entryId, "checkpoint-before-refactor");

// Clear a label
pi.setLabel(entryId, undefined);

// Read labels via sessionManager
const label = ctx.sessionManager.getLabel(entryId);
```

Labels persist in the session and survive restarts. Use them to mark important points (turns, checkpoints) in the conversation tree.

### pi.registerCommand(name, options)

Register a command.

If multiple extensions register the same command name, Atomic keeps them all and assigns numeric invocation suffixes in load order, for example `/review:1` and `/review:2`.

```typescript
pi.registerCommand("stats", {
  description: "Show session statistics",
  handler: async (args, ctx) => {
    const count = ctx.sessionManager.getEntries().length;
    ctx.ui.notify(`${count} entries`, "info");
  }
});
```

Optional: add argument auto-completion for `/command ...`:

```typescript
import type { AutocompleteItem } from "@earendil-works/pi-tui";

pi.registerCommand("deploy", {
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

### pi.getCommands()

Get the slash commands available for invocation via `prompt` in the current session. Includes extension commands, prompt templates, and skill commands.
The list matches the RPC `get_commands` ordering: extensions first, then templates, then skills.

```typescript
const commands = pi.getCommands();
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

### pi.registerMessageRenderer(customType, renderer)

Register a custom TUI renderer for messages with your `customType`. The renderer options contain `expanded` and the current numeric `outputPad`, so custom output can align with built-in messages. The same options are provided in normal and isolated-engine rendering. See [Custom UI](/extensions/ui#custom-ui).

### pi.registerMarkdownTransformer(transformer)

Register a synchronous, display-only transformer for Markdown in normal user text, assistant text, and thinking blocks. Atomic runs transformers in extension load order. Each extension retains one transformer, so a later call from that extension replaces its prior transformer. Each transformer receives the Markdown returned by the prior transformer, then Atomic renders the final value with its built-in Markdown renderer.

The transformer receives the Markdown string and a context with:

- `messageType` — `"user"`, `"assistant"`, or `"assistant-thinking"`
- `isStreaming` — `true` for partial assistant updates; `false` for user, finalized assistant, and restored messages
- `availableWidth` — exact terminal columns available for the transformed Markdown content

Return the transformed Markdown:

```typescript
pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
  if (isStreaming || messageType === "assistant-thinking") return markdown;
  return markdown.replaceAll("-->", "→");
});
```

If a transformer throws, Atomic keeps the Markdown produced so far and continues with the next transformer. The hook never changes the original message, session transcript, or model context. It runs for new user messages, assistant streaming updates, restored session messages, and terminal-width changes, so keep transformers synchronous and inexpensive. Isolated-engine rendering does not run host-side display transformers.

### pi.registerShortcut(shortcut, options)

Register a keyboard shortcut. See [Keybindings](/keybindings) for the shortcut format and built-in keybindings.

```typescript
pi.registerShortcut("ctrl+shift+p", {
  description: "Toggle plan mode",
  handler: async (ctx) => {
    ctx.ui.notify("Toggled!");
  },
});
```

### pi.registerFlag(name, options)

Register a CLI flag.

```typescript
pi.registerFlag("plan", {
  description: "Start in plan mode",
  type: "boolean",
  default: false,
});

// Check value
if (pi.getFlag("plan")) {
  // Plan mode enabled
}
```

### pi.exec(command, args, options?)

Execute a shell command.

```typescript
const result = await pi.exec("git", ["status"], { signal, timeout: 5000 });
// result.stdout, result.stderr, result.code, result.killed
```

### pi.getActiveTools() / pi.getAllTools() / pi.setActiveTools(names)

Manage active tools. This works for both built-in tools and dynamically registered tools. `pi.getActiveTools()` returns the active tool names as `string[]`; `pi.getAllTools()` returns metadata for all configured tools.

```typescript
const active = pi.getActiveTools(); // ["read", "bash", ...]
const all = pi.getAllTools();
// all = [{
//   name: "read",
//   description: "Read file contents...",
//   parameters: ...,
//   promptGuidelines: ["Use read to examine files instead of cat or sed."],
//   sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" }
// }, ...]
const builtinTools = all.filter((t) => t.sourceInfo.source === "builtin");
const extensionTools = all.filter((t) => t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk");
pi.setActiveTools([...new Set([...active, "my_custom_tool"])]); // Keep current tools and enable my_custom_tool
pi.setActiveTools(["read", "bash"]); // Switch to read-only
```

`pi.getAllTools()` returns `name`, `description`, `parameters`, `promptGuidelines`, and `sourceInfo`.

Typical `sourceInfo.source` values:
- `builtin` for built-in tools
- `sdk` for tools passed via `createAgentSession({ customTools })`
- extension source metadata for tools registered by extensions

### pi.getLoadedExtensions()

Returns loaded extension names and their `configurationOrigin`, including extensions that register no tools. Read it from an event handler or tool after resources have loaded, rather than during extension initialization. Each call returns a new array of `LoadedExtensionInfo` records; changing the records does not change the loaded extensions.

```typescript
const externalExtensions = pi.getLoadedExtensions?.()
  .filter(({ configurationOrigin }) => configurationOrigin !== "bundled") ?? [];
```

Use `configurationOrigin === "bundled"` to identify bundled extensions, not a name or path heuristic. Hosts that do not provide this optional API cannot report extension activity through it. Extension names may contain local paths, so scrub them before including them in a public report.

### pi.setModel(model)

Set the model for the current session. The change is recorded in session history and restored when that session is resumed, but it does not change the configured `defaultProvider` or `defaultModel` used by new sessions. Returns `false` if authentication is not configured for the model's provider. See [Custom models](/models) for configuring custom models.

```typescript
const model = ctx.modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (model) {
  const success = await pi.setModel(model);
  if (!success) {
    ctx.ui.notify("No API key for this model", "error");
  }
}
```

### pi.getThinkingLevel() / pi.setThinkingLevel(level)

Get the current thinking level. Level is clamped to model capabilities (non-reasoning models always use `"off"`; `"xhigh"` and `"max"` require model support). Changes emit `thinking_level_select`.

`pi.setThinkingLevel()` changes the thinking level for the current session. The change is recorded in session history and restored when that session is resumed, but it does not change the configured default used by new sessions.

```typescript
const current = pi.getThinkingLevel();  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
pi.setThinkingLevel("high");
```

### pi.events

Shared event bus for communication between active extensions. A subscription made with `on()` is removed automatically when its extension reloads or the session disposes. Use the returned function if you need to stop listening sooner:

```typescript
const unsubscribe = pi.events.on("my:event", (data) => { ... });
pi.events.emit("my:event", { ... });
unsubscribe();
```

`pi.events` belongs to the extension instance that received it. Register listeners again when that instance reloads, and do not retain the object for later use: calling `on()` or `emit()` through a captured handle after reload or disposal throws. To keep in-memory state across `/reload`, pass this facade to [`sessionScopedExtensionState`](/extensions/authoring#session-scoped-in-memory-state); do not capture the facade itself.

If you implement an `ExtensionRuntime` for an embedded host, provide `trackEventBusSubscription(unsubscribe)` and retain each returned subscription until that extension runtime is reloaded or disposed. `ExtensionUIContext.getChatRenderSettings()` must return `markdownTransformers`; it may also return `renderLatex` to control terminal math rendering. These fields keep event subscriptions and display transforms scoped to the active extension instance.


### Native providers

In addition to `registerProvider(name, config)`, extensions can register a complete native `Provider` from `@bastani/pi-ai` with `pi.registerProvider(provider)`. Use the native overload for provider-owned authentication, catalog refresh, and transport behavior; use the config overload for ordinary proxies and custom endpoints.

### pi.registerProvider(name, config)

Register or override a model provider dynamically. Useful for proxies, custom endpoints, or team-wide model configurations.

Calls made during the extension factory function are queued and applied once the runner initialises. Calls made after that — for example from a command handler following a user setup flow — take effect immediately without requiring a `/reload`.

If you need to discover models from a remote endpoint, prefer an async extension factory over deferring the fetch to `session_start`. Atomic waits for the factory before startup continues, so the registered models are available immediately, including to `atomic --list-models`.

```typescript
// Register a new provider with custom models
pi.registerProvider("my-proxy", {
  name: "My Proxy",
  baseUrl: "https://proxy.example.com",
  apiKey: "$PROXY_API_KEY",  // env var reference; omit $ for a literal
  api: "anthropic-messages",
  models: [
    {
      id: "claude-sonnet-4-20250514",
      name: "Claude 4 Sonnet (proxy)",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});

// Override baseUrl for an existing provider (keeps all models)
pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// Register provider with OAuth support for /login
pi.registerProvider("corporate-ai", {
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
      // Forward signal to the refresh request.
      signal.throwIfAborted();
      return credentials;
    },
    getApiKey(credentials) {
      return credentials.access;
    }
  }
});

// Register provider-owned API-key setup for /login
pi.registerProvider("local-server", {
  name: "Local Server",
  auth: {
    apiKey: {
      name: "Local server connection",
      async login({ signal, prompt }) {
        const baseUrl = await prompt({
          type: "text",
          message: "Server URL",
          placeholder: "http://localhost:8080"
        });
        if (signal.aborted) throw new Error("Login cancelled");
        return { type: "api_key", env: { LOCAL_SERVER_URL: baseUrl } };
      }
    }
  }
});
```

**Config options:**
- `name` - Display name for the provider in UI such as `/login`.
- `baseUrl` - API endpoint URL. Required when defining models.
- `apiKey` - API key literal or explicit environment variable reference (`$ENV_VAR` or `${ENV_VAR}`). Required when defining models (unless `oauth` provided).
- `api` - API type: `"anthropic-messages"`, `"openai-completions"`, `"openai-responses"`, etc.
- `headers` - Custom headers to include in requests.
- `authHeader` - If true, adds `Authorization: Bearer` header automatically.
- `models` - Array of model definitions. If provided, replaces all existing models for this provider. Model definitions can set `baseUrl` to override the provider endpoint for that model.
- `oauth` - OAuth provider config for `/login` support. When provided, the provider appears in the login menu.
- `auth.apiKey` - Provider-owned API-key or connection setup for `/login`. Its `name` appears in the provider list and `login({ signal, prompt })` returns the credential Atomic persists. Extension providers registered only in the isolated interactive engine child are synchronized into the host's `/login` list; their login callback and credential-dependent model refresh still execute in the child, while prompts are rendered by the terminal host.
- `streamSimple` - Custom streaming implementation for non-standard APIs.

See [Custom providers](/custom-provider) for advanced topics: custom streaming APIs, OAuth details, model definition reference.

### pi.unregisterProvider(name)

Remove a previously registered provider and its models. Built-in models that were overridden by the provider are restored. Has no effect if the provider was not registered.

Like `registerProvider`, this takes effect immediately when called after the initial load phase, so a `/reload` is not required.

```typescript
pi.registerCommand("my-setup-teardown", {
  description: "Remove the custom proxy provider",
  handler: async (_args, _ctx) => {
    pi.unregisterProvider("my-proxy");
  },
});
```

## Error Handling

- Extension errors are logged, agent continues
- `tool_call` errors block the tool (fail-safe)
- Tool `execute` errors must be signaled by throwing; the thrown error is caught, reported to the LLM with `isError: true`, and execution continues
