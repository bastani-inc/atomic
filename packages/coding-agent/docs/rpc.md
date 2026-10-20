---
title: "RPC"
description: "Drive a long-lived Atomic process over stdin/stdout JSONL."
---

# RPC Mode

RPC mode enables headless operation of the coding agent via a JSON protocol over stdin/stdout. This is useful for embedding the agent in other applications, IDEs, or custom UIs.

**Note for Node.js/TypeScript users**: If you're building a Node.js application, consider using `AgentSession` directly from `@bastani/atomic` instead of spawning a subprocess. See [`src/core/agent-session.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/agent-session.ts) for the API. For a subprocess-based TypeScript client, see [`src/modes/rpc/rpc-client.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/modes/rpc/rpc-client.ts).

## Where to go next

This page starts RPC mode and walks one client end to end. The rest is split by job:

- [RPC protocol](/rpc/protocol) — every command, event, type, and error contract.
- [RPC extension UI protocol](/rpc/extension-ui) — drive extension-rendered UI over RPC.
- [RPC client examples](/rpc/examples) — additional client implementations.
- [Stored summaries and workflow history](/rpc/protocol#stored-summaries-and-workflow-history) — read session and workflow summaries without starting a model turn.

Not sure RPC is the right integration mode? Compare it with the SDK and JSON mode on [Programmatic use](/programmatic).

## Starting RPC Mode

```bash
atomic --mode rpc [options]
```

Common options:
- `--provider <name>`: Set the LLM provider (anthropic, openai, google, etc.)
- `--model <pattern>`: Model pattern or ID (supports `provider/id` and optional `:<thinking>`)
- `--name <name>` / `-n <name>`: Set the session display name at startup
- `--no-session`: Disable session persistence
- `--session-dir <path>`: Custom session storage directory
- `--storage '<json>'` / `--storage-file <path>`: Select storage for this process's sessions and workflow runs

To give an RPC child its own store without changing the user's settings, start it with `ATOMIC_STORAGE` (or `--storage`) holding the same JSON selection as the shared `storage` setting, for example an adapter selection with `secrets` read from `{ "env": ... }`. The child keeps its sessions and workflow runs there, and `list_sessions` and `list_workflow_runs` report that store. An `atomic` started without the selection keeps using its settings. An invalid selection fails at startup with `StorageConfigError` naming the variable or flag. See [Selecting storage per process](/storage#selecting-storage-per-process).

## Protocol Overview

- **Commands**: JSON objects sent to stdin, one per line
- **Responses**: JSON objects with `type: "response"` indicating command success/failure
- **Events**: Agent events streamed to stdout as JSON lines

All commands support an optional `id` field for request/response correlation. If provided, the corresponding response will include the same `id`.

A complete saved provider/model default can block prompts if its provider remains unsupported after registration. The process stays live, but `prompt` returns a correlated error with the generic configuration diagnostic before emitting any user/model event. `get_available_models` and other non-prompt commands remain available.

Clear this condition with a successful explicit `set_model` or a successful `cycle_model` that returns a different available model. A null or unchanged cycle result does not clear it. Replacing the session applies the new session's condition again.

Supported providers with an unknown model or missing authentication retain ordinary automatic fallback behavior.

### Framing

RPC mode uses strict JSONL semantics with LF (`\n`) as the only record delimiter.

Atomic does not impose a size limit on RPC or isolated interactive-engine JSONL records. Commands, responses, events, and render frames are serialized in full. Clients and extensions must account for the memory and latency cost of large records and must not add a smaller line limit unless they intend to reject valid Atomic output.

This matters for clients:
- Split records on `\n` only
- Accept optional `\r\n` input by stripping a trailing `\r`
- Do not use generic line readers that treat Unicode separators as newlines

In particular, Node `readline` is not protocol-compliant for RPC mode because it also splits on `U+2028` and `U+2029`, which are valid inside JSON strings.

## Commands

Moved to [RPC protocol](/rpc/protocol#commands).

### Prompting

Moved to [RPC protocol](/rpc/protocol#prompting).

#### prompt

Moved to [RPC protocol](/rpc/protocol#prompt).

#### steer

Moved to [RPC protocol](/rpc/protocol#steer).

#### follow_up

Moved to [RPC protocol](/rpc/protocol#follow_up).

#### abort

Moved to [RPC protocol](/rpc/protocol#abort).

#### clear_queue

Moved to [RPC protocol](/rpc/protocol#clear_queue).

#### new_session

Moved to [RPC protocol](/rpc/protocol#new_session).

### State

Moved to [RPC protocol](/rpc/protocol#state).

#### get_state

Moved to [RPC protocol](/rpc/protocol#get_state).

#### get_messages

Moved to [RPC protocol](/rpc/protocol#get_messages).

### Model

Moved to [RPC protocol](/rpc/protocol#model).

#### set_model

Moved to [RPC protocol](/rpc/protocol#set_model).

#### cycle_model

Moved to [RPC protocol](/rpc/protocol#cycle_model).

#### get_available_models

Moved to [RPC protocol](/rpc/protocol#get_available_models).

#### logout_provider

Moved to [RPC protocol](/rpc/protocol#logout_provider).

### Thinking

Moved to [RPC protocol](/rpc/protocol#thinking).

#### set_thinking_level

Moved to [RPC protocol](/rpc/protocol#set_thinking_level).

#### cycle_thinking_level

Moved to [RPC protocol](/rpc/protocol#cycle_thinking_level).

#### get_available_thinking_levels

Moved to [RPC protocol](/rpc/protocol#get_available_thinking_levels).

### Queue Modes

Moved to [RPC protocol](/rpc/protocol#queue-modes).

#### set_steering_mode

Moved to [RPC protocol](/rpc/protocol#set_steering_mode).

#### set_follow_up_mode

Moved to [RPC protocol](/rpc/protocol#set_follow_up_mode).

### Compaction

Moved to [RPC protocol](/rpc/protocol#compaction).

#### compact

Moved to [RPC protocol](/rpc/protocol#compact).

#### set_auto_compaction

Moved to [RPC protocol](/rpc/protocol#set_auto_compaction).

### Retry

Moved to [RPC protocol](/rpc/protocol#retry).

#### set_auto_retry

Moved to [RPC protocol](/rpc/protocol#set_auto_retry).

#### abort_retry

Moved to [RPC protocol](/rpc/protocol#abort_retry).

### Bash

Moved to [RPC protocol](/rpc/protocol#bash).

#### bash

Moved to [RPC protocol](/rpc/protocol#bash-2).

#### abort_bash

Moved to [RPC protocol](/rpc/protocol#abort_bash).

### Session

Moved to [RPC protocol](/rpc/protocol#session).

#### get_session_stats

Moved to [RPC protocol](/rpc/protocol#get_session_stats).

#### export_html

Moved to [RPC protocol](/rpc/protocol#export_html).

#### switch_session

Moved to [RPC protocol](/rpc/protocol#switch_session).

#### fork

Moved to [RPC protocol](/rpc/protocol#fork).

#### clone

Moved to [RPC protocol](/rpc/protocol#clone).

#### get_fork_messages

Moved to [RPC protocol](/rpc/protocol#get_fork_messages).

#### get_entries

Moved to [RPC protocol](/rpc/protocol#get_entries).

#### get_tree

Moved to [RPC protocol](/rpc/protocol#get_tree).

#### get_last_assistant_text

Moved to [RPC protocol](/rpc/protocol#get_last_assistant_text).

#### set_session_name

Moved to [RPC protocol](/rpc/protocol#set_session_name).

### Commands

Moved to [RPC protocol](/rpc/protocol#commands-2).

#### get_commands

Moved to [RPC protocol](/rpc/protocol#get_commands).

## Events

Moved to [RPC protocol](/rpc/protocol#events).

### Event Types

Moved to [RPC protocol](/rpc/protocol#event-types).

### agent_start

Moved to [RPC protocol](/rpc/protocol#agent_start).

### agent_end

Moved to [RPC protocol](/rpc/protocol#agent_end).

### turn_start / turn_end

Moved to [RPC protocol](/rpc/protocol#turn_start-/-turn_end).

### message_start / message_end

Moved to [RPC protocol](/rpc/protocol#message_start-/-message_end).

### message_update (Streaming)

Moved to [RPC protocol](/rpc/protocol#message_update-streaming).

### tool_execution_start / tool_execution_update / tool_execution_end

Moved to [RPC protocol](/rpc/protocol#tool_execution_start-/-tool_execution_update-/-tool_execution_end).

### bash_execution_update

Moved to [RPC protocol](/rpc/protocol#bash_execution_update).

### queue_update

Moved to [RPC protocol](/rpc/protocol#queue_update).

### compaction_start / compaction_end

Moved to [RPC protocol](/rpc/protocol#compaction_start-/-compaction_end).

### auto_retry_start / auto_retry_end

Moved to [RPC protocol](/rpc/protocol#auto_retry_start-/-auto_retry_end).

### summarization_retry_scheduled / summarization_retry_attempt_start / summarization_retry_finished

Moved to [RPC protocol](/rpc/protocol#summarization_retry_scheduled-/-summarization_retry_attempt_start-/-summarization_retry_finished).

### extension_error

Moved to [RPC protocol](/rpc/protocol#extension_error).

## Extension UI Protocol

Moved to [RPC extension UI protocol](/rpc/extension-ui#extension-ui-protocol).

### Extension UI Requests (stdout)

Moved to [RPC extension UI protocol](/rpc/extension-ui#extension-ui-requests-stdout).

#### select

Moved to [RPC extension UI protocol](/rpc/extension-ui#select).

#### confirm

Moved to [RPC extension UI protocol](/rpc/extension-ui#confirm).

#### input

Moved to [RPC extension UI protocol](/rpc/extension-ui#input).

#### editor

Moved to [RPC extension UI protocol](/rpc/extension-ui#editor).

#### notify

Moved to [RPC extension UI protocol](/rpc/extension-ui#notify).

#### setStatus

Moved to [RPC extension UI protocol](/rpc/extension-ui#setstatus).

#### setWidget

Moved to [RPC extension UI protocol](/rpc/extension-ui#setwidget).

#### setTitle

Moved to [RPC extension UI protocol](/rpc/extension-ui#settitle).

#### set_editor_text

Moved to [RPC extension UI protocol](/rpc/extension-ui#set_editor_text).

### Extension UI Responses (stdin)

Moved to [RPC extension UI protocol](/rpc/extension-ui#extension-ui-responses-stdin).

#### Value response (select, input, editor)

Moved to [RPC extension UI protocol](/rpc/extension-ui#value-response-select-input-editor).

#### Confirmation response (confirm)

Moved to [RPC extension UI protocol](/rpc/extension-ui#confirmation-response-confirm).

#### Cancellation response (any dialog)

Moved to [RPC extension UI protocol](/rpc/extension-ui#cancellation-response-any-dialog).

## Error Handling

Moved to [RPC protocol](/rpc/protocol#error-handling).

## Types

Moved to [RPC protocol](/rpc/protocol#types).

### Model

Moved to [RPC protocol](/rpc/protocol#model-2).

### UserMessage

Moved to [RPC protocol](/rpc/protocol#usermessage).

### AssistantMessage

Moved to [RPC protocol](/rpc/protocol#assistantmessage).

### ToolResultMessage

Moved to [RPC protocol](/rpc/protocol#toolresultmessage).

### BashExecutionMessage

Moved to [RPC protocol](/rpc/protocol#bashexecutionmessage).

### Attachment

Moved to [RPC protocol](/rpc/protocol#attachment).

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

Moved to [RPC client examples](/rpc/examples#example-interactive-client-node-js).
