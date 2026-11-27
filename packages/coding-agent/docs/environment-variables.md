---
title: "Environment variables"
sidebarTitle: "Environment variables"
description: "Reference for Atomic environment variables, value parsing rules, web access and proxy variables, storage overrides, terminal controls, and subprocess metadata."
---

Atomic reads environment variables for configuration, provider credentials, web access, proxies, terminal overrides, and subprocess context. When an `ATOMIC_*` variable and its legacy `PI_*` alias are both set, `ATOMIC_*` takes precedence (for example, `ATOMIC_NO_PTY=0` overrides `PI_NO_PTY=1`).

<Note>
**Empty-string `PI_*` fallback exception:** For most variables, an explicit empty string (`""`) counts as set and stops fallback to `PI_*`. Two variables are exceptions—setting `ATOMIC_CACHE_RETENTION=""` or `ATOMIC_OAUTH_CALLBACK_HOST=""` falls through to `PI_CACHE_RETENTION` or `PI_OAUTH_CALLBACK_HOST` when set.
</Note>

## How boolean and numeric values are parsed

Variables follow strict parsing rules based on their category:

| Rule | Accepted values | Variables |
| --- | --- | --- |
| Exact `"1"` only | Only `"1"` enables (`"true"` and `"yes"` do not) | `ATOMIC_DEBUG`, `ATOMIC_TIMING`, `ATOMIC_REDUCED_MOTION`, `ATOMIC_EXPERIMENTAL`, `ATOMIC_NO_PTY`, `ATOMIC_HARDWARE_CURSOR`, `ATOMIC_CLEAR_ON_SHRINK`, `ATOMIC_CLIPBOARD_OSC52`, `ATOMIC_ALLOW_BROWSER_COOKIES`, `ATOMIC_ALLOW_PRIVATE_URL_READS`, `ATOMIC_TUI_DEBUG`, `ATOMIC_TUI_DEBUG_REDRAW`, `HERDR_ENV` |
| Truthy flag | `"1"`, `"true"`, or `"yes"` (case-insensitive) | `ATOMIC_OFFLINE` (`"0"`/`"false"` keep online), `ATOMIC_SKIP_VERSION_CHECK` (`"0"`/`"false"` keep enabled), `ATOMIC_STARTUP_BENCHMARK`, `ATOMIC_TELEMETRY` (any other defined value including `"0"`, `"false"`, `"no"`, or `""` disables version-adoption pings and provider attribution headers for OpenRouter, NVIDIA, and OpenCode) |
| Explicit boolean | `"1"`/`"true"` or `"0"`/`"false"` (case-insensitive, trimmed; other values ignored) | `ATOMIC_INTERCOM_JOIN_AT_STARTUP` |
| Any defined value | Any value, including `""` (unset instead of setting to `"0"`) | `NO_COLOR`, `NODE_DISABLE_COMPILE_CACHE` |
| Exact `"0"` to disable | Exact `"0"` disables (`ATOMIC_EVENT_LOOP_BLOCK_STACKS` is trimmed; `ATOMIC_TASK_CGROUP` is not) | `ATOMIC_EVENT_LOOP_BLOCK_STACKS`, `ATOMIC_TASK_CGROUP` |
| Numeric | Positive or non-negative numbers per variable; invalid or negative values fall back to the default (or disable stall logging for `ATOMIC_EVENT_LOOP_BLOCK_MS`) | `ATOMIC_TUI_ESC_TIMEOUT`, `ATOMIC_EVENT_LOOP_BLOCK_MS`, `ATOMIC_HEAP_MB`, `ATOMIC_STDIN_TIMEOUT_MS`, `ATOMIC_TOOL_ABORT_GRACE_MS`, `ATOMIC_CODEMODE_MAX_WORKERS` |

## Core and session variables

| Atomic variable | Legacy alias | Accepted values and behavior |
| --- | --- | --- |
| `ATOMIC_CODING_AGENT_DIR` | `PI_CODING_AGENT_DIR` | Path to the agent and config directory (default `~/.atomic/agent`). Read each time a session or extension load starts, so caches follow the active value. Setting this variable also suppresses interactive first-run setup. An [SDK](/sdk) session's `agentDir` option ([SDK directories](/sdk/reference#directories)) takes precedence |
| `ATOMIC_OFFLINE` | `PI_OFFLINE` | `1`, `true`, or `yes` (case-insensitive) disables automatic network activity: update checks, package updates, telemetry, model catalog refreshes, and downloads of `fd`, `rg`, and [Git](/getting-started/installation#git). `0` and `false` keep Atomic online |
| `ATOMIC_CACHE_RETENTION` | `PI_CACHE_RETENTION` | Case-sensitive `long` (default in Atomic CLI and SDK sessions), `short`, or `none`. Unrecognized non-empty values fall back to `short`; an empty string falls through to `PI_CACHE_RETENTION`. Standalone [`@bastani/atomic-ai`](/libraries/ai) defaults to `short`. See [Prompt-cache retention](#prompt-cache-retention) |
| `ATOMIC_MODEL_CATALOG_URL` | `PI_MODEL_CATALOG_URL` | Base URL for `<url>/api.json` model catalog refreshes (default `https://models.dev`). Refreshes run at most once every four hours per provider (or on `atomic update --models`), keeping the bundled catalog if download fails. See [Configure custom models](/models) |
| `ATOMIC_SHARE_VIEWER_URL` | `PI_SHARE_VIEWER_URL` | Base URL of the viewer that `/share` links open (default `https://bastani.ai/session/`; the gist ID is appended after `#`) |
| `ATOMIC_SKIP_VERSION_CHECK` | `PI_SKIP_VERSION_CHECK` | `1`, `true`, or `yes` (case-insensitive) skips automatic startup version checks; `0` and `false` keep checks enabled. Explicit self-update still checks |
| `ATOMIC_SELF_UPDATE_COMMAND` | `PI_SELF_UPDATE_COMMAND` | Command `atomic update` runs to update Atomic itself, split on whitespace, with `{packageName}`, `{version}`, and `{installSpec}` placeholders. Takes precedence over `selfUpdateCommand`. See [Custom update command](/reference/cli#custom-update-command) |
| `ATOMIC_TELEMETRY` | `PI_TELEMETRY` | `1`/`true`/`yes` enables version-adoption pings; any other defined value (including `0`, `false`, `no`, or `""`) disables pings and disables provider attribution headers for OpenRouter, NVIDIA, and OpenCode. Does not disable update checks |
| `ATOMIC_OAUTH_CALLBACK_HOST` | `PI_OAUTH_CALLBACK_HOST` | Bind host for the local OAuth callback server during `/login` (default `127.0.0.1`). An empty string falls through to `PI_OAUTH_CALLBACK_HOST` |
| `ATOMIC_PACKAGE_DIR` | `PI_PACKAGE_DIR` | Override package asset directory (useful for Nix or Guix store paths) |
| `ATOMIC_TODO_PATH` | `PI_TODO_PATH` | Override directory used by the built-in `todo` tool (default `.atomic/todos`) |
| `ATOMIC_ALLOW_PRIVATE_URL_READS` | None | Exact `1` allows the `read` tool to fetch `localhost`, `.localhost`, private IP addresses, and cloud metadata endpoints (blocked by default) |
| `ATOMIC_BLUEPRINT_GITHUB_BASE_URL` | None | Replace `https://github.com` when fetching blueprint `uses:` actions |
| `VISUAL`, `EDITOR` | None | External editor for `Ctrl+G` when `externalEditor` is unset in settings. Falls back to `notepad` on Windows or `nano` on macOS and Linux when all three are unset |

## Web access and proxy variables

### Web search and content fetching

| Variable | Accepted values and behavior |
| --- | --- |
| `EXA_API_KEY` | API key for Exa web search in `web_search`; overrides `exaApiKey` in `~/.atomic/web-search.json`. See [Web access](/web-access) |
| `PERPLEXITY_API_KEY` | API key for Perplexity web search in `web_search`; overrides `perplexityApiKey` in `~/.atomic/web-search.json`. See [Web access](/web-access) |
| `GEMINI_API_KEY` | API key for Google Gemini model requests and Gemini API web search and video analysis. See [Web access](/web-access) and [Model providers](/providers#environment-variables-or-auth-file) |
| `ATOMIC_ALLOW_BROWSER_COOKIES` | Exact `1` allows Gemini Web browser cookie reading without setting `allowBrowserCookies: true` in `~/.atomic/web-search.json` ([Web access](/web-access)). Setting `0` does not override `web-search.json` |

### Proxy variables

| Variable | Accepted values and behavior |
| --- | --- |
| `HTTP_PROXY`, `http_proxy` | Proxy URL for outbound HTTP requests; also used for `https://` requests when `HTTPS_PROXY` is unset. Takes precedence over `httpProxy` in [Network proxy settings](/settings#network-proxy) |
| `HTTPS_PROXY`, `https_proxy` | Proxy URL for outbound HTTPS requests (including model providers, OpenAI Codex WebSocket, and PostgreSQL HTTP proxies). Takes precedence over `httpProxy` in [Network proxy settings](/settings#network-proxy) |
| `NO_PROXY`, `no_proxy` | Comma-separated hostnames, domain suffixes, or addresses that bypass the proxy |
| `ALL_PROXY`, `all_proxy` | Fallback proxy URL read by the standalone binary when the protocol-specific variable is unset; not read by npm-installed `atomic` on Node.js |

Both npm-installed `atomic` and the standalone binary route `https://` requests through `HTTP_PROXY` when `HTTPS_PROXY` is unset, and skip hosts listed in `NO_PROXY`. Because the standalone binary uses Bun's HTTP client while npm installs use Node.js, proxy variables behave differently in these edge cases:

| Setup | npm-installed `atomic` (Node.js) | Standalone binary (Bun) |
| --- | --- | --- |
| `ALL_PROXY` naming an `http://` or `https://` proxy | Not read | Used when the request's own variable is unset |
| Empty lowercase variable (`http_proxy=""`, `no_proxy=""`) with uppercase set | Empty value wins: no proxy, no exemptions | Uppercase value is used |
| CIDR block in `NO_PROXY` (`10.0.0.0/8`) | Not matched | Exempts addresses in the range |
| Proxy variables changed while Atomic runs | Read at startup and when `httpIdleTimeoutMs` changes | Read on every request |
| `http://` endpoint through a proxy | Sent through a `CONNECT` tunnel | Sent to the proxy with the full URL |
| SOCKS proxy (`socks5://`) in `HTTP_PROXY` or `HTTPS_PROXY` | Supported | Requests fail with `UnsupportedProxyProtocol` |

The OpenAI Codex WebSocket uses the same proxy as other requests. In the standalone binary, it also reads proxy variables from a credential's [`env`](/providers#auth-file); an `ALL_PROXY` naming a SOCKS proxy is skipped for WebSocket and those requests fall back to SSE.

## Storage and team variables

Sessions default to `~/.atomic/workflows/journal.sqlite`. With a custom `ATOMIC_CODING_AGENT_DIR`, they default to `<agentDir>/workflows/journal.sqlite` unless an eligible custom directory adopted an existing parent store (see [Storage home](/storage#storage-home)).

| Atomic variable | Legacy alias | Accepted values and behavior |
| --- | --- | --- |
| `ATOMIC_CODING_AGENT_SESSION_DIR` | None | Non-empty path selects a JSONL session directory (`--session-dir` and `--no-session` take precedence; see [CLI session options](/reference/cli#session-options)). Relative paths resolve from the working directory; empty values leave [session settings](/settings#sessions) in effect |
| `ATOMIC_STORAGE` | None | Shared storage selection JSON in the same form as [`storage`](/settings#sessions) (including adapters; `{ "dir": "..." }` is forbidden here). Overrides settings, but not `--storage`, session flags, or session-specific env vars. Relative paths resolve from [storage home](/storage#storage-home) |
| `ATOMIC_SESSIONS_STORAGE` | None | Session-only storage selection JSON in the same form as [`sessions.storage`](/settings#sessions) (accepts `{ "dir": "..." }`). Relative paths resolve from [storage home](/storage#storage-home) |
| `ATOMIC_INTERCOM_GROUP` | `PI_INTERCOM_GROUP` | Static home Intercom group for this session. See [Intercom reference](/intercom/reference#configuration) |
| `ATOMIC_INTERCOM_JOIN_AT_STARTUP` | `PI_INTERCOM_JOIN_AT_STARTUP` | `1`/`true` or `0`/`false` (case-insensitive, trimmed) overrides whether interactive sessions join Intercom at startup regardless of Intercom config |

- **Conflicts:** Combining a non-empty `ATOMIC_CODING_AGENT_SESSION_DIR` with `--storage`, `--storage-file`, or `ATOMIC_SESSIONS_STORAGE` fails startup with `StorageConfigError` (`conflicting-overrides`).
- **In-memory storage:** Pass `{ "memory": true }` in `ATOMIC_STORAGE` or `ATOMIC_SESSIONS_STORAGE` for process-local memory storage. Atomic never falls back to memory automatically after a storage failure.
- See [Selecting storage per process](/storage#selecting-storage-per-process), [CLI session options](/reference/cli#session-options), and [SDK storage](/sdk/storage).

<Warning>
**Removed libSQL team variables (startup fails if set):** `ATOMIC_PROFILE`, `ATOMIC_TEAM_URL`, `ATOMIC_TEAM_TOKEN`, `ATOMIC_TEAM_TOKEN_FILE`, and `ATOMIC_TEAM_PREFIX` were removed along with libSQL support. Setting any of them to a non-empty value aborts startup with `TeamProfileConfigError` (`libsql-removed`) before any store opens so CI jobs do not silently fall back to local storage. Unset them and switch to PostgreSQL via `atomic storage join <postgres-url>` or `ATOMIC_STORAGE`. See [Moving off libSQL](/storage#moving-off-libsql).
</Warning>

## Terminal and display variables

| Variable | Legacy alias | Accepted values and behavior |
| --- | --- | --- |
| `NO_COLOR` | None | Any defined value (including empty string `""`) disables foreground and background colors and text styles in the TUI and switches installer output to plain text. Always takes precedence over `FORCE_COLOR` |
| `FORCE_COLOR` | None | `0` or `false` disables all colors and text styles (same as `NO_COLOR`). `1`, `true`, empty string `""`, or `2` caps true-color themes at 256 colors (never upgrades a terminal's detected color depth). `3` keeps the terminal's detected color mode. Ignored when `NO_COLOR` is set |
| `ATOMIC_REDUCED_MOTION` | None | Exact `1` skips startup animations and keeps the working `∀` static while elapsed time still updates |
| `ATOMIC_HARDWARE_CURSOR` | `PI_HARDWARE_CURSOR` | Exact `1` enables the hardware terminal cursor when `showHardwareCursor` is unset in settings |
| `ATOMIC_CLEAR_ON_SHRINK` | `PI_CLEAR_ON_SHRINK` | Exact `1` clears empty rows when rendered content shrinks; `terminal.clearOnShrink` in [Settings](/settings#terminal-and-images) takes precedence |
| `ATOMIC_CLIPBOARD_OSC52` | `PI_CLIPBOARD_OSC52` | Exact `1` also forwards copied text via OSC 52 after local clipboard writes (useful for remote multiplexers or IDE daemons without SSH env vars) |
| `ATOMIC_TUI_ESC_TIMEOUT` | `PI_TUI_ESC_TIMEOUT` | Positive finite milliseconds the terminal waits after a lone `ESC` before treating it as Escape (default `100` over SSH, `10` otherwise; invalid values fall back to default). Increase if Alt keys register as Escape |
| `ATOMIC_HYPERLINKS` | `PI_HYPERLINKS` | `1`, `0`, or `auto` overrides OSC 8 hyperlink detection; explicit `terminal.hyperlinks` in settings takes precedence |
| `ATOMIC_TRUE_COLOR` | `PI_TRUE_COLOR` | `1`, `0`, or `auto` overrides 24-bit color detection; explicit `terminal.trueColor` in settings takes precedence |
| `ATOMIC_IMAGE_PROTOCOL` | `PI_IMAGE_PROTOCOL` | Case-insensitive `kitty`, `iterm2`, `none` (or `0`), or `auto` overrides inline image detection; explicit `terminal.images` in settings takes precedence |
| `ATOMIC_PROGRAM_STATUS` | `PI_PROGRAM_STATUS` | Exact `1` forces OSC 7501 program-status reports; exact `0` disables them; any other value or unset reports only after terminal confirmation ([Program status](/terminal-setup#program-status)) |
| `COLORFGBG` | None | Fallback terminal background hint when OSC 11 background queries are unavailable. Uses the last `;`-separated integer: indices `0` to `6` and `8` map to dark, and other integers map to light. See [Themes](/themes) |
| `HERDR_ENV`, `HERDR_BIN_PATH`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH` | None | Set by Herdr inside managed panes. Exact `HERDR_ENV=1` with non-empty `HERDR_BIN_PATH`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH` enables built-in pane status reporting; `HERDR_ENV=1` is also required for Herdr automation. See [Herdr](/herdr) |

## Diagnostics and performance

| Variable | Legacy alias | Accepted values and behavior |
| --- | --- | --- |
| `ATOMIC_DEBUG` | `PI_DEBUG` | Exact `1` turns on [debug mode](/development#debugging) for this run (same as `--debug`; footer shows a `debug` badge). `ATOMIC_DEBUG=0` does not override `debug: true` in settings |
| `ATOMIC_TIMING` | `PI_TIMING` | Exact `1` prints startup timings to stderr and resume timings for `atomic --session` ([Inspecting snapshots](/worktree-snapshots#inspecting-snapshots)) |
| `ATOMIC_STARTUP_BENCHMARK` | `PI_STARTUP_BENCHMARK` | `1`, `true`, or `yes` (case-insensitive) launches interactive mode, measures startup until the editor is ready for input, exits cleanly, and prints the timings. Fails with `StartupBenchmarkConfigError` (`unsupported-mode`) in print (`-p`), JSON (`--mode json`), or standalone RPC (`--mode rpc`) modes |
| `ATOMIC_STARTUP_TRACE` | `PI_STARTUP_TRACE` | File path to append JSONL startup milestones (process start, first paint, session ready, first provider request) with timestamps across the terminal UI and background session process |
| `ATOMIC_EVENT_LOOP_BLOCK_MS` | None | Positive integer milliseconds: log terminal UI or background session event-loop stalls at least this long to `event-loop-blocks.jsonl` in the agent directory (`0` or invalid disables). See [Finding what freezes the UI](/development#finding-what-freezes-the-ui) |
| `ATOMIC_EVENT_LOOP_BLOCK_LOG` | None | Alternate output file for `ATOMIC_EVENT_LOOP_BLOCK_MS`; relative paths resolve from the startup directory |
| `ATOMIC_EVENT_LOOP_BLOCK_STACKS` | None | Exact `0` (trimmed) records stall and delay timings without CPU stack sampling overhead |
| `ATOMIC_TUI_WRITE_LOG` | `PI_TUI_WRITE_LOG` | File path to capture raw terminal output written by the renderer ([Debug logging](/tui/reference#debug-logging)) |
| `ATOMIC_TUI_DEBUG`, `ATOMIC_TUI_DEBUG_REDRAW` | `PI_TUI_DEBUG`, `PI_TUI_DEBUG_REDRAW` | Exact `1` enables TUI debug and redraw diagnostics ([Debug logging](/tui/reference#debug-logging)) |
| `ATOMIC_EXPERIMENTAL` | `PI_EXPERIMENTAL` | Exact `1` enables experimental features and stricter JSON-schema tool-argument validation for additional built-in tools (`read`, `edit`, `write`, `bash`, and `powershell` already prefer strict schemas by default). The footer shows an `xp` badge |
| `ATOMIC_NO_PTY` | `PI_NO_PTY` | Exact `1` disables PTY allocation for `bash` and `powershell` tool commands and forces pipe execution |
| `ATOMIC_HEAP_MB` | `PI_HEAP_MB` | Node.js heap cap in MiB for interactive and non-interactive Node runs (unused by standalone binaries). Defaults to half of available system or container cgroup memory when larger than Node's default; `0` keeps Node's default; invalid values auto-size. Explicit Node heap flags (`--max-old-space-size`, `--max-old-space-size-percentage`, `--max-heap-size`) in `NODE_OPTIONS` or on the command line take precedence |
| `ATOMIC_STDIN_TIMEOUT_MS` | `PI_STDIN_TIMEOUT_MS` | Milliseconds a print-mode run (`-p`, `--mode json`) waits for the first piped byte or EOF before starting with a prompt argument (default `2000`, max `2147483647`, `0` waits until EOF; invalid values fall back to `2000`). See [Modes](/reference/cli#modes) |
| `ATOMIC_TOOL_ABORT_GRACE_MS` | None | Milliseconds (digits only) an interrupted tool call may keep running before the turn moves on with `Operation aborted` (default `10000`, max `2147483647`, `0` stops waiting immediately; invalid values fall back to `10000`). See [Message queue](/usage#message-queue) |
| `ATOMIC_CODEMODE_MAX_WORKERS` | `PI_CODEMODE_MAX_WORKERS` | Positive integer maximum live codemode workers per Atomic process (default `2`, each capped at 256 MiB; invalid values fall back to `2`). Extra scripts queue until a slot opens. See [Codemode](/codemode) |
| `ATOMIC_HOST_SPAWN` | None | Set to `child-process` to launch helper processes (Git snapshots, `rg`, `fd`, worktree setup, and standalone shell commands) through standard Node child spawning instead of Atomic's native spawner. Useful for troubleshooting process-spawning issues on Linux or Windows |
| `ATOMIC_TASK_CGROUP` | None | Exact `0` disables Linux cgroup v2 process-tree containment for background shell tasks. See [Lifetime, retention, and process cleanup](/background-tasks/reference#lifetime-retention-and-cleanup) |
| `NODE_COMPILE_CACHE` | None | Override the directory for Node's persistent compile cache, enabled automatically on Node.js to speed up startup. On Windows, a cold default cache warms in a background helper during interactive runs; setting `NODE_COMPILE_CACHE` lets Node write it on exit instead |
| `NODE_DISABLE_COMPILE_CACHE` | None | Any defined value (including empty string `""`) prevents Node from enabling the compile cache |
| `NAPI_RS_NATIVE_LIBRARY_PATH` | None | Path to a locally compiled native addon (`.node` file); bypasses Atomic's release version check |

## Prompt-cache retention

Atomic defaults to **long** prompt-cache retention in main chat and subagents where the provider and model support it. Set `ATOMIC_CACHE_RETENTION` before launch to choose `short`, `none`, or `long` (`PI_CACHE_RETENTION` is a legacy alias; setting `ATOMIC_CACHE_RETENTION=""` falls through to `PI_CACHE_RETENTION`):

```bash
ATOMIC_CACHE_RETENTION=short atomic
```

Values are **case-sensitive** (`"long"`, `"short"`, or `"none"`). Any unrecognized non-empty value silently falls back to **`short`** (not `long`).

- **`short`:** shorter retention (5 minutes on Anthropic).
- **`long`:** extended retention (1 hour on Anthropic).
- **`none`:** disables Atomic's optional cache controls where supported (providers may still apply automatic caching).

When unset, OpenAI models without known extended-retention support (such as GPT-4o) use ordinary caching, and Bedrock Claude models without known one-hour support (such as Claude 3.7) use five-minute caching. Supported OpenAI models and Bedrock Claude 4.5+ keep extended caching. For Bedrock application inference profiles, set an accurate model name in [`models.json`](/models) so Atomic recognizes its capabilities. Custom OpenAI-compatible models can set `compat.supportsLongCacheRetention` in [`models.json`](/models-configuration).

In [SDK](/sdk) requests, explicit `cacheRetention` takes precedence over `ATOMIC_CACHE_RETENTION`, and request-scoped `env` overrides credential-scoped and process environments. Requests that disable caching (such as branch summaries) stay uncached. Direct calls to standalone [`@bastani/atomic-ai`](/libraries/ai) APIs default an unset `ATOMIC_CACHE_RETENTION` to `short` and enable `long` only when set to `"long"`, so disabling caching there requires passing `cacheRetention: "none"` explicitly.

<Tip>
**Anthropic cache-write pricing:** [Anthropic's prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing) bills **2x base input price for 1-hour (`long`) writes** versus **1.25x for 5-minute (`short`) writes**. Use `long` when prompts are reused after five minutes, and `short` when turns happen rapidly within five minutes or prompts are rarely reused.
</Tip>

## TLS certificates

`NODE_EXTRA_CA_CERTS` points to a PEM file of extra CA certificates trusted by both npm-installed `atomic` and standalone binaries for model providers, `https://` proxies, and PostgreSQL stores. Restart Atomic after changing it.

Requests refused for an untrusted certificate fail immediately without retrying and report the failing host and error code. When an `https://` proxy's own certificate fails, the error names the proxy's host (in standalone binaries, only Amazon Bedrock distinguishes proxy vs. endpoint certificate errors; other requests name the endpoint).

## Provider credentials

Provider API keys and cloud auth variables (such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `GEMINI_API_KEY`, and AWS/Bedrock credentials) are documented in [Model providers](/providers#environment-variables-or-auth-file).

Additional provider auth overrides:

- **`ANTHROPIC_AUTH_TOKEN`:** supplies a header-only bearer token (`Authorization: Bearer ...`) for Anthropic-compatible gateways without requiring an API key, across main chat turns, subagents, and branch summaries.
- **`KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST`:** overrides the OAuth host for Kimi Code device-code sign-in and token refresh (default `https://auth.kimi.com`; trailing slashes are stripped). `KIMI_CODE_OAUTH_HOST` takes precedence when both are set.

## Bash and PowerShell session environment

Every `bash` and `powershell` tool call (including in subagents, RPC, and SDK sessions) receives one execution-time snapshot:

| Atomic variable | Legacy alias | Value |
| --- | --- | --- |
| `ATOMIC_SESSION_ID` | `PI_SESSION_ID` | Active session ID |
| `ATOMIC_PROVIDER` | `PI_PROVIDER` | Active provider; omitted when no model is selected |
| `ATOMIC_MODEL` | `PI_MODEL` | Active model ID; omitted when no model is selected |
| `ATOMIC_REASONING_LEVEL` | `PI_REASONING_LEVEL` | Active reasoning level |

Before overlaying those eight current snapshot values, Atomic clears all ten reserved names: the eight names in the table above plus the two retired session-file names `ATOMIC_SESSION_FILE` and `PI_SESSION_FILE`. Clearing all ten guarantees stale metadata from another session never leaks into a shell command. Unrelated inherited and caller-supplied variables remain intact.

`ATOMIC_SESSION_FILE` and `PI_SESSION_FILE` are no longer populated because session IDs identify records inside the active store rather than assuming a file path. The snapshot is captured when each command runs, so resumed sessions and model changes are always reflected. SDK [`createBashTool()` and `createPowerShellTool()`](/sdk/reference#tools) expose these variables by default; pass `exposeSessionEnvironment: false` to omit them.

See [CLI environment variables](/reference/cli#environment-variables) and [RPC direct bash](/rpc/protocol#bash) for execution and streaming behavior.

## Subprocess attribution and worktree phase

Atomic sets `AI_AGENT=atomic` for itself and every subprocess it launches, replacing any caller-supplied value without mutating the caller's environment object. Scripts can inspect it to detect an Atomic-owned invocation.

During subagent worktree cleanup, Atomic sets `ATOMIC_SUBAGENT_WORKTREE_PHASE=finishing` on its own Git invocations (and clears any inherited value on other Git calls) so custom Git hooks or filters do not wait on that child's terminal notification. See [Subagents](/subagents).

## Retired workflow variables

Unset `ATOMIC_WORKFLOWS_JOURNAL`, `ATOMIC_WORKFLOW_JOURNAL_PATH`, and `ATOMIC_WORKFLOW_ARTIFACT_DIR` when upgrading from 0.9.x. Atomic inspects `ATOMIC_WORKFLOWS_JOURNAL` and `ATOMIC_WORKFLOW_JOURNAL_PATH` only when checking whether a custom agent directory should adopt an existing parent storage home; otherwise they are unused and existing files are left untouched. `ATOMIC_WORKFLOW_ARTIFACT_DIR`, `ATOMIC_WORKFLOW_DEBUG`, and `ATOMIC_DEBUG_POOLED_WATCH` are ignored; use `ATOMIC_DEBUG=1` for current diagnostics.

Unlike these ignored 0.9.x workflow variables, the removed libSQL team variables (`ATOMIC_PROFILE`, `ATOMIC_TEAM_URL`, `ATOMIC_TEAM_TOKEN`, `ATOMIC_TEAM_TOKEN_FILE`, `ATOMIC_TEAM_PREFIX`) hard-fail startup; see [Storage and team variables](#storage-and-team-variables).
