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

## Trust boundary

The webview is a trusted local compositor, not a sandbox. Starting the engine runs whatever command is in the Engine / Args / Cwd fields (or `ATOMIC_DESKTOP_ENGINE`). Once the child is up, the host can send any RPC frame, including `bash`, which default RPC executes immediately. The child inherits this process's environment, including provider keys.

That is the right shape for a source-checkout proof of concept. It is not a shipping app. Do not package it, sign it, or add it to required CI until a later pass replaces PATH spawning with a bundled sidecar and treats the Engine bar as a developer override.

Hardening (sidecar, CSP, code signing, updater) is follow-up 4 below. Typed permission prompts and host identity are protocol work, listed in [PROTOCOL_GAPS.md](./PROTOCOL_GAPS.md).

## What it renders

- Engine start/stop. Default command prefers this checkout's CLI (`bun packages/coding-agent/src/cli.ts --mode rpc`). Args are one token per line, so paths with spaces stay intact. Engine and cwd wrap instead of clipping.
- Session transcript from `get_messages`, then live `message_start` / `message_update` / `message_end`
- Prompt input. While a turn is running, send is either `streamingBehavior: "followUp"` or `"steer"` (composer control). `queue_update` shows up in the hint.
- Abort, with `stopReason` `aborted` / `error` on the assistant bubble
- Tool cards from `tool_execution_start` / `update` / `end` (phase, args, output)
- Blocking extension dialogs (`confirm`, `select`, `input`, `editor`) and the existing `oauth_*` UI methods
- Engine stderr, spawn errors, and exit codes in the transcript plus a copyable diagnostics panel

Out of scope on purpose: session picker, model picker chrome, themes as CSS tokens, custom extension UI, packaging/CI, host capability handshake. Those are written down in [PROTOCOL_GAPS.md](./PROTOCOL_GAPS.md) from what this host could not do cleanly.

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

Override the engine with `ATOMIC_DESKTOP_ENGINE`. Extra default tokens (still quoted the same way) can be appended with `ATOMIC_DESKTOP_ENGINE_ARGS`:

```bash
ATOMIC_DESKTOP_ENGINE="atomic --mode rpc --no-session" cargo run
ATOMIC_DESKTOP_ENGINE_ARGS='--no-session --no-extensions --provider openai --model gpt-4o-mini' cargo run
```

The host always appends `--mode rpc` last so Atomic's last-option-wins parser cannot fall through to `--mode text`. It writes JSONL with LF only, including on Windows.

Builtin extensions need the native binding. If that binding is missing, the RPC child exits on startup unless you pass `--no-extensions`. `--no-session` keeps this PoC from writing a session file.

## Check it

Launch the window, start the engine, and send a prompt. That is the check. There is no desktop test suite and no mock engine.

If you change the JSONL decoder in `src-tauri/src/jsonl.rs`, `cargo test` in that crate still covers LF-only framing.

## Protocol additions this host made obvious

See [PROTOCOL_GAPS.md](./PROTOCOL_GAPS.md). Short version:

**Host identity.** RPC sessions bind extensions with `ctx.mode === "rpc"` and `ctx.hasUI === true`. This desktop host and a CI embedder look the same.

**Session listing.** `list_sessions` is not a command. A recents UI would otherwise read `~/.atomic/agent/sessions`, which this host must not do.

**Project folder.** Cwd is fixed at spawn. "Open folder" today means kill and respawn.

**Typed permission prompts.** Default RPC auto-runs bash. Tool approval as a generic confirm/select is not Allow/Deny.

**Custom UI.** `ctx.ui.custom()` is TUI-only over RPC. Structured `tool_execution_*` events are enough for a basic tool card.

**Themes.** RPC has no palette export. This UI hardcodes Catppuccin Mocha from `DESIGN.md`.

**Auth.** `login_provider` and typed `oauth_*` extension UI events already exist. This host has no login chrome and does not send `login_provider`. Keys are inherited by the engine child. Fire-and-forget OAuth events become transcript/hint text; blocking ones reuse the dialog.

What already worked without protocol changes: spawn, `get_state`, `prompt`, a completed assistant turn, bash tool lifecycle, abort, steer / `queue_update`.

## Suggested follow-up PRs

1. Keep this host compiling and documented; do not add it to required CI.
2. Propose the smallest RPC handshake that names host kind (`tui` | `rpc` | `gui`) once a maintainer agrees the field list.
3. Add `list_sessions` (and maybe recents metadata) before any desktop session switcher.
4. Only then talk packaging, code signing, and a real settings UI.

See also [Desktop host (experimental)](../../packages/coding-agent/docs/desktop.md) and [RPC mode](../../packages/coding-agent/docs/rpc.md).
