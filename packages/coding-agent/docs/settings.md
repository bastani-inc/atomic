---
title: "Settings"
description: "Complete reference for ~/.atomic/agent/settings.json and project .atomic/settings.json options."
---

# Settings

Atomic reads JSON settings from two scopes, with project settings overriding global settings:

| Location | Scope |
| --- | --- |
| `~/.atomic/agent/settings.json` | Global (all projects; legacy `~/.pi/agent/settings.json` is a fallback) |
| `.atomic/settings.json` | Project override (requires project trust; legacy `.pi/settings.json` is a fallback) |

Edit these files directly or run `/settings` for common options.

- **Automatic startup defaults.** Changing the model or thinking level interactively (`/model`, `/thinking`, or cycling shortcuts) saves `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, and `modelThinkingLevels`. `/scoped-models` saves `enabledModels`. SDK calls, session restores, and fallbacks do not overwrite these defaults unless explicitly requested.
- **Schema and safe merges.** Add `"$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/settings.schema.json"` for editor completion and validation. Atomic preserves `$schema`, unknown keys (such as extension settings like `subagents.agentOverrides`), and concurrent edits. Saving writes only changed fields to `.atomic` (and only changed keys inside object settings such as `modelThinkingLevels`). To clear an inherited array such as `packages`, set `"packages": []` explicitly.
- **Per-file precedence and validation.** `.atomic` overrides `.pi` per file, so legacy `queueMode` in `.atomic` beats `steeringMode` in `.pi`. Wrong-typed values are ignored with a one-time warning without rewriting the file; wrong-typed array entries are dropped while keeping valid entries. Settings that validate themselves and fail closed are `decisionModel`, `compactionModel`, `storage`, `sessions`, `snapshots`, `httpIdleTimeoutMs`, `websocketConnectTimeoutMs`, and `streamDeadlineMs`. Leading UTF-8 BOMs are stripped.

## On this page and its guide

This page is the full settings reference. For first-time setup and project-override examples, see [Configure Atomic](/guides/configuration).

## Project trust

Project settings in `.atomic/settings.json` (and legacy `.pi/settings.json`) load only when the project is trusted.

- Interactive sessions prompt once before trusting a project with trust-gated files and save decisions in `~/.atomic/agent/trust.json` (manage them with `/trust`).
- Non-interactive modes (`-p`, `--mode json`, `--mode rpc`) never prompt; they follow global `defaultProjectTrust` (`"ask"` and `"never"` ignore project settings; `"always"` trusts them). Override for one run with `--approve`/`-a` or `--no-approve`/`-na`.
- Eligible interactive starts open the [early editor](/usage#startup-typing) immediately while non-trust-gated resources load; trust-gated resources always wait for authorization.

See [Project trust](/security#project-trust) for the full list of trust-gated inputs and saved-decision behavior.

## All settings

### Herdr

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `herdr.enabled` | boolean | `true` | Enable the built-in Herdr status reporter in eligible Herdr panes (`mode: "tui"` with UI and Herdr env vars; never claimed by child sessions). Reload or restart after changing. |

See [Herdr](/herdr) for state aggregation, reporter conflicts, and privacy.

### Model & thinking

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultProvider` | string | unset | Startup provider, saved automatically on interactive model switch |
| `defaultModel` | string | unset | Startup model ID, saved automatically on interactive model switch |
| `decisionModel` | string | `""` | Model for `structured_output` (when omitted) and `decide()`: exact `provider/model` (chat or classifier), or `""`/`"auto"` for the current chat model. See [decisionModel](#decisionmodel). |
| `defaultThinkingLevel` | string | unset | Startup thinking level (`"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`), clamped to model support |
| `modelThinkingLevels` | object | unset | Per-model startup thinking levels keyed by `"provider/modelId"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | unset | Custom token budgets per thinking level (native on Anthropic, Google, and Bedrock; OpenAI-compatible when `compat.thinkingTokenBudgetField` or `supportsThinkingTokenBudget` is set) |
| `showCacheMissNotices` | boolean | `false` | Show notices for significant prompt-cache misses, billed compaction or branch summaries, and provider recovery diagnostics (such as dropped Anthropic thinking blocks), including on resume |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"idle"` | Keep eligible prompt caches warm during runs (`"streaming"`) or up to 30 min between runs (`"idle"`). `"off"` disables. Refreshes incur provider cost. Global setting only. |
| `fallbackModels` | string[] | unset | Ordered main-chat fallback chain (`"provider/model"` with optional `:effort` suffix) |

- **Cache warming.** Runs only when the model declares `promptCache` ([Models configuration](/models-configuration)) and estimated avoided miss cost is at least $0.05. Recorded in usage and never added to context; extensions can intercept via `cache_warming_decision`.
- **Unsupported saved default provider.** If `defaultProvider` and `defaultModel` name a provider still unsupported after extensions load, Atomic does not switch providers silently. Interactive mode warns, print and JSON modes warn on stderr and exit nonzero (stdout stays valid JSONL), and RPC rejects `prompt` until an explicit `set_model` or model cycle succeeds. If the provider is supported but the model is unknown or unauthenticated, normal auto-selection applies.
- **Subagents (`model: "auto"`).** Subagents use `defaultProvider`/`defaultModel` when authenticated (at agent `thinking`, else `modelThinkingLevels`, else `defaultThinkingLevel`, else `medium`), falling back to the launching session's model. Built-in agent overrides can also be configured under `subagents.agentOverrides` in `settings.json`; see [Subagent reference](/subagents/reference#automatic-model-selection).

#### decisionModel

```json
{ "decisionModel": "" }
```

Controls which model answers `structured_output` calls (when no `model` is passed; classifiers answer finite `Choice` schemas, otherwise Atomic tries `fallbackModels` and then the current chat model) and extension [`decide()`](/sdk/structured-decisions#decide) calls. It does not change your chat model or subagent execution model.

- **Configure.** Set in JSON or open `/settings` and select **Decision model** (edits project override if present, otherwise global). `""` or `"auto"` uses the current chat model. To pin a model, use an exact registered classifier (such as `typesafe/jev-latest`, `vercel-ai-gateway/typesafe-ai/jev`, `opencode/jev-1.13`, or `opencode/jev-1.13-free`) or chat `provider/model` (image models and whitespace-padded IDs fail). Run `/reload` or restart running isolated engines.
- **Fallback and deadlines.** A failed explicit classifier (missing credentials, context error, refusal, or malformed output) falls back silently to the current chat model and logs in [debug mode](#debug-mode). Chat models get 1 initial attempt plus 3 corrective retries, with a total wall-clock budget from [`httpIdleTimeoutMs`](#http) (default 10 minutes). Cancellation does not fall back.
- **Provider, credentials, and cost.** The decision model's provider receives the decision context, so choose a permitted provider. Authenticate a pinned classifier with its provider login (for example `/login typesafe` or `TYPESAFE_API_KEY`). Classifiers do not appear in `/model`. An explicit empty project value overrides a global selection and restores the current chat model. Falling back to the current chat model can incur chat-provider charges.
- **Legacy migration.** Valid legacy `routerModel` values migrate automatically when `decisionModel` is absent without rewriting the file. Removed `modelRouting` and built-in override `modelConstraints`/`taskNeeds` keys are removed automatically on startup from writable `.atomic` settings with a one-time notice.

See [Structured decisions](/sdk/structured-decisions) and [TypeSafe Jev](/providers#typesafe-jev).

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

A changed budget applies to new sessions. A resumed session keeps the budget it last used on the same model and thinking level so the provider does not re-bill the cached conversation; switching models or thinking levels applies the new setting.

#### fallbackModels

Ordered fallback chain for main-chat turns after same-model retries exhaust on a retryable failure:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "high",
  "fallbackModels": [
    "anthropic/claude-opus-4-8:xhigh",
    "github-copilot/gpt-5.6-sol:high"
  ]
}
```

- **Entry format.** Use `provider/model` (preferred; bare IDs also work, including IDs with `/` or `:` such as `qwen/qwen3-coder:exacto`) with an optional `:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, or `:max` suffix (clamped to model support). Run `atomic --list-models` for IDs. Unmatched entries warn once after extensions load and are skipped.
- **CLI precedence.** `--model` runs strictly as named and falls back only to `--fallback-models`, ignoring settings `fallbackModels`. `--no-fallback` disables fallback for one run, and `--fallback-models` replaces this list for one run. Extension-registered providers work in both. Press `Esc` during a retry wait or model switch to stop the pending request. See [CLI model options](/reference/cli#model-options).
- **Triggers.** Rate limits, quota exhaustion (`The usage limit has been reached`), transient errors (unrecognized errors without a status code retry same-model first), content-filter refusals (OpenAI HTTP 422 `cyber_policy`, Anthropic refusal, or `content_filter`; skips same-model retry unless `retry.fallbackOnContentFilter: false`), and refused TLS certificates (skips same-model retry; each fallback is tried once). Context overflow compacts first and falls back only if compaction is off, fails, or does not clear the overflow. With `retry.enabled: false`, retryable errors advance immediately. Non-retryable errors and `Esc` cancellations never fall back.
- **Turn-scoped exclusions.** Unauthenticated providers are skipped before sending a request (if none have credentials, Atomic fails immediately and lists the missing providers). Rejected credentials (HTTP 401, `invalid_api_key`, `authentication_error`) exclude the whole provider for the turn. Model-scoped HTTP 403 or incompatible-request errors exclude only that model across all reasoning suffixes.
- **Persistence and billing.** Once a fallback runs, it stays active for later turns (keeping thinking-level changes) until you switch via `/model` or model cycling. Print mode reports fallbacks on stderr and ends with `Model: ran on <fallback>, not the requested <model>.`. `fallbackModels` is independent of `enabledModels`. Because switching providers changes billing and data-handling terms, list only approved providers.

### Fast models

Fast inference uses canonical `<model-id>-fast` model IDs (not a separate setting) anywhere models are configured (`/model`, `fallbackModels`, `enabledModels`, and subagents). Reasoning suffixes work normally (`openai-codex/gpt-5.6-sol-fast:medium`), and fast and normal IDs act as separate candidates:

```json
{
  "fallbackModels": [
    "openai-codex/gpt-5.6-sol-fast:medium",
    "openai-codex/gpt-5.6-sol:medium"
  ]
}
```

See [Providers](/providers#fast-models) for supported providers and precedence over custom `-fast` IDs.

### UI & display

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `theme` | string | `"dark"` | `"dark"`, `"light"`, `"system"` (terminal-derived palette), Catppuccin built-in, or custom theme ([Themes](/themes)) |
| `fullscreenScrollbar` | string | `"auto"` | `"auto"` (show while scrolling), `"always"` (reserved right column), or `"hidden"`. Draggable in the main chat; also shown when viewing a subagent or shell output (not draggable). |
| `fullscreenExitOutput` | string | `"transcript"` | `"transcript"` prints the final transcript and resume hint on exit; `"resume-hint"` restores the previous screen and prints only the resume hint. Configurable in `/settings`. |
| `fullscreenCopyOnSelect` | boolean | `true` | Auto-copy text selection on mouse release (`false` highlights only; `/copy` copies the last assistant message). Configurable in `/settings`. |
| `fullscreenWheelScrollLines` | `"auto"` or number | `"auto"` | Lines per wheel tick in the main chat, viewed subagent transcripts, and shell output (`"auto"` or `1` to `100`). Configurable in `/settings`. |
| `quietStartup` | boolean or `"header"` | `false` | `true` hides the startup header; `"header"` keeps it but hides the model scope line |
| `defaultProjectTrust` | string | `"ask"` | Fallback project trust (`"ask"`, `"always"`, `"never"`). Global setting only. |
| `collapseChangelog` | boolean | `false` | Show a one-line update notice instead of What's New highlights (`/changelog` shows full history) |
| `enableInstallTelemetry` | boolean | `true` | Send version-adoption ping on first interactive launch (fresh settings or after upgrade with changelog entries) and provider attribution headers; does not control update checks |
| `firstRunOnboardingStartedVersion` | string | unset | Managed onboarding state (leave unchanged) |
| `onboardedVersion` | string | unset | Managed onboarding completion state (leave unchanged) |
| `teamJoin` | object | unset | Managed `atomic team join` record used by `atomic team leave` (leave unchanged) |
| `enableAnalytics` | boolean | `false` | Opt in to analytics during first-run setup. Storage only; Atomic does not transmit analytics. |
| `trackingId` | string | unset | Locally generated analytics ID when analytics is enabled |
| `deviceId` | string | unset | Managed global install ID created when a provider sign-in needs it (project values ignored) |
| `doubleEscapeAction` | string | `"tree"` | Double-Esc action: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default `/tree` filter: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal input editor padding (`0` to `3`) |
| `outputPad` | number | `1` | Horizontal transcript padding (`0` or `1`) |
| `externalEditor` | string | unset | Command for `Ctrl+G` external editor (overrides `$VISUAL` and `$EDITOR`; defaults to Notepad on Windows, `nano` elsewhere) |
| `autocompleteMaxVisible` | number | `5` | Max visible autocomplete items (`3` to `20`) in default and `ctx.ui.setEditorComponent()` editors |
| `showHardwareCursor` | boolean | `false` | Use hardware terminal cursor instead of drawn cursor (still positioned for IME) |

Interactive mode runs fullscreen with stacked transient notices. Closing an overlay clears text selection inside it. `Ctrl+G` checks `externalEditor`, then `$VISUAL`, then `$EDITOR`, then Notepad (Windows) or `nano` (POSIX) in main chat, embedded chat, and extension dialogs; saving empty clears text, while an editor error preserves the original text.

### Debug mode

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `debug` | boolean | `false` | Write verbose debug output to the debug log shown by `/debug` (**Debug mode** in `/settings`). Global setting only. |

Use `--debug` or `ATOMIC_DEBUG=1` for a single run (shows a `debug` badge in the footer). Toggling in `/settings` applies immediately to new work; already-running workers and the Intercom broker apply it on next restart. See [Debugging](/development#debugging).

### Telemetry and update checks

- **Version-adoption telemetry.** Controlled by `enableInstallTelemetry` (disable with `"enableInstallTelemetry": false` or `ATOMIC_TELEMETRY=0`; force on with `ATOMIC_TELEMETRY=1`/`true`/`yes`, where `ATOMIC_TELEMETRY` beats legacy `PI_TELEMETRY`). Sends one bodyless `GET https://atomic-version-adoption.bastani-atomic.workers.dev/v1/version-adoption?version=<version>` with `User-Agent: atomic/<version> (<platform>; <runtime>; <arch>)` and no UUID, cookie, auth header, or user content. Fires only in interactive mode on first launch with fresh settings or after upgrading to a release with changelog entries, never on every launch, npm install, or `-p`/RPC. Atomic stores only UTC date, version, and an aggregate count; Cloudflare processes transient connection metadata (IP, TLS) to serve the request. Separate from `enableAnalytics` and `trackingId`.
- **Update checks.** Queries `https://registry.npmjs.org/@bastani/atomic/latest`. Disable independently with `ATOMIC_SKIP_VERSION_CHECK=1` (`PI_SKIP_VERSION_CHECK=1`).
- **Offline mode.** `--offline` or `ATOMIC_OFFLINE=1` (`PI_OFFLINE=1`) disables all startup network requests (update checks, package update checks, version-adoption telemetry, and model catalog refreshes).

### Network proxy

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `httpProxy` | string | unset | HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY`. Global setting only. |

```json
{ "httpProxy": "http://127.0.0.1:7890" }
```

Both the npm-installed `atomic` and the standalone binary route `https://` requests through `HTTP_PROXY` when `HTTPS_PROXY` is unset, and skip hosts listed in `NO_PROXY`. The binary uses Bun's HTTP client, which handles proxy variables differently in these cases:

| Setup | npm-installed `atomic` | Standalone binary |
| --- | --- | --- |
| `ALL_PROXY` naming an `http://` or `https://` proxy | Not read | Used when the request's own variable is unset |
| An empty lowercase variable (`http_proxy=""`, `no_proxy=""`) with the uppercase one set | The empty value counts: no proxy, no exemptions | The uppercase value is used |
| An address block in `NO_PROXY` (`10.0.0.0/8`) | Not matched | Exempts the addresses in it |
| Proxy variables changed while Atomic runs | Read at startup and when `httpIdleTimeoutMs` changes | Read for each request |
| An `http://` endpoint through a proxy | Sent through a `CONNECT` tunnel | Sent to the proxy with the full URL |
| A SOCKS proxy (`socks5://`) in `HTTP_PROXY` or `HTTPS_PROXY` | Used | Requests fail with `UnsupportedProxyProtocol` |

The OpenAI Codex WebSocket uses the same proxy as the install's other requests. In the binary it also reads proxy variables from a credential's [`env`](/providers#auth-file); an `ALL_PROXY` naming a SOCKS proxy is skipped for WebSocket and those requests fall back to SSE.

### Warnings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `warnings.anthropicExtraUsage` | boolean | `true` | Warn when Anthropic subscription auth may incur paid extra usage |

### Compaction

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `compaction.enabled` | boolean | `true` | Enable automatic compaction |
| `compaction.reserveTokens` | number | `16384` | Non-negative safe integer; triggers auto-compaction when usage exceeds `contextWindow - reserveTokens` |
| `compactionModel` | string | `"auto"` | `"auto"` or `""` clears context so the agent recovers from history; an exact registered compactor ID (such as `morph/morph-compactor`) compacts via that model. Saved chat or classifier IDs reset to `"auto"` on startup. See [Compaction model](/compaction#compaction-model). |

```json
{
  "compactionModel": "auto",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384
  }
}
```

Removed legacy keys (`compression_ratio`, `preserve_recent`, `keepContextShare`, `query`, `planningTimeoutMs`, `modelOverrides`, `background`, `backgroundThresholdPercent`, `historyRecall`) are ignored silently. See [Compaction](/compaction).

### Branch summary

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved when selecting branch history for summary |
| `branchSummary.skipPrompt` | boolean | `false` | Skip the "Summarize branch?" prompt on `/tree` switches (defaults to no summary) |

### Session summary

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `sessionSummary.enabled` | boolean | `true` | Generate one-line summaries for saved sessions in `/resume` when idle (skipped for `--no-session`) |

### Resume

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `resume.waitForBlueprint` | `"prompt"` \| `"tools"` | `"prompt"` (TUI) / `"tools"` (non-UI) | Controls whether restored worktree builds finish before opening (`"prompt"`) or run concurrently while holding tool calls (`"tools"`). When a `project_trust` extension handler can still decline a saved trust decision, Atomic behaves like `"tools"` so no project build step runs before trust settles. See [Start the first turn while the build runs](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs). |
| `resume.cache` | array | unset | Extra entries for [`atomic blueprint cache-key`](/guides/resume-on-any-machine#caches-for-runners): `{ "paths": [...], "kind"?: "store" \| "build", "keyFiles"?: [...] }`. `"store"` paths are absolute or `~` outside the repo; `"build"` paths are repo-relative. Globs, `!` exclusions, and credential paths are refused with a warning. Project list replaces global. |
| `resume.setupCommand` | string | unset | Deprecated (global only; prints warning). Move commands into `.atomic/blueprint.yaml` `maintenance` ([Set the environment up with a blueprint](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint)). |

### Snapshots

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `snapshots.enabled` | boolean | `true` | Record worktree snapshots so sessions resume with repository state |
| `snapshots.includeUntracked` | boolean | `true` | Capture non-ignored, non-denied untracked files |
| `snapshots.maxFileBytes` | number | `5242880` | Max single file size captured (bytes) |
| `snapshots.maxSnapshotBytes` | number | `52428800` | Max total captured snapshot or unpushed-commit bundle size (bytes) |
| `snapshots.fullEvery` | number | `10` | Restart patch chain from `HEAD` after this many snapshots |
| `snapshots.autoCollect` | boolean | `true` | Garbage-collect unreferenced snapshot content in background and on session close |
| `snapshots.collectIntervalSeconds` | number | `3600` | Minimum interval between automatic GC passes per database (seconds) |
| `snapshots.graceSeconds` | number | `3600` | Protect snapshot data stored or reused within this window (`0` disables) |
| `snapshots.pool.maxIdlePerRepository` | number | `2` | Idle restored worktrees kept per repository ([Restored worktrees](/worktree-snapshots#restored-worktrees)) |

See [Worktree snapshots](/worktree-snapshots).

### Retry

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `retry.enabled` | boolean | `true` | Enable agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base exponential backoff delay (2s, 4s, 8s) |
| `retry.maxAgentDelayMs` | number | `60000` | Cap on agent-level backoff (`0` retries immediately) |
| `retry.fallbackOnContentFilter` | boolean | `true` | Advance to next `fallbackModels` entry on content-filter refusals (such as OpenAI HTTP 422 `cyber_policy`); `false` retries on the same model |
| `retry.provider.timeoutMs` | number | SDK default | Provider or SDK request timeout (ms) |
| `retry.provider.maxRetries` | number | `0` | Provider or SDK-level retries (leave `0` to let agent-level retry handle backoff) |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-hinted retry delay before failing fast (`0` disables cap; legacy `retry.maxDelayMs` migrates here) |

- **Server retry hints.** Atomic honors `Retry-After-Ms`, `Retry-After`, Cloudflare 5xx `retry_after`, and Google `RetryInfo.retryDelay` up to `retry.provider.maxRetryDelayMs`, failing immediately if the server asks for longer (such as a 5-hour quota reset). This applies across OpenAI, OpenAI-compatible, Codex, Anthropic, Azure OpenAI, Mistral, Google, Vertex, and Bedrock. Cloudflare 520 to 524 and connection resets count as transient; non-retryable 4xx and quota errors fail immediately.
- **Refused TLS certificates.** Requests refused for an untrusted certificate (such as a self-signed certificate or corporate TLS proxy) are never retried. The error names the host (the proxy host when the `https://` proxy's own certificate failed), the code (such as `SELF_SIGNED_CERT_IN_CHAIN`), and how to trust a private CA with [`NODE_EXTRA_CA_CERTS`](/environment-variables#tls-certificates). Connection resets during TLS handshakes still retry.
- **GitHub Copilot long cuts.** A stream cut after 5 minutes or more gets 1 retry; a second consecutive long cut switches to `fallbackModels` or fails with guidance. See [Streams cut after a long attempt](/providers#streams-cut-after-a-long-attempt).
- **SDK `retryDeadline`.** Pass `retryDeadline: performance.now() + budgetMs` (or `{ at, onExpired }`) with `signal` on provider requests or `retryAssistantCall()` to avoid starting backoff past a local deadline (do not use `Date.now()`).

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "maxAgentDelayMs": 60000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### HTTP

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `httpIdleTimeoutMs` | number or string | `600000` | Global HTTP dispatcher idle timeout in ms, duration string (`"30s"`, `"5m"`, `"1h"`), or `"disabled"`/`0`. |

Applies to `fetch`, provider SDK HTTP clients, and the default total wall-clock budget for one [structured decision](/sdk/structured-decisions#cancellation-and-failures) (`structured_output`, `generateStructuredOutput()`, `decide()`). `/settings` presets offer `30 sec` (`30000`), `1 min` (`60000`), `5 min` (`300000`), `10 min` (`600000`), `30 min` (`1800000`), and `Disabled` (`"disabled"` or `0`). The standalone binary checks this timeout on a coarse timer, ending a silent request up to about 8 seconds late (or up to about two minutes late for timeouts longer than four minutes).

### Message delivery

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `steeringMode` | string | `"one-at-a-time"` | Steering message delivery: `"one-at-a-time"` or `"all"` |
| `followUpMode` | string | `"one-at-a-time"` | Follow-up message delivery: `"one-at-a-time"` or `"all"` |
| `transport` | string | `"auto"` | Multi-transport provider preference: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` (legacy boolean `websockets` migrates here) |
| `websocketConnectTimeoutMs` | number or string | `15000` | WebSocket handshake timeout (ms, duration string, or `"disabled"`/`0`) |
| `streamDeadlineMs` | number or string | `300000` | Max idle gap between provider stream events below HTTP (ms, duration string like `30s`, `5m`, `1h`, or `"disabled"`/`0`). Cuts stalled streams for retry or fallback; Anthropic `ping` events reset the timer. |

For the global HTTP idle timeout, see [HTTP](#http) (`httpIdleTimeoutMs`).

### Terminal & Images

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `terminal.showImages` | boolean | `true` | Render inline images when supported |
| `terminal.imageWidthCells` | number | `60` | Inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear blank rows when content shrinks (fallback env: `ATOMIC_CLEAR_ON_SHRINK=1`) |
| `terminal.showTerminalProgress` | boolean | `false` | Show OSC 9;4 progress bar in terminal tab |
| `images.autoResize` | boolean | `true` | Resize images over 2000x2000 for `@file`, `read`, and tool results (runs after `tool_result` hooks; keeps original on error) |
| `images.blockImages` | boolean | `false` | Block all images from being sent to the model |
| `terminal.hyperlinks` | boolean or `"auto"` | `"auto"` | JSON-only override for OSC 8 hyperlink detection (env: `ATOMIC_HYPERLINKS=1\|0\|auto`) |
| `terminal.images` | `"kitty"`, `"iterm2"`, `"auto"`, or `false` | `"auto"` | JSON-only override for inline image protocol (env: `ATOMIC_IMAGE_PROTOCOL=kitty\|iterm2\|none\|auto`) |
| `terminal.trueColor` | boolean or `"auto"` | `"auto"` | JSON-only override for 24-bit color detection (env: `ATOMIC_TRUE_COLOR=1\|0\|auto`) |

Explicit JSON values for `terminal.hyperlinks`, `terminal.images`, and `terminal.trueColor` override their `ATOMIC_*` and legacy `PI_*` environment variables.

### Shell

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `shellPath` | string | unset | Custom Bash path; a bare name such as `bash` is looked up in absolute `PATH` directories (does not change PowerShell used on native Windows `!` and `!!`) |
| `shellCommandPrefix` | string | unset | Prefix prepended to shell commands (PowerShell syntax on native Windows interactive shells; Bash syntax elsewhere, such as `"shopt -s expand_aliases"`) |
| `search.contextBefore` | number | `1` | Context lines before each `search` match |
| `search.contextAfter` | number | `3` | Context lines after each `search` match |
| `npmCommand` | string[] | unset | Command argv for npm lookup, install, uninstall, and git-package dependency installs (runs plain `install` when set, for example `["mise", "exec", "node@20", "--", "npm"]`) |
| `selfUpdateCommand` | string[] | unset | Command argv for `atomic update` using `{packageName}`, `{version}`, and `{installSpec}` (`ATOMIC_SELF_UPDATE_COMMAND` overrides; global settings only; [Custom update command](/reference/cli#custom-update-command)) |

On Windows, write JSON paths with forward slashes or escaped backslashes:

```json
{ "shellPath": "C:/Program Files/Git/bin/bash.exe" }
```

```json
{ "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe" }
```

### Tools

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultTools` | string[] | unset | Initial built-in tools: plain names replace defaults; `+name` and `-name` modify them |
| `codemode.mode` | `"on"` or `"only"` | `"on"` | `"on"` keeps direct tools declared alongside codemode; `"only"` hides ordinary direct tools so the model uses scripts (model-only tools stay top-level) |
| `codemode.inlineBudget` | number | `3000` | Estimated token budget for inline codemode tool declarations (`0` lists namespaces only; omitted tools remain discoverable via `searchTools()`) |

Built-in tool names include `read`, `bash`, `powershell`, `kill`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`, `codemode`, `tool_search`, and `ls`.

```json
{ "defaultTools": ["bash", "edit", "write"] }
```

```json
{ "defaultTools": ["read", "powershell", "edit", "write"] }
```

```json
{ "defaultTools": ["-bash", "+ls"] }
```

- **Merging and modifiers.** Modifier-only arrays start from standard defaults (project modifier-only arrays layer over global `defaultTools`). Plain names or `[]` replace the prior list (`[]` keeps extension and custom tools).
- **`codemode` and `tool_search`.** `codemode` is on by default (remove with `["-codemode"]`, or include explicitly in a replacement list); `tool_search` is opt-in (`["+tool_search"]`). See [codemode](/tools#codemode) and [tool search](/tools#tool_search).
- **CLI and `/reload`.** Plain `--tools` replaces the set as an allowlist; modifier-only `--tools` adjusts the resolved selection (including on `/reload`). `--no-tools` disables every tool even with an allowlist or modifiers. `--no-builtin-tools` suppresses coding defaults only when no allowlist is given. `--exclude-tools` filters the result. `/reload` adds newly enabled `defaultTools` without re-enabling tools disabled mid-session.

### Tasks

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `tasks.heartbeatMs` | number | `900000` | [Task heartbeat](/background-tasks#task-heartbeats) interval in ms (`0` disables; minimum `60000`; invalid values fall back to default; per-call `heartbeatMs` overrides) |
| `tasks.heartbeatWakesIdleSession` | boolean | `true` | Wake an Esc-interrupted idle session immediately on heartbeat (`false` waits for your next message) |

```json
{ "tasks": { "heartbeatMs": 1800000 } }
```

### Sessions

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `sessions.storage` | object | Local SQLite | Session-only store: `{ "path": "..." }`, `{ "dir": "..." }`, `{ "memory": true }`, or `{ "adapter": "...", "options": {}, "secrets": {}, "prefix": "..." }` |
| `storage` | object | Local SQLite | Shared storage default (sessions when `sessions.storage` is unset; in global settings also selects Intercom broker storage, see [Running Intercom across machines](/intercom/operations#running-intercom-across-machines)). Same forms except `dir`. |

```json
{ "sessions": { "storage": { "path": "sessions.sqlite" } } }
```

- **Default.** `~/.atomic/workflows/journal.sqlite` (`session_` tables; under `<agentDir>/workflows/` when `ATOMIC_CODING_AGENT_DIR` is set unless it adopted a parent store; see [Storage home](/storage#storage-home)). JSONL is opt-in via `dir`, `--session-dir`, or `ATOMIC_CODING_AGENT_SESSION_DIR` (legacy `sessionDir` was removed).
- **Precedence.** Highest to lowest: SDK `sessionStore`, `--no-session`, `--session-dir` or `--session-store`, `--storage` or `--storage-file`, `ATOMIC_SESSIONS_STORAGE` or `ATOMIC_CODING_AGENT_SESSION_DIR`, `ATOMIC_STORAGE`, `sessions.storage`, `storage`, and default SQLite. Project selections replace global objects whole rather than merging; an explicit `{}` on `sessions.storage` selects default SQLite rather than inheriting `storage`. Relative paths in settings and JSON flags or env vars resolve from [storage home](/storage#storage-home); `--session-dir`, `--session-store`, and `ATOMIC_CODING_AGENT_SESSION_DIR` resolve from `cwd`.
- **Errors.** Only the winning setting (plus set `ATOMIC_STORAGE` and `ATOMIC_SESSIONS_STORAGE`) is validated. Invalid config throws `StorageConfigError` (`source`, `field`, `reason`), and open failures throw typed errors without falling back to memory. See [Choosing a store](/sessions#choosing-a-store), [Selecting storage per process](/storage#selecting-storage-per-process), and [Storage errors](/storage#storage-errors).

### Models

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `enabledModels` | string[] | unset | Patterns for `Ctrl+P` model cycling (same syntax as `--models`; re-resolved after deferred extension loading). Independent of `fallbackModels`. |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"],
  "fallbackModels": ["anthropic/claude-opus-4-8:xhigh", "github-copilot/gpt-5.6-sol:high"]
}
```

### Markdown

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |
| `markdown.mermaid` | string | `"streaming"` | Display-only Mermaid rendering: `"off"`, `"final"`, or `"streaming"` (invalid or oversized diagrams stay as code) |
| `markdown.latex` | boolean | `true` | Display-only Unicode math rendering (supports whitespace and matrix layouts; stored messages keep source Markdown) |

### Resources

Paths in `~/.atomic/agent/settings.json` resolve from `~/.atomic/agent`; paths in `.atomic/settings.json` resolve from `.atomic`. Supports absolute paths, `~`, globs, `!exclusions`, `+exact-include`, and `-exact-exclude`.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `packages` | array | `[]` | npm, git, or local packages (string or object filter form) |
| `extensions` | string[] | `[]` | Local extension files or directories |
| `skills` | string[] | `[]` | Local skill files or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme files or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:<name>` commands |

<a id="workflow-storage" />
<a id="local-worker-pools" />

Legacy `workflows` settings no longer run workflows. Atomic reads their paths only when you ask to [convert a workflow to a skill](/orchestration/migrating-workflows).

#### Storage adapters

Install an adapter [Atomic package](/storage#adapters-from-atomic-packages) (or pass its directory via `--extension` or SDK `additionalExtensionPaths`, which takes precedence over settings) and reference it in `storage` or `sessions.storage`:

```json
{
  "storage": {
    "adapter": "@example/atomic-sqlite",
    "options": { "url": "libsql://database.example" },
    "secrets": { "authToken": { "env": "DATABASE_TOKEN" } },
    "prefix": "project_"
  }
}
```

- An empty shared `storage: {}` uses `<storageHome>/storage.sqlite`.
- `secrets` accepts `{ "env": "VAR" }` or `{ "file": "token.txt" }` (relative paths resolve from [storage home](/storage#storage-home), falling back to parent if an existing file lives there; one trailing `\n` or `\r\n` is stripped).
- Adapter modules execute code; review them before trusting project settings. See [Selecting an adapter](/storage#selecting-an-adapter).

#### packages

Load all resources with a string entry, or filter specific resources with an object entry (`"autoload": false` disables discovery and applies only explicit patterns):

```json
{
  "packages": [
    "npm:@org/team-skills",
    {
      "source": "@org/my-extension",
      "autoload": false,
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [Atomic packages](/packages).

<a id="example" />
<a id="project-overrides" />

For a complete example config and project-override walkthrough, see [Configure Atomic](/guides/configuration#example) and [Project overrides](/guides/configuration#project-overrides).
