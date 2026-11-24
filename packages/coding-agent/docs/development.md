---
title: "Diagnostics and debugging"
sidebarTitle: "Diagnostics"
description: "Enable debug logs, capture UI snapshots, profile event-loop stalls, and collect diagnostics for bug reports."
---

Use these tools to inspect failures, diagnose slow startup or UI stalls, and gather bug-report diagnostics. To build extensions, custom providers, or SDK integrations, start with [Build with Atomic](/build). To install the CLI, see [Installation](/getting-started/installation).

<Note>
Building Atomic from source or contributing to the repository? See [DEV_SETUP.md](https://github.com/bastani-inc/atomic/blob/main/DEV_SETUP.md) and [CONTRIBUTING.md](https://github.com/bastani-inc/atomic/blob/main/CONTRIBUTING.md).
</Note>

## Debugging

Enable debug mode from **Debug mode** in `/settings` (the global [`debug` setting](/settings#debug-mode)), by passing `--debug`, by setting `ATOMIC_DEBUG=1` (legacy `PI_DEBUG=1`; see [Environment variables](/environment-variables#diagnostics-and-performance)), or over RPC with [`set_debug`](/rpc/protocol#set_debug) (`{"type": "set_debug", "enabled": true}`, which leaves saved settings unchanged). The footer displays a `debug` badge while debug mode is active.

Only the exact value `"1"` enables debug mode via environment variable (`true` and `yes` are ignored). If `"debug": true` is saved in `~/.atomic/agent/settings.json`, setting `ATOMIC_DEBUG=0` does not turn debug mode off for that run; toggle **Debug mode** in `/settings` or edit `settings.json` instead.

When debug mode is active, Atomic appends one JSON line per event to `~/.atomic/agent/atomic-debug.log` in the form `{"at", "pid", "area", "event", "data"}`:

| Area | What it records |
| --- | --- |
| `decision` | A [classifier decision](/settings#decisionmodel) that failed and fell back to the current chat model. |
| `engine` | Background session recovery events and late tool results dropped after the conversation moved past them (`stale-detached-call`). |
| `storage` | Storage fallback and diagnostic events across SQLite [writer queues](/storage), worktree snapshot pools (locks, leases, evictions, seeds, refs), lock releases, compaction backups, resume checkouts and timings, startup progress, and migrations. Writer-queue degradation records its code, reason, adapter, path, and error code; other storage fallback events include redacted error messages and causes. |

Debug mode logs record IDs, names, counts, and status details, never prompts or conversation text. Common credential formats are replaced with `[redacted]`: bearer tokens, JWTs, GitHub tokens, private key blocks, `sk-...` API keys, credentials embedded in URLs (`https://user:pass@host`), and `key: value` or `key=value` pairs whose name contains a key, token, secret, or password. Other secret formats can pass through, so review the log before sharing it. Individual text fields truncate at 2,000 characters.

The Intercom broker and other child processes started while debug mode is on inherit it, and subagents follow it right away. Processes already running keep the setting they started with until they restart. If the debug log cannot be written, Atomic prints one warning and keeps running.

Extensions and SDK programs can read debug state and append records with the [debug output API](/sdk/reference#debug-output).

### Capture a UI and message snapshot (`/debug`)

Run `/debug` (a hidden slash command) or press `Shift+Ctrl+D` anywhere in the TUI (regardless of which element has focus) to append a diagnostic snapshot to `~/.atomic/agent/atomic-debug.log`.

Each snapshot appends plain text containing:

- Timestamp, terminal dimensions (`columns x rows`), and total rendered line count
- Every rendered TUI line, JSON-escaped with ANSI codes and visible widths
- **All messages in the current session context** as JSONL, **completely unredacted**

Because `/debug` writes your full session messages with no credential redaction and appends plain text into the same `atomic-debug.log` file where debug mode appends JSONL, delete `atomic-debug.log` before reproducing an issue (Atomic never trims or rotates it) and review and redact the file before sharing.

## Finding what freezes the UI

If the interactive UI stalls and keystrokes or streamed output appear late, set `ATOMIC_EVENT_LOOP_BLOCK_MS` to the shortest stall duration in milliseconds you want to capture, reproduce the stall, and quit:

```bash
ATOMIC_EVENT_LOOP_BLOCK_MS=100 atomic
```

`ATOMIC_EVENT_LOOP_BLOCK_MS` must be a positive whole number (`1` or greater); `"0"`, negative numbers, decimals, and non-numeric values are ignored and no monitor starts.

Interactive sessions log both the terminal UI process (`role: "host"`) and the background session worker (`role: "engine"`) to `~/.atomic/agent/event-loop-blocks.jsonl`. Single-process runs write only `role: "host"`. Override the log file path with `ATOMIC_EVENT_LOOP_BLOCK_LOG` (relative paths resolve from the startup working directory). If the file cannot be written at startup, Atomic prints one warning and skips monitoring.

| `type` | Written | Fields |
| --- | --- | --- |
| `start` | When monitoring starts | `at`, `role`, `pid`, `runtime` (`"node"` or `"bun"`), `thresholdMs`, and `stacks` (`"profiler"`, `"disabled"`, or `"unavailable"` if the inspector cannot connect) |
| `block` | After each stall at or above `thresholdMs` | `at` (when the event loop was due to respond), `role`, `pid`, `durationMs`, `thresholdMs`, `samples`, `hotFrames` (up to 10 most specific functions first), and `stacks` (up to 3 most common stacks, trimmed to the first 12 and last 12 frames) |
| `delay` | When ready for input (`startup`), when starting to quit (`session`), and on exit (`shutdown`) | `at`, `role`, `pid`, `phase` (`"startup"`, `"session"`, or `"shutdown"`), `durationMs`, `ticks`, `p50Ms`, `p99Ms`, and `maxMs` |

Quit Atomic cleanly, close the terminal or console window, or sign out of Windows so the final `shutdown` delay summary flushes to disk.

Block records contain function names and source paths, never prompts or message text. Atomic never trims `event-loop-blocks.jsonl`, so delete it before reproducing a new issue.

The monitor checks the event loop every 20 ms, tracks delay histograms at 10 ms resolution, and samples the CPU every 2 ms using a sampling profiler rather than debugger pauses. A `debugger;` statement does not pause Atomic just because monitoring is active, and an attached debugger keeps control of its own breakpoints. Completed 5-second profile windows stay available until overlapping stalls are recorded, and functions sharing a name are tracked separately by source location.

Because CPU sampling adds some overhead, pass `ATOMIC_EVENT_LOOP_BLOCK_STACKS=0` (must be exact `"0"`; `"false"` leaves stacks enabled) when measuring raw latency:

```bash
ATOMIC_EVENT_LOOP_BLOCK_MS=100 ATOMIC_EVENT_LOOP_BLOCK_STACKS=0 atomic
```

In delay-only mode, `start` records report `stacks: "disabled"` and `block` records have zero samples, while every stall duration and delay summary is still recorded.

## Terminal rendering diagnostics

Capture raw TUI output and redraw logs with three environment variables (legacy `PI_*` aliases work when the `ATOMIC_*` variable is unset; see [TUI debug logging](/tui/reference#debug-logging) and [Environment variables](/environment-variables#diagnostics-and-performance)):

- **`ATOMIC_TUI_WRITE_LOG`** writes the raw ANSI stdout stream to a file path, or to one `tui-<timestamp>-<pid>.log` file per process inside a directory path.
- **`ATOMIC_TUI_DEBUG=1`** writes main-screen render snapshots to `/tmp/tui/render-<timestamp>-<random>.log`.
- **`ATOMIC_TUI_DEBUG_REDRAW=1`** logs full-redraw triggers to `pi-tui-debug.log` in the TUI log directory.

```bash
ATOMIC_TUI_WRITE_LOG=/tmp/tui-ansi.log atomic
```

Review captured terminal logs for sensitive content before sharing them.

## Subsystem status and native troubleshooting

Check subsystem health and logs before collecting full traces:

- **`atomic storage status`** verifies active storage selection, adapter loading, database connectivity, and peer brokers ([Checking the selected storage](/storage#checking-the-selected-storage)).
- **`atomic intercom status`** inspects the local Intercom broker; broker logs live at `~/.atomic/agent/intercom/broker.log` and `broker-watchdog.log` ([Intercom operations](/intercom/operations#local-files-logs-and-locks)).
- **`atomic mcp list`** validates MCP configuration and tests enabled server connections ([MCP servers](/mcp-servers#shell-commands)).
- **`/tools`** lists active and inactive tools plus which `git` binary Atomic selected ([Tools](/tools)).
- **`/session snapshot`** shows [worktree snapshots](/worktree-snapshots) and the `Last resume` timing breakdown ([Inspecting snapshots](/worktree-snapshots#inspecting-snapshots)).

For process-spawning or native-addon errors:

- Set `ATOMIC_HOST_SPAWN=child-process` to launch helper processes (Git snapshots, `rg`, `fd`, worktree setup, and standalone shell commands) through standard Node child spawning instead of Atomic's native spawner ([Environment variables](/environment-variables#diagnostics-and-performance)).
- If startup fails with `NativeModuleUnavailableError`, check [Package manager troubleshooting](/getting-started/installation#package-manager-troubleshooting) or point `NAPI_RS_NATIVE_LIBRARY_PATH` at a locally built `.node` binary (which bypasses Atomic's exact release version check).

## Document conversion diagnostics

Diagnostics from document conversion (`.pdf`, `.doc`, `.docx`, `.ppt`, `.pptx`, `.xls`, `.xlsx`, `.rtf`, and `.epub`) and background session workers appear as status messages in interactive sessions and on stderr or console output in other modes. Conversion failures also include diagnostic details in the tool error result.

Long or noisy diagnostics may truncate, and interactive sessions keep only recent messages. Atomic strips ANSI escape codes and control characters so diagnostics render as plain text, and RPC clients receive them separately from JSON responses. Atomic does not write an `atomic-engine-stderr.log` file; copy the displayed diagnostic text and conversion error when reporting a document conversion issue.

## Startup timing and bug reports

To profile slow startup or session resume (see [Environment variables](/environment-variables#diagnostics-and-performance)):

- Set `ATOMIC_TIMING=1` (legacy `PI_TIMING=1`) to print startup timings and `atomic --session` resume timings to stderr ([Inspecting snapshots](/worktree-snapshots#inspecting-snapshots)).
- Set `ATOMIC_STARTUP_TRACE=/tmp/atomic-startup.jsonl` (legacy `PI_STARTUP_TRACE`) to append JSONL startup milestones with wall-clock timestamps.

To draft a bug report from inside Atomic, run `/skill:feedback <summary>`. It runs a debugger investigation, privacy-scrubs the Markdown draft, and lets you review it before posting to GitHub through your authenticated `gh` CLI ([Bundled skills](/skills#setup-notes-for-specific-bundled-skills)).

When reporting a bug or startup problem manually, include:

- Your OS and version
- Your [terminal emulator](/terminal-setup) (and [tmux](/tmux) or [Herdr](/herdr) version if applicable)
- Your installation method (npm/package manager, self-contained release archive, or standalone binary)
- Output of `atomic --version`
- Relevant redacted diagnostic logs

If you installed from a self-contained release archive, keep the archive's complete directory structure intact so Atomic can locate its bundled assets and native module. For dependency versions and official release downloads, see [Installation](/getting-started/installation#package-managers).
