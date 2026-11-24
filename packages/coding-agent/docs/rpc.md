---
title: "RPC mode"
sidebarTitle: "RPC mode"
description: "Drive a long-lived Atomic process over stdin and stdout using newline-delimited JSON commands and events."
---

RPC mode runs Atomic headless over a JSON Lines protocol on stdin and stdout. Use it to integrate Atomic into non-Node languages, editors, IDEs, or custom UIs.

If you are building a Node.js or TypeScript application, you can embed `AgentSession` directly with the [TypeScript SDK](/sdk) or use the typed `RpcClient` exported from `@bastani/atomic` (see [RPC client examples](/rpc/examples)). Compare all three programmatic modes on [Programmatic integration](/programmatic).

## Reference pages

- [RPC protocol reference](/rpc/protocol): every command, streamed event, error code, and JSON type.
- [RPC extension UI protocol](/rpc/extension-ui): handle extension dialogs, widgets, questionnaires, and OAuth prompts.
- [RPC client examples](/rpc/examples): TypeScript `RpcClient` and standalone Node.js examples.
- [Stored session summaries](/rpc/protocol#stored-session-summaries): inspect saved sessions without starting a model turn.

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
- `--session-dir <path>`: custom session storage directory.
- `--storage '<json>'` / `--storage-file <path>`: select storage for this process's sessions.
- `--tools <list>` / `--no-tools` / `--exclude-tools <list>`: control which tools are active.

To isolate an RPC subprocess's session store without changing user settings, start it with `ATOMIC_STORAGE` or `--storage` set to the same JSON object as the `storage` setting (for example, an adapter config reading secrets from `{ "env": "..." }`). `list_sessions` reports that store while other `atomic` processes keep their own settings. Invalid storage selections fail at startup with `StorageConfigError`. See [Selecting storage per process](/storage#selecting-storage-per-process).

## Protocol overview

- **Commands**: JSON objects written to stdin, one per line.
- **Responses**: JSON objects with `type: "response"` reporting command success or failure.
- **Events**: session events streamed to stdout as JSON lines.

Every command accepts an optional `id` string for request correlation. When you send `id`, the matching response echoes the same `id`.

If a saved default `provider/model` names a provider that remains unsupported after startup, the process stays alive and `prompt` returns a correlated error containing the configuration diagnostic before emitting any event. Non-prompt commands such as `get_available_models` keep working. Clear the error state with a successful explicit `set_model`, or a `cycle_model` that switches to a different available model (an unchanged or `null` cycle does not clear it). Supported providers with an unknown model or missing credentials fall back automatically as usual.

On compacted or branched sessions, `get_entries` and `get_tree` return the loaded context window, while `get_fork_messages` still includes prompts from older branches using short picker labels. Use [`get_history_page`](/rpc/protocol#get_history_page) (following `nextCursor`) and `get_history_chunk` to read older entries and oversized items.

### Framing

RPC mode uses strict JSONL framing with LF (`\n`) as the only record delimiter.

Atomic imposes no line-size cap on RPC JSONL records; commands, responses, and events serialize in full. Account for memory and latency on large tool outputs or images, and do not enforce smaller line limits unless you intend to reject valid output.

Client framing rules:

- Split records on `\n` only.
- Strip an optional trailing `\r` from `\r\n` lines.
- Avoid generic line readers that split on Unicode line separators (`U+2028`, `U+2029`) or bare `\r`.

Node's `readline` module is not protocol-compliant because it splits on `U+2028` and `U+2029`, which are valid unescaped inside JSON strings. Similarly, Python's `text=True` universal newlines mode splits on bare `\r`; read raw bytes and split on `b"\n"`.

## Shutdown and signals

- Closing stdin, `SIGTERM`, and `SIGHUP` start an orderly shutdown that disposes the active session before exiting. Once shutdown begins, closing stdin or sending a single signal does not interrupt cleanup, so closing stdin and sending `SIGTERM` together still lets disposal finish.
- Standalone RPC mode does not register `SIGHUP` on Windows, and skips `SIGHUP` on Unix when the process inherits `SIG_IGN` (for example under `nohup`).
- A second signal exits immediately (`143` for `SIGTERM`, `129` for `SIGHUP`), and `SIGKILL` always terminates immediately. Orderly shutdown exits with code `0`; if disposal fails, Atomic emits a [`shutdown_error`](/rpc/protocol#shutdown_error) event and exits with code `1` (or the signal's exit code when a signal started shutdown).
- An extension can call `ctx.shutdown()` to end an idle RPC session without another client command. Shutdown waits for any active command response and running turn; a request sent during extension-started compaction outside a turn runs once compaction completes.
- [`abort`](/rpc/protocol#abort) holds queued messages (like pressing `Esc` in the TUI) so a client can abort and close stdin safely, preserving queued completion notices for the next session instead of failing disposal.

## Example Python client

This minimal client reads stdout as binary lines split strictly on `\n`, sends one prompt, prints streamed text deltas, and closes stdin for orderly shutdown:

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
    send({"type": "prompt", "message": "Hello!"})
    for event in read_events():
        if event.get("type") == "message_update":
            delta = event.get("assistantMessageEvent", {})
            if delta.get("type") == "text_delta":
                print(delta["delta"], end="", flush=True)
        if event.get("type") == "agent_end":
            print()
            break
finally:
    if proc.stdin:
        proc.stdin.close()
    proc.wait()
```
