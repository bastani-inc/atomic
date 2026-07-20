# RPC Mode

RPC mode enables headless operation of the coding agent via a JSON protocol over stdin/stdout. This is useful for embedding the agent in other applications, IDEs, or custom UIs.

**Note for Node.js/TypeScript users**: If you're building a Node.js application, consider using `AgentSession` directly from `@bastani/atomic` instead of spawning a subprocess. See [`src/core/agent-session.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/agent-session.ts) for the API. For a subprocess-based TypeScript client, see [`src/modes/rpc/rpc-client.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/modes/rpc/rpc-client.ts).

## Starting RPC Mode

```bash
atomic --mode rpc [options]
```

Common options:
- `--provider <name>`: Set the LLM provider (anthropic, openai, google, etc.)
- `--model <pattern>`: Model pattern or ID (supports `provider/id` and optional `:<thinking>`)
- `--context-window <tokens>`: Select a supported context-window size for the startup model (`400k`, `1m`, or raw tokens)
- `--name <name>` / `-n <name>`: Set the session display name at startup
- `--no-session`: Disable session persistence
- `--session-dir <path>`: Custom session storage directory

## Protocol Overview

- **Commands**: JSON objects sent to stdin, one per line
- **Responses**: JSON objects with `type: "response"` indicating command success/failure
- **Events**: Agent events streamed to stdout as JSON lines

All commands support an optional `id` field for request/response correlation. If provided, the corresponding response will include the same `id`.

### Framing

RPC mode uses strict JSONL semantics with LF (`\n`) as the only record delimiter.

This matters for clients:
- Split records on `\n` only
- Accept optional `\r\n` input by stripping a trailing `\r`
- Do not use generic line readers that treat Unicode separators as newlines

In particular, Node `readline` is not protocol-compliant for RPC mode because it also splits on `U+2028` and `U+2029`, which are valid inside JSON strings.

## Commands

### Prompting

#### prompt

Send a user prompt to the agent. The command response is emitted after the prompt is accepted, queued, or handled. Events continue streaming asynchronously after acceptance.

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

With images:
```json
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

**During streaming**: If the agent is already streaming, you must specify `streamingBehavior` to queue the message:

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"`: Queue the message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
- `"followUp"`: Wait until the agent finishes. Message is delivered only when agent stops.

If the agent is streaming and no `streamingBehavior` is specified, the command returns an error.

**Extension commands**: If the message is an extension command (e.g., `/mycommand`), it executes immediately even during streaming. Extension commands manage their own LLM interaction via `pi.sendMessage()`.

**Input expansion**: Skill commands (`/skill:name`) and prompt templates (`/template`) are expanded before sending/queueing.

Response:
```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true}
```

`success: true` means the prompt was accepted, queued, or handled immediately. `success: false` means the prompt was rejected before acceptance. Failures after acceptance are reported through the normal event and message stream, not as a second `response` for the same request id.

The `images` field is optional. Each image uses `ImageContent` format: `{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}`.

#### steer

Queue a steering message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "steer", "message": "Stop and do this instead"}
```

With images:
```json
{"type": "steer", "message": "Look at this instead", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "steer", "success": true}
```

See [set_steering_mode](#set_steering_mode) for controlling how steering messages are processed.

#### follow_up

Queue a follow-up message to be processed after the agent finishes. Delivered only when agent has no more tool calls or steering messages. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "follow_up", "message": "After you're done, also do this"}
```

With images:
```json
{"type": "follow_up", "message": "Also check this image", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "follow_up", "success": true}
```

See [set_follow_up_mode](#set_follow_up_mode) for controlling how follow-up messages are processed.

#### abort

Abort the current agent operation.

```json
{"type": "abort"}
```

Response:
```json
{"type": "response", "command": "abort", "success": true}
```

#### new_session

Start a fresh session. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "new_session"}
```

With optional parent session tracking:
```json
{"type": "new_session", "parentSession": "/path/to/parent-session.jsonl"}
```

Response:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": true}}
```

### State

#### get_state

Get current session state.

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
    "model": {...},
    "thinkingLevel": "medium",
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "all",
    "followUpMode": "one-at-a-time",
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "sessionName": "my-feature-work",
    "autoCompactionEnabled": true,
    "messageCount": 5,
    "pendingMessageCount": 0
  }
}
```

The `model` field is a full [Model](#model) object or `null`. Its `contextWindow` is the active/effective token budget; selectable models may also include `defaultContextWindow` and `contextWindowOptions`. The `sessionName` field is the display name set via `set_session_name`, or omitted if not set.

#### get_messages

Get all messages in the conversation.

```json
{"type": "get_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_messages",
  "success": true,
  "data": {"messages": [...]}
}
```

Messages are `AgentMessage` objects (see [Types](#types)).

### Model

#### set_model

Switch to a specific model.

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

Response contains the full [Model](#model) object:
```json
{
  "type": "response",
  "command": "set_model",
  "success": true,
  "data": {...}
}
```

#### cycle_model

Cycle to the next available model. Returns `null` data if only one model available.

```json
{"type": "cycle_model"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_model",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isScoped": false
  }
}
```

The `model` field is a full [Model](#model) object.

#### get_available_models

List all configured models.

```json
{"type": "get_available_models"}
```

Response contains an array of full [Model](#model) objects:
```json
{
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": [...]
  }
}
```

### Context Window

#### get_available_context_windows

List the context-window token budgets supported by the current model and read the active/effective runtime selection.

```json
{"type": "get_available_context_windows"}
```

Response:
```json
{
  "type": "response",
  "command": "get_available_context_windows",
  "success": true,
  "data": {
    "contextWindows": [400000, 1000000],
    "currentContextWindow": 400000,
    "supportsSelection": true
  }
}
```

- `contextWindows`: supported token budgets for the active model, sorted ascending.
- `currentContextWindow`: the active/effective token budget on `model.contextWindow`; omitted when no model is selected.
- `supportsSelection`: `true` when the active model exposes more than one supported budget.

#### set_context_window

Set the active context-window token budget for the current model at runtime.

```json
{"type": "set_context_window", "contextWindow": 1000000}
```

Compact string values are also accepted:
```json
{"type": "set_context_window", "contextWindow": "1m"}
```

Response:
```json
{"type": "response", "command": "set_context_window", "success": true}
```

This command calls `AgentSession.setContextWindow(...)` without `{ persistDefault: true }`: it updates the active model, appends a `context_window_change` session entry and emits `context_window_changed` when the budget changes, but it does **not** write context-window defaults to settings. Use startup `--context-window` or an interactive context-window selection when you intentionally want the effective selection persisted under `defaultContextWindows["provider/modelId"]`.

Unsupported or malformed selections return the standard RPC error response:
```json
{
  "type": "response",
  "command": "set_context_window",
  "success": false,
  "error": "Context window 2m is not supported by custom/selectable-context. Supported values: 400k, 1m."
}
```

Larger provider context windows may consume more credits/cost. For catalog-advertised GitHub Copilot long-context models (including `github-copilot/gpt-5.5`, `github-copilot/claude-sonnet-5`, and `github-copilot/gemini-3.1-pro-preview`), selecting `1m` raises Atomic's local budget and sends `X-GitHub-Api-Version: 2026-06-01`; GitHub applies the long-context billing tier server-side by prompt token count. That tier consumes more Copilot AI credits and requires Copilot long-context/usage-based billing entitlement, otherwise requests over GitHub's server cap are rejected with a friendly hint.

### Thinking

#### set_thinking_level

Set the reasoning/thinking level for models that support it.

```json
{"type": "set_thinking_level", "level": "high"}
```

Levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`.

`xhigh` and `max` are available only when the active model's capability mapping supports them; unsupported levels are clamped by the session model controls.

Response:
```json
{"type": "response", "command": "set_thinking_level", "success": true}
```

#### cycle_thinking_level

Cycle through available thinking levels. Returns `null` data if model doesn't support thinking.

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

### Queue Modes

#### set_steering_mode

Control how steering messages (from `steer`) are delivered.

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all steering messages after the current assistant turn finishes executing its tool calls
- `"one-at-a-time"`: Deliver one steering message per completed assistant turn (default)

Response:
```json
{"type": "response", "command": "set_steering_mode", "success": true}
```

#### set_follow_up_mode

Control how follow-up messages (from `follow_up`) are delivered.

```json
{"type": "set_follow_up_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all follow-up messages when agent finishes
- `"one-at-a-time"`: Deliver one follow-up message per agent completion (default)

Response:
```json
{"type": "response", "command": "set_follow_up_mode", "success": true}
```

### Compaction

#### compact

Run Atomic's verbatim line compactor. The selected session model receives the complete active numbered transcript except for exactly the newest `preserve_recent` context-visible messages and returns bare `start,end` deletion records; Atomic validates them and mechanically reconstructs retained lines with `(filtered N lines)` markers. The default tail is two messages, with no user-turn alignment. A value of zero sends the entire active transcript and persists `firstKeptEntryId: null`. The command appends a durable `compaction` entry with `details.strategy: "verbatim-lines"`.

```json
{"type": "compact"}
```

Response:
```json
{
  "type": "response",
  "command": "compact",
  "success": true,
  "data": {
    "compactedText": "[User]: fix the test\n(filtered 42 lines)\n[Assistant]: Fixed.",
    "firstKeptEntryId": "m7",
    "tokensBefore": 150000,
    "promptVersion": 3,
    "parameters": {
      "compression_ratio": 0.5,
      "preserve_recent": 2,
      "query": "fix the test"
    },
    "rung": "planned",
    "stats": {
      "linesBefore": 812,
      "linesDeleted": 417,
      "linesKept": 395,
      "rangeCount": 63,
      "tokensBefore": 150000,
      "tokensAfter": 72000,
      "percentReduction": 52
    },
    "backupPath": "/path/to/session.jsonl.2026-06-06T00-00-00-000Z.compact.bak"
  }
}
```

`firstKeptEntryId` is a string when at least one ordinary message remains outside compaction and `null` when none does. RPC clients must accept both values.

#### set_auto_compaction

Enable or disable automatic compaction when context is nearly full.

```json
{"type": "set_auto_compaction", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_compaction", "success": true}
```

### Retry

#### set_auto_retry

Enable or disable automatic retry on transient errors (overloaded, rate limit, 5xx).

```json
{"type": "set_auto_retry", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_retry", "success": true}
```

#### abort_retry

Abort an in-progress retry (cancel the delay and stop retrying).

```json
{"type": "abort_retry"}
```

Response:
```json
{"type": "response", "command": "abort_retry", "success": true}
```

### Bash

#### bash

Execute a shell command and add output to conversation context.

```json
{"type": "bash", "command": "ls -la"}
```

Response:
```json
{
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

If output was truncated, includes `fullOutputPath`:
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
    "fullOutputPath": "/tmp/atomic-bash-abc123.log"
  }
}
```

**How bash results reach the LLM:**

The `bash` command executes immediately and returns a `BashResult`. Internally, a `BashExecutionMessage` is created and stored in the agent's message state. This message does NOT emit an event.

When the next `prompt` command is sent, all messages (including `BashExecutionMessage`) are transformed before being sent to the LLM. The `BashExecutionMessage` is converted to a `UserMessage` with this format:

````
Ran `ls -la`
```
total 48
drwxr-xr-x ...
```
````

This means:
1. Bash output is included in the LLM context on the **next prompt**, not immediately
2. Multiple bash commands can be executed before a prompt; all outputs will be included
3. No event is emitted for the `BashExecutionMessage` itself

#### abort_bash

Abort a running bash command.

```json
{"type": "abort_bash"}
```

Response:
```json
{"type": "response", "command": "abort_bash", "success": true}
```

### Session

#### get_session_stats

Get token usage, cost statistics, and current context window usage.

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
    }
  }
}
```

`tokens` contains assistant usage totals for the current session state. `contextUsage` contains the actual current context-window estimate used for compaction and footer display.

`contextUsage` is omitted when no model or context window is available. `contextUsage.tokens` and `contextUsage.percent` are `null` immediately after compaction until a fresh post-compaction assistant response provides valid usage data.

#### export_html

Export session to an HTML file.

```json
{"type": "export_html"}
```

With custom path:
```json
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

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

Load a different session file. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "switch_session", "sessionPath": "/path/to/session.jsonl"}
```

Response:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled the switch:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": true}}
```

#### fork

Create a new fork from a previous user message on the active branch. Can be cancelled by a `session_before_fork` extension event handler. Returns the text of the message being forked from.

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

If an extension cancelled the fork:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": true}
}
```

#### clone

Duplicate the current active branch into a new session at the current position. Can be cancelled by a `session_before_fork` extension event handler.

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

If an extension cancelled the clone:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": true}
}
```

#### get_fork_messages

Get user messages available for forking.

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

Get all session entries in append order (excluding the session header). The session is an append-only tree of entries with stable ids, so an entry id works as a durable cursor: pass the last entry id you have seen as `since` to get only entries strictly after it, even across client restarts. Unlike `get_messages`, this includes pre-compaction history and abandoned branches.

```json
{"type": "get_entries"}
```

With a cursor:
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
      {"type": "message", "id": "def456", "parentId": "abc123", "timestamp": "...", "message": {"role": "user", "...": "..."}}
    ],
    "leafId": "def456"
  }
}
```

`leafId` is the id of the current leaf entry (`null` for an empty session), so a client can tell in one round trip whether the active branch moved. If `since` does not match any entry id, the response is `success: false`.

#### get_tree

Get the session as a tree of entries. Each node is `{entry, children, label?, labelTimestamp?}`. A well-formed session has a single root; orphaned entries (broken parent chain) also appear as roots.

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
        "entry": {"type": "message", "id": "abc123", "parentId": null, "...": "..."},
        "children": [
          {"entry": {"type": "message", "id": "def456", "parentId": "abc123", "...": "..."}, "children": []}
        ]
      }
    ],
    "leafId": "def456"
  }
}
```

#### get_last_assistant_text

Get the text content of the last assistant message.

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

Returns `{"text": null}` if no assistant messages exist.

#### set_session_name

Set a display name for the current session. The name appears in session listings and helps identify sessions.

```json
{"type": "set_session_name", "name": "my-feature-work"}
```

Response:
```json
{
  "type": "response",
  "command": "set_session_name",
  "success": true
}
```

The current session name is available via `get_state` in the `sessionName` field. To set the initial name when starting RPC mode, pass `--name <name>` or `-n <name>` to the `atomic --mode rpc` process.

### Commands

#### get_commands

Get available commands (extension commands, prompt templates, and skills). These can be invoked via the `prompt` command by prefixing with `/`.

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
      {"name": "session-name", "description": "Set or clear session name", "source": "extension", "path": "/home/user/.atomic/agent/extensions/session.ts"},
      {"name": "fix-tests", "description": "Fix failing tests", "source": "prompt", "location": "project", "path": "/home/user/myproject/.atomic/prompts/fix-tests.md"},
      {"name": "skill:brave-search", "description": "Web search via Brave API", "source": "skill", "location": "user", "path": "/home/user/.atomic/agent/skills/brave-search/SKILL.md"}
    ]
  }
}
```

Each command has:
- `name`: Command name (invoke with `/name`)
- `description`: Human-readable description (optional for extension commands)
- `source`: What kind of command:
  - `"extension"`: Registered via `pi.registerCommand()` in an extension
  - `"prompt"`: Loaded from a prompt template `.md` file
  - `"skill"`: Loaded from a skill directory (name is prefixed with `skill:`)
- `location`: Where it was loaded from (optional, not present for extensions):
  - `"user"`: User-level (`~/.atomic/agent/`)
  - `"project"`: Project-level (`./.atomic/`)
  - `"path"`: Explicit path via CLI or settings
- `path`: Absolute file path to the command source (optional)

**Note**: Built-in TUI commands (`/settings`, `/hotkeys`, etc.) are not included. They are handled only in interactive mode and would not execute if sent via `prompt`.

## Events

Events are streamed to stdout as JSON lines during agent operation. Events do NOT include an `id` field (only responses do).

### Event Types

| Event | Description |
|-------|-------------|
| `agent_start` | Agent begins processing |
| `agent_end` | Agent completes (includes all generated messages) |
| `turn_start` | New turn begins |
| `turn_end` | Turn completes (includes assistant message and tool results) |
| `message_start` | Message begins |
| `message_update` | Streaming update (text/thinking/toolcall deltas) |
| `message_end` | Message completes |
| `tool_execution_start` | Tool begins execution |
| `tool_execution_update` | Tool execution progress (streaming output) |
| `tool_execution_end` | Tool completes |
| `queue_update` | Pending steering/follow-up queue changed |
| `context_window_changed` | Active context-window token budget changed |
| `compaction_start` | Verbatim line compaction begins |
| `compaction_end` | Verbatim line compaction completes |
| `auto_retry_start` | Auto-retry begins (after transient error) |
| `auto_retry_end` | Auto-retry completes (success or final failure) |
| `extension_error` | Extension threw an error |

### agent_start

Emitted when the agent begins processing a prompt.

```json
{"type": "agent_start"}
```

### agent_end

Emitted when the agent completes. Contains all messages generated during this run.

```json
{
  "type": "agent_end",
  "messages": [...]
}
```

### turn_start / turn_end

A turn consists of one assistant response plus any resulting tool calls and results.

```json
{"type": "turn_start"}
```

```json
{
  "type": "turn_end",
  "message": {...},
  "toolResults": [...]
}
```

### message_start / message_end

Emitted when a message begins and completes. The `message` field contains an `AgentMessage`.

```json
{"type": "message_start", "message": {...}}
{"type": "message_end", "message": {...}}
```

### message_update (Streaming)

Emitted during streaming of assistant messages. Contains both the partial message and a streaming delta event.

```json
{
  "type": "message_update",
  "message": {...},
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello ",
    "partial": {...}
  }
}
```

The `assistantMessageEvent` field contains one of these delta types:

| Type | Description |
|------|-------------|
| `start` | Message generation started |
| `text_start` | Text content block started |
| `text_delta` | Text content chunk |
| `text_end` | Text content block ended |
| `thinking_start` | Thinking block started |
| `thinking_delta` | Thinking content chunk |
| `thinking_end` | Thinking block ended |
| `toolcall_start` | Tool call started |
| `toolcall_delta` | Tool call arguments chunk |
| `toolcall_end` | Tool call ended (includes full `toolCall` object) |
| `done` | Message complete (reason: `"stop"`, `"length"`, `"toolUse"`) |
| `error` | Error occurred (reason: `"aborted"`, `"error"`) |

Example streaming a text response:
```json
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_start","contentIndex":0,"partial":{...}}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello","partial":{...}}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world","partial":{...}}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world","partial":{...}}}
```

### tool_execution_start / tool_execution_update / tool_execution_end

Emitted when a tool begins, streams progress, and completes execution.

```json
{
  "type": "tool_execution_start",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"}
}
```

During execution, `tool_execution_update` events stream partial results (e.g., bash output as it arrives):

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

When complete:

```json
{
  "type": "tool_execution_end",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "result": {
    "content": [{"type": "text", "text": "total 48\n..."}],
    "details": {...}
  },
  "isError": false
}
```

Use `toolCallId` to correlate events. The `partialResult` in `tool_execution_update` contains the accumulated output so far (not just the delta), allowing clients to simply replace their display on each update.

### queue_update

Emitted whenever the pending steering or follow-up queue changes.

```json
{
  "type": "queue_update",
  "steering": ["Focus on error handling"],
  "followUp": ["After that, summarize the result"]
}
```

### context_window_changed

Emitted when the active context-window token budget changes through RPC `set_context_window`, `AgentSession.setContextWindow()` in an SDK-backed runtime, or because in-place tree navigation replayed a branch-scoped `context_window_change` entry. Navigation replay updates the active model for accurate budgeting and compaction but does not append another session entry or write context-window defaults to settings.

```json
{
  "type": "context_window_changed",
  "contextWindow": 1000000
}
```

Larger provider context windows may consume more credits/cost. Prefer the model default unless the additional repository/session context is useful for the current task. For catalog-advertised GitHub Copilot long-context models such as `github-copilot/gpt-5.5`, `github-copilot/claude-sonnet-5`, and `github-copilot/gemini-3.1-pro-preview`, a `1m` selection raises Atomic's local budget and sends `X-GitHub-Api-Version: 2026-06-01`; GitHub applies the long-context billing tier server-side by prompt size, consumes more Copilot AI credits, and requires long-context/usage-based billing entitlement.

### compaction_start / compaction_end

Emitted when default Verbatim Compaction runs, whether manual or automatic. The result records deletion targets and stats rather than a generated summary.

```json
{"type": "compaction_start", "reason": "threshold"}
```

The `reason` field is `"manual"`, `"threshold"`, or `"overflow"`.

```json
{
  "type": "compaction_end",
  "reason": "threshold",
  "result": {
    "compactedText": "[User]: fix the test\n(filtered 42 lines)",
    "firstKeptEntryId": "m7",
    "tokensBefore": 150000,
    "promptVersion": 3,
    "parameters": {"compression_ratio": 0.5, "preserve_recent": 2, "query": "fix the test"},
    "rung": "planned",
    "stats": {
      "linesBefore": 812,
      "linesDeleted": 417,
      "linesKept": 395,
      "rangeCount": 63,
      "tokensBefore": 150000,
      "tokensAfter": 72000,
      "percentReduction": 52
    }
  },
  "aborted": false,
  "willRetry": false
}
```

If `reason` was `"overflow"` and compaction succeeds, `willRetry` is `true` and the agent will automatically retry the prompt. Public prompt/RPC callers wait for that post-compaction continuation before the prompt is considered complete.

If compaction was aborted, `result` is `null` and `aborted` is `true`.

If compaction failed (e.g., API quota exceeded), `result` is `null`, `aborted` is `false`, and `errorMessage` contains the error description.

If overflow recovery exhausts the same-model compact-and-retry attempt, `compaction_end` includes `"unresolvedOverflow": true` and an `errorMessage`. Workflow orchestration treats that signal as a context-length failure that can advance configured model fallback tiers.

There is no `context_compact` command; Atomic reports it as an unknown command. Use `compact`. Only `compaction_start` and `compaction_end` events are emitted.

### auto_retry_start / auto_retry_end

Emitted when automatic retry is triggered after a transient error (overloaded, rate limit, 5xx).

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
{
  "type": "auto_retry_end",
  "success": true,
  "attempt": 2
}
```

On final failure (max retries exceeded):
```json
{
  "type": "auto_retry_end",
  "success": false,
  "attempt": 3,
  "finalError": "529 overloaded_error: Overloaded"
}
```

### extension_error

Emitted when an extension throws an error.

```json
{
  "type": "extension_error",
  "extensionPath": "/path/to/extension.ts",
  "event": "tool_call",
  "error": "Error message..."
}
```

## Extension UI Protocol

Extensions can request user interaction via `ctx.ui.select()`, `ctx.ui.confirm()`, etc. In RPC mode, these are translated into a request/response sub-protocol on top of the base command/event flow.

There are two categories of extension UI methods:

- **Dialog methods** (`select`, `confirm`, `input`, `editor`): emit an `extension_ui_request` on stdout and block until the client sends back an `extension_ui_response` on stdin with the matching `id`.
- **Fire-and-forget methods** (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`): emit an `extension_ui_request` on stdout but do not expect a response. The client can display the information or ignore it.

If a dialog method includes a `timeout` field, the agent-side will auto-resolve with a default value when the timeout expires. The client does not need to track timeouts.

Some `ExtensionUIContext` methods are not supported or degraded in RPC mode because they require direct TUI access:
- `custom()` returns `undefined`
- `setWorkingMessage()`, `setWorkingIndicator()`, `setFooter()`, `setHeader()`, `setEditorComponent()` are no-ops
- `getEditorText()` returns `""`
- `setToolsExpanded()` and `getToolsExpanded()` maintain context-local expansion state; `getChatRenderSettings().toolOutputExpanded` reports the same value. This state is not sent through the client extension-UI protocol.
- `pasteToEditor()` delegates to `setEditorText()` (no paste/collapse handling)
- `getAllThemes()` returns `[]`
- `getTheme()` returns `undefined`
- `setTheme()` returns `{ success: false, error: "..." }`

Note: `ctx.mode` is `"rpc"` and `ctx.hasUI` is `true` in RPC mode because the dialog and fire-and-forget methods are functional via the extension UI sub-protocol. Use `ctx.mode === "tui"` to guard TUI-specific features like `custom()` that require a real terminal.

### Extension UI Requests (stdout)

All requests have `type: "extension_ui_request"`, a unique `id`, and a `method` field.

#### select

Prompt the user to choose from a list. Dialog methods with a `timeout` field include the timeout in milliseconds; the agent auto-resolves with `undefined` if the client doesn't respond in time.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "select",
  "title": "Allow dangerous command?",
  "options": ["Allow", "Block"],
  "timeout": 10000
}
```

Expected response: `extension_ui_response` with `value` (the selected option string) or `cancelled: true`.

#### confirm

Prompt the user for yes/no confirmation.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Clear session?",
  "message": "All messages will be lost.",
  "timeout": 5000
}
```

Expected response: `extension_ui_response` with `confirmed: true/false` or `cancelled: true`.

#### input

Prompt the user for free-form text.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "input",
  "title": "Enter a value",
  "placeholder": "type something..."
}
```

Expected response: `extension_ui_response` with `value` (the entered text) or `cancelled: true`.

#### editor

Open a multi-line text editor with optional prefilled content.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-4",
  "method": "editor",
  "title": "Edit some text",
  "prefill": "Line 1\nLine 2\nLine 3"
}
```

Expected response: `extension_ui_response` with `value` (the edited text) or `cancelled: true`.

#### notify

Display a notification. Fire-and-forget, no response expected.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-5",
  "method": "notify",
  "message": "Command blocked by user",
  "notifyType": "warning"
}
```

The `notifyType` field is `"info"`, `"warning"`, or `"error"`. Defaults to `"info"` if omitted.

#### setStatus

Set or clear a status entry in the footer/status bar. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-6",
  "method": "setStatus",
  "statusKey": "my-ext",
  "statusText": "Turn 3 running..."
}
```

Send `statusText: undefined` (or omit it) to clear the status entry for that key.

#### setWidget

Set or clear a widget (block of text lines) displayed above or below the editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setWidget",
  "widgetKey": "my-ext",
  "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"],
  "widgetPlacement": "aboveEditor"
}
```

Send `widgetLines: undefined` (or omit it) to clear the widget. The `widgetPlacement` field is `"aboveEditor"` (default) or `"belowEditor"`. Only string arrays are supported in RPC mode; component factories are ignored.

#### setTitle

Set the terminal window/tab title. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-8",
  "method": "setTitle",
  "title": "atomic - my project"
}
```

#### set_editor_text

Set the text in the input editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-9",
  "method": "set_editor_text",
  "text": "prefilled text for the user"
}
```

### Extension UI Responses (stdin)

Responses are sent for dialog methods only (`select`, `confirm`, `input`, `editor`). The `id` must match the request.

#### Value response (select, input, editor)

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

#### Confirmation response (confirm)

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

#### Cancellation response (any dialog)

Dismiss any dialog method. The extension receives `undefined` (for select/input/editor) or `false` (for confirm).

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

## Error Handling

Failed commands return a response with `success: false`:

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: invalid/model"
}
```

Parse errors:

```json
{
  "type": "response",
  "command": "parse",
  "success": false,
  "error": "Failed to parse command: Unexpected token..."
}
```

## Types

Source files and installed definitions:
- `node_modules/@earendil-works/pi-ai/dist/types.d.ts` - `Model`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`
- `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts` - `AgentMessage`, `AgentEvent`
- [`src/core/messages.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/messages.ts) - `BashExecutionMessage`
- [`src/modes/rpc/rpc-types.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts) - RPC command/response types, extension UI request/response types

### Model

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
  "defaultContextWindow": 200000,
  "contextWindowOptions": [200000, 1000000],
  "maxTokens": 16384,
  "cost": {
    "input": 3.0,
    "output": 15.0,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  }
}
```

`contextWindow` is the active/effective token budget used by Atomic's local budgeting, footer/stats, and compaction logic. `defaultContextWindow` is the model's scalar default before a session/runtime override, and `contextWindowOptions` lists selectable token budgets when the model supports more than one size. RPC clients can read/select the active runtime budget with `get_available_context_windows` and `set_context_window`; the runtime command does not persist context-window defaults to settings.

### UserMessage

```json
{
  "role": "user",
  "content": "Hello!",
  "timestamp": 1733234567890
}
```

The `content` field can be a string or an array of `TextContent`/`ImageContent` blocks.

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
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "stopReason": "stop",
  "timestamp": 1733234567890
}
```

Stop reasons: `"stop"`, `"length"`, `"toolUse"`, `"error"`, `"aborted"`

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

Created by the `bash` RPC command (not by LLM tool calls):

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

### Attachment

```json
{
  "id": "img1",
  "type": "image",
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 102400,
  "content": "base64-encoded-data...",
  "extractedText": null,
  "preview": null
}
```

## Example: Basic Client (Python)

```python
import subprocess
import json

proc = subprocess.Popen(
    ["atomic", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True
)

def send(cmd):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()

def read_events():
    for line in proc.stdout:
        yield json.loads(line)

# Send prompt
send({"type": "prompt", "message": "Hello!"})

# Process events
for event in read_events():
    if event.get("type") == "message_update":
        delta = event.get("assistantMessageEvent", {})
        if delta.get("type") == "text_delta":
            print(delta["delta"], end="", flush=True)
    
    if event.get("type") == "agent_end":
        print()
        break
```

## Example: Interactive Client (Node.js)

See [`test/rpc-example.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/test/rpc-example.ts) for a complete interactive example, or [`src/modes/rpc/rpc-client.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/modes/rpc/rpc-client.ts) for a typed client implementation.

For a complete example of handling the extension UI protocol, see [`examples/rpc-extension-ui.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/rpc-extension-ui.ts) which pairs with the [`examples/extensions/rpc-demo.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/rpc-demo.ts) extension.

```javascript
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const agent = spawn("atomic", ["--mode", "rpc", "--no-session"]);

function attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

        while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;

            let line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            onLine(line);
        }
    });

    stream.on("end", () => {
        buffer += decoder.end();
        if (buffer.length > 0) {
            onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
        }
    });
}

attachJsonlReader(agent.stdout, (line) => {
    const event = JSON.parse(line);

    if (event.type === "message_update") {
        const { assistantMessageEvent } = event;
        if (assistantMessageEvent.type === "text_delta") {
            process.stdout.write(assistantMessageEvent.delta);
        }
    }
});

// Send prompt
agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// Abort on CTRL+C
process.on("SIGINT", () => {
    agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```
