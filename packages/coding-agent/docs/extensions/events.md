---
title: "Extension events"
sidebarTitle: "Events"
description: "Reference for extension lifecycle events, payloads, handler chaining rules, and return contracts."
---

<div id="events" />

Subscribe to lifecycle events with `atomic.on(event, handler)`. Every `atomic.on()` call returns an unsubscribe function `() => void` if you need to detach a listener before reload or shutdown.

## Lifecycle overview

When interactive startup needs to ask whether you trust a project, user, global, and CLI `-e` extensions start first (receiving `session_start` and `resources_discover`) so they can participate in `project_trust` and display UI. After trust is granted, project extensions load, receive `session_start`, and `resources_discover` runs again for the full set.

A `resources_discover` handler that fails both passes with the same error is reported once. Different handlers are reported separately even if they throw the same message. Extensions already started during the first pass keep their session and do not receive a second `session_start`. Non-interactive startup resolves trust before running the normal lifecycle.

```text
Atomic starts
  │
  ├─► session_start / resources_discover (user/global and CLI -e extensions when trust is needed)
  ├─► project_trust (user/global and CLI -e extensions only, before project resources load)
  ├─► session_start { reason: "startup" } (remaining extensions)
  ├─► resources_discover { reason: "startup" }
  └─► after the transcript renders: session_recovery_restore / session_recovery_replay
      │
      ▼
user sends prompt ─────────────────────────────────────────┐
  │                                                        │
  ├─► (extension commands checked first; bypass if found)  │
  ├─► input (can intercept, transform, or handle)          │
  ├─► (skill/template expansion if not handled)            │
  ├─► before_agent_start (can inject message, adjust prompt)
  ├─► agent_start                                          │
  ├─► message_start / message_update / message_end         │
  │                                                        │
  │   ┌─── turn (repeats while model calls tools) ─┐       │
  │   │                                            │       │
  │   ├─► turn_start                               │       │
  │   ├─► context (modify conversation messages)   │       │
  │   ├─► context_with_system (modify full list)   │       │
  │   ├─► before_provider_headers (mutate headers) │       │
  │   ├─► before_provider_request (edit payload)   │       │
  │   ├─► after_provider_response (status+headers) │       │
  │   ├─► provider_stream_event (raw chunk events) │       │
  │   │                                            │       │
  │   │   Model responds, may call tools:          │       │
  │   │     ├─► tool_execution_start               │       │
  │   │     ├─► tool_call (can block or patch)     │       │
  │   │     ├─► tool_execution_update              │       │
  │   │     ├─► tool_result (can modify result)    │       │
  │   │     └─► tool_execution_end                 │       │
  │   │                                            │       │
  │   ├─► turn_end (can append entries & continue) │       │
  │   └─► context-size check after tool results    │       │
  │       (may compact before next model request)  │       │
  ├─► agent_end                                            │
  ├─► retry backoff or final-attempt recovery (when needed)│
  │   └─► fresh agent_start on successful recovery         │
  ├─► agent_before_settle (append entries & continue)      │
  └─► agent_settled (final, notification-only)             │
                                                           │
user sends another prompt ◄────────────────────────────────┘

/new (new session) or /resume (switch session)
  ├─► session_before_switch (can cancel)
  ├─► session_shutdown
  ├─► session_start { reason: "new" | "resume", previousSessionId? }
  ├─► resources_discover { reason: "startup" }
  └─► after the transcript renders (resume only):
      ├─► session_recovery_restore
      └─► session_recovery_replay (only when interrupted deliveries are pending)

/fork or /clone
  ├─► session_before_fork (can cancel)
  ├─► session_shutdown
  ├─► session_start { reason: "fork", previousSessionId }
  └─► resources_discover { reason: "startup" }

/compact or auto-compaction
  ├─► session_before_compact (can cancel or provide compactedText)
  ├─► session_compact (after the compaction boundary is persisted)
  └─► session_compact_failed (failure or cancellation)

/tree navigation
  ├─► session_before_tree (can cancel or customize)
  └─► session_tree

/model or CTRL+P (model selection/cycling)
  ├─► thinking_level_select (if model change clamps thinking level)
  └─► model_select

thinking level changes (settings, keybinding, atomic.setThinkingLevel())
  └─► thinking_level_select

prompt cache warming (when enabled)
  └─► cache_warming_decision (can return { action: "warm" | "stop" })

exit (CTRL+C, CTRL+D, SIGHUP, SIGTERM)
  └─► session_shutdown
```

## Startup events

### project_trust

Fired before Atomic decides whether to trust a project with local configuration (`.atomic`, legacy `.pi`, or `.agents/skills`). Runs during startup and when switching sessions (such as `/resume`) enters a working directory whose trust has not been resolved in this process. Only user, global, and CLI `-e` extensions participate because project extensions load after trust is granted.

```typescript
atomic.on("project_trust", async (event, ctx) => {
  // event.cwd - current working directory
  // ctx has a limited trust context: cwd, mode, hasUI, and select/confirm/input/notify UI helpers
  if (ctx.hasUI && (await ctx.ui.confirm("Trust project?", event.cwd))) {
    return { trusted: "yes", remember: true };
  }
  return { trusted: "undecided" };
});
```

A `project_trust` handler must return `{ trusted: "yes" | "no" | "undecided" }`. The first `"yes"` or `"no"` decision wins and suppresses the built-in trust prompt. Set `remember: true` to persist the decision; otherwise it applies to the current process only.

Return `"undecided"` to pass control to later handlers or Atomic's built-in trust flow, and check `ctx.hasUI` before prompting. If no handler decides, saved `trust.json` decisions apply first, then `defaultProjectTrust` decides whether Atomic asks, trusts, or declines.

## Resource events

### resources_discover

Fired after `session_start` so extensions can contribute skill, prompt template, and theme paths. Startup passes `reason: "startup"`; `/reload` passes `reason: "reload"`.

```typescript
atomic.on("resources_discover", async (event, _ctx) => {
  // event.cwd - current working directory
  // event.reason - "startup" | "reload"
  return {
    skillPaths: ["/path/to/skills"],
    promptPaths: ["/path/to/prompts"],
    themePaths: ["/path/to/themes"],
  };
});
```

## Session events

See [Session format](/session-format) for session storage details and the `SessionManager` API.

For all cancellable `session_before_*` events (`session_before_switch`, `session_before_fork`, `session_before_compact`, `session_before_tree`), the **first** handler returning `{ cancel: true }` immediately short-circuits remaining handlers and cancels the action. Otherwise, the last non-empty result wins.

### session_start

Fired when a session starts, reloads, switches, or forks.

```typescript
atomic.on("session_start", async (event, ctx) => {
  // event.reason - "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionId - present for "new", "resume", and "fork"
  // event.engineRestart - true only when a crashed interactive worker process restarted
  ctx.ui.notify(`Session: ${ctx.sessionManager.getSessionId()}`, "info");
});
```

If a handler throws, interactive mode shows the error with the extension's path and keeps the session open; print mode, RPC mode, and SDK sessions fail startup instead. See [Error handling](/extensions/api-reference#error-handling).

### session_recovery_restore / session_recovery_replay

Fired once per session when recovering unfinished work from an earlier process. Interactive mode runs them after the transcript renders; SDK and RPC hosts run them when calling `session.startPendingRecovery()` or sending `start_pending_recovery`.

`session_recovery_restore` runs first so extensions can restore background work such as child agents. It receives `event.reason` (`"startup" | "resume"`) and `event.engineRestart` (`true` when triggered after an automatic worker restart).

`session_recovery_replay` follows only when delivery cards shown before exit never reached the model. Each decision in `decisions` takes `{ entryId, action }`, where `action` is:

- `"replay"`: explicitly deliver the pending card in a visible turn (also the default when no handler returns a decision for that card).
- `"drop"`: permanently close a card whose sender or target no longer exists.
- `"defer"`: leave the card pending without starting a turn so the next recovery offers it again (useful when a peer service is unreachable).

If handlers disagree on the same card, `"drop"` wins over `"defer"`. Notices returned from either event combine into one non-triggering message for the user and model.

```typescript
atomic.on("session_recovery_restore", async (event) => {
  // event.reason - "startup" | "resume"
  // event.engineRestart - true after a worker restart
  return { notices: ["Worker reviewer could not be restored and is gone."] };
});

atomic.on("session_recovery_replay", async (event) => {
  // event.pending - [{ entryId, customType, content, details, timestamp, stageAdmissionKey?, delivery }]
  return {
    decisions: event.pending.map((entry) => ({
      entryId: entry.entryId,
      action: entry.customType === "my-extension:stale" ? "drop" : "replay",
    })),
  };
});
```

### session_info_changed

Fired when the session display name changes via `/name`, RPC, or `atomic.setSessionName()`.

```typescript
atomic.on("session_info_changed", async (event, ctx) => {
  // event.name - normalized name, or undefined if cleared
  ctx.ui.notify(`Session renamed: ${event.name ?? "(none)"}`, "info");
});
```

### session_before_switch

Fired before `/new` or `/resume`. The first handler returning `{ cancel: true }` stops the switch and skips later handlers.

```typescript
atomic.on("session_before_switch", async (event, ctx) => {
  // event.reason - "new" | "resume"
  // event.targetSessionId - destination session ID (only for "resume")
  if (event.reason === "new") {
    const ok = await ctx.ui.confirm("Clear?", "Delete all messages?");
    if (!ok) return { cancel: true };
  }
});
```

After a successful switch, Atomic emits `session_shutdown` for the previous instance, reloads extensions for the new session, and emits `session_start` with `reason: "new" | "resume"` and `previousSessionId`.

### session_before_fork

Fired before `/fork` or `/clone`. The first handler returning `{ cancel: true }` cancels the action and skips later handlers.

```typescript
atomic.on("session_before_fork", async (event) => {
  // event.entryId - ID of the selected entry
  // event.position - "before" for /fork, "at" for /clone
  return { cancel: true };
  // Or: return { skipConversationRestore: true };
});
```

After a successful fork or clone, Atomic emits `session_shutdown`, reloads extensions for the new session, and emits `session_start` with `reason: "fork"` and `previousSessionId`.

### session_before_compact / session_compact / session_compact_failed

Fired by `/compact` and automatic compaction, including when tool output pushes the prospective next-turn context past the threshold. Atomic prepares all context since the last compaction boundary.

Handlers on `session_before_compact` can cancel compaction (`{ cancel: true }`, short-circuiting later handlers) or return `{ compactedText }`. When `compactedText` is provided, Atomic skips the configured compactor and inserts that text verbatim into a `Context compacted` boundary message followed by history recovery instructions. Empty or whitespace-only text counts as no replacement.

If replacement text exceeds the compactor's output limit or still exceeds the automatic trigger together with the system prompt and recovery instructions, Atomic clears the context instead. A successful post-tool compaction feeds its rebuilt context directly into the active turn loop; cancellation or failure stops the follow-up model request.

```typescript
atomic.on("session_before_compact", async (event) => {
  const { preparation, branchEntries, parameters, reason, signal } = event;
  // preparation.region.lines - role-tagged lines since the last boundary (deep-frozen)
  // preparation.firstKeptEntryId - always null
  // preparation.tokensBefore - whole-context token estimate
  // parameters.query - /compact instructions or latest user request
  // branchEntries - raw entries on the active branch
  // reason - "manual" | "threshold" | "overflow"

  if (signal.aborted) return { cancel: true };

  return {
    compactedText: preparation.region.lines
      .filter((line) => line.startsWith("[User]: "))
      .join("\n"),
  };
});

atomic.on("session_compact", async (event) => {
  // event.result - VerbatimCompactionResult (compactedText, form, backend, model, fallbackReason, history, stats)
  // event.compactionEntry - saved CompactionEntry with strategy "verbatim-lines"
  // event.fromExtension - true when session_before_compact provided compactedText
  // Notification-only: handler errors are logged and do not affect the saved compaction.
});

atomic.on("session_compact_failed", async (event) => {
  // event.reason - "manual" | "threshold" | "overflow"
  // event.errorMessage - absent on cancellation
  // event.aborted / event.willRetry - terminal state
  // event.fromExtension - whether extension-provided text was active
});
```

### session_before_tree / session_tree

Fired on `/tree` navigation. See [Sessions](/sessions) for tree navigation concepts.

When a handler is registered or summarization is requested, `event.preparation.entriesToSummarize` contains the entries of the abandoned branch segment (even when `userWantsSummary` is `false`). Atomic releases that array after navigation; if your extension retains a reference, it owns that memory.

```typescript
atomic.on("session_before_tree", async (event) => {
  const { preparation, signal } = event;
  // preparation.targetId - destination entry ID
  // preparation.oldLeafId - leaf ID before navigation
  // preparation.commonAncestorId - shared ancestor entry ID
  // preparation.entriesToSummarize - entries leaving the active branch
  // preparation.userWantsSummary - whether the user requested a branch summary
  // preparation.customInstructions / preparation.replaceInstructions / preparation.label

  if (signal.aborted) return { cancel: true };

  // Cancel navigation:
  // return { cancel: true };

  // Customize summary prompt or label without replacing summarization:
  // return { customInstructions: "Keep API contract decisions", replaceInstructions: false, label: "branch-cut" };

  // Or supply a custom summary directly:
  return { summary: { summary: "Explored approach A; switched to B.", details: {} }, label: "approach-a" };
});

atomic.on("session_tree", async (event) => {
  // event.newLeafId, event.oldLeafId, event.summaryEntry, event.fromExtension
});
```

### session_shutdown

Fired before a started session shuts down, reloads, switches, or forks. Close background resources opened in `session_start` here.

```typescript
atomic.on("session_shutdown", async (event) => {
  // event.reason - "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionId - destination session ID on switches or forks
  // event.fromSignal - true when "quit" came from SIGTERM/SIGHUP rather than explicit quit
});
```

`fromSignal` is set only when `reason === "quit"` came from an OS signal (`SIGTERM`, `SIGHUP`, or terminal close); `Ctrl+D` and `/quit` leave it unset.

Handlers have about 5 seconds to finish on Linux and macOS quit or signal shutdown (a second `SIGTERM` exits immediately), and about 4 seconds on Windows console close or OS shutdown after startup finishes. Any running [`atomic.exec`](/extensions/api-reference#atomic-exec-command-args-options) command is stopped first so it cannot block shutdown handlers.

## Agent events

### before_agent_start

Fired before a run starts from a user prompt or from `atomic.sendMessage(..., { triggerTurn: true })` while idle. Multiple handlers returning `message` all inject their messages in extension load order. Returning `systemPrompt` updates `systemPromptOptions.forceSystemPrompt` (last handler wins), while `event.systemPrompt` and `ctx.getSystemPrompt()` update live for each subsequent handler.

Always check `event.messageType` before reading the trigger payload: `"user"` events carry `prompt` and optional `images`, while `"custom"` events carry `message`.

```typescript
atomic.on("before_agent_start", async (event) => {
  if (event.messageType === "user") {
    // event.prompt, event.images
  } else {
    // event.message (starting custom message)
  }
  // event.systemPrompt - chained system prompt so far
  // event.systemPromptOptions - mutable BuildSystemPromptOptions:
  //   customPrompt, forceSystemPrompt, selectedTools, toolSnippets, toolGuidelines,
  //   sections, promptGuidelines, appendSystemPrompt, cwd, contextFiles, skills

  return {
    message: {
      customType: "my-extension",
      content: "Additional context for the model",
      display: true,
    },
    systemPrompt: `${event.systemPrompt}\n\nExtra instructions for this run.`,
  };
});
```

Prefer mutating `event.systemPromptOptions.sections`, `selectedTools`, or `promptGuidelines` instead of returning a full `systemPrompt` override so prompt caching stays intact. Editing `selectedTools` or calling `atomic.setActiveTools()` here applies to the same run's executable tools as well as its prompt text.

### agent_start / agent_end / agent_before_settle / agent_settled

- `agent_start` marks the start of one low-level model run.
- `agent_end` marks the end of that run (Atomic may still retry, compact and retry, or deliver queued follow-ups).
- `agent_before_settle` is the final actionable boundary before going idle: handlers can append entries and request one continuation (`continue: true`).
- `agent_settled` is final and notification-only, with `event.aborted: boolean` (`true` if cancelled, including during `agent_before_settle`).

```typescript
atomic.on("agent_start", async () => {});
atomic.on("agent_end", async (event) => {
  // event.messages - messages produced in this run
});

let addedReviewReminder = false;
atomic.on("agent_before_settle", async (event) => {
  if (addedReviewReminder) return;
  addedReviewReminder = true;
  return {
    entries: [
      ...event.entries,
      {
        type: "custom_message",
        customType: "review-reminder",
        content: "Review the final diff before replying.",
        display: false,
      },
    ],
    continue: true,
  };
});

atomic.on("agent_settled", async (event, ctx) => {
  // event.aborted - true when cancelled
  // ctx.isIdle() is true; any new prompt started here waits until all agent_settled handlers finish.
});
```

If aborted during `agent_before_settle`, valid entries still persist while `continue: true` is suppressed. Input queued from `agent_before_settle` with `deliverAs: "steer"` or `"followUp"` joins the requested continuation instead of starting a second run.

Each provider request builds from the persisted session after earlier event handlers (`agent_start`, `turn_start`, `message_start`, `message_end`, `tool_execution_*`) settle, because `message_end` can modify a saved message. Do not await something later in the same run inside one of those handlers; wait in `agent_end` or `agent_settled` instead.

### ui_prompt_start / ui_prompt_end

Notification-only events wrapping blocking user-facing prompts:

- `reason: "ui_prompt"`: prompts opened via `ctx.ui.select()`, `confirm()`, `input()`, `editor()`, and `custom()` (unless `{ purpose: "navigation" }` is passed).
- `reason: "project_trust"`: interactive trust dialogs and `/trust`.

Nested or overlapping prompts emit a single start/end pair that closes only after all nested prompts finish, preserving the original `reason`, `kind`, and `title`. Prompt display never waits for observers, so update your tracking state before awaiting async work. During session switches, pending notification delivery has a 1,000 ms limit.

```typescript
atomic.on("ui_prompt_start", (event) => {
  // event.reason - "ui_prompt" | "project_trust"
  // event.kind - "select" | "confirm" | "input" | "editor" | "custom"
  // event.title - prompt title when available
});

atomic.on("ui_prompt_end", (event) => {
  // All prompts in this span have closed.
});
```

### turn_start / turn_end

Fired around each turn (one model response plus its tool calls). `turn_end` runs after the assistant message and tool results persist, and lets extensions append structural entries and request a continuation.

```typescript
atomic.on("turn_start", async (event) => {
  // event.turnIndex, event.timestamp
});

let replacedResponse = false;
atomic.on("turn_end", async (event) => {
  // event.turnIndex, event.message, event.toolResults
  // event.messageEntryId, event.toolResultEntryIds, event.outcome
  // event.entries - entries proposed by earlier handlers
  // event.context - rebuilt projection (contextEntries, contextMessages, llmMessages, pendingMessages, canContinue)
  if (replacedResponse || event.outcome !== "completed" || event.toolResults.length > 0) return;
  replacedResponse = true;
  return {
    entries: [
      ...event.entries,
      { type: "context_edit", targetId: event.messageEntryId, replacement: null },
      {
        type: "custom_message",
        customType: "replacement-instruction",
        content: "Answer again using the persisted user request.",
        display: false,
      },
    ],
    continue: true,
  };
});
```

Boundary rules shared by `turn_end` and `agent_before_settle`:

- Allowed draft entry types are `custom`, `custom_message`, `context_edit`, and `compaction` (`summary` text with `firstKeptEntryId: null`).
- Returning `entries` or `continue` updates only that field; omitted fields keep earlier handlers' proposals.
- Atomic validates the combined proposal before appending entries in order. A handler error is reported without stopping later handlers.
- `continue: true` ensures one next model request when tool results, steering, or follow-ups do not already trigger one. Always guard `continue: true` so it cannot loop indefinitely. Error and aborted outcomes stop regardless.

### message_start / message_update / message_end

- `message_start` and `message_end` fire for `user`, `assistant`, and `toolResult` messages.
- `message_update` fires for streaming assistant deltas (`event.assistantMessageEvent`).
- `message_end` handlers can return `{ message }` to replace the finalized message. The replacement must keep the same `role`; returning a different `role` reports an extension error and ignores that handler's replacement (keeping the previous message).

```typescript
atomic.on("message_start", async (event) => {
  // event.message
});

atomic.on("message_update", async (event) => {
  // event.assistantMessageEvent (token-by-token delta)
});

atomic.on("message_end", async (event) => {
  if (event.message.role !== "assistant") return;
  return {
    message: {
      ...event.message,
      usage: { ...event.message.usage, cost: { ...event.message.usage.cost, total: 0.123 } },
    },
  };
});
```

### tool_execution_start / tool_execution_update / tool_execution_end

Fired around each tool execution. Nested tool calls invoked through `ctx.executeTool()` include `event.parentToolCallId`.

In parallel tool mode:

- `tool_execution_start` fires in assistant message order while calls are checked sequentially before parallel execution begins.
- `tool_execution_update` events can interleave across concurrent calls.
- `tool_execution_end` fires in completion order (`durationMs` measures time spent in `execute()` via a monotonic clock, or is omitted if the tool did not run).
- Final `toolResult` message events still emit in assistant message order.

```typescript
atomic.on("tool_execution_start", async (event) => {
  // event.toolCallId, event.toolName, event.args, event.parentToolCallId?
});

atomic.on("tool_execution_update", async (event) => {
  // event.toolCallId, event.toolName, event.args, event.partialResult, event.parentToolCallId?
});

atomic.on("tool_execution_end", async (event) => {
  // event.toolCallId, event.toolName, event.result, event.isError, event.durationMs, event.parentToolCallId?
});
```

### context

Fired before each model request to filter or adjust conversation messages non-destructively. If tool output crossed the compaction threshold, the context-size check and compaction finish before `context` runs, so `event.messages` reflects the compacted transcript.

```typescript
atomic.on("context", async (event) => {
  // event.messages - deep copy without system messages, safe to modify
  const filtered = event.messages.filter((m) => !shouldPrune(m));
  return { messages: filtered };
});
```

`event.messages` excludes system messages so filtering cannot drop Atomic's prompt or tool declarations. When a handler modifies or returns a new message list, Atomic replays the active prompt sections and tool declarations into one leading system message ahead of your returned messages. Leaving `event.messages` unchanged preserves mid-conversation system patches for prompt caching. To change prompts or tools durably, use [`before_agent_start`](#before_agent_start) or `atomic.setActiveTools()`; to edit system messages directly for one request, use [`context_with_system`](#context_with_system).

### context_with_system

Fired after every `context` handler runs and Atomic restores prompt and tool state. `event.messages` contains the complete transcript including system messages. The returned list is sent verbatim.

```typescript
import { getCurrentSystemMessage } from "@bastani/atomic-ai";

atomic.on("context_with_system", async (event) => {
  const cut = findCutIndex(event.messages);
  const head = getCurrentSystemMessage(event.messages.slice(0, cut));
  return { messages: head ? [head, ...event.messages.slice(cut)] : event.messages.slice(cut) };
});
```

Keep a system message at index `0` (dropping it triggers an extension error). Verify your result with `getCurrentSystemPrompt()` and `getCurrentTools()` from `@bastani/atomic-ai`. A `systemPrompt` forced in `before_agent_start` still applies afterward.

### before_provider_headers

Fired after outgoing HTTP headers are assembled. `event` contains only `{ type: "before_provider_headers", headers }`; read `ctx.model` if you need the active provider or model ID. Mutate `event.headers` in place to add, change, or remove headers.

Atomic's default `User-Agent` and provider attribution headers (OpenRouter, NVIDIA NIM, OpenCode) are added afterward, so headers you set here or in `models.json` take precedence. For OpenCode models, `x-opencode-session` is already present and can be read, replaced, or deleted. Fires again if Atomic retries a request with updated credentials.

```typescript
atomic.on("before_provider_headers", (event, ctx) => {
  if (ctx.model?.provider === "openai") {
    event.headers["x-session-id"] = ctx.sessionManager.getSessionId();
  }
  delete event.headers["x-remove-me"];
});
```

### before_provider_request

Fired right before sending the serialized provider request body. Handlers run in load order; returning `undefined` leaves the payload unchanged, while returning any other value replaces the payload for later handlers and the request. Fires again on credential-refresh retries.

Payload edits here do not update `ctx.getSystemPrompt()`. Providers using stateful continuations (OpenAI Codex WebSockets, Anthropic threads) may send only the new delta since the prior request.

```typescript
atomic.on("before_provider_request", (event) => {
  console.log(JSON.stringify(event.payload, null, 2));
  // Optional: return { ...event.payload, temperature: 0 };
});
```

### after_provider_response

Fired after an HTTP response arrives and before its stream body is consumed. Header availability depends on the provider transport.

```typescript
atomic.on("after_provider_response", (event) => {
  // event.status - HTTP status code
  // event.headers - normalized response headers
  if (event.status === 429) {
    console.log("rate limited", event.headers["retry-after"]);
  }
});
```

### provider_stream_event

Fired for each parsed provider stream chunk before Atomic normalizes it into assistant message events.

```typescript
atomic.on("provider_stream_event", (event) => {
  // event.provider, event.api, event.model
  // event.data - parsed provider chunk (treat as read-only)
  const chunk = event.data as Record<string, unknown>;
  if (chunk.openrouter_metadata) console.log(chunk.openrouter_metadata);
});
```

Notification-only and not persisted to the session; cache-warming requests do not emit it. Handlers are awaited in stream order, so keep them fast. Custom providers using `streamSimple` emit this event only when they call `options.onProviderStreamEvent`. See [`debug-provider.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/debug-provider.ts).

## Model events

### model_select

Fired when the active model changes via `/model`, `Ctrl+P`, session restore, or fallback selection.

```typescript
atomic.on("model_select", async (event, ctx) => {
  // event.model, event.previousModel (undefined on initial selection)
  // event.source - "set" | "cycle" | "restore" | "fallback"
  const next = `${event.model.provider}/${event.model.id}`;
  ctx.ui.notify(`Model changed (${event.source}): ${next}`, "info");
});
```

### thinking_level_select

Notification-only event fired when the thinking level changes via settings, keybindings, model clamping, or `atomic.setThinkingLevel()`.

```typescript
atomic.on("thinking_level_select", async (event, ctx) => {
  // event.level, event.previousLevel
  ctx.ui.setStatus("thinking", `thinking: ${event.level}`);
});
```

### cache_warming_decision

Fired when prompt cache warming decides whether to send a warming request. Handlers run in load order and receive `warmCost`, `missCost`, `continuationProbability`, and the current `action` (`"warm"` or `"stop"`). Return `{ action: "warm" }` or `{ action: "stop" }` to override the decision for later handlers and the warmer.

```typescript
atomic.on("cache_warming_decision", (event) => {
  if (event.continuationProbability < 0.5) {
    return { action: "stop" };
  }
});
```

## Tool events

### tool_call

Fired after `tool_execution_start` and before `execute()`. **Can block or patch arguments.**

Before `tool_call` runs, `ctx.sessionManager` is synced through the current assistant tool-calling message. In parallel tool mode, sibling calls from the same assistant message are checked sequentially before running concurrently, so `tool_call` may not see sibling tool results from that message. Nested `ctx.executeTool()` calls run `tool_call` too and include `event.parentToolCallId` (see [Structured results and nested tools](/extensions/authoring#structured-results-and-nested-tools)).

Chaining and mutation rules:

- `event.input` is mutable; later `tool_call` handlers and `execute()` see in-place edits without re-validation.
- The **first** handler returning `{ block: true, reason?, terminate? }` immediately short-circuits later handlers and blocks the tool call.
- If a `tool_call` handler **throws an error**, Atomic immediately blocks the tool call with that error and skips remaining handlers.
- `terminate: true` applies only on a blocked call; the turn ends early only when every finalized result in the batch is terminating.

```typescript
import { isToolCallEventType } from "@bastani/atomic";

atomic.on("tool_call", async (event) => {
  // event.toolName, event.toolCallId, event.input (mutable), event.parentToolCallId?
  if (isToolCallEventType("bash", event)) {
    event.input.command = `source ~/.profile\n${event.input.command}`;
    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command", terminate: true };
    }
  }

  if (isToolCallEventType("powershell", event)) {
    event.input.command = `$ErrorActionPreference = "Stop"\n${event.input.command}`;
  }

  if (isToolCallEventType("read", event)) {
    console.log(`Reading: ${event.input.path}`);
  }

  if (isToolCallEventType("search", event)) {
    event.input.paths ??= ".";
  }
});
```

#### Typing custom tool input

Export the static input type from your tool module and pass type arguments to `isToolCallEventType`:

```typescript
import { isToolCallEventType } from "@bastani/atomic";
import type { MyToolInput } from "./my-tool.js";

atomic.on("tool_call", (event) => {
  if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
    console.log(event.input.action);
  }
});
```

### tool_result

Fired after a tool finishes and before `tool_execution_end` and the final `toolResult` message event. **Can modify the result.**

In parallel mode, `tool_result` runs in tool completion order while final `toolResult` transcript messages still emit in assistant message order.

Handlers chain in extension load order, each seeing prior changes. Return partial patches for `content`, `structuredContent`, `details`, `usage`, or `isError`. Omitted fields stay unchanged, except replacing `content` without replacing `structuredContent` drops `structuredContent` so redacted data cannot leak. After all handlers finish, Atomic applies `images.autoResize` to returned images.

Built-in result type guards exported from `@bastani/atomic`: `isBashToolResult`, `isPowerShellToolResult`, `isReadToolResult`, `isEditToolResult`, `isWriteToolResult`, `isFindToolResult`, `isSearchToolResult`, and `isLsToolResult`.

```typescript
import {
  isBashToolResult,
  isEditToolResult,
  isFindToolResult,
  isLsToolResult,
  isPowerShellToolResult,
  isReadToolResult,
  isSearchToolResult,
  isWriteToolResult,
} from "@bastani/atomic";

atomic.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input, event.parentToolCallId?
  // event.content, event.structuredContent, event.details, event.usage, event.isError

  if (isBashToolResult(event)) {
    // event.details is BashToolDetails | undefined
  }
  if (isReadToolResult(event) || isEditToolResult(event) || isWriteToolResult(event)) {
    // Narrowed built-in details types
  }
  if (isFindToolResult(event) || isSearchToolResult(event) || isLsToolResult(event) || isPowerShellToolResult(event)) {
    // Narrowed built-in details types
  }

  const response = await fetch("https://example.com/summarize", {
    method: "POST",
    body: JSON.stringify({ content: event.content }),
    signal: ctx.signal,
  });

  return { content: event.content, details: await response.json(), isError: false };
});
```

## User bash events

### user_bash

Fired when the user runs `!` or `!!` shell commands. Return `{ operations }` to customize execution (optionally wrapping `createLocalBashOperations()` from `@bastani/atomic`) or `{ result }` to return a result directly.

```typescript
import { createLocalBashOperations } from "@bastani/atomic";

atomic.on("user_bash", (event) => {
  // event.command, event.excludeFromContext (true for !!), event.cwd

  // Option 1: Custom operations (such as SSH)
  // return { operations: remoteBashOps };

  // Option 2: Wrap Atomic's local bash backend
  const local = createLocalBashOperations();
  return {
    operations: {
      exec(command, cwd, options) {
        return local.exec(`source ~/.profile\n${command}`, cwd, options);
      },
    },
  };

  // Option 3: Full replacement
  // return { result: { output: "...", exitCode: 0, cancelled: false, truncated: false } };
});
```

## Input events

### input

Fired on user input after extension commands are checked and before `/skill:` and prompt template expansion. Direct `session.steer()` and `session.followUp()` calls also run `input` handlers before queueing (`source` defaults to `"interactive"`, or `"rpc"` for RPC queue commands).

Processing order:

1. Extension slash commands (`/cmd`) match first and skip `input`.
2. `input` handlers run and can return `"continue"`, `"transform"`, or `"handled"`.
3. If not handled, `/skill:<name>` commands expand.
4. If not handled, prompt templates (`/template`) expand.
5. Agent execution begins (`before_agent_start`).

`event.streamingBehavior` tells you whether the input is an immediate submission (`undefined`) or queued while a turn is running (`"steer"` or `"followUp"`):

```typescript
atomic.on("input", async (event, ctx) => {
  // event.text - raw text before skill/template expansion
  // event.images - attached images, if any
  // event.source - "interactive" | "rpc" | "extension"
  // event.streamingBehavior - undefined (immediate) | "steer" | "followUp" (queued while streaming)

  if (event.text.startsWith("?quick ")) {
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };
  }

  if (event.text === "ping") {
    ctx.ui.notify("pong", "info");
    return { action: "handled" };
  }

  if (event.source === "extension") return { action: "continue" };

  return { action: "continue" };
});
```

Return actions:

- `"continue"`: pass through unchanged (default when returning `undefined`).
- `"transform"`: replace `text` or `images` and continue to later handlers and expansion. Transformed text is what enters the session and `Ctrl+R` search, while Up/Down editor history keeps what you typed.
- `"handled"`: stop processing without sending to the model (first `"handled"` result wins).

See [input-transform.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/input-transform.ts) and [input-transform-streaming.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/input-transform-streaming.ts).

## Next steps

Continue with [Extension UI](/extensions/ui) to add dialogs, pickers, widgets, and custom components, or inspect all context properties in the [Extension API reference](/extensions/api-reference#extensioncontext).
