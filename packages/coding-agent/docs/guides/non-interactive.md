---
title: "Run Atomic non-interactively"
sidebarTitle: "Run non-interactively"
description: "Run Atomic from scripts, pipelines, and editors using print mode (-p), JSON event streams, RPC, or the SDK."
---

You can run Atomic without the terminal UI in three CLI modes, or embed it directly in TypeScript with the SDK.

| What you want | Use | Read |
| --- | --- | --- |
| One prompt, one plain-text answer, then exit | Print mode (`-p`, `--print`) | [CLI modes](/reference/cli#modes) |
| A machine-readable stream of messages, tool calls, and results | JSON event stream (`--mode json`) | [JSON event stream](/json) |
| A long-lived session another program drives interactively | RPC (`--mode rpc`) | [RPC](/rpc) |
| Embed Atomic directly inside a TypeScript application | SDK | [SDK](/sdk) |

## Print mode

`atomic -p "..."` (or `--print`) runs prompts without launching the terminal UI and exits when finished:

```bash
# Single prompt
atomic -p "Summarize the architecture of this repository"

# Pipe input into a prompt
git diff | atomic -p "Write a concise commit message for these changes"

# Run multiple sequential prompts in one session (prints the final answer)
atomic -p "Inspect src/auth.ts" "List any edge cases you found"

# Read-only analysis with structured JSON event output
atomic --mode json --tools read,search,find -p "Audit src/ for hardcoded secrets"
```

Key behaviors in print mode:

- **Automatic print mode on pipes and redirects:** If standard input or standard output is not a TTY (for example piping into `atomic` or redirecting `atomic > out.txt`), Atomic enters print mode automatically even without `-p`.
- **Piped stdin and prompt merging:** Atomic trims piped stdin and separates it from CLI prompt text or `@file` blocks with a blank line when adjacent text has no whitespace boundary. When a prompt argument or `@file` is present, Atomic waits up to 2 seconds for the first piped byte before starting without stdin (override with [`ATOMIC_STDIN_TIMEOUT_MS`](/environment-variables#diagnostics-and-performance), or set `0` to always wait for EOF).
- **Multiple prompts:** Passing multiple positional prompts runs them sequentially in the same session. Plain-text print mode prints only the final prompt's answer to stdout, while `--mode json` streams events for every turn.
- **Interactive prompts and project trust:** Both print mode and `--mode json` automatically disable interactive question prompts (`ask_user_question`) because no terminal UI is available. Non-interactive runs never prompt for project trust; when an untrusted project has local settings, Atomic prints a stderr warning advising `--approve` (`-a`) and ignores project settings, extensions, and context files unless you pass `--approve` (`-a`) or set global `defaultProjectTrust` to `"always"`. See [Project trust](/security#project-trust).
- **Pre-flight checks and structured output:** Before starting an automated run, verify provider credentials with `atomic auth check` ([Verify readiness before a session](/providers#verify-readiness-before-a-session)). For typed classification or final structured JSON outputs in scripts and SDK hosts, see [Structured decisions](/sdk/structured-decisions).
- **Truncated responses:** If a response hits the model's output token limit, print mode keeps the partial text on stdout, writes a truncation warning to stderr, and exits `1`. Always check the exit code before treating redirected output as complete.
- **Extension slash commands:** You can invoke extension slash commands in print mode (for example `atomic --session <id> -p "/curator off"`). If the command sends a message or triggers a turn, print mode waits for that response and prints it before continuing or exiting.

### Exit codes and signals

| Exit code | Meaning |
| --- | --- |
| `0` | Completed normally |
| `1` | Model error, aborted or truncated response, session write conflict, or CLI error |
| `75` | Target `--session` is already open in another live Atomic process |
| `129` | Stopped by `SIGHUP` on Linux or macOS after graceful shutdown |
| `130` | Stopped by `SIGINT` (`Ctrl+C`) after graceful shutdown |
| `143` | Stopped by `SIGTERM` on Linux or macOS after graceful shutdown |

Sending a second termination signal during graceful shutdown forces immediate exit.

<Tip>
**Running after terminal disconnect (`SIGHUP`):** On Linux and macOS, the standalone Atomic binary preserves an ignored `SIGHUP` (such as under `nohup atomic -p ...`) and keeps running after the terminal closes. An npm installation runs on Node.js, which resets an ignored `SIGHUP`; start it with `setsid` to keep it running after disconnect.
</Tip>

## JSON events

Use `--mode json` when a script or CI job needs to observe every message, tool call, and result rather than just the final text:

```bash
atomic --mode json "Run the test suite and report any failures"
```

Atomic writes one JSON event object per line to stdout. See [JSON event stream](/json) for the full event schema.

## RPC

Use `--mode rpc` to run a persistent session controlled over stdin and stdout JSON messages—ideal for editors, bots, and background services that need multi-turn control or interactive UI callbacks:

```bash
atomic --mode rpc --no-session
```

Start with [RPC](/rpc) and the [RPC protocol](/rpc/protocol).

## Next steps

<Columns cols={2}>
  <Card title="CLI reference" href="/reference/cli">
    Every flag, model-matching rule, subcommand, and exit code.
  </Card>
  <Card title="Environment variables" href="/environment-variables">
    Configure `ATOMIC_STDIN_TIMEOUT_MS`, `ATOMIC_STORAGE`, and CI overrides.
  </Card>
  <Card title="Programmatic use" href="/programmatic">
    Compare print mode, JSON events, RPC, and the TypeScript SDK.
  </Card>
  <Card title="Background tasks" href="/background-tasks">
    Run subagents and shells in the background during interactive sessions.
  </Card>
</Columns>
