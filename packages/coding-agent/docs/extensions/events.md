---
title: Extension events
description: Every extension event, its payload, and its return contract.
---

# Extension events

## Events

### Lifecycle Overview

Interactive trust-gated startup first emits `session_start` and `resources_discover` for the permitted trust-safe extensions, then resolves `project_trust`. After authorization, newly loaded extensions receive `session_start`; resource discovery runs again against the completed set. Existing reporters keep their session and do not receive a second `session_start`. Noninteractive startup resolves trust before the ordinary session lifecycle.

```
Atomic starts
  │
  ├─► session_start / resources_discover (trust-safe interactive bootstrap, when needed)
  ├─► project_trust (user/global and CLI extensions only, before project resources load)
  ├─► session_start { reason: "startup" } (extensions not already started)
  └─► resources_discover { reason: "startup" }
      │
      ▼
user sends prompt ─────────────────────────────────────────┐
  │                                                        │
  ├─► (extension commands checked first, bypass if found)  │
  ├─► input (can intercept, transform, or handle)          │
  ├─► (skill/template expansion if not handled)            │
  ├─► before_agent_start (can inject message, modify system prompt)
  ├─► agent_start                                          │
  ├─► message_start / message_update / message_end         │
  │                                                        │
  │   ┌─── turn (repeats while LLM calls tools) ───┐       │
  │   │                                            │       │
  │   ├─► turn_start                               │       │
  │   ├─► context (can modify conversation messages)   │
  │   ├─► context_with_system (can modify the full transcript)
  │   ├─► before_provider_request (can inspect or replace payload)
  │   ├─► after_provider_response (status + headers, before stream consume)
  │   ├─► provider_stream_event (each parsed provider event, before normalization)
  │   │                                            │       │
  │   │   LLM responds, may call tools:            │       │
  │   │     ├─► tool_execution_start               │       │
  │   │     ├─► tool_call (can block)              │       │
  │   │     ├─► tool_execution_update              │       │
  │   │     ├─► tool_result (can modify)           │       │
  │   │     └─► tool_execution_end                 │       │
  │   │                                            │       │
  │   ├─► turn_end (can append entries and continue)       │
  │   └─► post-tool threshold preflight            │       │
  │       (may compact before the next provider request)   │
  ├─► agent_end                                            │
  ├─► retry backoff or final-attempt recovery (when selected)
  │   └─► fresh agent_start on successful recovery         │
  ├─► agent_before_settle (can append entries and continue)│
  └─► agent_settled (final, notification only)             │
                                                           │
user sends another prompt ◄────────────────────────────────┘

/new (new session) or /resume (switch session)
  ├─► session_before_switch (can cancel)
  ├─► session_shutdown
  ├─► session_start { reason: "new" | "resume", previousSessionFile? }
  └─► resources_discover { reason: "startup" }

/fork or /clone
  ├─► session_before_fork (can cancel)
  ├─► session_shutdown
  ├─► session_start { reason: "fork", previousSessionFile }
  └─► resources_discover { reason: "startup" }

/compact or auto-compaction
  ├─► compaction_start / compaction_end (verbatim line-compaction status)
  ├─► session_before_compact (can cancel or provide compactedText)
  ├─► session_compact (after the compaction boundary is persisted)
  └─► session_compact_failed (failure or cancellation)

/tree navigation
  ├─► session_before_tree (can cancel or customize)
  └─► session_tree

/model or CTRL+P (model selection/cycling)
  ├─► thinking_level_select (if model change changes/clamps thinking level)
  └─► model_select

thinking level changes (settings, keybinding, pi.setThinkingLevel())
  └─► thinking_level_select

prompt cache warming (when enabled)
  └─► cache_warming_decision (can return `{ action: "warm" | "stop" }`)

exit (CTRL+C, CTRL+D, SIGHUP, SIGTERM)
  └─► session_shutdown
```

### Startup Events

#### project_trust

Fired before Atomic decides whether to trust a project with dynamic configs (`.atomic`, legacy `.pi`, or `.agents/skills`). It runs during startup and when session replacement (for example `/resume`) enters a cwd whose trust has not been resolved in the current process. Only user/global extensions and CLI `-e` extensions participate; project-local extensions are not loaded until after trust is resolved.

```typescript
pi.on("project_trust", async (event, ctx) => {
  // event.cwd - current working directory
  // ctx has a limited trust context: cwd, mode, hasUI, and select/confirm/input/notify UI helpers
  if (ctx.hasUI && await ctx.ui.confirm("Trust project?", event.cwd)) {
    return { trusted: "yes", remember: true };
  }
  return { trusted: "undecided" };
});
```

A `project_trust` handler must return `{ trusted: "yes" | "no" | "undecided" }`. A user/global or CLI extension that returns `"yes"` or `"no"` owns the decision; the first yes/no decision wins and suppresses the built-in trust prompt. Use `remember: true` to persist a yes/no decision; otherwise it applies only to the current process. Return `"undecided"` to let later handlers or the built-in trust flow decide. Check `ctx.hasUI` before prompting. If no handler returns yes/no, normal trust resolution continues: saved `trust.json` decisions apply first, then `defaultProjectTrust` controls whether Atomic asks, trusts, or declines by default.

### Resource Events

#### resources_discover

Fired after `session_start` so extensions can contribute additional skill, prompt, and theme paths.
The startup path uses `reason: "startup"`. Reload uses `reason: "reload"`.

```typescript
pi.on("resources_discover", async (event, _ctx) => {
  // event.cwd - current working directory
  // event.reason - "startup" | "reload"
  return {
    skillPaths: ["/path/to/skills"],
    promptPaths: ["/path/to/prompts"],
    themePaths: ["/path/to/themes"],
  };
});
```

### Session Events

See [Session Format](/session-format) for session storage internals and the SessionManager API.

#### session_start

Fired when a session is started, loaded, or reloaded.

```typescript
pi.on("session_start", async (event, ctx) => {
  // event.reason - "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile - present for "new", "resume", and "fork"
  ctx.ui.notify(`Session: ${ctx.sessionManager.getSessionFile() ?? "ephemeral"}`, "info");
});
```

#### session_info_changed

Fired when the current session display name is set via `/name`, RPC, or `pi.setSessionName()`.

```typescript
pi.on("session_info_changed", async (event, ctx) => {
  // event.name - current normalized name, or undefined if cleared
  ctx.ui.notify(`Session renamed: ${event.name ?? "(none)"}`, "info");
});
```

#### session_before_switch

Fired before starting a new session (`/new`) or switching sessions (`/resume`).

```typescript
pi.on("session_before_switch", async (event, ctx) => {
  // event.reason - "new" or "resume"
  // event.targetSessionFile - session we're switching to (only for "resume")

  if (event.reason === "new") {
    const ok = await ctx.ui.confirm("Clear?", "Delete all messages?");
    if (!ok) return { cancel: true };
  }
});
```

After a successful switch or new-session action, Atomic emits `session_shutdown` for the old extension instance, reloads and rebinds extensions for the new session, then emits `session_start` with `reason: "new" | "resume"` and `previousSessionFile`.
Do cleanup work in `session_shutdown`, then reestablish any in-memory state in `session_start`.

#### session_before_fork

Fired when forking via `/fork` or cloning via `/clone`.

```typescript
pi.on("session_before_fork", async (event, ctx) => {
  // event.entryId - ID of the selected entry
  // event.position - "before" for /fork, "at" for /clone
  return { cancel: true }; // Cancel fork/clone
  // OR
  return { skipConversationRestore: true }; // Reserved for future conversation restore control
});
```

After a successful fork or clone, Atomic emits `session_shutdown` for the old extension instance, reloads and rebinds extensions for the new session, then emits `session_start` with `reason: "fork"` and `previousSessionFile`.
Do cleanup work in `session_shutdown`, then reestablish any in-memory state in `session_start`.

#### session_before_compact / session_compact / session_compact_failed

Fired by `/compact` and auto-compaction, including a threshold crossing detected after tool results enter the prospective next-turn context. Atomic prepares the complete active transcript except for the exact newest `preserve_recent` context-visible messages. Extensions may cancel or provide a complete, non-empty `compactedText` replacement for that region; they cannot move `firstKeptEntryId`. The override is persisted verbatim and works without provider credentials. A successful post-tool compaction returns its rebuilt context directly to the already-active Pi loop; it does not start a separate continuation. Cancellation or failure prevents that loop's follow-up provider request.

```typescript
pi.on("session_before_compact", async (event) => {
  const { preparation, branchEntries, parameters, reason, signal } = event;

  // preparation.region.lines - unnumbered compactable transcript lines
  // preparation.firstKeptEntryId - fixed start of the exact tail, or null when the tail is empty
  // preparation.tokensBefore - whole-context token estimate
  // parameters - compression_ratio, preserve_recent, query
  // branchEntries - raw entries on the active branch
  // reason - "manual" | "threshold" | "overflow"
  // preparation is a deep-frozen clone

  if (signal.aborted) return { cancel: true };

  // Cancel compaction:
  return { cancel: true };

  // Or replace only the prepared region. Whitespace-only text is rejected.
  return {
    compactedText: preparation.region.lines.slice(0, 40).join("\n"),
  };
});

pi.on("session_compact", async (event) => {
  // event.result - VerbatimCompactionResult (text, boundary, stats, parameters, rung)
  // event.compactionEntry - saved CompactionEntry with strategy "verbatim-lines"
  // event.fromExtension - true when session_before_compact provided compactedText
  // Observe-only: errors are isolated after persistence.
});

pi.on("session_compact_failed", async (event) => {
  // event.reason - "manual" | "threshold" | "overflow"
  // event.errorMessage - absent for cancellation
  // event.aborted / event.willRetry - terminal state
  // event.fromExtension - whether extension-provided text was active
});
```

#### session_before_tree / session_tree

Fired on `/tree` navigation. See [Sessions](/sessions) for tree navigation concepts.

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;
  return { cancel: true };
  // OR provide custom summary:
  return { summary: { summary: "...", details: {} } };
});

pi.on("session_tree", async (event, ctx) => {
  // event.newLeafId, oldLeafId, summaryEntry, fromExtension
});
```

#### session_shutdown

Fired before a started session runtime is torn down. Use this to clean up resources opened from `session_start` or other session-scoped hooks.

```typescript
pi.on("session_shutdown", async (event, ctx) => {
  // event.reason - "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionFile - destination session for session replacement flows
  // Cleanup, save state, etc.
});
```

### Agent Events

#### before_agent_start

Fired after user submits prompt, before agent loop. Can inject a message and/or modify the system prompt.

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.prompt - user's prompt text
  // event.images - attached images (if any)
  // event.systemPrompt - current chained system prompt for this handler
  //   (includes changes from earlier before_agent_start handlers)
  // event.systemPromptOptions - structured options used to build the system prompt
  //   .customPrompt - prompt prefix from --system-prompt, SYSTEM.md, or custom templates
  //   .forceSystemPrompt - optional exact replacement for the complete prompt
  //   .selectedTools - tools currently active in the prompt
  //   .toolSnippets - one-line descriptions for each tool
  //   .toolGuidelines - guideline bullets keyed by tool name
  //   .sections - custom XML-wrapped sections keyed by tag name
  //   .promptGuidelines - custom guideline bullets
  //   .appendSystemPrompt - text from --append-system-prompt flags
  //   .cwd - working directory
  //   .contextFiles - AGENTS.md files and other loaded context files
  //   .skills - loaded skills

  return {
    // Inject a persistent message (stored in session, sent to LLM)
    message: {
      customType: "my-extension",
      content: "Additional context for the LLM",
      display: true,
    },
    // Replace the system prompt for this turn (chained across extensions)
    systemPrompt: event.systemPrompt + "\n\nExtra instructions for this turn...",
  };
});
```

The `systemPromptOptions` collections are mutable. Prefer editing `sections`, `selectedTools`, or `promptGuidelines`: Atomic records only changed prompt sections and tool declarations as chronological system messages. Editing `selectedTools`, or calling `pi.setActiveTools()` inside the handler, changes the same request's executable tools as well as their prompt contributions.

Returning `systemPrompt`, or setting `forceSystemPrompt`, replaces the complete provider prompt for the run without recording the forced text. The transcript still records structured sections. Models supporting mid-conversation system messages receive patches in place; other models receive the replayed leading prompt. A forced replacement or unsupported tool transition can invalidate the cached prefix.

Inside `before_agent_start`, `event.systemPrompt` and `ctx.getSystemPrompt()` both reflect the chained system prompt as of the current handler. Later `before_agent_start` handlers can still modify it again.

#### agent_start / agent_end / agent_before_settle / agent_settled

`agent_start` begins a low-level run. `agent_end` fires when that run ends, but Atomic may still retry, compact and retry, or deliver queued follow-ups. `agent_before_settle` is the final actionable boundary: it can append session entries and request one continuation. `agent_settled` is final and notification-only; use it when a status integration needs to know Atomic has no automatic continuation left, including a chain of repeated output-cap continuations. Silence during a provider request or between these runs is not settlement.

```typescript
pi.on("agent_start", async (_event, ctx) => {});
pi.on("agent_end", async (event, ctx) => {
  // event.messages - messages from this low-level run
});

let addedReviewReminder = false;
pi.on("agent_before_settle", async (event, ctx) => {
  if (addedReviewReminder) return;
  addedReviewReminder = true;
  return {
    entries: [...event.entries, {
      type: "custom_message",
      customType: "review-reminder",
      content: "Review the final diff before replying.",
      display: false,
    }],
    continue: true,
  };
});

pi.on("agent_settled", async (_event, ctx) => {
  // ctx.isIdle() is true; runs requested here start after all settled handlers finish.
});
```

If the run is aborted while `agent_before_settle` handlers are running, valid returned entries are still committed, but requested continuation is suppressed. Work requested from `agent_settled` is deferred until every settled handler completes, so notification dispatch is non-reentrant. Input sent from an `agent_before_settle` handler with `deliverAs: "steer"` or `"followUp"` queues for the requested continuation instead of starting a second run.

Each provider request is built from the persisted session after every queued handler for the events before it (`agent_start`, `turn_start`, `message_start`, `message_end`, `tool_execution_*`) has finished, because a `message_end` handler may replace the message that gets persisted. Handlers run without blocking the event that triggered them, but a handler that waits for something later in the same run, such as the provider's response, stalls that run; wait in `agent_end` or `agent_settled` instead.

#### ui_prompt_start / ui_prompt_end

These notification-only events wrap blocking user-facing prompts. Each event has `reason: "ui_prompt" | "project_trust"`, the prompt `kind`, and the prompt `title` when available. Host and status integrations can use the pair to distinguish waiting for the user from active work.

- `ui_prompt`: extension prompts opened through `ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.input()`, `ctx.ui.editor()`, and `ctx.ui.custom()`.
  Custom inspection/navigation components can pass `{ purpose: "navigation" }` to omit their own prompt span. The default remains `"prompt"`. A custom prompt carries a `title` only when its caller passes `{ title }`; the built-in `ask_user_question` dialog passes its first question. Nested approval calls still emit events; mounting or hiding the workflow graph is not itself an approval.
- `project_trust`: interactive startup/resume trust dialogs, trust-hook dialogs, borrowed extension-source authorization, and the built-in `/trust` selector. Silent saved/default/CLI decisions and noninteractive startup do not emit artificial waits.

Trust-safe extensions receive a live context before the trust prompt. Newly authorized project extensions load afterward and do not receive historical prompt events. Resume trust dialogs use the outgoing session context; failed preparation leaves that session active.

Nested or overlapping prompts share one outer span. Its end retains the original reason, kind, and title and fires after all nested prompts settle. Prompt display and answers never wait for observers. An observer's asynchronous start and end work can overlap, so update lifecycle state before awaiting unrelated work. During session replacement, pending notification delivery has a 1,000 ms limit; do not assume an old context remains valid beyond it.

```typescript
pi.on("ui_prompt_start", (event) => {
  // event.reason - "ui_prompt" | "project_trust"
  // event.kind - "select" | "confirm" | "input" | "editor" | "custom"
  // event.title - prompt title when available
});

pi.on("ui_prompt_end", (event) => {
  // Atomic is no longer waiting on this outer prompt span.
});
```

#### turn_start / turn_end

Fired for each turn (one LLM response + tool calls).

```typescript
pi.on("turn_start", async (event, ctx) => {
  // event.turnIndex, event.timestamp
});

let replacedResponse = false;
pi.on("turn_end", async (event, ctx) => {
  // event.turnIndex, event.message, event.toolResults
  // event.messageEntryId, event.toolResultEntryIds, event.outcome
  // event.entries contains the structural entries proposed so far.
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

`turn_end` runs after the assistant and tool-result messages have been persisted and before the low-level `turn_end` event. Retry backoff and final-attempt recovery still happen after `agent_end`, preserving their existing lifecycle and queue ordering; `agent_before_settle` sees the repaired projection after that work completes. Boundary handlers run in extension load and registration order. Each handler sees prior proposals in `event.entries` and sees `event.context` rebuilt from them (`contextEntries`, `contextMessages`, `llmMessages`, `pendingMessages`, `canContinue`). Returning `entries` or `continue` replaces only that field; omitted fields preserve the current proposal. Allowed draft entry types are `custom`, `custom_message`, `context_edit`, and `compaction` (`summary` is the compacted transcript text; `firstKeptEntryId: null` keeps no preceding entries). The complete proposal is validated before it is appended in list order after all handlers finish; a handler error is reported and later handlers still run. Validation prevents partially applied semantic errors, but persistence is not transactional.

`continue: true` ensures one next provider request for that boundary invocation. If tool results, steering, or a follow-up already cause that request, they satisfy the decision and no additional request is made; otherwise Atomic makes one context-only request. Error and aborted responses remain hard exits. `continue: false` never suppresses natural work. Guard continuation conditions: an unconditional `continue: true` is evaluated again after the next response and can create an endless loop. A `custom_message` draft contributes a user-role model message but is extension-authored: it does not run human input hooks, slash commands, skills, or prompt templates.

Host integrations that construct `TurnEndEvent` values must provide `messageEntryId`, `toolResultEntryIds`, `outcome`, `entries`, `continue`, and `context`. `ExtensionEvent` exhaustive switches must also handle `agent_before_settle`. `ExtensionRunner.emit()` excludes actionable turn boundaries; dispatch `turn_end` and `agent_before_settle` through `emitBoundary(baseEvent, buildContext)` so handlers receive chained previews.

#### message_start / message_update / message_end

Fired for message lifecycle updates.

- `message_start` and `message_end` fire for user, assistant, and toolResult messages.
- `message_update` fires for assistant streaming updates.
- `message_end` handlers can return `{ message }` to replace the finalized message. The replacement must keep the same `role`.

```typescript
pi.on("message_start", async (event, ctx) => {
  // event.message
});

pi.on("message_update", async (event, ctx) => {
  // event.assistantMessageEvent (token-by-token delta; no cumulative message)
});

pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;

  return {
    message: {
      ...event.message,
      usage: {
        ...event.message.usage,
        cost: {
          ...event.message.usage.cost,
          total: 0.123,
        },
      },
    },
  };
});
```

#### tool_execution_start / tool_execution_update / tool_execution_end

Fired for tool execution lifecycle updates.

In parallel tool mode:
- `tool_execution_start` is emitted in assistant source order during the preflight phase
- `tool_execution_update` events may interleave across tools
- `tool_execution_end` is emitted in tool completion order after each tool is finalized
- final `toolResult` message events are still emitted later in assistant source order

```typescript
pi.on("tool_execution_start", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args
});

pi.on("tool_execution_update", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args, event.partialResult
});

pi.on("tool_execution_end", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.result, event.isError
});
```

#### context

Fired before each LLM call. Modify messages non-destructively. See [Session Format](/session-format) for message types. When tool output crosses the buffered compaction threshold, the post-tool compaction preflight finishes before this hook runs for the follow-up call, so `event.messages` contains the rebuilt compacted context.

```typescript
pi.on("context", async (event, ctx) => {
  // event.messages - deep copy without system messages, safe to modify
  const filtered = event.messages.filter(m => !shouldPrune(m));
  return { messages: filtered };
});
```

`event.messages` holds the conversation without system messages. The prompt and tool declarations belong to Atomic and are not part of this hook: when the handler returns a changed list (or edits `event.messages` in place), Atomic replays the current prompt sections and tool declarations into one leading system message ahead of the returned messages. Filtering, windowing, or slicing from a compaction boundary therefore cannot drop the prompt or the tools. An unchanged list keeps mid-conversation system messages in place, so models that accept them retain their cached prefix. System messages a handler adds are kept after Atomic's head. To change the prompt or the tool set durably, use [`before_agent_start`](#before_agent_start) or `pi.setActiveTools()`; to edit system messages for one request, use [`context_with_system`](#context_with_system).

#### context_with_system

Fired before each LLM call, after every `context` handler has run and Atomic has restored the prompt and tool state. `event.messages` is the full transcript, including the leading system message and any mid-conversation prompt or tool patches (see [Session Format](/session-format)). The returned messages are sent as they are: this hook owns the prompt and tool declarations for the request.

```typescript
import { getCurrentSystemMessage } from "@bastani/pi-ai";

pi.on("context_with_system", async (event, ctx) => {
  const cut = findCutIndex(event.messages);
  // Fold the dropped prefix so its prompt and tool state survives as the new head.
  const head = getCurrentSystemMessage(event.messages.slice(0, cut));
  return { messages: head ? [head, ...event.messages.slice(cut)] : event.messages.slice(cut) };
});
```

Rules: keep a system message at index 0 (providers read the prompt and initial tool declarations there; Atomic reports an extension error if a handler drops it). Removing a system message removes the tool declarations and section patches it carries. Check your output with `getCurrentSystemPrompt()` and `getCurrentTools()` from `@bastani/pi-ai`. Handlers run in extension load order; a `systemPrompt` forced from `before_agent_start` is still projected onto the request afterwards.

#### before_provider_headers

Fires after outgoing HTTP headers are assembled. Mutate `event.headers` to add, override, or remove headers. The event also identifies the provider and model.

```typescript
pi.on("before_provider_headers", (event, ctx) => {
  event.headers["x-session-id"] = ctx.sessionManager.getSessionId();
  delete event.headers["x-remove-me"];
});
```

#### before_provider_request

Fired after the provider-specific payload is built, right before the request is sent. Handlers run in extension load order. Returning `undefined` keeps the payload unchanged. Returning any other value replaces the payload for later handlers and for the actual request.

This hook can rewrite provider-level system instructions or remove them entirely. Those payload-level changes are not reflected by `ctx.getSystemPrompt()`, which reports Atomic's system prompt string rather than the final serialized provider payload.

```typescript
pi.on("before_provider_request", (event, ctx) => {
  console.log(JSON.stringify(event.payload, null, 2));

  // Optional: replace payload
  // return { ...event.payload, temperature: 0 };
});
```

This is mainly useful for debugging provider serialization and cache behavior.

#### after_provider_response

Fired after an HTTP response is received and before its stream body is consumed. Handlers run in extension load order.

```typescript
pi.on("after_provider_response", (event, ctx) => {
  // event.status - HTTP status code
  // event.headers - normalized response headers
  if (event.status === 429) {
    console.log("rate limited", event.headers["retry-after"]);
  }
});
```

Header availability depends on provider and transport. Providers that abstract HTTP responses may not expose headers.

#### provider_stream_event

Fired for each parsed provider stream event before Atomic normalizes it into assistant message events. Use it to inspect provider-specific fields that Atomic does not keep in the assistant message.

```typescript
pi.on("provider_stream_event", (event, ctx) => {
  // event.provider, event.api, event.model - the model that produced the event
  // event.data - the parsed provider event (read-only)
  const chunk = event.data as Record<string, unknown>;
  if (chunk.openrouter_metadata) console.log(chunk.openrouter_metadata);
});
```

`event.data` is the earliest structured value available to Atomic, not necessarily the original HTTP bytes or SSE frame, and SDK-backed providers expose only the fields their SDK keeps. Treat it as read-only: changing it can change how the response is normalized. The event is notification-only and is not saved to the session. Cache-warming requests do not emit it.

Handlers run in stream order and are awaited, so a slow handler delays the response. Handler errors are reported without changing the provider response. Custom providers registered with `streamSimple` emit this event only if they call `options.onProviderStreamEvent`. See [`debug-provider.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/debug-provider.ts) for an opt-in viewer.

### Model Events

#### model_select

Fired when the model changes via `/model` command, model cycling (`CTRL+P`), or session restore.

```typescript
pi.on("model_select", async (event, ctx) => {
  // event.model - newly selected model
  // event.previousModel - previous model (undefined if first selection)
  // event.source - "set" | "cycle" | "restore"

  const prev = event.previousModel
    ? `${event.previousModel.provider}/${event.previousModel.id}`
    : "none";
  const next = `${event.model.provider}/${event.model.id}`;

  ctx.ui.notify(`Model changed (${event.source}): ${prev} -> ${next}`, "info");
});
```

Use this to update UI elements (status bars, footers) or perform model-specific initialization when the active model changes.

#### thinking_level_select

Fired when the thinking level changes. This is notification-only; handler return values are ignored.

```typescript
pi.on("thinking_level_select", async (event, ctx) => {
  // event.level - newly selected thinking level
  // event.previousLevel - previous thinking level

  ctx.ui.setStatus("thinking", `thinking: ${event.level}`);
});
```

Use this to update extension UI when `pi.setThinkingLevel()`, model changes, or built-in thinking-level controls change the active thinking level.

### Tool Events

#### tool_call

Fired after `tool_execution_start`, before the tool executes. **Can block.** Use `isToolCallEventType` to narrow and get typed inputs.

Before `tool_call` runs, Atomic waits for previously emitted Agent events to finish draining through `AgentSession`. This means `ctx.sessionManager` is up to date through the current assistant tool-calling message.

In the default parallel tool execution mode, sibling tool calls from the same assistant message are preflighted sequentially, then executed concurrently. `tool_call` is not guaranteed to see sibling tool results from that same assistant message in `ctx.sessionManager`.

`event.input` is mutable. Mutate it in place to patch tool arguments before execution.

Behavior guarantees:
- Mutations to `event.input` affect the actual tool execution
- Later `tool_call` handlers see mutations made by earlier handlers
- No re-validation is performed after your mutation
- Return values from `tool_call` control blocking via `{ block: true, reason?: string, terminate?: boolean }`
- `terminate` only applies to a blocked call; the agent stops early only when every finalized result in the batch is terminating

```typescript
import { isToolCallEventType } from "@bastani/atomic";

pi.on("tool_call", async (event, ctx) => {
  // event.toolName - "bash", "powershell", "read", "write", "edit", "find", "search", etc.
  // event.toolCallId
  // event.input - tool parameters (mutable)

  // Built-in tools: no type params needed
  if (isToolCallEventType("bash", event)) {
    // event.input is { command: string; timeout?: number }
    event.input.command = `source ~/.profile\n${event.input.command}`;

    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command", terminate: true };
    }
  }

  if (isToolCallEventType("powershell", event)) {
    // event.input is typed as PowerShellToolInput
    event.input.command = `$ErrorActionPreference = "Stop"\n${event.input.command}`;
  }

  if (isToolCallEventType("read", event)) {
    // event.input is { path: string }
    console.log(`Reading: ${event.input.path}`);
  }

  if (isToolCallEventType("search", event)) {
    // event.input is typed as SearchToolInput
    event.input.paths ??= ".";
  }
});
```

#### Typing custom tool input

Custom tools should export their input type:

```typescript
// my-extension.ts
export type MyToolInput = Static<typeof myToolSchema>;
```

Use `isToolCallEventType` with explicit type parameters:

```typescript
import { isToolCallEventType } from "@bastani/atomic";
import type { MyToolInput } from "my-extension";

pi.on("tool_call", (event) => {
  if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
    event.input.action;  // typed
  }
});
```

#### tool_result

Fired after tool execution finishes and before `tool_execution_end` plus the final tool result message events are emitted. **Can modify result.**

In parallel tool mode, `tool_result` and `tool_execution_end` may interleave in tool completion order, while final `toolResult` message events are still emitted later in assistant source order.

`tool_result` handlers chain like middleware:
- Handlers run in extension load order
- Each handler sees the latest result after previous handler changes
- Handlers can return partial patches (`content`, `details`, or `isError`); omitted fields keep their current values

After all handlers finish, Atomic normalizes image blocks returned by the tool or inserted by a handler according to `images.autoResize` before saving the result to history. If image processing fails, the original image remains in the result.

Use `ctx.signal` for nested async work inside the handler. This lets Escape cancel model calls, `fetch()`, and other abort-aware operations started by the extension.

```typescript
import { isBashToolResult, isPowerShellToolResult, isSearchToolResult } from "@bastani/atomic";

pi.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input
  // event.content, event.details, event.isError

  if (isBashToolResult(event)) {
    // event.details is typed as BashToolDetails
  }

  if (isPowerShellToolResult(event)) {
    // event.details is typed as PowerShellToolDetails | undefined
  }

  if (isSearchToolResult(event)) {
    // event.details is typed as SearchToolDetails | undefined
  }

  const response = await fetch("https://example.com/summarize", {
    method: "POST",
    body: JSON.stringify({ content: event.content }),
    signal: ctx.signal,
  });

  // Modify result:
  return { content: [...], details: {...}, isError: false };
});
```

### User Bash Events

#### user_bash

Fired when user executes `!` or `!!` commands. **Can intercept.**

```typescript
import { createLocalBashOperations } from "@bastani/atomic";

pi.on("user_bash", (event, ctx) => {
  // event.command - the bash command
  // event.excludeFromContext - true if !! prefix
  // event.cwd - working directory

  // Option 1: Provide custom operations (e.g., SSH)
  return { operations: remoteBashOps };

  // Option 2: Wrap atomic's built-in local bash backend
  const local = createLocalBashOperations();
  return {
    operations: {
      exec(command, cwd, options) {
        return local.exec(`source ~/.profile\n${command}`, cwd, options);
      }
    }
  };

  // Option 3: Full replacement - return result directly
  return { result: { output: "...", exitCode: 0, cancelled: false, truncated: false } };
});
```

### Input Events

#### input

Fired when user input is received, after extension commands are checked but before skill and template expansion. The event sees the raw input text, so `/skill:foo` and `/template` are not yet expanded.

Direct `session.steer()` and `session.followUp()` calls also run input handlers before skill/template expansion and queue admission. A handled input is not queued; transformed text and images are queued instead. Their optional third argument sets `source`, defaulting to `interactive`; RPC queue commands use `rpc`.

**Processing order:**
1. Extension commands (`/cmd`) checked first - if found, handler runs and input event is skipped
2. `input` event fires - can intercept, transform, or handle
3. If not handled: skill commands (`/skill:name`) expanded to skill content
4. If not handled: prompt templates (`/template`) expanded to template content
5. Agent processing begins (`before_agent_start`, etc.)

```typescript
pi.on("input", async (event, ctx) => {
  // event.text - raw input (before skill/template expansion)
  // event.images - attached images, if any
  // event.source - "interactive" (typed), "rpc" (API), or "extension" (via sendUserMessage)

  // Transform: rewrite input before expansion
  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };

  // Handle: respond without LLM (extension shows its own feedback)
  if (event.text === "ping") {
    ctx.ui.notify("pong", "info");
    return { action: "handled" };
  }

  // Route by source: skip processing for extension-injected messages
  if (event.source === "extension") return { action: "continue" };

  // Intercept skill commands before expansion
  if (event.text.startsWith("/skill:")) {
    // Could transform, block, or let pass through
  }

  return { action: "continue" };  // Default: pass through to expansion
});
```

**Results:**
- `continue` - pass through unchanged (default if handler returns nothing)
- `transform` - modify text/images, then continue to expansion
- `handled` - skip agent entirely (first handler to return this wins)

Transforms chain across handlers. See [input-transform.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/input-transform.ts) and [input-transform-streaming.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/input-transform-streaming.ts) for `streamingBehavior`-aware routing.

## Workflow activity and lifecycle hooks

The host exposes typed workflow observation contracts. A workflow provider must register and publish activity; these APIs alone do not connect the workflow scheduler. Without a publisher snapshot, availability is `unavailable`, not an empty ready state.

Use `ctx.observeWorkflowActivity` rather than importing internal workflow helpers. Root summaries distinguish live work from stored history: independent work remains `working` even when another stage needs attention; paused roots are `idle`, and unresolved waits without progressing work are `blocked`. A control event does not prove execution has stopped.

The workflows extension registers a publisher on activation and publishes this activity stream for its owning session: root snapshots and changes, plus `workflow_lifecycle`, `workflow_stage_completed`, and `workflow_heartbeat` hooks (the runtime state table is in [`workflows/operations.md`](/workflows/operations#workflow-activity-for-extensions)). It does not change chat notifications. The built-in [Herdr reporter](/herdr) consumes this stream to reflect workflow execution and human-input waits in the owning pane.

| Hook | Payload and semantics |
| --- | --- |
| `workflow_lifecycle` | `WorkflowLifecycleEvent`: run, stage, tool, or prompt target with typed status, optional previous status, event identity, cursor, ownership, timestamps, and `live` or `replay` delivery. Run targets may carry a control `action`, distinct from its eventual outcome. |
| `workflow_activity_changed` | `WorkflowActivityChangedEvent`: full root replacement and the same cursor as the observer's `changed` frame. No initial snapshot guarantee. |
| `workflow_stage_completed` | `WorkflowStageCompletedEvent`: the lifecycle envelope with a stage target whose status is `completed`. Shares the lifecycle event ID and cursor. Failed, skipped, cancelled, and killed outcomes do not produce this hook. |
| `workflow_heartbeat` | `WorkflowHeartbeatEvent`: run/root/owner identity, `scheduledAt`, and `intervalMinutes`. Observation only, with no scheduler or cadence change. |

Run control actions describe the caller's request: an already-aborted caller signal still emits `kill` after run registration, and a whole-run pause at a task-result checkpoint emits `pause` while graceful suspension retains the paused outcome and `exitReason: "quit"`. A control event alone does not mean execution has drained.

Use `ctx.observeWorkflowActivity` for status consumers. Registration captures a snapshot atomically with attaching the observer. Delivery is asynchronous, snapshot first, then FIFO updates. Each callback finishes before the next callback for that observer starts; a slow observer does not delay the publisher or other observers.

```typescript
import type { ExtensionAPI, WorkflowActivitySubscription, WorkflowRootActivity } from "@bastani/atomic";

export default function (pi: ExtensionAPI) {
  let lease: WorkflowActivitySubscription | undefined;
  const roots = new Map<string, WorkflowRootActivity>();

  pi.on("session_start", (_event, ctx) => {
    lease?.dispose();
    lease = ctx.observeWorkflowActivity((frame) => {
      if (frame.kind === "snapshot") {
        roots.clear();
        if (frame.availability !== "ready") {
          // Unknown activity must not be interpreted as idle.
          return;
        }
        for (const root of frame.roots) roots.set(root.rootRunId, root);
      } else if (frame.kind === "changed") {
        roots.set(frame.root.rootRunId, frame.root);
      } else {
        roots.delete(frame.rootRunId);
      }
    });
  });
  pi.on("session_shutdown", () => lease?.dispose());
  pi.on("workflow_stage_completed", (event) => {
    // Canonical nested identity, not the display name.
    console.log(event.eventId, event.target.stageId, event.delivery);
  });
}
```

Frames are ordinary objects with a `{ epoch: string, revision: number }` cursor. Revisions increase within an epoch; lifecycle publication may leave gaps between activity revisions. A new publisher starts a new epoch and an `unavailable` snapshot. Never compare revision numbers across epochs. A `ready` snapshot has a `roots` array, including an empty array when known empty. `recovering` and `unavailable` snapshots omit `roots`. Subsequent snapshots replace all prior knowledge. Changes replace a complete root, not increment counters. Removals contain `rootRunId`. Root summaries include `state`, `reason`, execution/wait counts, and `needsAttention`.

Providers call `pi.registerWorkflowActivityPublisher()` and retain its returned `WorkflowActivityPublisher`. Its methods are `publishSnapshot({ availability: "ready", roots })`, `publishSnapshot({ availability: "recovering" | "unavailable" })`, `publishChanged(root)`, `publishRemoved(rootRunId)`, `publishLifecycle(event)`, `publishHeartbeat(event)`, and `dispose()`. Lifecycle input includes `type: "workflow_lifecycle"` and the envelope except `cursor`, which the host supplies. Heartbeat input includes `type: "workflow_heartbeat"`. IDs, names, timestamps, zero counts and optional attribution are preserved. Roots are keyed by `rootRunId`; duplicate snapshot IDs use the last value at the first insertion position. Removing an absent ID is permitted. Changes do not turn an unknown source into `ready`; publish a snapshot to establish readiness.

Workflow hooks published during extension factory initialization are retained until the runner binds dispatch, then delivered asynchronously in publication order before later live publications. Buffered events keep their original payloads and cursors; publisher retirement and runner disposal fence them just like live events.

Observation leases and publisher disposal are idempotent. Runner retirement on reload disposes every observer and fences publishers. Already-running callbacks cannot be cancelled, but no queued observer callbacks run after disposal. Runner retirement, publisher disposal, and publisher replacement also fence every workflow hook handler that has not started, including later handlers in the same or another extension when a previous handler is awaiting. Already-published activity frames remain ordered before the new source snapshot. Activity recovery never synthesizes lifecycle completions; explicit lifecycle replay retains the supplied event ID and `delivery: "replay"`.

The host hub retains at most 256 diagnostics, available through its host-side `diagnostics()` inspection API. These are diagnostic records, not thrown observation errors:

- `ObserverDisposed`: an observation lease was retired.
- `SourceRecovering`: the provider is hydrating state.
- `SourceUnavailable`: no current source snapshot is known.
- `ObserverDeliveryFailed`: a callback threw or rejected; other observers and publication continue.
- `ObserverOverflow`: a per-observer queue reached its 256-frame limit. Pending frames are cleared and a fresh snapshot replaces them, invalidating continuity instead of silently losing updates.
- `PublisherFenced`: a disposed or superseded publisher attempted publication.

## Next steps

Continue with [extension UI](/extensions/ui) to add user interaction. Look up the context available to event handlers in the [Extension API reference](/extensions/api-reference#extensioncontext).
