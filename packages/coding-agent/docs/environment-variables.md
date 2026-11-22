---
title: "Environment variables"
description: "Canonical reference for Atomic environment variables, legacy Pi aliases, provider credentials, and shell session metadata."
---

# Environment variables

Atomic reads environment variables for configuration, provider credentials, terminal overrides, and subprocess context. When an `ATOMIC_*` variable and its legacy `PI_*` alias are both set, the `ATOMIC_*` variable takes precedence.

## Application configuration

| Atomic variable | Legacy alias | Purpose |
|---|---|---|
| `ATOMIC_CODING_AGENT_DIR` | `PI_CODING_AGENT_DIR` | Agent and config directory; default `~/.atomic/agent`. Read each time a session or extension load starts, so caches such as the extension transpile cache follow the active value. An SDK session's `agentDir` option takes precedence |
| `ATOMIC_CODING_AGENT_SESSION_DIR` | None | Non-empty value selects a JSONL session directory; `--session-dir` and `--no-session` take precedence. Without a selection, sessions use the shared local SQLite database |
| `ATOMIC_PACKAGE_DIR` | `PI_PACKAGE_DIR` | Override package asset directory (useful for Nix or Guix store paths) |
| `ATOMIC_OFFLINE` | `PI_OFFLINE` | Disable automatic network activity, including update checks, package updates, telemetry, model catalog refreshes, and downloads of `fd`, `rg`, and [Git](/getting-started/installation#git) |
| `ATOMIC_MODEL_CATALOG_URL` | `PI_MODEL_CATALOG_URL` | Base URL for `<url>/api.json` model catalog refreshes; default `https://models.dev`. Refreshes run at most once every four hours per provider (or on `atomic update --models`), keeping the bundled catalog if download fails |
| `ATOMIC_SHARE_VIEWER_URL` | `PI_SHARE_VIEWER_URL` | Base URL of the viewer that `/share` links open; default `https://bastani.ai/session/` (the gist ID is appended after `#`) |
| `ATOMIC_SKIP_VERSION_CHECK` | `PI_SKIP_VERSION_CHECK` | Skip automatic startup version checks; explicit self-update still checks |
| `ATOMIC_SELF_UPDATE_COMMAND` | `PI_SELF_UPDATE_COMMAND` | Command `atomic update` runs to update Atomic itself, split on whitespace, with `{packageName}`, `{version}`, and `{installSpec}` placeholders. Takes precedence over `selfUpdateCommand`. See [Custom update command](/reference/cli#custom-update-command) |
| `ATOMIC_TELEMETRY` | `PI_TELEMETRY` | Override version-adoption and first-interactive-launch pings (`1`/`true`/`yes` or `0`/`false`/`no`). Does not disable update checks |
| `ATOMIC_REDUCED_MOTION` | None | Set to `1` to skip startup animations and keep the working `∀` static while elapsed time still updates |
| `ATOMIC_DEBUG` | `PI_DEBUG` | Set to `1` to turn on [debug mode](/development#debugging) for this run, the same as `--debug`. The footer shows a `debug` badge |
| `ATOMIC_TIMING` | `PI_TIMING` | Set to `1` to print startup timings to stderr and resume timings for `atomic --session` ([Inspecting snapshots](/worktree-snapshots#inspecting-snapshots)) |
| `ATOMIC_STARTUP_TRACE` | `PI_STARTUP_TRACE` | File path to append JSONL startup milestones (process start, first paint, engine ready, first provider request) with wall-clock timestamps across host and engine |
| `ATOMIC_EVENT_LOOP_BLOCK_MS` | None | Positive integer milliseconds: log UI or engine event-loop stalls at least this long to `event-loop-blocks.jsonl` in the agent directory. See [Finding what freezes the UI](/development#finding-what-freezes-the-ui) |
| `ATOMIC_EVENT_LOOP_BLOCK_LOG` | None | Alternate output file for `ATOMIC_EVENT_LOOP_BLOCK_MS`; relative paths resolve from the startup directory |
| `ATOMIC_EVENT_LOOP_BLOCK_STACKS` | None | Set to `0` to record stall and delay timings without CPU stack sampling overhead |
| `ATOMIC_EXPERIMENTAL` | `PI_EXPERIMENTAL` | Set to `1` to enable experimental features and preferred strict JSON-schema constrained sampling for additional built-in tools; `read`, `edit`, `write`, `bash`, and PowerShell already prefer strict sampling by default. The footer shows an `xp` badge |
| `ATOMIC_NO_PTY` | `PI_NO_PTY` | Set to `1` to disable PTY allocation for `bash` and `powershell` tool commands and force pipe execution |
| `ATOMIC_OAUTH_CALLBACK_HOST` | `PI_OAUTH_CALLBACK_HOST` | Bind host for the local OAuth callback server during `/login`; default `127.0.0.1` |
| `ATOMIC_HARDWARE_CURSOR` | `PI_HARDWARE_CURSOR` | Set to `1` to use the hardware terminal cursor when `showHardwareCursor` is unset in settings |
| `ATOMIC_CLEAR_ON_SHRINK` | `PI_CLEAR_ON_SHRINK` | Set to `1` to clear empty rows when rendered content shrinks; `terminal.clearOnShrink` in [Settings](/settings) takes precedence |
| `ATOMIC_CLIPBOARD_OSC52` | `PI_CLIPBOARD_OSC52` | Set to `1` to also send copied text via OSC 52 after local clipboard writes, useful for remote multiplexers or IDE daemons without SSH env vars |
| `ATOMIC_INTERCOM_GROUP` | `PI_INTERCOM_GROUP` | Static home Intercom group for this session. See [Intercom reference](/intercom/reference#configuration) |
| `ATOMIC_INTERCOM_JOIN_AT_STARTUP` | `PI_INTERCOM_JOIN_AT_STARTUP` | `1`/`true` or `0`/`false` to override whether interactive sessions join Intercom at startup regardless of Intercom config |
| `ATOMIC_ALLOW_BROWSER_COOKIES` | None | Set to `1` to allow Gemini Web browser cookie reading without setting `allowBrowserCookies: true` in `~/.atomic/web-search.json` ([Web access](/web-access)) |
| `ATOMIC_BLUEPRINT_GITHUB_BASE_URL` | None | Replace `https://github.com` when fetching blueprint `uses:` actions |
| `ATOMIC_TODO_PATH` | `PI_TODO_PATH` | Override directory used by the built-in `todo` tool; default `.atomic/todos` |
| `ATOMIC_STORAGE` | None | Shared storage selection JSON for sessions without their own selection and for Intercom. Overrides settings but not `--storage`, session flags, or session-specific env vars. See [Selecting storage per process](/storage#selecting-storage-per-process) |
| `ATOMIC_SESSIONS_STORAGE` | None | Session-only storage selection JSON in the same form as `sessions.storage`. Conflicts with a non-empty `ATOMIC_CODING_AGENT_SESSION_DIR` |
| `ATOMIC_PROFILE` | None | `ci` selects the team database for sessions and Intercom from `ATOMIC_TEAM_*` without writing settings. See [Team and CI setup](/guides/team-setup#ci-and-swarms) |
| `ATOMIC_TEAM_URL`, `ATOMIC_TEAM_TOKEN`, `ATOMIC_TEAM_TOKEN_FILE`, `ATOMIC_TEAM_PREFIX` | None | Team database settings for `ATOMIC_PROFILE=ci`. Setting any without `ATOMIC_PROFILE=ci` fails startup. `ATOMIC_TEAM_TOKEN_FILE` must be an absolute path |
| `ATOMIC_HEAP_MB` | `PI_HEAP_MB` | Node heap cap in MiB for the agent process (interactive engine, or headless `-p`/`json`/`rpc` via one relaunch). Defaults to half of system memory when larger than Node's default; `0` keeps Node's default. Explicit Node heap flags in `NODE_OPTIONS` or on Atomic's command line take precedence. Unused by standalone binaries |
| `ATOMIC_STDIN_TIMEOUT_MS` | `PI_STDIN_TIMEOUT_MS` | Milliseconds a print-mode run (`-p`, `--mode json`) waits for the first piped byte or EOF before starting with a prompt argument; default `2000`, max `2147483647`, `0` waits until EOF. See [Modes](/reference/cli#modes) |
| `ATOMIC_TOOL_ABORT_GRACE_MS` | None | Milliseconds an interrupted tool call may keep running before the turn moves on with `Operation aborted`; default `10000`, max `2147483647`, `0` stops waiting immediately. See [Message queue](/usage#message-queue) |
| `ATOMIC_CODEMODE_MAX_WORKERS` | `PI_CODEMODE_MAX_WORKERS` | Maximum live codemode workers per Atomic process; default `2` (each worker caps at 256 MiB). Extra scripts queue until a slot opens. See [Codemode](/codemode) |
| `ATOMIC_HOST_SPAWN` | None | Set to `child-process` to launch Atomic's internal helper processes (snapshot Git, `pi.exec`, `rg`, `fd`, worktree setup) through Node's `child_process`. On Linux this disables the fork-free native spawner; on Windows it also bypasses per-command Job objects for `!` shells and ownerless `bash`/`powershell` calls |

## Runtime, terminal, and native environment variables

| Variable | Legacy alias | Purpose |
|---|---|---|
| `NO_COLOR` | None | Any value disables foreground and background colors and text styles (bold, italic, dim, underline, inverse, strikethrough) in the TUI and switches installer output to plain text |
| `NODE_COMPILE_CACHE` | None | Override the directory for Node's persistent compile cache, enabled automatically on Node 22.8+ to speed up startup. On Windows, a cold default cache warms in a background helper during interactive runs; setting `NODE_COMPILE_CACHE` lets Node write it on exit instead |
| `NODE_DISABLE_COMPILE_CACHE` | None | Set to any value (for example `1`) to prevent Node from enabling the compile cache |
| `NAPI_RS_NATIVE_LIBRARY_PATH` | None | Path to a custom `@bastani/atomic-natives` `.node` addon binary; bypasses the release version check |
| `VISUAL`, `EDITOR` | None | External editor for `Ctrl+G` when `externalEditor` is unset in settings |
| `ATOMIC_TUI_ESC_TIMEOUT` | `PI_TUI_ESC_TIMEOUT` | Milliseconds the renderer waits after a lone `ESC` before treating it as Escape; default is `100` over SSH and `10` otherwise. Increase if Alt keys register as Escape |
| `ATOMIC_HYPERLINKS` | `PI_HYPERLINKS` | `1`, `0`, or `auto` to override OSC 8 hyperlink detection; explicit `terminal.hyperlinks` in settings takes precedence |
| `ATOMIC_TRUE_COLOR` | `PI_TRUE_COLOR` | `1`, `0`, or `auto` to override 24-bit color detection; explicit `terminal.trueColor` in settings takes precedence |
| `ATOMIC_IMAGE_PROTOCOL` | `PI_IMAGE_PROTOCOL` | `kitty`, `iterm2`, `none`, or `auto` to override inline image detection; explicit `terminal.images` in settings takes precedence |
| `ATOMIC_PROGRAM_STATUS` | `PI_PROGRAM_STATUS` | `1` forces OSC 7501 program-status reports; `0` disables them; unset reports only after terminal confirmation ([Program status](/terminal-setup#program-status)) |
| `ATOMIC_TUI_WRITE_LOG` | `PI_TUI_WRITE_LOG` | Capture raw terminal output written by the renderer ([Debug logging](/tui/reference#debug-logging)) |
| `ATOMIC_TUI_DEBUG`, `ATOMIC_TUI_DEBUG_REDRAW` | `PI_TUI_DEBUG`, `PI_TUI_DEBUG_REDRAW` | Set to `1` to enable TUI debug and redraw diagnostics ([Debug logging](/tui/reference#debug-logging)) |

## Retired workflow variables

Unset `ATOMIC_WORKFLOWS_JOURNAL`, `ATOMIC_WORKFLOW_JOURNAL_PATH`, and `ATOMIC_WORKFLOW_ARTIFACT_DIR` when upgrading from 0.9.x. Atomic ignores them without modifying existing files. `ATOMIC_WORKFLOW_DEBUG` and `ATOMIC_DEBUG_POOLED_WATCH` are also ignored; use `ATOMIC_DEBUG=1` for current diagnostics.

## Session storage

Sessions default to `~/.atomic/workflows/journal.sqlite`. With a custom `ATOMIC_CODING_AGENT_DIR`, they default to `<agentDir>/workflows/journal.sqlite` (unless an eligible custom directory adopted an existing parent store; see [Storage home](/storage#storage-home)).

`ATOMIC_CODING_AGENT_SESSION_DIR` selects JSONL session files. Relative paths resolve against the working directory, and an empty value leaves settings in effect.

`ATOMIC_STORAGE` and `ATOMIC_SESSIONS_STORAGE` accept the same JSON selections as `storage` and `sessions.storage`, including adapters, with relative paths resolving from the storage home. Use `{ "memory": true }` for process-local memory (never selected automatically after a storage failure). See [Selecting storage per process](/storage#selecting-storage-per-process).

## Prompt-cache retention

Atomic defaults to **long** prompt-cache retention in main chat and subagents where the provider and model support it. Set `ATOMIC_CACHE_RETENTION` before launch to choose `short`, `none`, or `long` (`PI_CACHE_RETENTION` is a legacy alias):

```bash
ATOMIC_CACHE_RETENTION=short atomic
```

Use `short` for shorter caching (five minutes on Anthropic), `none` to disable Atomic's optional cache controls where supported, or `long` to request extended retention (one hour on Anthropic). Providers can still apply automatic caching depending on the model.

When unset, OpenAI models without known extended-retention support (such as GPT-4o) use ordinary caching, and Bedrock Claude models without known one-hour support (such as Claude 3.7) use five-minute caching. Supported OpenAI models and Bedrock Claude 4.5+ keep extended caching. For Bedrock application inference profiles, set an accurate model name in `models.json` so Atomic recognizes its capabilities. Custom OpenAI-compatible models can set `compat.supportsLongCacheRetention` in `models.json`.

In SDK requests, explicit `cacheRetention` takes precedence over `ATOMIC_CACHE_RETENTION`, and request-scoped `env` overrides credential-scoped and process environments. Requests that disable caching (such as branch summaries) stay uncached.

[Anthropic's prompt-caching pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing) charges **2x base input price for one-hour writes** versus **1.25x for five-minute writes**. Extended retention helps when prompts are reused after five minutes; `short` can cost less when cache hits happen within five minutes or prompts are rarely reused.

## Subprocess attribution and worktree phase

Atomic sets `AI_AGENT=atomic` for itself and every subprocess it launches, replacing any caller-supplied value without mutating the caller's environment object. Scripts can inspect it to detect an Atomic-owned invocation.

During subagent worktree cleanup, Atomic sets `ATOMIC_SUBAGENT_WORKTREE_PHASE=finishing` on its own Git invocations (and clears any inherited value on other Git calls) so custom Git hooks or filters do not wait on that child's terminal notification. See [Subagents](/subagents).

## TLS certificates

`NODE_EXTRA_CA_CERTS` points to a PEM file of extra CA certificates trusted by both npm-installed `atomic` and standalone binaries for model providers, `https://` proxies, and PostgreSQL stores. Restart Atomic after changing it.

Requests refused for an untrusted certificate fail immediately without retrying and report the failing host and error code. When an `https://` proxy's own certificate fails, the error names the proxy's host (in standalone binaries, only Amazon Bedrock distinguishes proxy vs. endpoint certificate errors; other requests name the endpoint).

## Provider credentials

Provider API keys and cloud auth variables (such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `GEMINI_API_KEY`, and AWS/Bedrock credentials) are documented in [Providers](/providers#environment-variables-or-auth-file).

`ANTHROPIC_AUTH_TOKEN` supplies a header-only bearer token (`Authorization: Bearer ...`) for Anthropic-compatible gateways without requiring an API key, across normal turns, isolated execution, and branch summaries.

## Bash and PowerShell session environment

Every built-in, factory-created, direct, and isolated `bash` or `powershell` execution receives one execution-time snapshot:

| Atomic variable | Exact Pi alias | Value |
|---|---|---|
| `ATOMIC_SESSION_ID` | `PI_SESSION_ID` | Active session ID |
| `ATOMIC_PROVIDER` | `PI_PROVIDER` | Active provider; omitted when no model is selected |
| `ATOMIC_MODEL` | `PI_MODEL` | Active model ID; omitted when no model is selected |
| `ATOMIC_REASONING_LEVEL` | `PI_REASONING_LEVEL` | Active reasoning level |

Before overlaying those eight current snapshot values, Atomic clears all ten reserved names: the eight names in the table above plus the two retired session-file names `ATOMIC_SESSION_FILE` and `PI_SESSION_FILE`. Clearing all ten guarantees stale metadata from another session never leaks into a shell command. Unrelated inherited and caller-supplied variables remain intact.

`ATOMIC_SESSION_FILE` and `PI_SESSION_FILE` are no longer populated because session IDs identify records inside the active store rather than assuming a file path. The snapshot is captured when each command runs, so resumed sessions and model changes are always reflected. SDK `createBashTool()` and `createPowerShellTool()` expose these variables by default; pass `exposeSessionEnvironment: false` to omit them.

See [CLI environment variables](/reference/cli#environment-variables) and [RPC direct bash](/rpc/protocol#bash) for execution and streaming behavior.
