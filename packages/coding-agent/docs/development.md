---
title: "Development"
description: "Debug mode, event-loop stall profiling, PDF diagnostics, and troubleshooting information for Atomic."
---

# Development and diagnostics

For building extensions, custom providers, or SDK integrations, start with [Build with Atomic](/build). To install the CLI, see [Installation](/getting-started/installation).

<a id="forking--rebranding"></a>

## Path resolution

Atomic supports both package-manager installs and self-contained release archives. Keep an archive's complete directory structure intact so Atomic can resolve its bundled assets and native module.

## Debugging

Enable debug mode from **Debug mode** in `/settings` (the [`debug` setting](/settings#debug-mode)), by passing `--debug`, or by setting `ATOMIC_DEBUG=1`. The footer displays a `debug` badge while debug mode is active.

When debug mode is on, each diagnostic area appends one JSON line per event to `~/.atomic/agent/atomic-debug.log` in the form `{"at", "pid", "area", "event", "data"}`:

| Area | What it records |
| --- | --- |
| `decision` | A [classifier decision](/settings#decisionmodel) that failed and fell back to the current chat model. |
| `engine` | Interactive engine recovery and detached tool calls dropped after the conversation moved past them (`stale-detached-call`). |
| `storage` | Each [writers' queue degradation](/storage) of a SQLite database, once per reason: its code, reason, adapter, database path, and error code (never the error message). |

Debug logs record IDs, names, counts, and status details, never prompts or conversation text. Common credential formats are replaced with `[redacted]`: bearer tokens, JWTs, GitHub tokens, private key blocks, `sk-...` API keys, and `key: value` or `key=value` pairs whose name is a key, token, secret, or password. Other formats can pass through, so review the log before sharing it. Long fields truncate at 2,000 characters.

The Intercom broker and other child processes started while debug mode is on inherit it, and subagents follow it immediately. Processes already running keep the setting they started with until their next start. If the debug log cannot be written, Atomic prints one warning and keeps running.

Extensions and SDK programs can read debug state and append records with the [debug output API](/sdk/reference#debug-output).

### Debug command

`/debug` (a hidden slash command) appends a snapshot to `~/.atomic/agent/atomic-debug.log` containing:

- Rendered TUI lines with ANSI codes
- The last messages sent to the model

Unlike debug mode logs, `/debug` snapshots include conversation content, and every call appends to the same file. Atomic never trims or rotates `atomic-debug.log`. Delete the file before reproducing an issue, and review its contents before sharing.

### Finding what freezes the UI

If the interactive UI stalls and keystrokes or streamed output appear late, set `ATOMIC_EVENT_LOOP_BLOCK_MS` to the shortest stall duration (in milliseconds) you want to capture, reproduce the stall, and quit:

```bash
ATOMIC_EVENT_LOOP_BLOCK_MS=100 atomic
```

The UI process (`host`) and the interactive engine process (`engine`) each append JSON lines to `~/.atomic/agent/event-loop-blocks.jsonl`, or to the file path in `ATOMIC_EVENT_LOOP_BLOCK_LOG`. When running without an isolated engine, all records are written by `host`.

| `type` | Written | Fields |
| --- | --- | --- |
| `start` | When monitoring starts | `role`, `pid`, `runtime`, `thresholdMs`, and stack-collection mode |
| `block` | After each stall at or above the threshold | `at` (when the UI was due to respond), `durationMs`, `samples`, `hotFrames` (most specific first), and the most common `stacks` |
| `delay` | When ready for input (`startup`), when starting to quit (`session`), and on exit (`shutdown`) | `phase` (`startup`, `session`, or `shutdown`), `p50Ms`, `p99Ms`, `maxMs`, and `ticks` |

Quit Atomic, close the terminal or console window, or sign out of Windows to record the engine's `shutdown` summary.

Block records contain function names and file paths, never prompts or message text. Atomic never trims the file, so delete it before reproducing a new issue.

Stack collection is enabled by default using a sampling CPU profiler rather than debugger pauses. A `debugger;` statement does not pause Atomic just because monitoring is enabled, and an attached debugger keeps control of its own breakpoints.

Profiles rotate every 5 seconds while the event loop runs, and completed profile windows stay available until overlapping stalls are recorded. Functions sharing a name are tracked separately by their source location. Because sampling adds some CPU overhead, disable stack collection when measuring raw latency:

```bash
ATOMIC_EVENT_LOOP_BLOCK_MS=100 ATOMIC_EVENT_LOOP_BLOCK_STACKS=0 atomic
```

In delay-only mode, `start` records report `stacks: "disabled"` and `block` records have zero samples, while every stall duration and delay summary is still written. Monitoring runs only when `ATOMIC_EVENT_LOOP_BLOCK_MS` is a positive integer; when unset, no sampler or monitor starts.

## PDF and engine diagnostics

PDF conversion and engine diagnostics appear as status messages in interactive sessions and on stderr or console output in other modes. Conversion failures also include diagnostic details in the tool error result. Long or noisy diagnostics may truncate, and interactive sessions keep only recent diagnostics.

Diagnostics render as plain text, not terminal control sequences, and RPC clients receive them separately from JSON responses. Atomic does not write an `atomic-engine-stderr.log` file; include the shown diagnostic text and conversion error when reporting a PDF issue.

## Reporting startup problems

When reporting a startup issue, include your OS, terminal emulator, installation method, and `atomic --version` output.

<a id="testing"></a>
<a id="installed-package-smoke-test"></a>

## Dependency versions and official releases

For how Atomic pins dependencies in package-manager installs versus self-contained release archives, and how to download official releases, see [Installation](/getting-started/installation#package-managers).

<a id="project-structure"></a>
