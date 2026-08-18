# Atomic desktop proof of concept

Optional Tauri host that starts the existing Atomic engine over `--mode rpc` and renders a basic session. It is not a replacement for the TUI, not on the default install path, and not part of `@bastani/atomic`.

This is the first slice described on [issue 2352](https://github.com/bastani-inc/atomic/issues/2352): a real host consuming the current protocol, so the protocol additions a GUI actually needs can be named from use rather than invented up front.

## Why this shape

Atomic already has a host/engine split. The public embed API is JSONL over stdin/stdout (`atomic --mode rpc`). The TUI uses that same child, plus a private isolation layer (`engine_ready` / `engine_bound` / remote paint). A first desktop host should speak the public RPC. The isolation frames are TUI compositor details; copying them would hide the gaps instead of exposing them.

Placement is `apps/desktop`, outside `packages/*` and outside the Rust natives workspace, so:

- `npm ci` and the published shrinkwrap stay unchanged
- `atomic` still starts the TUI by default
- Tauri, GTK, and WebKit are never required to test or extend the CLI

The webview does not read `~/.atomic` credential or settings files. It spawns the engine and talks JSONL. Session files, auth, tools, and extensions stay in the engine.

## What the PoC renders

- Engine start/stop, with a default command that prefers this checkout's CLI (`bun packages/coding-agent/src/cli.ts --mode rpc`) when present
- Session transcript from `get_messages`, then live `message_start` / `message_update` / `message_end`
- Prompt input (`prompt`, with `streamingBehavior: "followUp"` while a turn is running)
- Abort
- Tool cards from `tool_execution_start` / `update` / `end`
- Blocking extension dialogs (`confirm`, `select`, `input`, `editor`) so a permission prompt does not stall the pipe

Out of scope on purpose: session picker, model picker chrome, themes as CSS tokens, custom extension UI, packaging/CI, host capability handshake.

## Run

From a source checkout, after `npm ci --ignore-scripts`:

```bash
cd apps/desktop/src-tauri
cargo run
```

Or, with the Tauri CLI:

```bash
cargo install tauri-cli --locked --version '^2'
cd apps/desktop/src-tauri
cargo tauri dev
```

Linux needs the usual Tauri WebKit/GTK dev packages. macOS and Windows use the platform webview.

Override the engine with `ATOMIC_DESKTOP_ENGINE`, for example:

```bash
ATOMIC_DESKTOP_ENGINE="atomic --mode rpc --no-session" cargo run
```

The host always ensures `--mode rpc` is present. It writes JSONL with LF only, including on Windows.

JSONL framing tests (no GUI):

```bash
cd apps/desktop/src-tauri
cargo test
```

## Protocol additions this host made obvious

These are the gaps to discuss next. None of them are implemented here.

**Host identity.** RPC sessions bind extensions with `ctx.mode === "rpc"` and `ctx.hasUI === true`. This desktop host and a CI embedder look the same. A GUI-aware extension still cannot write `ctx.ui.hostInfo.kind === "gui"` because that field does not exist. The right follow-up is an additive handshake on the existing RPC, not a new GUI mode that forks the engine.

**Session listing.** `switch_session` takes a path. There is no `list_sessions` command. A desktop "open recents" UI would otherwise have to read `~/.atomic/agent/sessions` itself, which this host must not do.

**Project folder.** Cwd is fixed at spawn. "Open folder" today means kill and respawn. A `set_cwd` or equivalent would keep the window and drop the session in one step, or make the restart explicit.

**Typed permission prompts.** Tool approval arrives as a generic `extension_ui_request` (`select` / `confirm`) with a title string. That is enough to unblock the pipe. It is not enough to render Allow/Deny as a first-class desktop control without parsing copy.

**Custom UI.** `ctx.ui.custom()` is TUI-only over RPC (`undefined`). Structured `tool_execution_*` events are enough for a basic tool card. Rich tool views need a web-oriented custom-UI protocol, not ANSI frames from the interactive-engine painter.

**Themes.** RPC has no palette or CSS token export. This UI hardcodes Catppuccin Mocha from `DESIGN.md`.

**Auth.** `login_provider` exists, but this PoC has no login chrome. OAuth device codes and "open this URL" still need a host-visible event if the desktop app is the thing that should open a browser.

**Notifications / window title.** Fire-and-forget `setTitle` / `notify` work if the host implements them. There is no native notification primitive.

What already worked without protocol changes: spawn, `get_state`, `get_messages`, `prompt`, streaming `text_delta`, tool lifecycle, abort, and the extension UI request/response dance.

## Suggested follow-up PRs

1. Keep this host compiling and documented; do not add it to required CI.
2. Propose the smallest RPC handshake that names host kind (`tui` | `rpc` | `gui`) once a maintainer agrees the field list.
3. Add `list_sessions` (and maybe recents metadata) before any desktop session switcher.
4. Only then talk packaging, code signing, and a real settings UI.

See also [Desktop host (experimental)](../../packages/coding-agent/docs/desktop.md) and [RPC mode](../../packages/coding-agent/docs/rpc.md).
