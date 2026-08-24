---
title: "Desktop host"
description: "Experimental optional Tauri host that speaks Atomic RPC"
---

# Desktop host (experimental)

Atomic's default interface is the TUI. This repository also carries a small optional [Tauri](https://v2.tauri.app/) proof of concept that starts the existing engine and renders a basic session. It lives in `apps/desktop`, outside the npm workspace and outside the natives Cargo workspace.

The TUI does not depend on it. `atomic` still launches interactive mode on a TTY. Extensions still see `ctx.mode === "tui"` in that path.

## What it is for

Issue [#2352](https://github.com/bastani-inc/atomic/issues/2352) asked whether a desktop host belongs in this project. Maintainers preferred Tauri over Electron, and asked for a real host on the current protocol before any GUI capability handshake.

This proof of concept is that host:

1. Spawn `atomic --mode rpc` (or this checkout's CLI) with piped stdio.
2. Speak the documented JSONL RPC from [RPC mode](/rpc).
3. Render user/assistant text, streaming deltas, tool cards, abort/`stopReason`, follow-up vs steer, stderr/diagnostics, and blocking extension dialogs.

It does not read credential or configuration files. The engine still owns sessions, tools, extensions, settings, models, trust, and authentication.

Treat the webview as trusted local UI, not as a sandbox: it can spawn the engine command and send any RPC frame, including `bash`. That is acceptable for `cargo run` from a checkout. It is not a distribution or CI surface. The trust-boundary section in `apps/desktop/README.md` is the longer form.

## Run it

From a source checkout:

```bash
cd apps/desktop/src-tauri
cargo run
```

`ATOMIC_DESKTOP_ENGINE` overrides the child command. `ATOMIC_DESKTOP_ENGINE_ARGS` appends extra tokens to the default command. `--mode rpc` is always appended last.

If builtin native bindings are not built, pass `--no-extensions` or the RPC child exits on startup. `--no-session` keeps the PoC from writing a session file.

There is no desktop test suite. Launch the window and send a prompt.

Details, Linux WebKit packages, and the protocol gaps the host ran into are in `apps/desktop/README.md` and `apps/desktop/PROTOCOL_GAPS.md`.

## What this does not change

- No GUI discriminator on `ExtensionContext` yet. A desktop RPC session still reports `mode: "rpc"`.
- No Electron or Tauri dependency in `@bastani/atomic`.
- No required CI job for the desktop crate.
