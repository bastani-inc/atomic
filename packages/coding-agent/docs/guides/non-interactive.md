---
title: "Non-interactive mode"
sidebarTitle: "Non-interactive mode"
description: "Run Atomic without the terminal UI using print mode (-p), JSON event streams, or RPC."
---

You can run Atomic without the terminal UI in three ways, or embed it directly in TypeScript with the SDK.

| You want | Use | Read |
| --- | --- | --- |
| One prompt, one answer, then exit | Print mode (`-p`, `--print`) | [CLI modes](/reference/cli#modes) |
| A machine-readable stream of everything the session does | JSON event stream (`--mode json`) | [JSON event stream](/json) |
| A long-lived session another program drives | RPC (`--mode rpc`) | [RPC](/rpc) |
| Embed Atomic in your own TypeScript program | SDK | [SDK](/sdk) |

## Print mode

`atomic --print "..."` (or `-p`) runs prompts without launching the terminal UI and exits when done.

- **Automatic print mode on pipes and redirects:** If standard input or standard output is not a TTY (for example piping text into `atomic` or redirecting `atomic > out.txt`), Atomic enters print mode automatically even without `-p`.
- **Piped stdin and prompt merging:** Atomic reads piped stdin and separates it from CLI prompt text with a newline, so it composes cleanly with shell pipelines. When a prompt argument or `@file` is present, Atomic waits up to 2 seconds for the first piped byte before continuing without stdin (override with `ATOMIC_STDIN_TIMEOUT_MS`, or set `0` to always wait for EOF).
- **Multiple prompts:** Passing multiple positional prompts (such as `atomic -p "step 1" "step 2"`) runs them sequentially in the same session. Plain-text print mode prints only the final prompt's answer to stdout, while `--mode json` emits events for every turn.
- **Disabled interactive tools and project trust:** Both print mode and `--mode json` automatically disable `ask_user_question` because no interactive terminal UI is available. Non-interactive runs never show project trust prompts; untrusted projects ignore project settings, extensions, and context files unless you pass `--approve` (`-a`) or set global `defaultProjectTrust` to `"always"`.
- **Truncated responses:** If a text response hits the model's output token limit, print mode keeps the partial text on stdout, writes a truncation warning to stderr, and exits with code `1`. Check the exit code before treating redirected output as complete.
- **Extension commands as prompts:** Running `atomic --session <id> -p "/curator off"` prints the command's reply. If the command sends a message or starts a turn, print mode waits for that response and prints it before running the next prompt or exiting.

### Exit codes and signals

| Exit code | Meaning |
| --- | --- |
| `0` | Completed normally |
| `1` | Model error, aborted or truncated response, session write conflict, or CLI error |
| `75` | Target `--session` is already open in another live Atomic process |
| `129` | Stopped by `SIGHUP` on Linux or macOS after graceful shutdown |
| `130` | Stopped by `SIGINT` (`Ctrl+C`) after graceful shutdown |
| `143` | Stopped by `SIGTERM` on Linux or macOS after graceful shutdown |

Sending a second termination signal during graceful shutdown forces immediate exit. On Linux and macOS, the standalone binary preserves an ignored `SIGHUP` (as under `nohup atomic -p ...`) and keeps running after its terminal closes. An npm installation runs on Node.js, which resets an ignored `SIGHUP`; start it with `setsid` to keep it running after disconnect.

## JSON events

Use `--mode json` when another program needs to observe a run rather than read plain text. Atomic emits one JSON record per message, tool call, and result for logging, CI annotations, or downstream scripts. See [JSON event stream](/json) for the event shapes.

## RPC

Use `--mode rpc` to keep a session alive so another process can send prompts, answer UI requests, and receive events over stdin and stdout. Use it for editors, bots, and long-running services that need multi-turn control. Start at [RPC](/rpc) and the [RPC protocol](/rpc/protocol).

## Next steps

- [CLI reference](/reference/cli) for every flag, model-matching rule, and exit code.
- [Programmatic use](/programmatic) to choose between the SDK, RPC, and the JSON event stream.
- [Background tasks](/background-tasks) when work should continue while you keep chatting interactively.
