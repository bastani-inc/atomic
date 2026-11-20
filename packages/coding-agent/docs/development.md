# Development

For extensions and SDK integrations, start with [Build with Atomic](/build).

## Setup

To install the released CLI, follow [Installation](/getting-started/installation).

<a id="forking--rebranding"></a>

## Path Resolution

Atomic supports package-manager installs and standalone archives. Keep an archive's complete payload together.

## Debugging

Turn on debug mode with **Debug mode** in `/settings` (the [`debug` setting](/settings#debug-mode)), with `--debug`, or with `ATOMIC_DEBUG=1`. The footer shows a `debug` badge while it is on.

In debug mode, every area below appends one JSON line per event to `~/.atomic/agent/atomic-debug.log`, the file `/debug` shows: `{"at", "pid", "area", "event", "data"}`.

| Area | What it shows |
|------|---------------|
| `decision` | A [classifier decision](/settings#decisionmodel) that failed and fell back to the current chat model |
| `engine` | Interactive engine recovery and detached tool calls dropped because the conversation moved past them (`stale-detached-call`) |
| `storage` | Each [writers' queue degradation](/storage) of a SQLite database, once per reason: its code, reason, adapter, database path and error code, never the error message |

Debug output holds only what each area already reports, such as ids, names, counts and error messages. It never includes prompts or message text. Credentials in common forms are replaced with `[redacted]`: bearer tokens, JWTs, GitHub tokens, private key blocks, `sk-…` style API keys, and `key: value` or `key=value` pairs whose name is a key, token, secret or password. Other credential formats can pass through, so review the log before sharing it. Long text is cut to 2,000 characters.

The Intercom broker and other child processes started while debug mode is on inherit it, and subagents follow it at once. Processes that are already running keep the state they started with until their next start. If the debug log cannot be written, Atomic shows one warning and keeps running.

Extensions and SDK code can check and write debug output with the [debug output API](/sdk/reference#debug-output).

### Debug command

`/debug` (hidden) appends a snapshot to the same `~/.atomic/agent/atomic-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

Unlike debug mode, each snapshot includes conversation content, and every `/debug` adds another one. Atomic never trims or rotates the file, so it keeps every earlier snapshot and debug line until you delete it. Delete the file before reproducing a problem you want to share, and review it before sharing.

### Finding what freezes the UI

If the interactive UI stalls, with keystrokes or streamed text showing up late, set `ATOMIC_EVENT_LOOP_BLOCK_MS` to the shortest stall you want to catch, reproduce the problem, and quit:

```bash
ATOMIC_EVENT_LOOP_BLOCK_MS=100 atomic
```

The process that draws the UI (`host`) and the engine that runs the agent and extensions (`engine`) each append JSON lines to `~/.atomic/agent/event-loop-blocks.jsonl`, or to the file `ATOMIC_EVENT_LOOP_BLOCK_LOG` names. Without an isolated engine, everything runs in the `host`.

| `type` | Written | Fields |
|--------|---------|--------|
| `start` | When the process starts watching | `role`, `pid`, `runtime`, `thresholdMs`, and how stacks are taken |
| `block` | After each stall of at least the threshold | `at` (when the UI was due to respond), `durationMs`, the number of stack `samples`, `hotFrames` (the functions most samples were in, most specific first) and the most common full `stacks` |
| `delay` | Once the process is ready for input (the `host` as it draws its first frame, the `engine` once it has loaded its session and extensions), once it starts to quit, and as it exits | `phase` (`startup`, `session` or `shutdown`), and how late the process responded: `p50Ms`, `p99Ms`, `maxMs` over `ticks` checks. A stall counts in the phase it started in |

Quit to get the engine's `shutdown` record. If you close the terminal instead, the engine is ended at once on every platform, so its last records are not written.

Records hold function names and file paths, never prompts or message text. Atomic never trims the file, so delete it before reproducing a problem.

Stack collection is enabled by default for this diagnostic. Both the npm package and standalone binary use a sampling CPU profile, not debugger pauses. A `debugger;` statement does not stop the application just because the diagnostic is on, and an attached debugger keeps control of its own breakpoints. Profiles rotate every five seconds while the event loop runs. Completed profile data stays available until every overlapping stall window has been read, including a stall discovered just after a startup/session boundary, and is then discarded. Functions sharing a name are listed separately by their definition's source location. Sampling adds some CPU overhead, so use delay-only mode for latency comparisons.

For delay measurements without sampling overhead, disable stack collection:

```bash
ATOMIC_EVENT_LOOP_BLOCK_MS=100 ATOMIC_EVENT_LOOP_BLOCK_STACKS=0 atomic
```

This still records every delay summary and each stall over the configured threshold. The `start` record reports `stacks: "disabled"`; block records have zero samples and empty stack details. Use delay-only mode for latency comparisons, and collect stacks separately when you need to locate the code behind a stall.

Neither mode runs unless `ATOMIC_EVENT_LOOP_BLOCK_MS` is a positive whole number. With that variable unset, no stack sampler is initialized and no monitoring runs.

## PDF and engine diagnostics

PDF conversion and engine diagnostics appear as status messages in interactive sessions
and console output otherwise. Conversion failures also include diagnostic details in
their error result. Long or noisy diagnostics may be truncated. Interactive sessions keep
only recent diagnostics; older diagnostics are discarded without removing normal chat.

Diagnostics are displayed as text, not terminal commands. RPC clients receive diagnostics
separately from JSON responses. No `atomic-engine-stderr.log` file is written; include the
displayed diagnostic and conversion error when reporting a PDF problem.

## Startup timing probes

For a startup problem, report your OS, terminal, installation method, and Atomic version.

<a id="testing"></a>
<a id="installed-package-smoke-test"></a>

## Deterministic installs

Package-manager installs use Atomic's published shrinkwrap.

## Release security boundary

Download official releases through the [installation instructions](/getting-started/installation). Maintainers should follow the [release pipeline](https://github.com/bastani-inc/atomic/blob/main/docs/ci.md#direct-release-trigger-and-recovery).

<a id="project-structure"></a>

For source setup and repository checks, see [DEV_SETUP.md](https://github.com/bastani-inc/atomic/blob/main/DEV_SETUP.md).
