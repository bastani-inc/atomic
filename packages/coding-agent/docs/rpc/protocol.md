---
title: "RPC protocol reference"
sidebarTitle: "RPC protocol"
description: "Reference for every Atomic RPC command, streamed event, structured error code, and JSON wire type."
---

## Commands

### Stored session summaries

These read-only commands do not start a model turn. Stored summaries remain available even when `sessionSummary.enabled` is `false`.

| Command | Response `data` | TypeScript `RpcClient` method |
| --- | --- | --- |
| `{"type":"get_session_summary"}` | `{ summary: SessionSummaryEntry \| null }`, including `summary` and `summarizedThroughId`; always `null` for an unsaved (`--no-session`) session | `getSessionSummary()` |
| `{"type":"list_sessions"}` | `{ sessions: RpcSessionInfo[] }` for the current project or session directory, including `summary` and `summarizedThroughId`; `created` and `modified` are ISO strings | `listSessions()` |

### Prompting

#### prompt

Send a user prompt to the agent. Atomic emits the command response once the prompt is accepted, queued, or handled. Session events then stream asynchronously.

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

With images:

```json
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

**During streaming:** If the agent is already streaming, pass `streamingBehavior` to queue the message:

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"`: queue the message for delivery after the current assistant turn finishes its tool calls, before the next model request.
- `"followUp"`: hold the message until the active run stops.

Sending `prompt` during streaming without `streamingBehavior` returns an error response.

**Extension commands:** If `message` invokes an extension command (such as `/mycommand`), it executes immediately even while streaming. Extension commands manage their own model interaction through `atomic.sendMessage()`.

**Input expansion:** Skill commands (`/skill:name`) and prompt templates (`/template`) expand before sending or queueing.

Response:

```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true, "data": {"disposition": "started"}}
```

`data.disposition` reports how Atomic accepted the prompt:

- `"handled"`: an extension command or input handler consumed it; no turn started, so do not wait for `agent_end` or `agent_settled`.
- `"queued"`: queued during an active run, held while the queue was paused, or held during compaction. A prompt held during compaction runs once compaction ends; if starting that turn fails (for example, missing credentials), the message stays queued and Atomic emits `agent_continue_error` with `source: "post_compaction"`.
- `"started"`: Atomic started a run for this prompt.

`success: true` means the prompt was accepted, queued, or handled. `success: false` means it was rejected before acceptance. Failures after acceptance appear on the event stream rather than as a second `response` for the same request ID.

Each optional entry in `images` uses `ImageContent` format: `{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}`.

#### steer

Queue a steering message while the agent is running. Atomic delivers it after the current assistant turn finishes its tool calls, before the next model call.

If no run is active and the session already has messages, Atomic starts a turn to deliver it (so a `prompt` sent during that turn requires `streamingBehavior`). On an empty session, or after `abort`, the message stays queued until the next `prompt`. Skill commands and prompt templates expand; extension commands are rejected (use `prompt` instead).

```json
{"type": "steer", "message": "Stop and do this instead"}
```

With optional images:

```json
{"type": "steer", "message": "Look at this instead", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

Response:

```json
{"type": "response", "command": "steer", "success": true, "data": {"disposition": "queued"}}
```

`data.disposition` is `"handled"` when an input handler consumed the message, or `"queued"` when Atomic queued it. See [set_steering_mode](#set_steering_mode) for delivery behavior.

#### follow_up

Queue a follow-up message to run after the agent finishes, once no tool calls or steering messages remain.

If no run is active and the session already has messages, Atomic starts a turn to deliver it. On an empty session, or after `abort`, the message stays queued until the next `prompt`. Skill commands and prompt templates expand; extension commands are rejected.

```json
{"type": "follow_up", "message": "After you're done, also do this"}
```

With optional images:

```json
{"type": "follow_up", "message": "Also check this image", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

Response:

```json
{"type": "response", "command": "follow_up", "success": true, "data": {"disposition": "queued"}}
```

`data.disposition` is `"handled"` or `"queued"`. See [set_follow_up_mode](#set_follow_up_mode).

#### abort

Abort the current operation and wait for the session to become idle before responding.

Like `Esc` in the TUI, `abort` holds queued messages first: queued steering and follow-up messages, plus notices arriving afterward (such as background command completions), wait instead of starting a new turn.

The next `prompt` releases the hold and includes them in its turn. If the client paused the queue with `pause_queued_messages` before or after `abort`, the hold stays active until `resume_queued_messages`. If the process shuts down while a notice is held, Atomic saves the notice and displays it once when the session reopens.

```json
{"type": "abort"}
```

Response:

```json
{"type": "response", "command": "abort", "success": true}
```

#### clear_queue

Remove all queued steering and follow-up messages and return them.

The response lists the exact messages removed by this call, including anything queued after the last `queue_update` event and excluding messages already taken into a turn. Restore an editor from this response rather than from cached `queue_update` state.

```json
{"type": "clear_queue"}
```

Response:

```json
{
  "type": "response",
  "command": "clear_queue",
  "success": true,
  "data": {
    "steering": ["Change direction (rewritten)"],
    "followUp": ["Summarize when finished"],
    "typed": {
      "steering": ["Change direction"],
      "followUp": ["Summarize when finished"]
    },
    "images": {
      "steering": [null],
      "followUp": [null]
    }
  }
}
```

`steering` and `followUp` contain each message after `input` hooks, skill expansion, and prompt templates ran. `typed` contains the original submitted text when any message was transformed; restore `typed` when returning text to a user editor so expansions do not run twice (`typed` is omitted when nothing was transformed). Optional `images` carries `{ steering: (ImageContent[] | undefined)[], followUp: (ImageContent[] | undefined)[] }` aligned with the cleared messages.

To mirror interactive `Esc`, send `clear_queue` before `abort` and restore the returned messages in your editor.

#### pause_queued_messages

Hold queued steering messages, follow-up messages, and arrival notices so they do not start a new turn until released by `resume_queued_messages`.

```json
{"type": "pause_queued_messages"}
```

Response:

```json
{"type": "response", "command": "pause_queued_messages", "success": true}
```

#### resume_queued_messages

Release a queued-message hold placed by `pause_queued_messages` or `abort`.

```json
{"type": "resume_queued_messages"}
```

Response:

```json
{"type": "response", "command": "resume_queued_messages", "success": true, "data": {"released": true}}
```

`data.released` is `true` if held messages were released into processing, or `false` if nothing was waiting.

#### new_session

Start a fresh session. A `session_before_switch` extension hook can cancel it.

```json
{"type": "new_session"}
```

With optional parent session tracking:

```json
{"type": "new_session", "parentSession": "parent-session-id"}
```

Response:

```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled:

```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": true}}
```

#### delete_session

Delete a stored session and its entries from the active session store (SQLite or JSONL). Use `list_sessions` to discover IDs.

```json
{"id": "req-2", "type": "delete_session", "sessionId": "019fdf86-cf98-7327-8a73-21365028f6ae"}
```

`sessionId` selects the session to delete, while `id` is the request correlation ID echoed in the response. If `sessionId` is omitted, `id` is used as the session ID too; if both are present, `sessionId` wins. Omitting both returns an error (`delete_session requires sessionId`).

Response:

```json
{"id": "req-2", "type": "response", "command": "delete_session", "success": true}
```

You cannot delete the session currently open in this process; start or switch to another session first. Deleting an ID that does not exist succeeds without error.

```json
{"id": "req-2", "type": "response", "command": "delete_session", "success": false, "error": "Cannot delete the session that is currently open: 019fdf86-cf98-7327-8a73-21365028f6ae"}
```

TypeScript `RpcClient` method: `deleteSession(sessionId)`.

### State

#### get_state

Return the current session state.

```json
{"type": "get_state"}
```

Response:

```json
{
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {},
    "thinkingLevel": "medium",
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "all",
    "followUpMode": "one-at-a-time",
    "sessionLocation": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "sessionName": "my-feature-work",
    "autoCompactionEnabled": true,
    "messageCount": 5,
    "pendingMessageCount": 0,
    "queuedMessagesPaused": false,
    "projectTrusted": true,
    "resourceErrors": [{"path": "/path/to/extension.ts", "error": "Failed to load extension: ..."}],
    "resourceWarnings": []
  }
}
```

Key fields on `data`:

- `model`: full [Model](#model-type) object when a model is selected, or **omitted** (not `null`) when no model is active. Its `contextWindow` is the model's token budget.
- `modelFallbackMessage` / `modelFallbackReason`: present when startup fell back from a requested or default model.
- `sessionName`: display name set via `set_session_name` or `--name`, omitted when unset.
- `queuedMessagesPaused`: `true` when queued message delivery is currently held.
- `retryStatus`: present while waiting to retry or switch fallback models; carries the `auto_retry_start` or `model_fallback_start` event (and `retryAt` in Unix epoch milliseconds for retries). Use `retryStatus` rather than `isStreaming` to render retry waits.
- `turnStartedAt`: Unix epoch timestamp in milliseconds of the active turn's first request; stays stable across retries and fallbacks and is omitted when idle.
- `compactionReason` / `compactionStartedAt`: present only while `isCompacting` is `true`, reporting why compaction started and its start timestamp in Unix epoch milliseconds.
- `projectTrusted` / `pendingProjectResourcesTrusted`: current project trust state while deciding or after trust resolution.
- `resourceErrors` / `resourceWarnings`: extension load failures and warnings from the last startup or reload.
- `resourceOverlaps` / `resourceExtensions`: overlapping resource diagnostics and loaded extension descriptors (`{ path, sourceInfo?, hidden }`).

#### get_messages

Return all messages in the active conversation branch.

```json
{"type": "get_messages"}
```

Response:

```json
{
  "type": "response",
  "command": "get_messages",
  "success": true,
  "data": {"messages": []}
}
```

Messages are `AgentMessage` objects (see [Types](#types)).

#### stop_all_background

Cancel every running or queued background subagent and background shell owned by this session (including shells started by its subagents).

```json
{"type": "stop_all_background"}
```

Response:

```json
{
  "type": "response",
  "command": "stop_all_background",
  "success": true,
  "data": {
    "agents": 1,
    "shells": 2,
    "failures": []
  }
}
```

`agents` and `shells` count the tasks cancelled; `failures` lists descriptive messages for any tasks that could not be stopped.

### Model

#### set_model

Switch to a specific model. Pass optional `thinkingLevel` (`"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"`) to set both model and reasoning level in one call. Unsupported levels for that model clamp to a supported level; unrecognized values return an error response without changing the model.

Omit `persist` (or pass `false`) to change only the active session. Pass `"persist": true` to also save `defaultProvider`, `defaultModel`, and the effective thinking level in global settings, matching interactive `/model`.

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

Persist as the startup default with an explicit reasoning level:

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514", "thinkingLevel": "high", "persist": true}
```

Response contains the full [Model](#model-type) object:

```json
{
  "type": "response",
  "command": "set_model",
  "success": true,
  "data": {}
}
```

When `persist` is `true`, `data` also includes `persistedDefaults` (`{ provider, modelId, thinkingLevel, defaultThinkingLevel }`) reflecting the global settings file without project overrides. Use `get_state` to read the live session model and thinking level.

#### cycle_model

Cycle to the next available model. Pass optional `direction` (`"forward"` or `"backward"`, default `"forward"`) and optional `persist: true` to save the cycled model as the startup default.

Returns `null` when fewer than two authenticated models are available in the active scope or catalog. When an unsupported saved default is blocking prompts, a cycle that selects a different model clears that block; a `null` or unchanged result does not.

```json
{"type": "cycle_model", "direction": "forward"}
```

Response:

```json
{
  "type": "response",
  "command": "cycle_model",
  "success": true,
  "data": {
    "model": {},
    "thinkingLevel": "medium",
    "isScoped": false
  }
}
```

`model` is a full [Model](#model-type) object. With `persist: true`, `data` includes `persistedDefaults` in the same format as [`set_model`](#set_model).

#### set_scoped_models

Replace the active session's model-cycling scope. Model cycling and scoped searches apply the new list immediately. Pass `"models": []` to clear the cycling restriction.

```json
{"type": "set_scoped_models", "models": [{"provider": "openai", "modelId": "o3", "thinkingLevel": "high"}]}
```

- `models` must be an array of `{ provider, modelId, thinkingLevel? }` objects; non-array values or unrecognized `thinkingLevel` values return an error response without mutating state.
- Entries matching a model known to the model runtime are added to `scopedModels` (even if unauthenticated); unknown model references are ignored.
- Optional `enabledModels` updates global `enabledModels` patterns in `settings.json` (project settings stay unchanged). Omit it to leave saved settings alone, pass an array of pattern strings (same exact, glob, and fuzzy syntax as `--models`), or pass `null` to clear saved restrictions. Non-string array entries or invalid types return an error response without modifying settings.

Response has `command: "set_scoped_models"` and the same catalog `data` shape as [`get_available_models`](#get_available_models), including the updated `scopedModels`.

#### get_available_models

List all configured models and auth metadata.

```json
{"type": "get_available_models"}
```

Response contains an array of full [Model](#model-type) objects:

```json
{
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": [],
    "scopedModels": [],
    "compactorModels": [],
    "customAuthProviders": [],
    "oauthProviders": [],
    "providerAuthStatuses": []
  }
}
```

- `compactorModels`: dedicated compactor models registered in the session (`morph/morph-compactor`, custom `models.json` compactors, and extension-registered compactors).
- `customAuthProviders`: extension-registered providers (`{ id, name }`) accepting API-key login through `login_provider`.
- `oauthProviders`: providers supporting interactive OAuth login through `login_provider`.
- `providerAuthStatuses`: auth status of extension-registered providers (`{ provider, status }`, where `status` is `{ configured, source?, label? }`) when credentials do not come from `auth.json` (for example, an environment variable).

The raw subprocess protocol returns full `Model` objects. The TypeScript `RpcClient.getAvailableModels()` helper returns the compact `ModelInfo` shape (`provider`, `id`, `contextWindow`, `reasoning`, plus optional `compat`). When present, `compat` exposes constrained-sampling flags (`supportsStrictTools`, `supportsStrictMode`, `supportsOpenAIGrammarTools`, and the synchronized `supportsGrammarTools` alias). Treat omitted flags as unsupported; do not infer support from provider names.

```typescript
const models = await client.getAvailableModels();
const capabilities = models[0]?.compat;
if (capabilities?.supportsStrictTools) {
  // The selected model advertises Anthropic/Bedrock strict-tool support.
}
```

#### login_provider

Start an API-key or interactive OAuth sign-in flow for a provider, save the resulting credential, and refresh the catalog.

```json
{"type": "login_provider", "provider": "anthropic", "authType": "oauth", "loginId": "login-1"}
```

- `authType`: `"oauth"` or `"api_key"` (defaults to `"api_key"` when omitted).
- `loginId`: optional correlation string echoed on `oauth_*` extension UI requests so you can cancel a specific login with `cancel_login_provider`.
- For `"oauth"`, Atomic emits `oauth_*` requests over the [RPC extension UI protocol](/rpc/extension-ui#oauth-login-methods) and waits for interactive prompt responses.

Response when sign-in succeeds (returns the refreshed `RpcModelCatalog` plus `provider` and `cancelled: false`, without echoing the raw secret):

```json
{
  "type": "response",
  "command": "login_provider",
  "success": true,
  "data": {
    "provider": "anthropic",
    "cancelled": false,
    "models": [],
    "scopedModels": [],
    "customAuthProviders": []
  }
}
```

If cancelled:

```json
{"type": "response", "command": "login_provider", "success": true, "data": {"provider": "anthropic", "cancelled": true}}
```

#### cancel_login_provider

Cancel an in-flight `login_provider` flow. Pass the same `provider` and optional `loginId`.

```json
{"type": "cancel_login_provider", "provider": "anthropic", "loginId": "login-1"}
```

Response:

```json
{"type": "response", "command": "cancel_login_provider", "success": true}
```

#### save_provider_credential

Persist a provider `Credential` object directly (without driving interactive prompts) and return the refreshed model catalog.

```json
{
  "type": "save_provider_credential",
  "provider": "openai",
  "credential": {"type": "api_key", "key": "sk-..."},
  "refreshCatalog": true
}
```

`refreshCatalog` defaults to `true` (fetches the remote catalog before publishing the credential). Response `data` has the same `RpcModelCatalog` shape as [`get_available_models`](#get_available_models).

#### logout_provider

Remove a provider's stored credential in the running Atomic process, refresh its available-model catalog, and return the remaining auth status and catalog. Environment variables and `models.json` auth are reported but never modified.

```json
{"type": "logout_provider", "provider": "github-copilot"}
```

Response:

```json
{
  "type": "response",
  "command": "logout_provider",
  "success": true,
  "data": {
    "provider": "github-copilot",
    "authStatus": {"configured": false},
    "models": [],
    "scopedModels": []
  }
}
```

If authentication still comes from an environment variable, `authStatus.source` is `"environment"` and `authStatus.label` names the variable.

#### refresh_models

Refresh provider model catalogs and return the updated catalog plus any per-provider refresh errors.

```json
{"type": "refresh_models", "timeoutMs": 15000, "force": true, "allowNetwork": true}
```

All options (`timeoutMs`, `force`, `allowNetwork`) are optional.

Response:

```json
{
  "type": "response",
  "command": "refresh_models",
  "success": true,
  "data": {
    "models": [],
    "scopedModels": [],
    "customAuthProviders": [],
    "oauthProviders": [],
    "providerAuthStatuses": [],
    "aborted": false,
    "errors": []
  }
}
```

### Thinking

#### set_thinking_level

Set the reasoning level for models that support it. Omit `persist` (or pass `false`) to change only the current session. Pass `"persist": true` to also save `defaultThinkingLevel` and, when a model is active, its per-model override.

```json
{"type": "set_thinking_level", "level": "high"}
```

Persist as the startup default:

```json
{"type": "set_thinking_level", "level": "high", "persist": true}
```

Valid levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`. Passing an unrecognized `level` returns an error response (`success: false`) without changing session state or settings.

`xhigh` and `max` apply only when the active model supports them; valid levels unsupported by the current model clamp to a supported level.

Current Atomic versions include the effective level after capability clamping and, when a model is active, the provider and model persisted against:

```json
{"type": "response", "command": "set_thinking_level", "success": true, "data": {"level": "high", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}}
```

Older clients may also encounter a data-less success response (`{"type": "response", "command": "set_thinking_level", "success": true}`). Record persisted overrides against the acknowledgement's `provider` and `modelId`, and keep newer `thinking_level_changed` events if an older acknowledgement arrives later. `RpcClient.setThinkingLevel(level)` remains a one-argument `Promise<void>` method.

#### cycle_thinking_level

Cycle through thinking levels supported by the active model. Returns `data: null` if the model does not support thinking.

```json
{"type": "cycle_thinking_level"}
```

Response:

```json
{
  "type": "response",
  "command": "cycle_thinking_level",
  "success": true,
  "data": {"level": "high"}
}
```

#### get_available_thinking_levels

Return the thinking levels supported by the current model, in cycle order.

```json
{"type": "get_available_thinking_levels"}
```

Response:

```json
{
  "type": "response",
  "command": "get_available_thinking_levels",
  "success": true,
  "data": {"levels": ["off", "low", "medium", "high"]}
}
```

### Queue modes

#### set_steering_mode

Control how steering messages queued by `steer` are delivered.

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

Modes:

- `"all"`: deliver all queued steering messages after the current assistant turn finishes its tool calls.
- `"one-at-a-time"`: deliver one steering message per completed assistant turn (default).

Response:

```json
{"type": "response", "command": "set_steering_mode", "success": true}
```

#### set_follow_up_mode

Control how follow-up messages queued by `follow_up` are delivered.

```json
{"type": "set_follow_up_mode", "mode": "one-at-a-time"}
```

Modes:

- `"all"`: deliver all queued follow-up messages when the agent finishes.
- `"one-at-a-time"`: deliver one follow-up message per agent completion (default).

Response:

```json
{"type": "response", "command": "set_follow_up_mode", "success": true}
```

### Compaction

#### compact

Stop the active run and compact the session by clearing the context window or replacing it with the configured compactor model's output. Optional `instructions` is added to the boundary message and passed as the compactor query (like `/compact <instructions>`). Rejects with `Nothing to compact` if nothing has entered the context since the last boundary. See [Compaction](/compaction) for details.

```json
{"type": "compact", "instructions": "keep the migration plan"}
```

Response:

```json
{
  "type": "response",
  "command": "compact",
  "success": true,
  "data": {
    "compactedText": "Context cleared. Your earlier conversation (150,000 tokens) is no longer in your context window. ...",
    "firstKeptEntryId": null,
    "tokensBefore": 150000,
    "promptVersion": 7,
    "parameters": {"query": "keep the migration plan"},
    "form": "cleared",
    "history": {"sessionId": "abc123", "rangeUnit": "entries", "entriesBefore": 42, "boundaryEntry": 43, "totalEntries": 44},
    "stats": {
      "linesBefore": 812,
      "linesDeleted": 812,
      "linesKept": 0,
      "rangeCount": 0,
      "tokensBefore": 150000,
      "tokensAfter": 2400,
      "percentReduction": 98.4
    },
    "backupPath": "/path/to/session.jsonl.2026-06-06T00-00-00-000Z.compact.bak"
  }
}
```

`compactedText` is the full boundary message seen by the model. `firstKeptEntryId` is always `null`. `form` is `"cleared"` or `"compacted"`; compacted results also carry `backend` (`"compactor"` or `"extension"`) and, for a compactor, `model`. `fallbackReason` explains why a configured compactor was skipped. See [Persistence and resume](/compaction/reference#persistence-and-resume).

`RpcClient.compact(instructions?)` sends this command and resolves with `data`.

#### set_auto_compaction

Enable or disable automatic compaction when context approaches the model limit.

```json
{"type": "set_auto_compaction", "enabled": true}
```

Response:

```json
{"type": "response", "command": "set_auto_compaction", "success": true}
```

#### set_compaction_model

Switch the active compaction model immediately without restarting or reloading, and persist it to global or project settings. Pass `""` or `"auto"` for Automatic (clear and recover), or an exact compactor `provider/model` ID.

```json
{"type": "set_compaction_model", "model": "my-compactor/compact-v2", "scope": "global"}
```

Response:

```json
{"type": "response", "command": "set_compaction_model", "success": true}
```

#### set_decision_model

Switch the active decision model immediately without restarting or reloading, and persist it to global or project settings. Pass `""` or `"auto"` for Automatic (current chat model), or an exact registered classifier or chat `provider/model` ID.

```json
{"type": "set_decision_model", "model": "typesafe/jev-latest", "scope": "global"}
```

Response:

```json
{"type": "response", "command": "set_decision_model", "success": true}
```

#### abort_compaction

Abort an in-progress compaction run.

```json
{"type": "abort_compaction"}
```

Response:

```json
{"type": "response", "command": "abort_compaction", "success": true}
```

#### abort_branch_summary

Abort an in-progress branch summary run (for example during `navigate_tree` with `summarize: true`).

```json
{"type": "abort_branch_summary"}
```

Response:

```json
{"type": "response", "command": "abort_branch_summary", "success": true}
```

#### set_background_compaction

Background compaction was removed. `set_background_compaction` and `set_background_compaction_threshold` remain accepted as no-ops for backward compatibility.

```json
{"type": "set_background_compaction", "enabled": false}
```

Response:

```json
{"type": "response", "command": "set_background_compaction", "success": true}
```

### Extension UI

#### set_extension_ui_capabilities

Declare which optional extension UI methods the client supports. With `questionnaire: true`, `ask_user_question` sends one [`questionnaire`](/rpc/extension-ui#questionnaire) request instead of failing for lack of a terminal. Off by default; omitted fields retain their current values.

```json
{"type": "set_extension_ui_capabilities", "questionnaire": true}
```

Response:

```json
{"type": "response", "command": "set_extension_ui_capabilities", "success": true}
```

Older Atomic versions that lack this command return an error response, so clients can send it at startup and fall back when unsupported.

### Debug

#### set_debug

Enable or disable [debug mode](/development#debugging) for this Atomic process and child processes it starts afterward. Does not modify the saved `debug` setting. Passing a non-boolean `enabled` returns an error response without changing state.

```json
{"type": "set_debug", "enabled": true}
```

Response:

```json
{"type": "response", "command": "set_debug", "success": true}
```

Error response for a non-boolean value (reports the received type, never the value):

```json
{
  "type": "response",
  "command": "set_debug",
  "success": false,
  "error": "Invalid debug setting: enabled is string, not a boolean (invalid-setting). Pass true or false.",
  "errorCode": "debug_error",
  "errorDetails": {
    "name": "DebugConfigError",
    "code": "invalid-setting",
    "message": "Invalid debug setting: enabled is string, not a boolean (invalid-setting). Pass true or false.",
    "hint": "Pass true or false.",
    "retryable": false,
    "fields": {"source": "rpc", "field": "enabled", "received": "string"}
  }
}
```

`errorDetails` is a serialized [debug error](/sdk/reference#debug-errors) that `RpcClient` rehydrates automatically.

### Retry

#### set_auto_retry

Enable or disable automatic retry on transient provider errors (overloaded, rate limit, 5xx).

```json
{"type": "set_auto_retry", "enabled": true}
```

Response:

```json
{"type": "response", "command": "set_auto_retry", "success": true}
```

#### abort_retry

Cancel a retry or fallback wait already in progress. If the initial request is still running and no retry has started, `abort_retry` does nothing; use `abort` to cancel the active request.

```json
{"type": "abort_retry"}
```

Response:

```json
{"type": "response", "command": "abort_retry", "success": true}
```

### Shell commands

#### bash

Execute a shell command through Atomic's `user_bash` extension hooks and add its output to conversation context (unless `excludeFromContext: true`).

```json
{"id": "req-1", "type": "bash", "command": "ls -la", "excludeFromContext": false}
```

Response:

```json
{
  "id": "req-1",
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "total 48\ndrwxr-xr-x ...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": false
  }
}
```

While running, Atomic emits ordered stdout/stderr deltas correlated by the command `id`:

```json
{"type": "bash_execution_update", "id": "req-1", "channel": "stdout", "delta": "building...\n"}
{"type": "bash_execution_update", "id": "req-1", "channel": "stderr", "delta": "warning\n"}
```

`channel` is `"stdout"` or `"stderr"`. Concurrent bash commands may interleave globally but keep distinct IDs. Request ownership survives `new_session`, `switch_session`, `import_session`, `fork`, and `clone`: deltas keep the original ID and results record only into the originating session. Exactly one `response` ends each request.

If output was truncated, `data.fullOutputPath` points to the full log inside the owner- and session-scoped temp directory (`<tmpdir>/atomic-<uid>/<session-id>/`; see [Persisted tool output](/tools#persisted-tool-output)). `fullOutputPath` is `null` if the log could not be written.

```json
{
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "truncated output...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": true,
    "fullOutputPath": "/tmp/atomic-501/019fdf86-cf98-7327-8a73-21365028f6ae/atomic-bash-abc123.log"
  }
}
```

**How shell output reaches the model:** When `excludeFromContext` is not `true`, Atomic saves a `BashExecutionMessage` in the originating session (emitting no event of its own) and includes all saved bash outputs on the next `prompt` formatted as:

````markdown
Ran `ls -la`
```text
total 48
drwxr-xr-x ...
```
````

#### user_bash

Alias for interactive user shell commands (`!` / `!!`). Accepts the exact same `{ command, excludeFromContext? }` fields, invokes `user_bash` extension hooks, streams `bash_execution_update` deltas correlated by `id`, and returns a `BashResult` with `"command": "user_bash"`.

```json
{"id": "req-2", "type": "user_bash", "command": "git status", "excludeFromContext": true}
```

#### abort_bash

Abort running RPC shell commands (`bash` or `user_bash`). Pass `requestId` to cancel one specific command by its request `id`, or omit `requestId` to cancel every active RPC-owned shell command (including ones started before a session switch). Shutting down RPC cancels and drains remaining shell commands automatically.

```json
{"id": "cancel-1", "type": "abort_bash", "requestId": "req-1"}
```

Response:

```json
{"id": "cancel-1", "type": "response", "command": "abort_bash", "success": true}
```

### Session

#### get_session_stats

Return token totals, cost statistics, and current context-window usage.

```json
{"type": "get_session_stats"}
```

Response:

```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "userMessages": 5,
    "assistantMessages": 5,
    "toolCalls": 12,
    "toolResults": 12,
    "totalMessages": 22,
    "tokens": {
      "input": 50000,
      "output": 10000,
      "cacheRead": 40000,
      "cacheWrite": 5000,
      "total": 105000
    },
    "cost": 0.45,
    "contextUsage": {
      "tokens": 60000,
      "contextWindow": 200000,
      "percent": 30
    },
    "latestAssistantUsage": {
      "input": 200,
      "output": 800,
      "cacheRead": 59000,
      "cacheWrite": 0,
      "totalTokens": 60000,
      "cost": {"input": 0.0006, "output": 0.012, "cacheRead": 0.0177, "cacheWrite": 0, "total": 0.0303}
    }
  }
}
```

`contextUsage` is omitted when no model or context window is active. Immediately after compaction, `contextUsage.tokens` and `contextUsage.percent` are `null` until the next assistant response reports usage. `latestAssistantUsage` reports usage from the newest assistant message (including aborted or failed turns) and is omitted until the session has at least one assistant message.

#### get_tools

Report active tools, inactive tools and why they are off, missing configured tool names, excluded tools, and Git status.

```json
{"type": "get_tools"}
```

Response (abbreviated):

```json
{
  "type": "response",
  "command": "get_tools",
  "success": true,
  "data": {
    "selection": {
      "source": "default-tools-setting",
      "description": "the defaultTools setting",
      "names": ["read", "bash", "kill", "edit", "write", "find", "search", "ask_user_question", "todo", "codemode", "tool-search"],
      "modifiers": []
    },
    "tools": [
      {
        "name": "read",
        "active": true,
        "exposure": "direct",
        "source": "built-in",
        "sourcePath": "<builtin:read>",
        "summary": "Read files, directories, archives, SQLite databases, internal resources, images, documents, and URLs through one path string."
      },
      {
        "name": "codemode",
        "active": true,
        "exposure": "model-only",
        "source": "built-in extension \"codemode\"",
        "sourcePath": "builtin:codemode",
        "summary": "Run JavaScript that composes tool calls in a fresh QuickJS worker sandbox."
      },
      {
        "name": "tool_search",
        "active": false,
        "exposure": "model-only",
        "source": "built-in extension \"tool-search\"",
        "sourcePath": "builtin:tool-search",
        "summary": "Search deferred tool metadata with BM25 and load matching tools for the next model call.",
        "inactiveReason": "opt-in; add \"+tool_search\" to defaultTools or --tools to enable it"
      }
    ],
    "missing": [
      {
        "name": "tool-search",
        "reason": "selected by the defaultTools setting, but no built-in, extension, SDK custom tool, or MCP server has registered a tool named \"tool-search\"; did you mean \"tool_search\"?"
      }
    ],
    "excluded": []
  }
}
```

`selection.source` is `"default-tools-setting"`, `"built-in-defaults"`, `"tools-allowlist"`, `"explicit-selection"`, `"no-built-in-tools"`, or `"no-tools"`. `get_tools` waits until extensions finish loading so their tools are included. `RpcClient.getTools()` returns `data`.

#### export_html

Export the active session to an HTML file.

```json
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

`outputPath` is optional.

Response:

```json
{
  "type": "response",
  "command": "export_html",
  "success": true,
  "data": {"path": "/tmp/session.html"}
}
```

#### switch_session

Load a stored session by its exact `sessionId`. A `session_before_switch` extension hook can cancel the switch. `sessionLocation` from `get_state` is display text, not a switch target.

```json
{"type": "switch_session", "sessionId": "abc123"}
```

When opening a session from another project's JSONL directory, pass `sessionDirectory` so lookup stays pinned to that store. Pass `cwdOverride` to change the resumed working directory without changing the store.

```json
{"type": "switch_session", "sessionId": "abc123", "sessionDirectory": "/path/to/project-sessions", "cwdOverride": "/new/project"}
```

Response:

```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": false, "notices": []}}
```

`notices` holds resume warnings (`{"type": "warning", "message": "..."}`), such as partial [blueprint](/guides/resume-on-any-machine) builds.

When restoring a worktree, `switch_session` responds once the worktree is ready while the blueprint build continues in the background behind the first turn. Tool calls and `bash` commands in that worktree wait for the build, and `blueprint_build_finished` delivers any warnings. Set `resume.waitForBlueprint` to `"prompt"` to wait before responding ([details](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs)).

If the session's stored working directory does not exist on this machine, `switch_session` fails before opening anything with `errorCode: "missing_session_cwd"` and serialized `MissingSessionCwdError` fields (`sessionCwd`, `fallbackCwd`, and optional `sessionFile`) in `errorDetails`. Retry with `cwdOverride` to open in another directory:

```json
{
  "type": "response",
  "command": "switch_session",
  "success": false,
  "error": "Stored session working directory does not exist: /old/project\nCurrent working directory: /new/project",
  "errorCode": "missing_session_cwd",
  "errorDetails": {
    "name": "MissingSessionCwdError",
    "code": "session-cwd-missing",
    "message": "Stored session working directory does not exist: /old/project\nCurrent working directory: /new/project",
    "hint": "Open the session from its original working directory, or continue or fork it when asked.",
    "retryable": false,
    "fields": {"sessionCwd": "/old/project", "fallbackCwd": "/new/project"}
  }
}
```

#### import_session

Import a JSONL session export file into the active session store and switch to it. Can be cancelled by `session_before_switch`.

```json
{"type": "import_session", "inputPath": "/path/to/export.jsonl", "cwdOverride": "/new/project"}
```

Response:

```json
{"type": "response", "command": "import_session", "success": true, "data": {"cancelled": false, "notices": []}}
```

If the exported session's working directory does not exist and `cwdOverride` was omitted, `import_session` stores nothing and fails with `errorCode: "missing_session_cwd"` (same shape as [`switch_session`](#switch_session)). Repeat with `cwdOverride` to import into another directory.

#### start_pending_recovery

Recover interrupted work left by a previous process in the current session. Send this after displaying the transcript at startup or after `switch_session`.

Opening a session never recovers interrupted work automatically. This command runs once per loaded session (repeating it returns the same report) and does not block prompts or `abort`.

```json
{"type": "start_pending_recovery", "reason": "resume"}
```

Optional `reason` is `"startup"` or `"resume"`. Extensions restore background work first, interrupted deliveries replay as normal turns, and undelivered notices append without starting a turn.

Response:

```json
{
  "type": "response",
  "command": "start_pending_recovery",
  "success": true,
  "data": {"replayed": 1, "dropped": 1, "completions": 0, "notices": ["Worker reviewer is gone."]}
}
```

#### fork

Create a new session forked from a previous user message on the active branch. Can be cancelled by `session_before_fork`.

```json
{"type": "fork", "entryId": "abc123"}
```

Response:

```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": false}
}
```

#### clone

Duplicate the active branch into a new session at the current leaf entry. Can be cancelled by `session_before_fork`. Fails with `"Cannot clone session: no current entry selected"` on an empty session (`leafId === null`).

```json
{"type": "clone"}
```

Response:

```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": false}
}
```

#### get_fork_messages

List user prompts available for forking across every branch, including older prompts on compacted or branched sessions (long prompts use short picker labels). Pass any returned `entryId` to `fork`.

```json
{"type": "get_fork_messages"}
```

Response:

```json
{
  "type": "response",
  "command": "get_fork_messages",
  "success": true,
  "data": {
    "messages": [
      {"entryId": "abc123", "text": "First prompt..."},
      {"entryId": "def456", "text": "Second prompt..."}
    ]
  }
}
```

#### get_entries

Return entries in the loaded context window in append order (excluding the session header). Use [`get_history_page`](#get_history_page) to read pre-compaction history and abandoned branches.

Pass the last entry ID you received as `since` to fetch only strictly newer entries. If `since` points to an older archived entry outside the loaded context window, Atomic resolves its sequence in history and returns all loaded entries with a higher sequence. Only an unknown entry ID returns `success: false`.

```json
{"type": "get_entries", "since": "abc123"}
```

Response:

```json
{
  "type": "response",
  "command": "get_entries",
  "success": true,
  "data": {
    "entries": [
      {"type": "message", "id": "def456", "parentId": "abc123", "timestamp": "2026-01-01T00:00:00.000Z", "message": {"role": "user", "content": "Hello"}}
    ],
    "leafId": "def456"
  }
}
```

`leafId` is the current leaf entry ID (`null` on an empty session).

#### get_history_page

Read one page of the full saved session in append order, including pre-compaction entries and abandoned branches. Pass optional inclusive `fromSeq` / `toSeq` and optional `pageEntries`, or pass `cursor: data.nextCursor` (without a range) to fetch the next page.

```json
{"type": "get_history_page", "fromSeq": 1, "pageEntries": 64}
```

Response:

```json
{
  "type": "response",
  "command": "get_history_page",
  "success": true,
  "data": {
    "items": [
      {"seq": 1, "entry": {"type": "message", "id": "abc123", "parentId": null}}
    ],
    "nextCursor": "eyJ..."
  }
}
```

Each page contains up to 64 entries and 1 MiB of serialized JSON; an entry exceeding that limit is returned alone as an oversized reference item readable via `get_history_chunk`. Later appends do not shift the snapshot's end sequence.

#### get_history_chunk

Read up to 64 KiB of the original UTF-8 bytes of one oversized item returned by `get_history_page`. Pass `reference` (the complete oversized item) and `offset` (`0` for the first chunk).

```json
{"type": "get_history_chunk", "reference": {"oversized": true, "seq": 12, "id": "big123", "byteLength": 2097152}, "offset": 0}
```

Response:

```json
{
  "type": "response",
  "command": "get_history_chunk",
  "success": true,
  "data": {
    "data": "eyJ0eXBlIjoibWVzc2FnZSI...",
    "nextOffset": 65536
  }
}
```

Decode `data.data` from base64 and continue requesting at `data.nextOffset` until `nextOffset` is omitted. Session replacement invalidates prior references.

#### get_tree

Return the loaded context window as a tree of entries. Each node is `{ entry, children, label?, labelTimestamp? }`. A well-formed session has one root; orphaned entries also appear as roots.

```json
{"type": "get_tree"}
```

Response:

```json
{
  "type": "response",
  "command": "get_tree",
  "success": true,
  "data": {
    "tree": [
      {
        "entry": {"type": "message", "id": "abc123", "parentId": null},
        "children": [
          {"entry": {"type": "message", "id": "def456", "parentId": "abc123"}, "children": []}
        ]
      }
    ],
    "leafId": "def456"
  }
}
```

#### navigate_tree

Move the active branch leaf to `targetId` in the session tree, optionally summarizing the abandoned branch.

```json
{
  "type": "navigate_tree",
  "targetId": "abc123",
  "options": {
    "summarize": true,
    "customInstructions": "Preserve all test outcomes",
    "replaceInstructions": false,
    "label": "before-refactor"
  }
}
```

Response:

```json
{
  "type": "response",
  "command": "navigate_tree",
  "success": true,
  "data": {
    "cancelled": false,
    "editorText": "Optional prompt text to restore"
  }
}
```

`data` may also contain `aborted: true` (if branch summarization was cancelled with `abort_branch_summary`) and `summaryEntry` (`BranchSummaryEntry`) when summarization ran.

#### set_label

Attach or clear a bookmark label on a session entry. Omit `label` (or pass `undefined`) to clear an existing label.

```json
{"type": "set_label", "entryId": "abc123", "label": "baseline"}
```

Response:

```json
{"type": "response", "command": "set_label", "success": true, "data": {"entryId": "label-entry-id"}}
```

#### get_last_assistant_text

Return the text content of the most recent assistant message. Messages without text from aborted or failed turns, or tool-call-only messages, are skipped. Returns `{"text": null}` if none exist.

```json
{"type": "get_last_assistant_text"}
```

Response:

```json
{
  "type": "response",
  "command": "get_last_assistant_text",
  "success": true,
  "data": {"text": "The assistant's response..."}
}
```

#### set_session_name

Set a display name for the current session. Empty or whitespace-only names fail with `"Session name cannot be empty"`.

```json
{"type": "set_session_name", "name": "my-feature-work"}
```

Response:

```json
{"type": "response", "command": "set_session_name", "success": true}
```

Read the active name from `get_state.data.sessionName`, or set it at startup with `--name <name>` (`-n <name>`).

#### reload

Reload keybindings, extensions, skills, prompt templates, and themes (equivalent to `/reload`).

```json
{"type": "reload"}
```

Response:

```json
{"type": "response", "command": "reload", "success": true}
```

Before responding, Atomic emits one [`extension_error`](#extension_error) event with `"event": "reload"` for each extension that failed to load.

#### get_shortcuts

List keyboard shortcuts registered by extensions in the active session.

```json
{"type": "get_shortcuts"}
```

Response:

```json
{
  "type": "response",
  "command": "get_shortcuts",
  "success": true,
  "data": {
    "shortcuts": [
      {"key": "ctrl+alt+p", "description": "Toggle preview"}
    ]
  }
}
```

#### invoke_shortcut

Invoke an extension-registered keyboard shortcut by its `key` string (as returned by `get_shortcuts`).

```json
{"type": "invoke_shortcut", "key": "ctrl+alt+p"}
```

Response:

```json
{"type": "response", "command": "invoke_shortcut", "success": true}
```

### Slash commands

#### get_commands

List slash commands available through `prompt` (extension commands, prompt templates, and skills). Invoke any returned command by prefixing its `name` with `/`.

```json
{"type": "get_commands"}
```

Response:

```json
{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {
        "name": "session-name",
        "description": "Set or clear session name",
        "hasArgumentCompletions": true,
        "source": "extension",
        "sourceInfo": {
          "path": "/home/user/.atomic/agent/extensions/session.ts",
          "source": "local",
          "scope": "user",
          "origin": "top-level",
          "baseDir": "/home/user/.atomic/agent/extensions"
        }
      },
      {
        "name": "fix-tests",
        "description": "Fix failing tests",
        "source": "prompt",
        "sourceInfo": {
          "path": "/home/user/myproject/.atomic/prompts/fix-tests.md",
          "source": "local",
          "scope": "project",
          "origin": "top-level",
          "baseDir": "/home/user/myproject/.atomic/prompts"
        }
      },
      {
        "name": "skill:brave-search",
        "description": "Web search via Brave API",
        "source": "skill",
        "sourceInfo": {
          "path": "/home/user/.atomic/agent/skills/brave-search/SKILL.md",
          "source": "local",
          "scope": "user",
          "origin": "top-level",
          "baseDir": "/home/user/.atomic/agent/skills/brave-search"
        }
      }
    ]
  }
}
```

Each item (`RpcSlashCommand`) contains:

- `name`: command name without the leading `/` (skills are prefixed with `skill:`).
- `description`: optional human-readable description.
- `source`: `"extension"`, `"prompt"`, or `"skill"`.
- `sourceInfo`: `SourceInfo` object (`{ path, source, scope: "user" | "project" | "temporary", origin: "package" | "top-level", baseDir? }`). There are no top-level `location` or `path` fields.
- `hasArgumentCompletions`: present and `true` only on extension commands that implement `getArgumentCompletions`.

Built-in interactive commands (`/settings`, `/hotkeys`, and similar TUI commands) are omitted because they do not run through RPC `prompt`.

#### get_command_completions

Evaluate live argument completions for an extension command that reported `hasArgumentCompletions: true`.

```json
{"type": "get_command_completions", "commandName": "session-name", "argumentPrefix": "feat"}
```

Response:

```json
{
  "type": "response",
  "command": "get_command_completions",
  "success": true,
  "data": {
    "completions": [
      {"value": "feature-auth", "label": "feature-auth", "description": "Auth work"}
    ]
  }
}
```

Returns `{"completions": null}` when the command does not exist or does not provide argument completions.

## Events

Events stream to stdout as JSON lines. Most events carry no `id`; `bash_execution_update` is the exception and carries the originating shell command's `id`.

### Event types

| Event | Description |
| --- | --- |
| `agent_start` | Agent attempt begins (carries optional `turnStartedAt`) |
| `agent_end` | One low-level agent loop completed (includes generated `messages` and optional `retryPending: true`) |
| `agent_settled` | No automatic session work remains (`{ aborted: boolean }`) |
| `session_released` | Session was released to idle storage (`{ released: ReleasedAgentSession }`) |
| `entry_appended` | A durable `SessionEntry` was appended (`{ entry: SessionEntry }`) |
| `session_info_changed` | Session display name changed (`{ name: string \| undefined }`) |
| `model_changed` | Active model changed (`{ model, previousModel, source: "set" \| "cycle" \| "restore" \| "fallback" }`) |
| `thinking_level_changed` | Active thinking level changed (`{ level }`) |
| `turn_start` | New assistant turn begins |
| `turn_end` | Turn completes (includes assistant `message` and `toolResults`) |
| `message_start` | Message begins |
| `message_update` | Streaming delta (text, thinking, or tool call) plus cumulative `usage` |
| `message_end` | Message completes (carries `entryId` and `seq` when persisted) |
| `tool_execution_start` | Tool starts running (`toolCallId`, `toolName`, `args`) |
| `tool_execution_update` | Tool streams partial result (`partialResult`) |
| `tool_execution_end` | Tool completes (`result`, `isError`, optional `durationMs`) |
| `bash_execution_update` | Correlated `bash` / `user_bash` stdout or stderr delta |
| `queue_update` | Pending steering and follow-up queues changed |
| `compaction_start` | Compaction begins |
| `compaction_end` | Compaction completed, failed, or aborted |
| `compaction_usage` | Compactor model request returned token usage |
| `child_session_usage` | Child session (such as a subagent) completed one model call |
| `agent_continue_error` | Post-compaction continuation failed to start (`{ source: "post_compaction", errorMessage }`) |
| `auto_retry_start` | Automatic retry scheduled after a transient provider error |
| `auto_retry_end` | Automatic retry loop completed or exhausted |
| `model_fallback_start` | Fallback switch scheduled (`from`, `to`, optional thinking levels, `reason`, `attempt`) |
| `model_fallback_end` | Fallback loop succeeded or exhausted (`success`, optional `from`, `to`, `finalError`) |
| `summarization_retry_scheduled` | Branch-summary retry scheduled |
| `summarization_retry_attempt_start` | Retried branch-summary request starts |
| `summarization_retry_finished` | Branch-summary retry loop completed |
| `task_cleanup_quarantined` | Background task cleanup failed and was quarantined (`taskId`, `resources`) |
| `worktree_snapshot_unavailable` | Worktree snapshot could not be captured (`reason`) |
| `extension_error` | Extension threw an error or failed to load |
| `shutdown_error` | Session disposal failed during shutdown (last line before exit) |
| `blueprint_build_waiting` | Resume is waiting on another process's blueprint build of the same worktree (may arrive before the first response) |
| `blueprint_build_finished` | Background blueprint build for a resumed worktree finished (`notices` lists warnings) |

### agent_start

Emitted when the agent begins an attempt. `turnStartedAt` records when the turn's first request began and stays unchanged across retries.

```json
{"type": "agent_start", "turnStartedAt": 1760000000000}
```

### agent_end and agent_settled

`agent_end` fires when one agent loop finishes and carries all messages generated during that loop. If `retryPending` is `true`, a retry or fallback is pending and can be stopped with `abort_retry`.

```json
{"type": "agent_end", "messages": []}
```

`agent_settled` fires once no automatic retries, compaction continuations, or queued turns remain:

```json
{"type": "agent_settled", "aborted": false}
```

### Session metadata and fallback events

- `session_info_changed`: `{"type": "session_info_changed", "name": "my-feature-work"}` (`name` is omitted when cleared).
- `model_changed`: `{"type": "model_changed", "model": {}, "previousModel": {}, "source": "set"}` (`source` is `"set"`, `"cycle"`, `"restore"`, or `"fallback"`).
- `thinking_level_changed`: `{"type": "thinking_level_changed", "level": "high"}`.
- `entry_appended`: `{"type": "entry_appended", "entry": {}}`.
- `session_released`: `{"type": "session_released", "released": {}}`.
- `agent_continue_error`: `{"type": "agent_continue_error", "source": "post_compaction", "errorMessage": "..."}`.
- `model_fallback_start` / `model_fallback_end`: bracket automatic model fallback switches across configured `fallbackModels`.
- `task_cleanup_quarantined`: reports background task resources that failed cleanup (`taskId`, `resources`).
- `worktree_snapshot_unavailable`: reports why a worktree snapshot could not be recorded (`reason`).

### turn_start / turn_end

A turn covers one assistant response and any tool calls and tool results it produces.

```json
{"type": "turn_start"}
```

```json
{"type": "turn_end", "message": {}, "toolResults": []}
```

### message_start / message_end

Emitted when a message begins and completes. `message` is an `AgentMessage`.

```json
{"type": "message_start", "message": {}}
{"type": "message_end", "message": {}, "entryId": "a1b2c3d4", "seq": 42}
```

When the session saved the message, `message_end` also includes `entryId` and its history sequence `seq`. Both are omitted for unsaved messages.

### message_update (streaming)

Emitted during assistant message streaming with the delta and cumulative usage.

On the wire, `message_update` omits the top-level `message` snapshot and strips `assistantMessageEvent.partial`. Build incremental state from `message_start` plus deltas, then replace with the authoritative message from `message_end`.

Top-level `usage` holds the latest cumulative provider-reported token counts (which may stay zero until completion for providers that report usage only at the end). Top-level `endTurn` is present only when the provider reported an explicit end-of-turn flag (`AssistantMessage.endTurn`, such as OpenAI Codex `end_turn`).

```json
{
  "type": "message_update",
  "usage": {
    "input": 100,
    "output": 1,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 101,
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
  },
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello "
  }
}
```

`assistantMessageEvent` delta types:

| Type | Description |
| --- | --- |
| `start` | Message generation started |
| `text_start` | Text content block started |
| `text_delta` | Text content chunk |
| `text_end` | Text content block ended |
| `thinking_start` | Thinking block started |
| `thinking_delta` | Thinking content chunk |
| `thinking_end` | Thinking block ended |
| `toolcall_start` | Tool call started (includes top-level `id` and `toolName` added on the wire) |
| `toolcall_delta` | Tool call arguments chunk |
| `toolcall_end` | Tool call ended (includes full `toolCall` object) |
| `done` | Message complete (`reason`: `"stop"`, `"length"`, `"toolUse"`) |
| `error` | Error occurred (`reason`: `"aborted"`, `"error"`) |

Example streaming a text response:

```json
{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_start","contentIndex":0}}
{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world"}}
{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world"}}
```

### tool_execution_start / tool_execution_update / tool_execution_end

Emitted when a tool begins, streams accumulated partial output, and completes.

```json
{
  "type": "tool_execution_start",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"}
}
```

```json
{
  "type": "tool_execution_update",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"},
  "partialResult": {
    "content": [{"type": "text", "text": "partial output so far..."}],
    "details": {"truncation": null, "fullOutputPath": null}
  }
}
```

```json
{
  "type": "tool_execution_end",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "result": {
    "content": [{"type": "text", "text": "total 48\n..."}],
    "details": {}
  },
  "isError": false,
  "durationMs": 42
}
```

Correlate events with `toolCallId`. `partialResult` holds the accumulated output so far, so clients can replace their rendered output on each update. Optional `durationMs` on `tool_execution_end` records execution time in milliseconds using a monotonic clock and is omitted when the tool did not execute.

### bash_execution_update

Emitted only for direct `bash` and non-intercepted `user_bash` RPC commands. Each event carries `{ type, id?, channel, delta }` where `channel` is `"stdout"` or `"stderr"`. Use `id` to separate concurrent commands. Tool-call bash uses `tool_execution_update` instead.

### queue_update

Emitted whenever the pending steering or follow-up queue changes.

```json
{
  "type": "queue_update",
  "steering": ["Focus on error handling"],
  "followUp": ["After that, summarize the result"]
}
```

### compaction_start / compaction_end

Emitted when manual or automatic compaction starts and finishes. `reason` is `"manual"`, `"threshold"`, or `"overflow"`.

```json
{"type": "compaction_start", "reason": "threshold"}
```

```json
{
  "type": "compaction_end",
  "reason": "threshold",
  "result": {
    "compactedText": "Context compacted. Your earlier conversation (150,000 tokens) was replaced by the compacted text below, produced by morph/morph-compactor. ...",
    "firstKeptEntryId": null,
    "tokensBefore": 150000,
    "promptVersion": 7,
    "parameters": {"query": "fix the test"},
    "form": "compacted",
    "backend": "compactor",
    "model": "morph/morph-compactor",
    "history": {"sessionId": "abc123", "rangeUnit": "entries", "entriesBefore": 42, "boundaryEntry": 43, "totalEntries": 48},
    "stats": {
      "linesBefore": 812,
      "linesDeleted": 406,
      "linesKept": 406,
      "rangeCount": 0,
      "tokensBefore": 150000,
      "tokensAfter": 21400,
      "percentReduction": 85.7
    }
  },
  "aborted": false,
  "willRetry": false
}
```

If a compactor model fails, Atomic clears the context instead (`result.form: "cleared"` with `result.fallbackReason`). If `reason` is `"overflow"` and compaction succeeds, `willRetry` is `true` and Atomic automatically retries the prompt. If aborted, `result` is `null` and `aborted` is `true`. Check `result` and `errorMessage` independently because a mid-turn compaction can commit a durable boundary before a follow-up request exceeds the provider's hard input limit. Exhausted overflow recovery sets `"unresolvedOverflow": true` alongside `errorMessage`.

### compaction_usage

Emitted once when a compactor model request returns usage, even if the run later fails or cancels. Clearing context emits no `compaction_usage`. For a successful run, `compaction_end.result.usage` reports the same usage; do not double-count both.

```json
{"type": "compaction_usage", "reason": "threshold", "usage": {"input": 5000, "output": 20, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 5020, "cost": {"input": 0.5, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.5}}}
```

### child_session_usage

Emitted once per model call executed by a child session (such as a subagent or nested subagent): assistant turns, compactor requests, and cache warming.

```json
{"type": "child_session_usage", "usage": {"input": 10, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 10, "cost": {"input": 2, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 2}}}
```

### auto_retry_start / auto_retry_end

Emitted when automatic retry runs after a transient error (overloaded, rate limit, 5xx).

```json
{
  "type": "auto_retry_start",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
}
```

```json
{"type": "auto_retry_end", "success": true, "attempt": 2}
```

On exhausted retries:

```json
{"type": "auto_retry_end", "success": false, "attempt": 3, "finalError": "529 overloaded_error: Overloaded"}
```

### summarization_retry_scheduled / summarization_retry_attempt_start / summarization_retry_finished

Emitted when branch summarization retries after a transient provider error. Compaction never retries its compactor call and clears context instead.

```json
{"type": "summarization_retry_scheduled", "attempt": 1, "maxAttempts": 3, "delayMs": 2000, "errorMessage": "terminated"}
```

```json
{"type": "summarization_retry_attempt_start", "source": "branchSummary"}
```

```json
{"type": "summarization_retry_finished"}
```

### extension_error

Emitted when an extension throws an error or fails to load (`"event": "startup"` on initial startup, `"event": "reload"` during [`reload`](#reload)).

```json
{
  "type": "extension_error",
  "extensionPath": "/path/to/extension.ts",
  "event": "tool_call",
  "error": "Error message..."
}
```

### shutdown_error

The final line written when disposing the session failed during shutdown. Atomic attempts every cleanup step first. `code` carries the failure code (such as `"ShutdownFailed"`), and `errors` lists failed cleanup steps when multiple steps failed. The process then exits with `exitCode` (`1` after stdin close or shutdown request, `143` for `SIGTERM`, `129` for `SIGHUP`).

```json
{
  "type": "shutdown_error",
  "error": "Runtime shutdown failed",
  "code": "ShutdownFailed",
  "errors": ["messages"],
  "exitCode": 1
}
```

## Error handling

Failed commands return a `response` with `success: false`:

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: invalid/model"
}
```

Invalid JSON on stdin returns a parse error response:

```json
{
  "type": "response",
  "command": "parse",
  "success": false,
  "error": "Failed to parse command: Unexpected token..."
}
```

### Structured error codes (`errorCode` and `errorDetails`)

Some errors attach typed `errorCode` and `errorDetails` properties that `RpcClient` rehydrates into typed errors:

| `errorCode` | `errorDetails` shape | When returned |
| --- | --- | --- |
| `"debug_error"` | `SerializedDebugError` (`name`, `code`, `message`, `hint`, `retryable`, `fields`) | Invalid argument passed to `set_debug`. |
| `"missing_session_cwd"` | `SerializedMissingSessionCwdError` (`sessionCwd`, `fallbackCwd`, optional `sessionFile`) | `switch_session` or `import_session` when the recorded `cwd` does not exist and `cwdOverride` was omitted. |
| `"credential_synchronization"` | `{ providerId: string, operation: "save" \| "logout" \| "oauth" }` | Credential persistence could not synchronize with the active provider store. |

## Types

Exported TypeScript definitions:

- `@bastani/atomic-ai`: `Model`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `ImageContent`.
- `@bastani/atomic-agent-core`: `AgentMessage`, `AgentEvent`.
- `@bastani/atomic`: augments `AgentMessage` with `BashExecutionMessage`, `CustomMessage`, and `BranchSummaryMessage`, and exports `RpcClient`, `RpcEvent`, and `ModelInfo`.

### Model object {#model-type}

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {
    "input": 3.0,
    "output": 15.0,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  }
}
```

`contextWindow` is the model's token budget used for local token estimates, stats, and compaction.

### UserMessage

```json
{
  "role": "user",
  "content": "Hello!",
  "timestamp": 1733234567890
}
```

`content` is either a string or an array of `TextContent` and `ImageContent` blocks.

### ImageContent

```json
{
  "type": "image",
  "data": "base64-encoded-data",
  "mimeType": "image/png"
}
```

### AssistantMessage

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help?"},
    {"type": "thinking", "thinking": "User is greeting me..."},
    {"type": "toolCall", "id": "call_123", "name": "bash", "arguments": {"command": "ls"}}
  ],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 150,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "stopReason": "stop",
  "timestamp": 1733234567890
}
```

Terminal stop reasons are `"stop"`, `"length"`, `"toolUse"`, `"error"`, and `"aborted"`. On `message_start`, an in-progress assistant message carries `stopReason: "pending"` until `message_end` replaces it with the terminal reason. When a provider sends an explicit end-of-turn flag (`AssistantMessage.endTurn`), `endTurn: true` appears on the message and is echoed at the top level of `message_update`.

### ToolResultMessage

```json
{
  "role": "toolResult",
  "toolCallId": "call_123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "total 48\ndrwxr-xr-x ..."}],
  "isError": false,
  "timestamp": 1733234567890
}
```

### BashExecutionMessage

Created by the direct `bash` and `user_bash` RPC commands (not by model tool calls):

```json
{
  "role": "bashExecution",
  "command": "ls -la",
  "output": "total 48\ndrwxr-xr-x ...",
  "exitCode": 0,
  "cancelled": false,
  "truncated": false,
  "fullOutputPath": null,
  "timestamp": 1733234567890
}
```

### CustomMessage

Injected by extensions via `atomic.sendMessage()`:

```json
{
  "role": "custom",
  "customType": "my-extension",
  "content": "Deployment check passed.",
  "display": true,
  "details": {"status": "ok"},
  "timestamp": 1733234567890
}
```

### BranchSummaryMessage

Inserted when switching branches with `navigate_tree` (`summarize: true`):

```json
{
  "role": "branchSummary",
  "summary": "Explored caching approach before switching back to the main branch.",
  "fromId": "entry-abc123",
  "timestamp": 1733234567890
}
```
