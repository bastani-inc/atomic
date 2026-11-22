---
title: "RPC"
description: "Drive a long-lived Atomic process over stdin/stdout JSONL."
---

# RPC mode

RPC mode runs Atomic headless over a JSON Lines protocol on stdin and stdout. Use it to embed Atomic in other languages, IDEs, or custom UIs.

If you are building a Node.js or TypeScript application, consider using `AgentSession` directly from the [SDK](/sdk) instead of spawning a subprocess. For a typed subprocess client in TypeScript, use `RpcClient` exported from `@bastani/atomic` (see [RPC client examples](/rpc/examples)).

An extension can call `ctx.shutdown()` to close an idle RPC session without another client command. Shutdown waits for any active command response and running turn. A request during extension-started compaction outside a turn is processed after the next command or turn once compaction finishes.

Closing stdin, `SIGTERM`, and `SIGHUP` each start an orderly shutdown that disposes the active runtime before exiting. Once shutdown starts, a stdin close or single signal does not interrupt cleanup, so closing stdin and sending `SIGTERM` together lets disposal finish.

A second signal exits immediately (`143` for `SIGTERM`, `129` for `SIGHUP`), and `SIGKILL` always ends the process immediately. Orderly shutdown exits with code `0`; if disposal fails, Atomic writes a [`shutdown_error`](/rpc/protocol#shutdown_error) event and exits with code `1` (or the signal's code when a signal started shutdown).

[`abort`](/rpc/protocol#abort) holds queued messages, like `Esc` in the TUI, so a client can abort and then close stdin: any queued completion notice is saved for the next session instead of failing disposal.

`get_entries`, `get_tree`, and `get_fork_messages` keep their existing response shapes (`entries`, `tree`, and `messages`). On a compacted or branched session, `get_entries` and `get_tree` cover the resident window, while `get_fork_messages` still includes prompts from older branches using short picker labels. Use [`get_history_page`](/rpc/protocol#get_history_page) (following `nextCursor`) and `get_history_chunk` to read older entries and oversized items.

## Where to go next

This page starts RPC mode and walks through a minimal Python client. Reference details live on dedicated pages:

- [RPC protocol](/rpc/protocol): every command, event, type, and error contract.
- [RPC extension UI protocol](/rpc/extension-ui): drive extension-rendered UI and OAuth prompts over RPC.
- [RPC client examples](/rpc/examples): Node.js and `RpcClient` client implementations.
- [Stored session summaries](/rpc/protocol#stored-session-summaries): read session summaries without starting a model turn.

Compare RPC mode with the SDK and JSON mode on [Programmatic use](/programmatic).

## Starting RPC mode

```bash
atomic --mode rpc [options]
```

Common options:
- `--provider <name>`: set the LLM provider (`anthropic`, `openai`, `google`, and others).
- `--model <pattern>`: model pattern or ID (supports `provider/id` and optional `:<thinking>`).
- `--name <name>` / `-n <name>`: set the session display name at startup.
- `--no-session`: run without a resumable session ([released history may use disk](/sessions)).
- `--session-dir <path>`: custom session storage directory.
- `--storage '<json>'` / `--storage-file <path>`: select storage for this process's sessions.

To give an RPC child its own store without changing user settings, start it with `ATOMIC_STORAGE` (or `--storage`) holding the same JSON selection as the `storage` setting (for example, an adapter selection with `secrets` read from `{ "env": ... }`). The child keeps its sessions there and `list_sessions` reports that store, while other `atomic` processes keep using their settings. Invalid selections fail at startup with `StorageConfigError`. See [Selecting storage per process](/storage#selecting-storage-per-process).

## Protocol overview

- **Commands**: JSON objects sent to stdin, one per line.
- **Responses**: JSON objects with `type: "response"` indicating command success or failure.
- **Events**: session events streamed to stdout as JSON lines.

Every command accepts an optional `id` field for request/response correlation. When provided, the matching response echoes the same `id`.

If a complete saved provider/model default names a provider that stays unsupported after registration, the process stays live and `prompt` returns a correlated error with the configuration diagnostic before emitting any event. Non-prompt commands such as `get_available_models` keep working. Clear this state with a successful explicit `set_model`, or a `cycle_model` that returns a different available model (a `null` or unchanged cycle result does not clear it). Supported providers with an unknown model or missing auth keep normal automatic fallback behavior.

### Framing

RPC mode uses strict JSONL framing with LF (`\n`) as the only record delimiter.

Atomic imposes no line-size limit on RPC or isolated interactive-engine JSONL records; commands, responses, events, and render frames serialize in full. Clients must account for memory and latency on large records and should not add smaller line caps unless they intend to reject valid output.

Client framing rules:
- Split records on `\n` only.
- Accept optional `\r\n` input by stripping a trailing `\r`.
- Avoid generic line readers that split on Unicode line separators.

Node's `readline` module is not protocol-compliant for RPC mode because it splits on `U+2028` and `U+2029`, which are valid unescaped inside JSON strings.

## Example: basic client (Python)

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

## Moved sections

<a id="commands" />
<a id="prompting" />
<a id="prompt" />
<a id="steer" />
<a id="follow_up" />
<a id="abort" />
<a id="clear_queue" />
<a id="new_session" />
<a id="state" />
<a id="get_state" />
<a id="get_messages" />
<a id="model" />
<a id="set_model" />
<a id="cycle_model" />
<a id="get_available_models" />
<a id="logout_provider" />
<a id="thinking" />
<a id="set_thinking_level" />
<a id="cycle_thinking_level" />
<a id="get_available_thinking_levels" />
<a id="queue-modes" />
<a id="set_steering_mode" />
<a id="set_follow_up_mode" />
<a id="compaction" />
<a id="compact" />
<a id="set_auto_compaction" />
<a id="retry" />
<a id="set_auto_retry" />
<a id="abort_retry" />
<a id="bash" />
<a id="bash-2" />
<a id="abort_bash" />
<a id="session" />
<a id="get_session_stats" />
<a id="export_html" />
<a id="switch_session" />
<a id="fork" />
<a id="clone" />
<a id="get_fork_messages" />
<a id="get_entries" />
<a id="get_tree" />
<a id="get_last_assistant_text" />
<a id="set_session_name" />
<a id="commands-2" />
<a id="get_commands" />
<a id="events" />
<a id="event-types" />
<a id="agent_start" />
<a id="agent_end" />
<a id="turn_start-/-turn_end" />
<a id="message_start-/-message_end" />
<a id="message_update-streaming" />
<a id="tool_execution_start-/-tool_execution_update-/-tool_execution_end" />
<a id="bash_execution_update" />
<a id="queue_update" />
<a id="compaction_start-/-compaction_end" />
<a id="auto_retry_start-/-auto_retry_end" />
<a id="summarization_retry_scheduled-/-summarization_retry_attempt_start-/-summarization_retry_finished" />
<a id="extension_error" />
<a id="error-handling" />
<a id="types" />
<a id="model-2" />
<a id="usermessage" />
<a id="assistantmessage" />
<a id="toolresultmessage" />
<a id="bashexecutionmessage" />
<a id="attachment" />
<a id="extension-ui-protocol" />
<a id="extension-ui-requests-stdout" />
<a id="select" />
<a id="confirm" />
<a id="input" />
<a id="editor" />
<a id="notify" />
<a id="setstatus" />
<a id="setwidget" />
<a id="settitle" />
<a id="set_editor_text" />
<a id="extension-ui-responses-stdin" />
<a id="value-response-select-input-editor" />
<a id="confirmation-response-confirm" />
<a id="cancellation-response-any-dialog" />
<a id="example-interactive-client-node-js" />

These reference sections moved to dedicated pages:

- Commands, events, error handling, and JSON types: [RPC protocol](/rpc/protocol)
- Extension UI requests, OAuth prompts, and responses: [RPC extension UI protocol](/rpc/extension-ui)
- Node.js interactive client and `RpcClient` examples: [RPC client examples](/rpc/examples)
