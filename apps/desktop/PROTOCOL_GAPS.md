# Protocol gaps the desktop host actually hit

This is the issue 2352 follow-up: run a real host on today's RPC, then write down what a GUI still cannot do cleanly. Nothing here is implemented. Each gap is a candidate for a small additive RPC change, not a new `--mode gui`.

Evidence comes from launching `apps/desktop` against this checkout's CLI (`bun packages/coding-agent/src/cli.ts --mode rpc`) with a real provider key inherited by the child. The webview never reads `~/.atomic`. There is no mock engine and no desktop test suite.

## How to read a gap

For each item:

1. What the host tried
2. What was unclean
3. Smallest protocol change
4. Test that would prove it

Skip anything that already works. A live window on this checkout against OpenAI `gpt-4o-mini` already did spawn, `get_state`, `prompt` (`pong`), bash `pwd` → `/workspace`, abort of `sleep 25` (`ATOMIC · aborted` / tool phase error), and a follow-up after `sleep 20` (`FIRST_TURN` then `queued`). No `extension_ui_request`. Diagnostics copy worked. Default RPC still auto-runs bash.

## Host identity

**Tried.** Bind a session, then guess whether this RPC client is a desktop window, a CI embedder, or a script. `get_state` returns model, session id, streaming flags. It does not name the host.

**Unclean.** Extensions see `ctx.mode === "rpc"` and `ctx.hasUI === true` for every RPC host that implements the UI methods. A permission prompt or custom widget cannot say "this is a GUI" without sniffing process names or env vars the webview must not read.

**Smallest change.** Additive handshake, for example `hello` / `get_state.host` with `kind: "tui" | "rpc" | "gui"` and maybe `name` / `version`. Keep `mode: "rpc"`. Do not add `--mode gui`.

**Proving test.** Start RPC, send the handshake, assert `get_state` (or the hello response) reports `kind: "gui"` for this host and `kind: "rpc"` for `RpcClient` with no UI. An extension fixture reads `ctx.ui.hostInfo.kind`.

## Session listing

**Tried.** After `get_state`, the window has one session id. There is no command that returns other sessions. Sending `{ "type": "list_sessions" }` fails with `Unknown command: list_sessions`. `get_state` has `sessionId` and optional `sessionFile` / `sessionName`. `--no-session` leaves `sessionFile` unset.

**Unclean.** `switch_session` takes a path. A desktop "Open recent" UI would have to read `~/.atomic/agent/sessions` itself. This host must not do that. The webview has no business opening credential or session files.

**Smallest change.** `list_sessions` returning id, name, mtime, path (or an opaque handle `switch_session` already understands). Optional recents cap. No file contents.

**Proving test.** Create two named sessions via RPC, call `list_sessions`, assert both rows, `switch_session` to the other id/path, `get_state.sessionId` matches. A desktop host must not `fs.readFile` the sessions dir.

## Project folder / cwd

**Tried.** Put cwd on the engine bar and restart the child to change it. That works. There is no command to change cwd on a live session.

**Unclean.** "Open folder" kills the engine, drops in-flight turns, and loses the window's RPC identity. Users will treat that as a crash. A host that respawns also has to re-issue `get_state` / `get_messages` and hope the new child is the same session.

**Smallest change.** `set_cwd` that either (a) fails while streaming, or (b) documents that it implies `new_session`. Returning `{ restartRequired: true }` is enough if the engine cannot rebind in place.

**Proving test.** `set_cwd` to a temp dir, `prompt` "run pwd", tool output is the new dir, same `sessionId` or an explicit new id in the response. A second case: `set_cwd` while streaming returns a correlated error.

## Typed permission prompts

**Tried.** The UI already handles `extension_ui_request` for `confirm` / `select` / `input` / `editor`. Live bash on the default desktop engine never emitted `extension_ui_request`. The tool ran, `tool_execution_start` arrived, and that was the whole permission story.

**Unclean.** Default RPC auto-runs bash. A desktop host cannot show Allow/Deny without parsing title strings from some extension. `select` with a title of "Allow bash?" is not a permission primitive.

**Smallest change.** A dedicated event, for example `permission_request` with `toolName`, `args`, `scope: "once" | "session" | "always"`, answered by `permission_response`. Keep `extension_ui_request` for real extension dialogs.

**Proving test.** Engine started with a policy that requires approval. `prompt` "run pwd". Host sees `permission_request` (not a generic confirm). Deny: no `tool_execution_start`. Allow: tool runs. This host's confirm dialog is the stand-in until that event exists.

## Custom UI

**Tried.** Render tool cards from `tool_execution_start` / `update` / `end` (name, phase, args JSON, output). That is enough for bash. `ctx.ui.custom()` stays TUI-only over RPC (`undefined` in the docs).

**Unclean.** Rich tool views would have to ship ANSI frames from the interactive-engine painter into a webview, or the host would invent an ad-hoc HTML channel. Both are the wrong layer.

**Smallest change.** A web-oriented custom-UI payload (JSON schema + HTML or a named view id). Not remote TUI paint.

**Proving test.** Fixture extension calls `ctx.ui.custom(...)`. RPC host receives a structured event, replies, extension continues. Fail if the payload contains ANSI CSI.

## Themes

**Tried.** Hardcode Catppuccin Mocha from `DESIGN.md`. RPC has no palette or CSS token export.

**Unclean.** A settings-sync'd TUI theme cannot reach the webview without the host reading settings files, which it must not do.

**Smallest change.** Optional `theme` on `get_state` or a `theme_changed` event: background/text/accent tokens only.

**Proving test.** Change theme via RPC or settings the engine owns, assert the event. Host applies tokens without opening `~/.atomic`.

## Auth / login chrome

**Tried.** If `OPENAI_API_KEY` is in the environment the child inherits, `get_state` reports `gpt-4o-mini` and `prompt` works. There is no login UI in this host. `login_provider` exists on the protocol.

**Unclean.** OAuth device codes and "open this URL" are not a first-class host event. A desktop app that should open a browser has to scrape `extension_ui_request` copy or dump stderr. The webview still must not read API keys out of `~/.atomic`.

**Smallest change.** `login_provider` already returns data. Add a `login_user_action` event (`open_url`, `show_device_code`) so the host can open a browser without parsing strings. Keep credentials in the engine.

**Proving test.** `login_provider` with `authType: "oauth"` emits `open_url`. Assert the event contains a URL and does not contain a token.

## Notifications / window title

**Tried.** `setTitle` / `notify` / `setStatus` via `extension_ui_request`. The host updates the subtitle or hint. No native notification.

**Unclean.** Fine for a PoC. A real app would want a `notify` that is allowed to be fire-and-forget without looking like a blocking dialog.

**Smallest change.** Document that `notify` / `setTitle` are non-blocking, and that unknown methods must be cancelled rather than stalling the pipe. This host already does that.

**Proving test.** Send `notify` while a turn is streaming. `prompt` still completes. No dialog is shown. Already true here.

## What this host guessed and should stop guessing

- Args were space-split, so `--cwd "/tmp/My Project"` broke. The bar now takes one argument per line. Still no structured argv type on the protocol; that is a host bug, not an RPC gap.
- Engine and cwd sit on their own rows and break long paths so `/home/ubuntu/.bun/bin/bun` stays visible. Diagnostics still hold the full argv. No protocol change needed.
- Mid-stream `prompt` without `streamingBehavior` errors. The composer now sends `followUp` or `steer` on purpose. `queue_update` is the hint. No protocol change needed.
- Abort was wired but `stopReason` was ignored. The assembler now keeps `aborted` / `error` on the assistant bubble. No protocol change needed.
- Stderr and spawn failures vanished into `console.debug`. They now land in the transcript and a copyable diagnostics panel. No protocol change needed.
- Default RPC looks like a GUI to extensions. That is the host-identity gap above. Do not paper over it with `ATOMIC_DESKTOP=1`.
