# Settings

Atomic reads JSON settings from two scopes, with project settings overriding global settings:

| Location | Scope |
| --- | --- |
| `~/.atomic/agent/settings.json` | Global (all projects; legacy `~/.pi/agent/settings.json` is a fallback) |
| `.atomic/settings.json` | Project override (requires project trust; legacy `.pi/settings.json` is a fallback) |

Edit these files directly or use `/settings` for common options.

- **Automatic startup defaults:** Changing model or thinking level interactively (`/model`, `/thinking`, or cycling shortcuts) saves `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, and `modelThinkingLevels`. `/scoped-models` saves `enabledModels`. SDK calls, session restores, and fallbacks do not overwrite these defaults unless explicitly requested.
- **Schema & safe merges:** Add `"$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/settings.schema.json"` for editor autocomplete and validation. Atomic preserves `$schema`, unknown keys (such as extension settings), and concurrent edits; saving writes only changed fields to `.atomic` (and only changed keys inside object settings like `modelThinkingLevels`). To clear an inherited array such as `packages`, set `"packages": []` explicitly.
- **Per-file precedence & validation:** `.atomic` overrides `.pi` per file (so legacy `queueMode` in `.atomic` beats `steeringMode` in `.pi`). Wrong-typed values are ignored with a one-time warning (`Invalid settings file ...; ignoring it.`) without rewriting the file; wrong-typed array entries are dropped while keeping valid entries. Settings that validate themselves and fail closed instead of falling back are `decisionModel`, `storage`, `sessions`, `snapshots`, `httpIdleTimeoutMs`, `websocketConnectTimeoutMs`, and `streamDeadlineMs`. Leading UTF-8 BOMs are stripped.

## On this page and its guide

This page is the full settings reference. For first-time setup and project-override examples, see [Configure Atomic](/guides/configuration).

## Project Trust

On interactive startup, Atomic prompts before trusting a project directory that contains trust-gated inputs (`.atomic`/`.pi` settings or resources, project context files, project packages, or project extensions) when no decision exists in `~/.atomic/agent/trust.json` for that folder or a parent.

- The prompt runs before the UI paints (no model request needed). Declining ignores project resources and warns in the transcript.
- **Non-interactive modes (`-p`, `--mode json`, `--mode rpc`):** Never prompt; use global `defaultProjectTrust` (`"ask"` and `"never"` ignore project inputs; `"always"` trusts them). Override for one run with `--approve`/`-a` or `--no-approve`/`-na` (also supported by `atomic config` and package commands). Ignored project settings print a warning naming the file.
- **Manage trust:** Run `/trust` interactively to save decisions in `~/.atomic/agent/trust.json` (including parent-folder trust), then restart Atomic. Bare folders or inert state dirs (`.atomic/todos/`, `.atomic/sessions/`) do not require trust.
- **Deferred startup:** Interactive mode opens the editor immediately while non-trust-gated resources load (early prompts wait briefly with a spinner). Trust-gated resources always wait for authorization.

## All Settings

### Herdr

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `herdr.enabled` | boolean | `true` | Enable the built-in Herdr status reporter in eligible Herdr panes (`mode: "tui"` with UI and Herdr env vars; never claimed by child sessions). Reload or restart after changing. |

See [Herdr](/herdr) for state aggregation, reporter conflicts, and privacy.

### Model & Thinking

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultProvider` | string | - | Startup provider, saved automatically on interactive model switch |
| `defaultModel` | string | - | Startup model ID, saved automatically on interactive model switch |
| `decisionModel` | string | `""` | Model for `structured_output` (when omitted) and `decide()`: exact `provider/model` (chat or classifier), or `""`/`"auto"` for the current chat model. See [decisionModel](#decisionmodel). |
| `defaultThinkingLevel` | string | - | Startup thinking level (`"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`), clamped to model support |
| `modelThinkingLevels` | object | - | Per-model startup thinking levels keyed by `"provider/modelId"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level (native on Anthropic/Google/Bedrock; OpenAI-compatible when `compat.thinkingTokenBudgetField` or `supportsThinkingTokenBudget` is set) |
| `showCacheMissNotices` | boolean | `false` | Show notices for significant prompt-cache misses, billed compaction/branch summaries, and provider recovery diagnostics (such as dropped Anthropic thinking blocks), including on resume |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"idle"` | Keep eligible prompt caches warm during runs (`"streaming"`) or up to 30 min between runs (`"idle"`). `"off"` disables. Refreshes incur provider cost. Global setting only. |
| `fallbackModels` | string[] | - | Ordered main-chat fallback chain (`"provider/model"` with optional `:effort` suffix) |

- **Cache warming:** Runs only when the model declares `promptCache` ([Models Configuration](/models-configuration)) and estimated avoided miss cost is ≥$0.05. Recorded in usage, never added to context; extensions can intercept via `cache_warming_decision`.
- **Unsupported saved default provider:** If `defaultProvider` + `defaultModel` names a provider still unsupported after extensions load, Atomic does not switch providers silently: interactive mode warns; print/JSON modes warn on stderr and exit non-zero (stdout stays clean JSONL); RPC rejects `prompt` until an explicit `set_model` or model cycle succeeds. If the provider is supported but the model is unknown or unauthenticated (or either field is omitted), normal auto-selection applies.
- **Subagents (`model: "auto"`):** Run `defaultProvider`/`defaultModel` when authenticated (at agent `thinking`, else `modelThinkingLevels`, else `defaultThinkingLevel`, else `medium`), falling back to the launching session's model. See [Automatic model selection](/subagents/reference#automatic-model-selection).

#### decisionModel

```json
{ "decisionModel": "" }
```

Controls which model answers `structured_output` calls (when no `model` is passed; classifiers answer finite `Choice` schemas, otherwise call `fallbackModels` then current chat model) and extension [`decide()`](/sdk/structured-decisions#decide) calls. Does not change your chat model or subagent execution model.

- **Configure:** Set in JSON or `/settings` → **Decision model** (edits project override if present, otherwise global). `""` or `"auto"` uses the current chat model. To pin a model, use an exact registered classifier (such as `typesafe/jev-latest`, `vercel-ai-gateway/typesafe-ai/jev`, `opencode/jev-1.13`, `opencode/jev-1.13-free`) or chat `provider/model` (image models and invalid/whitespace-padded IDs fail). Run `/reload` or restart for already-running isolated engines.
- **Fallback & deadlines:** A failed explicit classifier (missing credentials, context error, refusal, malformed output) falls back silently to the current chat model (logged only in [debug mode](#debug-mode)). Chat models get 1 initial attempt + 3 corrective retries; total wall-clock limit comes from [`httpIdleTimeoutMs`](#http) (default 10 min). Cancellation does not fall back.
- **Legacy migration:** Valid legacy `routerModel` values auto-migrate when `decisionModel` is absent (never rewriting the file; invalid values warn once via `shown-notices.json`). Removed `modelRouting` and builtin override `modelConstraints`/`taskNeeds` keys are auto-removed on startup from writable `.atomic` settings with a one-time notice.

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

#### fallbackModels

Ordered fallback chain for main-chat turns after same-model retries exhaust on a retryable failure:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.5",
  "defaultThinkingLevel": "high",
  "fallbackModels": [
    "anthropic/claude-opus-4-8:xhigh",
    "github-copilot/gpt-5.5:high"
  ]
}
```

- **Entry format:** `provider/model` (preferred; bare IDs also work, including IDs containing `/` or `:` like `qwen/qwen3-coder:exacto`) with optional `:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, or `:max` suffix (clamped to model support). Run `atomic --list-models` for IDs. Unmatched entries warn once after extensions load and are skipped.
- **CLI precedence:** `--model` runs strictly as named and falls back only to `--fallback-models` (ignoring settings `fallbackModels`). `--no-fallback` disables fallback for one run. See [CLI model options](/reference/cli#model-options).
- **Triggers:** Rate limits, quota/usage exhaustion (`The usage limit has been reached`), transient errors (unrecognized errors without status/code retry same-model first), and content-filter refusals (OpenAI HTTP 422 `cyber_policy`, Anthropic refusal, `content_filter`—skips same-model retry; set `retry.fallbackOnContentFilter: false` to stay on the refusing model). Context overflow compacts first and falls back only if compaction is off, fails, or does not resolve overflow. With `retry.enabled: false`, retryable errors advance immediately. Non-retryable errors and `Esc`/cancellations never fall back.
- **Provider/model exclusion for the turn:** Unauthenticated providers skip before any request (recorded in `model_change` `fallback.skipped`; if none have credentials, fails immediately listing missing providers). Rejected credentials (HTTP 401, invalid/expired key or token, `invalid_api_key`, `authentication_error`) exclude the whole provider for the turn. Model-scoped HTTP 403 or incompatible-request failures exclude only that model across all reasoning suffixes.
- **Persistence & visibility:** Once a fallback runs, it stays active for subsequent turns (and keeps thinking-level changes) until you explicitly switch via `/model` or model cycling. Recorded as a `model_change` entry; in `-p` mode prints fallbacks to stderr and ends with `Model: ran on <fallback>, not the requested <model>.`. Independent from `enabledModels`. Switching providers changes billing and data-handling terms—include only approved providers.

### Fast models

Fast inference is selected via canonical `<model-id>-fast` model IDs (not a separate setting), anywhere models are configured (`/model`, `fallbackModels`, `enabledModels`, subagents). Reasoning suffixes work normally (`openai-codex/gpt-5.6-sol-fast:medium`), and fast/normal IDs are tracked as distinct candidates:

```json
{
  "fallbackModels": [
    "openai-codex/gpt-5.6-sol-fast:medium",
    "openai-codex/gpt-5.6-sol:medium"
  ]
}
```

See [Providers](/providers#fast-models) for supported providers and precedence over custom `-fast` IDs.

### UI & Display

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `theme` | string | `"dark"` | `"dark"`, `"light"`, `"system"` (terminal-derived palette), Catppuccin built-in, or custom theme ([Themes](/themes)) |
| `fullscreenScrollbar` | string | `"auto"` | `"auto"` (show while scrolling), `"always"` (reserved right column), or `"hidden"`. Draggable in main chat; also shown in `/tasks` transcripts (not draggable). |
| `fullscreenExitOutput` | string | `"transcript"` | `"transcript"` prints the final transcript + resume hint on exit; `"resume-hint"` restores the previous screen and prints only the resume hint. Configurable in `/settings`. |
| `fullscreenCopyOnSelect` | boolean | `true` | Auto-copy text selection on mouse release (`false` highlights only; `/copy` copies the last assistant message). Configurable in `/settings`. |
| `fullscreenWheelScrollLines` | `"auto"` or number | `"auto"` | Lines per wheel tick in fullscreen and `/tasks` transcripts (`"auto"` or `1`–`100`). Configurable in `/settings`. |
| `quietStartup` | boolean or `"header"` | `false` | `true` hides the startup header; `"header"` keeps it but hides the model scope line |
| `defaultProjectTrust` | string | `"ask"` | Fallback project trust (`"ask"`, `"always"`, `"never"`). Global setting only. |
| `collapseChangelog` | boolean | `false` | Show one-line update notice instead of What's New highlights (`/changelog` shows full history) |
| `enableInstallTelemetry` | boolean | `true` | Send version-adoption ping on first interactive launch (fresh settings or after upgrade with changelog entries) and provider attribution headers; does not control update checks |
| `firstRunOnboardingStartedVersion` | string | - | Managed onboarding state (leave unchanged) |
| `onboardedVersion` | string | - | Managed onboarding completion state (leave unchanged) |
| `teamJoin` | object | - | Managed `atomic team join` record used by `atomic team leave` (leave unchanged) |
| `enableAnalytics` | boolean | `false` | Opt in to analytics during first-run setup |
| `trackingId` | string | - | Locally generated analytics ID when analytics is enabled |
| `deviceId` | string | - | Managed global install ID created when a provider sign-in needs it (project values ignored) |
| `doubleEscapeAction` | string | `"tree"` | Double-Esc action: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default `/tree` filter: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal input editor padding (`0`–`3`) |
| `outputPad` | number | `1` | Horizontal transcript padding (`0` or `1`) |
| `externalEditor` | string | - | Command for `Ctrl+G` external editor (overrides `$VISUAL`/`$EDITOR`; defaults to Notepad on Windows, `nano` elsewhere) |
| `autocompleteMaxVisible` | number | `5` | Max visible autocomplete items (`3`–`20`) in default and `ctx.ui.setEditorComponent()` editors |
| `showHardwareCursor` | boolean | `false` | Use hardware terminal cursor instead of drawn cursor (still positioned for IME) |

- Interactive mode runs fullscreen with stacked transient notices. Overlay text selections clear when closing overlays.
- `Ctrl+G` opens `externalEditor` → `$VISUAL` → `$EDITOR` → Notepad (Windows) / `nano` (POSIX) in main chat, embedded chat, and extension dialogs; saving empty clears text, editor failure preserves original text.

### Debug mode

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `debug` | boolean | `false` | Write verbose debug output to the debug log shown by `/debug` (**Debug mode** in `/settings`). Global setting only. |

Use `--debug` or `ATOMIC_DEBUG=1` for a single run (displays a `debug` badge in the footer). Toggling in `/settings` applies immediately to new work; already-running workers and the Intercom broker apply it on next restart. See [Debugging](/development#debugging).

### Telemetry and update checks

- **Version-adoption telemetry:** Controlled by `enableInstallTelemetry` (opt out via `"enableInstallTelemetry": false` or `ATOMIC_TELEMETRY=0` / legacy `PI_TELEMETRY=0`; force on with `ATOMIC_TELEMETRY=1`/`true`/`yes`, where `ATOMIC_TELEMETRY` beats `PI_TELEMETRY`). Sends one bodyless `GET https://atomic-version-adoption.bastani-atomic.workers.dev/v1/version-adoption?version=<version>` with the standard `atomic/<version> (<platform>; <runtime>; <arch>)` User-Agent (no UUID, cookie, auth header, or user content). Fires only in interactive mode on first launch with fresh settings or first launch after upgrading to a version with changelog entries—never on every launch, npm install, reinstall keeping settings, or `-p`/RPC. Stores UTC date, version, and aggregate count (Cloudflare processes transient IP/TLS metadata). Separate from opt-in analytics (`enableAnalytics` / `trackingId`).
- **Update checks:** Queries `https://registry.npmjs.org/@bastani/atomic/latest`. Disable independently with `ATOMIC_SKIP_VERSION_CHECK=1` (`PI_SKIP_VERSION_CHECK=1`).
- **Offline mode:** `--offline` or `ATOMIC_OFFLINE=1` (`PI_OFFLINE=1`) disables all startup network requests (update checks, package update checks, version-adoption telemetry, and catalog refreshes).

### Network proxy

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `httpProxy` | string | - | HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY`. Global setting only. |

```json
{ "httpProxy": "http://127.0.0.1:7890" }
```

### Warnings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `warnings.anthropicExtraUsage` | boolean | `true` | Warn when Anthropic subscription auth may incur paid extra usage |

### Compaction

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `compaction.enabled` | boolean | `true` | Enable automatic compaction |
| `compaction.reserveTokens` | number | `16384` | Non-negative safe integer; triggers auto-compaction when usage exceeds `contextWindow - reserveTokens` |
| `compactionModel` | string | `"auto"` | `"auto"` / `""` clears context so the agent recovers from history; an exact registered compactor ID (such as `morph/morph-compactor`) compacts via that model. Saved chat/classifier IDs reset to `"auto"` on startup. See [Compaction model](/compaction#compaction-model). |

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

### Branch Summary

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved when selecting branch history for summary |
| `branchSummary.skipPrompt` | boolean | `false` | Skip the "Summarize branch?" prompt on `/tree` switches (defaults to no summary) |

### Session Summary

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `sessionSummary.enabled` | boolean | `true` | Generate one-line summaries for saved sessions in `/resume` when idle (skipped for `--no-session`) |

### Resume

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `resume.waitForBlueprint` | `"prompt"` \| `"tools"` | `"prompt"` (TUI) / `"tools"` (non-UI) | Controls whether restored worktree builds finish before opening (`"prompt"`) or run concurrently while gating tool calls (`"tools"`). See [Start the first turn while the build runs](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs). |
| `resume.cache` | array | unset | Extra entries for [`atomic blueprint cache-key`](/guides/resume-on-any-machine#caches-for-runners): `{ "paths": [...], "kind"?: "store" \| "build", "keyFiles"?: [...] }`. `"store"` paths are absolute/`~` outside the repo; `"build"` paths are repo-relative. Globs, `!` exclusions, and credential paths are refused with a warning. Project list replaces global. |
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
| `snapshots.graceSeconds` | number | `3600` | Protect snapshot data stored/reused within this window (`0` disables) |
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
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout (ms) |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK-level retries (leave `0` to let agent-level retry handle backoff) |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-hinted retry delay before failing fast (`0` disables cap; legacy `retry.maxDelayMs` migrates here) |

- **Server retry hints:** Honors `Retry-After-Ms`, `Retry-After`, Cloudflare 5xx `retry_after`, and Google `RetryInfo.retryDelay` up to `retry.provider.maxRetryDelayMs` (failing immediately if the server requests longer, e.g. a 5-hour quota reset). Covers OpenAI, OpenAI-compatible, Codex, Anthropic, Azure OpenAI, Mistral, Google/Vertex, and Bedrock. Cloudflare 520–524 and connection resets count as transient; non-retryable 4xx and quota errors fail immediately.
- **GitHub Copilot long cuts:** A stream cut after ≥5 minutes gets 1 retry; a second consecutive long cut switches to `fallbackModels` (or fails suggesting smaller steps / lower effort). See [GitHub Copilot errors](/providers#streams-cut-after-a-long-attempt).
- **SDK `retryDeadline`:** Pass `retryDeadline: performance.now() + budgetMs` (or `{ at, onExpired }`) alongside `signal` on provider requests or `retryAssistantCall()` to prevent starting backoff retries past a local process deadline (do not use `Date.now()`).

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

Applies to `fetch`, provider SDK HTTP clients, and the default total wall-clock budget for one [structured decision](/sdk/structured-decisions#cancellation-and-failures) (`structured_output`, `generateStructuredOutput()`, `decide()`). `/settings` presets: `30 sec` (`30000`), `1 min` (`60000`), `5 min` (`300000`), `10 min` (`600000`), `30 min` (`1800000`), `Disabled` (`"disabled"` / `0`).

### Message Delivery

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `steeringMode` | string | `"one-at-a-time"` | Steering message delivery: `"one-at-a-time"` or `"all"` |
| `followUpMode` | string | `"one-at-a-time"` | Follow-up message delivery: `"one-at-a-time"` or `"all"` |
| `transport` | string | `"auto"` | Multi-transport provider preference: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` (legacy boolean `websockets` migrates here) |
| `httpIdleTimeoutMs` | number or string | `600000` | HTTP idle timeout (ms, duration string, or `"disabled"`/`0`) |
| `websocketConnectTimeoutMs` | number or string | `15000` | WebSocket handshake timeout (ms, duration string, or `"disabled"`/`0`) |
| `streamDeadlineMs` | number or string | `300000` | Max idle gap between provider stream events below HTTP (ms, duration string like `30s`/`5m`/`1h`, or `"disabled"`/`0`). Cuts stalled streams for retry/fallback; Anthropic `ping` events reset the timer. |

### Terminal & Images

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `terminal.showImages` | boolean | `true` | Render inline images when supported |
| `terminal.imageWidthCells` | number | `60` | Inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear blank rows when content shrinks (fallback env: `ATOMIC_CLEAR_ON_SHRINK=1`) |
| `terminal.showTerminalProgress` | boolean | `false` | Show OSC 9;4 progress bar in terminal tab |
| `images.autoResize` | boolean | `true` | Resize images over 2000×2000 for `@file`, `read`, and tool results (runs after `tool_result` hooks; keeps original on error) |
| `images.blockImages` | boolean | `false` | Block all images from being sent to the model |
| `terminal.hyperlinks` | boolean or `"auto"` | `"auto"` | JSON-only override for OSC 8 hyperlink detection (env: `ATOMIC_HYPERLINKS=1\|0\|auto`) |
| `terminal.images` | `"kitty"`, `"iterm2"`, `"auto"`, or `false` | `"auto"` | JSON-only override for inline image protocol (env: `ATOMIC_IMAGE_PROTOCOL=kitty\|iterm2\|none\|auto`) |
| `terminal.trueColor` | boolean or `"auto"` | `"auto"` | JSON-only override for 24-bit color detection (env: `ATOMIC_TRUE_COLOR=1\|0\|auto`) |

Explicit JSON values for `terminal.hyperlinks`, `terminal.images`, and `terminal.trueColor` beat their `ATOMIC_*` / legacy `PI_*` env vars.

### Shell

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `shellPath` | string | - | Custom Bash path (does not change PowerShell used on native Windows `!`/`!!`) |
| `shellCommandPrefix` | string | - | Prefix prepended to shell commands (PowerShell syntax on native Windows interactive shells; Bash syntax elsewhere, e.g. `"shopt -s expand_aliases"`) |
| `search.contextBefore` | number | `1` | Context lines before each `search` match |
| `search.contextAfter` | number | `3` | Context lines after each `search` match |
| `npmCommand` | string[] | - | Command argv for npm lookup/install/uninstall and git-package dependency installs (runs plain `install` when set, e.g. `["mise", "exec", "node@20", "--", "npm"]`) |
| `selfUpdateCommand` | string[] | - | Command argv for `atomic update` using `{packageName}`, `{version}`, `{installSpec}` (`ATOMIC_SELF_UPDATE_COMMAND` overrides; **global settings only**; [Custom update command](/reference/cli#custom-update-command)) |

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
| `defaultTools` | string[] | - | Initial built-in tools: plain names replace defaults; `+name` / `-name` modify them |
| `codemode.mode` | `"on"` or `"only"` | `"on"` | `"on"` keeps direct tools declared alongside codemode; `"only"` hides ordinary direct tools so the model uses scripts (model-only tools stay top-level) |
| `codemode.inlineBudget` | number | `3000` | Estimated token budget for inline codemode tool declarations (`0` lists namespaces only; omitted tools remain discoverable via `searchTools()`) |

Built-in tool names include `read`, `bash`, `powershell`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`, `codemode`, `tool_search`, and `ls`.

```json
{ "defaultTools": ["bash", "edit", "write"] }
```

```json
{ "defaultTools": ["read", "powershell", "edit", "write"] }
```

```json
{ "defaultTools": ["-bash", "+ls"] }
```

- **Merging & modifiers:** Modifier-only arrays start from standard defaults (and project modifier-only arrays layer over global `defaultTools`). Plain names or `[]` replace the prior list (`[]` keeps extension/custom tools).
- **`codemode` & `tool_search`:** `codemode` is on by default (remove with `["-codemode"]`, or include explicitly in a replacement list); `tool_search` is opt-in (`["+tool_search"]`). See [codemode](/tools#codemode) and [tool search](/tools#tool_search).
- **CLI & `/reload`:** Plain `--tools` replaces the set as an allowlist; modifier-only `--tools` adjusts the resolved selection (including on `/reload`); `--no-tools`, `--no-builtin-tools`, and `--exclude-tools` always win. `/reload` adds newly enabled `defaultTools` without re-enabling tools you disabled mid-session.

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
| `storage` | object | Local SQLite | Shared storage default (sessions when `sessions.storage` is unset; in global settings also selects Intercom broker storage — [Running Intercom across machines](/intercom/operations#running-intercom-across-machines)). Same forms except `dir`. |

```json
{ "sessions": { "storage": { "path": "sessions.sqlite" } } }
```

- **Default:** `~/.atomic/workflows/journal.sqlite` (`session_` tables; under `<agentDir>/workflows/` when `ATOMIC_CODING_AGENT_DIR` is set unless it adopted a parent store — see [Storage home](/storage#storage-home)). JSONL is opt-in via `dir`, `--session-dir`, or `ATOMIC_CODING_AGENT_SESSION_DIR` (legacy `sessionDir` was removed).
- **Precedence:** SDK `sessionStore` → `--no-session` → `--session-dir` / `--session-store` → `--storage` / `--storage-file` → `ATOMIC_SESSIONS_STORAGE` / `ATOMIC_CODING_AGENT_SESSION_DIR` → `ATOMIC_STORAGE` → `sessions.storage` → `storage` → default SQLite. Project selections replace global objects whole (never merged); an explicit `{}` on `sessions.storage` picks default SQLite rather than inheriting `storage`. Relative paths in settings and JSON flags/env resolve from [storage home](/storage#storage-home); `--session-dir`, `--session-store`, and `ATOMIC_CODING_AGENT_SESSION_DIR` resolve from `cwd`.
- **Errors:** Only the winning setting (plus set `ATOMIC_STORAGE` / `ATOMIC_SESSIONS_STORAGE`) is validated; invalid config throws `StorageConfigError` (`source`, `field`, `reason`) and open failures throw typed errors—never silently falling back to memory. See [Choosing a store](/sessions#choosing-a-store), [Selecting storage per process](/storage#selecting-storage-per-process), and [Storage errors](/storage#storage-errors).

### Models

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `enabledModels` | string[] | - | Patterns for `Ctrl+P` model cycling (same syntax as `--models`; re-resolved after deferred extension loading). Independent of `fallbackModels`. |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"],
  "fallbackModels": ["anthropic/claude-opus-4-8:xhigh", "github-copilot/gpt-5.5:high"]
}
```

### Markdown

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |
| `markdown.mermaid` | string | `"streaming"` | Display-only Mermaid rendering: `"off"`, `"final"`, or `"streaming"` (invalid/oversized diagrams stay as code) |
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

Legacy `workflows` settings no longer run workflows—Atomic uses their paths only when you ask to [convert a workflow to a skill](/orchestration/migrating-workflows).

#### Storage adapters

Install an adapter [Atomic package](/storage#adapters-from-atomic-packages) (or pass its directory via `--extension` / SDK `additionalExtensionPaths`, which beats settings) and reference it in `storage` or `sessions.storage`:

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
- Adapter modules execute code—review them before trusting project settings. See [Storage adapters](/storage#selecting-an-adapter).

#### packages

Load all resources with a string entry, or filter specific resources with an object entry (`"autoload": false` disables discovery and applies only explicit patterns):

```json
{
  "packages": [
    "pi-skills",
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
