---
title: "Drive Atomic over RPC"
sidebarTitle: "Drive over RPC"
description: "Drive a long-lived Atomic process over stdin and stdout using newline-delimited JSON commands, concurrency lanes, and streamed events."
---

RPC mode runs Atomic headless over a JSON Lines protocol on stdin and stdout. Use it to integrate Atomic into non-Node languages, editors, IDEs, or custom UIs.

If you are building a Node.js or TypeScript application, you can embed `AgentSession` directly with the [TypeScript SDK](/sdk) or use the typed `RpcClient` exported from `@bastani/atomic` (see [Connect with RPC clients](/rpc/examples)). Compare all four programmatic modes on [Choose an integration mode](/programmatic).

## Reference pages

<Columns cols={2}>
  <Card title="RPC protocol reference" href="/rpc/protocol">
    Every RPC command, streamed event, structured error code, and JSON wire type.
  </Card>
  <Card title="Handle extension UI over RPC" href="/rpc/extension-ui">
    Answer extension dialogs, notifications, widgets, questionnaires, and OAuth prompts.
  </Card>
  <Card title="Connect with RPC clients" href="/rpc/examples">
    TypeScript `RpcClient` recipes, caveats, and a standalone Node.js client.
  </Card>
  <Card title="Stored session summaries" href="/rpc/protocol#stored-session-summaries">
    Inspect saved sessions with `get_session_summary` and `list_sessions` without starting a model turn.
  </Card>
</Columns>

## Starting RPC mode

```bash
atomic --mode rpc [options]
```

Common startup options:

- `--provider <name>`: select the model provider (`anthropic`, `openai`, `google`, and others).
- `--model <pattern>`: select a model by `provider/id` or pattern, with optional `:<thinking>` level.
- `--models <patterns>`: restrict scoped models (comma-separated patterns).
- `--thinking <level>`: set the initial thinking level.
- `--session <id>` / `--continue` (`-c`) / `--resume` (`-r`): open or resume a stored session.
- `--name <name>` / `-n <name>`: set the session display name at startup.
- `--no-session`: run without a resumable session (released idle history may still page to disk; see [Sessions](/sessions)).
- `--session-dir <path>`: select a JSONL session storage and lookup directory.
- `--session-store <path>`: select a SQLite session database file (cannot be combined with `--session-dir` or `--no-session`).
- `--session-prefix <prefix>`: table prefix for `--session-store` (requires `--session-store`; defaults to empty).
- `--storage '<json>'` / `--storage-file <path>`: select storage for this process's sessions.
- `--tools <list>` / `--no-tools` / `--exclude-tools <list>`: control which tools are active.

<Note>
`@file` CLI arguments are **not supported** in RPC mode; passing any `@file` argument writes an error to stderr and exits immediately with code `1`. Send file content or base64 `images` inside `prompt`, `steer`, or `follow_up` commands instead.
</Note>

To isolate an RPC subprocess's session store without changing user settings, start it with `ATOMIC_STORAGE` or `--storage` set to the same JSON object as the `storage` setting (for example, an adapter config reading secrets from `{ "env": "..." }`). `list_sessions` reports that store while other `atomic` processes keep their own settings. Invalid storage selections fail at startup with `StorageConfigError`. See [Selecting storage per process](/storage#selecting-storage-per-process).

## Protocol overview

- **Commands:** JSON objects written to stdin, one per line.
- **Responses:** JSON objects with `type: "response"` reporting command success or failure.
- **Events:** session events streamed to stdout as JSON lines.

Every command accepts an optional `id` string for request correlation. When you send `id`, the matching response echoes the same `id`.

If a saved default `provider/model` names a provider that remains unsupported after startup, the process stays alive and `prompt` returns a correlated error containing the configuration diagnostic before emitting any event. Non-prompt commands such as `get_available_models` keep working. Clear the error state with a successful explicit `set_model`, or a `cycle_model` that switches to a different available model (an unchanged or `null` cycle does not clear it). Supported providers with an unknown model or missing credentials fall back automatically as usual.

On compacted or branched sessions, `get_entries` and `get_tree` return the loaded context window, while `get_fork_messages` still includes prompts from older branches using short picker labels. Use [`get_history_page`](/rpc/protocol#get_history_page) (following `nextCursor`) and [`get_history_chunk`](/rpc/protocol#get_history_chunk) to read older entries and oversized items.

### Waiting for turns to finish (`agent_settled` vs. `agent_end`)

A single `prompt` can trigger retries, model fallbacks, automatic compaction recovery, or queued turns:

- Check the `prompt` response's `data.disposition` first. If `disposition` is `"handled"`, an extension command or input hook consumed the message and **no turn started** — do not wait for `agent_end` or `agent_settled`.
- `agent_end` fires after **one** low-level agent loop finishes, even when a retry (`retryPending: true`), post-compaction continuation, or queued follow-up is about to run next.
- **`agent_settled`** fires once the entire turn chain finishes with no automatic work remaining (`{ "type": "agent_settled", "aborted": false }`). Wait for `agent_settled` rather than `agent_end` before closing stdin or treating a multi-step prompt as done.

## Command execution and concurrency

Atomic dispatches stdin frames across two lanes so cancellations and extension UI replies are never blocked behind slow commands:

| Lane | Commands | Behavior |
| --- | --- | --- |
| **Sequential (FIFO) lane** | Ordinary commands (`get_state`, `set_model`, `switch_session`, `compact`, `prompt`, etc.) | Executed strictly one at a time in arrival order. `prompt` responds once preflight completes and detaches immediately so later commands run while the turn streams. In standalone RPC mode, `compact` holds this lane until compaction completes. |
| **Concurrent / control lane** | Interrupts (`abort`, `cancel_login_provider`, `abort_compaction`, `abort_branch_summary`, `abort_retry`, `abort_bash`, `pause_queued_messages`, `resume_queued_messages`, `clear_queue`), `extension_ui_response`, and concurrent commands (`bash`, `user_bash`, `refresh_models`, `set_compaction_model`, `set_decision_model`, `start_pending_recovery`, `stop_all_background`) | Bypass the sequential queue and run immediately even while an ordinary command (such as `compact` or a slow `switch_session`) is in flight. |

Because the first sequential frame starts synchronously before the next line is read, a follow-up interrupt sent immediately after a command cannot overtake the command's initialization.

### Framing

RPC mode uses strict JSONL framing with LF (`\n`) as the only record delimiter.

Atomic imposes no line-size cap on RPC JSONL records; commands, responses, and events serialize in full. Account for memory and latency on large tool outputs or images, and do not enforce smaller line limits unless you intend to reject valid output.

Client framing rules:

- Split records on `\n` only.
- Strip an optional trailing `\r` from `\r\n` lines.
- Avoid generic line readers that split on Unicode line separators (`U+2028`, `U+2029`) or bare `\r`.

<Warning>
Node's `readline` module is **not** protocol-compliant because it splits on `U+2028` and `U+2029`, which are valid unescaped inside JSON strings. Similarly, Python's `text=True` universal newlines mode splits on bare `\r`; always read raw bytes and split strictly on `b"\n"`.
</Warning>

## Shutdown and signals

- Closing stdin, `SIGTERM`, and `SIGHUP` start an orderly shutdown that disposes the active session before exiting. Once shutdown begins, closing stdin or sending a single signal does not interrupt cleanup, so closing stdin and sending `SIGTERM` together still lets disposal finish.
- Standalone RPC mode does not register `SIGHUP` on Windows, and skips `SIGHUP` on Unix when the process inherits `SIG_IGN` (for example under `nohup`).
- A second signal exits immediately (`143` for `SIGTERM`, `129` for `SIGHUP`), and `SIGKILL` always terminates immediately. Orderly shutdown exits with code `0`; if disposal fails, Atomic emits a [`shutdown_error`](/rpc/protocol#shutdown_error) event and exits with code `1` (or the signal's exit code when a signal started shutdown).
- An extension can call `ctx.shutdown()` to end an idle RPC session without another client command. Shutdown waits for any active command response and running turn; a request sent during extension-started compaction outside a turn runs once compaction completes.
- [`abort`](/rpc/protocol#abort) holds queued messages (like pressing `Esc` in the TUI) so a client can abort and close stdin safely, preserving queued completion notices for the next session instead of failing disposal.

## Example Python client

This minimal client reads stdout as binary lines split strictly on `\n`, sends one correlated `prompt`, checks `data.disposition` in case an extension command handled it without starting a turn, streams text deltas, waits for `agent_settled` (covering any retries or continuations), and closes stdin for orderly shutdown:

```python
import json
import subprocess

proc = subprocess.Popen(
    ["atomic", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
)

def send(cmd: dict) -> None:
    assert proc.stdin is not None
    proc.stdin.write((json.dumps(cmd) + "\n").encode("utf-8"))
    proc.stdin.flush()

def read_events():
    assert proc.stdout is not None
    buf = b""
    while True:
        chunk = proc.stdout.read(4096)
        if not chunk:
            if buf:
                yield json.loads(buf.rstrip(b"\r").decode("utf-8"))
            break
        buf += chunk
        while b"\n" in buf:
            raw_line, buf = buf.split(b"\n", 1)
            line = raw_line.rstrip(b"\r")
            if line:
                yield json.loads(line.decode("utf-8"))

try:
    send({"id": "p-1", "type": "prompt", "message": "Hello!"})
    for event in read_events():
        if event.get("type") == "response" and event.get("id") == "p-1":
            if not event.get("success"):
                raise RuntimeError(event.get("error", "prompt failed"))
            if event.get("data", {}).get("disposition") == "handled":
                break
        elif event.get("type") == "message_update":
            delta = event.get("assistantMessageEvent", {})
            if delta.get("type") == "text_delta":
                print(delta["delta"], end="", flush=True)
        elif event.get("type") == "agent_settled":
            print()
            break
finally:
    if proc.stdin:
        proc.stdin.close()
    proc.wait()
```
