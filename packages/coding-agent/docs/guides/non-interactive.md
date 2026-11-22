---
title: "Non-interactive use"
description: "Orientation for running Atomic without the interactive TUI: print mode, the JSON event stream, and RPC."
---

# Non-interactive use

Atomic's session engine supports three non-interactive entry points. Use the table below to choose one, or embed the engine with the SDK.

| You want | Use | Read |
| --- | --- | --- |
| One prompt, one answer, then exit | Print mode (`-p`, `--print`) | [CLI reference](/reference/cli#modes) |
| A machine-readable stream of everything the session does | JSON event stream | [JSON event stream](/json) |
| A long-lived session another program drives | RPC | [RPC](/rpc) |
| To embed Atomic in your own TypeScript program | SDK | [SDK](/sdk) |

## Print mode

`atomic --print "..."` (or `-p`) runs a single turn and exits. It reads piped stdin and merges it into the prompt, so it composes with shell pipelines. See the [CLI reference](/reference/cli) for all flags, exit codes, and stdin merge rules.

If a text response hits the model's output token limit, print mode keeps the partial text on stdout, writes a truncation warning to stderr, and exits with code `1`. Check the exit code before treating redirected output as complete.

On Linux and macOS, `SIGTERM` or `SIGHUP` stops a print-mode run after the session shuts down and exits with code `143` or `129`. The standalone binary preserves an ignored `SIGHUP` (as under `nohup atomic -p ...`) and keeps running after its terminal closes. An npm installation runs on Node.js, which resets an ignored `SIGHUP`; start it with `setsid` to keep it running after disconnect.

Extension commands also work as prompts. Running `atomic --session <id> -p "/curator off"` prints the command's reply. If the command sends a message or starts a turn, print mode waits for that response and prints it before running the next prompt or exiting.

## JSON events

Use the JSON event stream when another program needs to observe a run rather than read plain text. Atomic emits one JSON record per message, tool call, and result for logging, CI annotations, or downstream scripts. See [JSON event stream](/json) for the event shapes.

## RPC

RPC keeps a session alive so another process can send prompts, answer UI requests, and receive events over stdin and stdout. Use it for editors, bots, and long-running services that need multi-turn control. Start at [RPC](/rpc) and the [RPC protocol](/rpc/protocol).

## Next steps

- [CLI reference](/reference/cli) for every flag and exit code.
- [Programmatic use](/programmatic) to choose between the SDK, RPC, and the JSON event stream.
- [Background tasks](/background-tasks) when work should continue while you keep chatting interactively.
