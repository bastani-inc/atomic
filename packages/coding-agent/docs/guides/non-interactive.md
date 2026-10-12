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

`atomic --print "..."` runs a single turn and exits. It also reads piped stdin and merges it into the prompt, so it composes with ordinary shell pipelines. Flags, exit codes, and the stdin merge rules are in the [CLI reference](/reference/cli).

If a text response reaches the model's output token limit, print mode keeps the partial text on stdout, writes a truncation warning to stderr, and exits with code `1`. Check the exit code before treating redirected output as complete.

## JSON events

When you need to observe a run rather than read it, the JSON event stream emits one structured record per message, tool call, and result. Use it for logging, CI annotations, or piping into another tool. The event shapes are in [JSON event stream](/json).

## RPC

RPC keeps a session alive so another process can send prompts, answer prompts, and receive events. Use it for editors, bots, and long-running services that need more than a single request/response. Start at [RPC](/rpc) and the [RPC protocol](/rpc/protocol).

## Next steps

- [CLI reference](/reference/cli) for every flag and exit code.
- [Programmatic use](/programmatic) for choosing between the SDK, RPC, and the event stream.
- [Background and parallel work](/background-tasks) if the work should continue while you keep chatting interactively.
