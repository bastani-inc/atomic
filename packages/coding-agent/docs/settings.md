---
title: "Settings"
sidebarTitle: "Settings"
description: "Reference for every option in global and project settings.json files, including model scoping, fallbacks, retries, tools, and storage."
---

Atomic reads JSON settings from two scopes, with trusted project settings overriding global settings:

| Location | Scope |
| --- | --- |
| `~/.atomic/agent/settings.json` | Global (all projects; legacy `~/.pi/agent/settings.json` is a fallback) |
| `.atomic/settings.json` | Project override (requires project trust; legacy `.pi/settings.json` is a fallback) |

Edit these files directly or run `/settings` to change common options interactively. For a starter file and project-override walkthrough, see [Configure Atomic](/guides/configuration). For programmatic access through `SettingsManager` and `createAgentSession()`, see [SDK](/sdk) and [Settings management](/sdk/reference#settings-management).

## How settings load and save

- **Strict JSON and syntax errors.** `settings.json` must be valid JSON (no `//` comments or trailing commas; leading UTF-8 BOMs are stripped). If a file has a JSON syntax error, Atomic warns, uses defaults for that scope, and stops writing to that scope so your file is never overwritten.
- **Automatic startup defaults.** Interactive model or thinking switches (`/model`, `/thinking`, or cycling shortcuts) save `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, and `modelThinkingLevels`. `/scoped-models` saves `enabledModels`. SDK calls, session restores, and automatic fallbacks do not overwrite saved defaults unless you request it.
- **Editor schema and safe merges.** Add `"$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/settings.schema.json"` for editor completion and validation. Atomic preserves `$schema`, unknown keys (such as extension settings like `subagents.agentOverrides`), symlinks, and concurrent external edits. Saving writes only changed fields to `.atomic` (and only changed keys inside object settings such as `modelThinkingLevels`).
- **Scope merging and legacy `.pi` files.** Within one scope, `.atomic` overrides `.pi` per file, so legacy `queueMode` in `.atomic` beats `steeringMode` in `.pi`, and setting an array to `[]` in `.atomic` clears the `.pi` array in that scope. Across global and project scopes, `packages`, `extensions`, `skills`, `prompts`, and `themes` combine rather than replace; setting `"packages": []` in `.atomic/settings.json` clears only a legacy `.pi/settings.json` in that project, not global `~/.atomic/agent/settings.json`. Non-resource arrays (`enabledModels`, `fallbackModels`, `npmCommand`, `resume.cache`) replace the global array. Legacy `skills` objects (`{ "enableSkillCommands": ..., "customDirectories": [...] }`) migrate automatically on load.

<Note>
**Validation and invalid values.** Load-time type checks validate **top-level keys and top-level list entries** (plus deprecated `skills` object fields), ignoring wrong-typed values with a one-time warning without rewriting your file. Wrong-typed fields nested inside object settings (such as `retry.maxRetries`, `compaction.enabled`, `terminal.showImages`, or `search.contextBefore`) do not emit a load-time warning and either fall back to defaults or pass through the setting reader—use `$schema` in your editor to catch nested mistakes.

A few settings fail strictly instead of falling back:

- **Startup or `/reload`:** invalid `httpIdleTimeoutMs`, or an invalid active `storage` or `sessions.storage` selection.
- **First model request:** invalid `websocketConnectTimeoutMs` or `streamDeadlineMs`.
- **When the feature runs:** an invalid `snapshots` block (except `snapshots.pool.maxIdlePerRepository`, which falls back to `2`); a negative or non-integer `compaction.reserveTokens`; an invalid `decisionModel` (wrong type, whitespace-padded string, unregistered ID, bare ID without `provider/`, image model, or compactor model—`/settings` shows unavailable IDs without failing); or a non-string `compactionModel`.

For programmatic error classes, see [SDK reference](/sdk/reference).
</Note>

## Project trust

Project settings in `.atomic/settings.json` (and legacy `.pi/settings.json`) load only when the project is trusted:

- Interactive sessions prompt once before trusting a project with trust-gated files and save decisions in `~/.atomic/agent/trust.json` (manage them with `/trust`).
- Non-interactive modes (`-p`, `--mode json`, `--mode rpc`) never prompt; they follow global `defaultProjectTrust` (`"ask"` and `"never"` ignore project settings; `"always"` trusts them). Override for one run with `--approve`/`-a` or `--no-approve`/`-na`.
- Eligible interactive starts open the [early editor](/usage#startup-typing) immediately while non-trust-gated resources load; trust-gated resources always wait for authorization.

See [Project trust](/security#project-trust) for the full list of trust-gated inputs and saved-decision behavior.

## Models and thinking

See [Choose a model](/models/choose-a-model) for everyday model selection, [Model providers](/providers) for credentials, and [Configure custom models](/models) for custom endpoints and overrides.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultProvider` | string | unset | Startup provider, saved automatically on interactive model switch |
| `defaultModel` | string | unset | Startup model ID, saved automatically on interactive model switch |
| `enabledModels` | string[] | unset | Model patterns that restrict the startup model, `Ctrl+P` cycling, `/model`, and subagent models. Fast and Ultrafast versions have their own model IDs, so patterns must match them too. See [Model scope (`enabledModels`)](#enabledmodels) |
| `fallbackModels` | string[] | unset | Ordered main-chat fallback chain (`provider/model` with optional `:effort` suffix). See [`fallbackModels`](#fallbackmodels) |
| `decisionModel` | string | `""` | Model for `structured_output` (when omitted) and `decide()`: exact `provider/model` (chat or classifier), or `""`/`"auto"` for the current chat model. See [`decisionModel`](#decisionmodel) |
| `defaultThinkingLevel` | string | unset | Startup thinking level (`"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`), clamped to model support |
| `modelThinkingLevels` | object | unset | Per-model startup thinking levels keyed by `"provider/modelId"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | unset | Custom token budgets per thinking level (native on Anthropic, Google, and Bedrock; OpenAI-compatible when `compat.thinkingTokenBudgetField` or `supportsThinkingTokenBudget` is set) |
| `showCacheMissNotices` | boolean | `false` | Show notices for significant prompt-cache misses, billed compaction or branch summaries, and provider recovery diagnostics (such as dropped Anthropic thinking blocks), including on resume |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"idle"` | Keep eligible prompt caches warm during runs (`"streaming"`, up to 60 min after the starting request) or up to 30 min between runs (`"idle"`). `"off"` disables. Refreshes incur provider cost. Global setting only |

- **Cache warming.** Runs only when the model declares `promptCache` (`short` and/or `long` TTLs in seconds in [`models.json`](/models-configuration)) and the request uses a retention tier with a configured TTL. A refresh is sent only when expected savings (`continuationProbability * missCost - warmCost`) are at least **$0.05**, where `continuationProbability` is `1.0` while streaming and `0.15` (15%) while idle, `missCost` is the extra cost of a cache miss over a cache hit, and `warmCost` is one cache read plus one output token. Warming is disabled for Anthropic models without adaptive thinking (`compat.forceAdaptiveThinking: true`) whenever thinking is enabled (such as Claude 4.5 Haiku, Sonnet, and Opus), because replaying with a 1-token output cap changes Anthropic's thinking-budget cache key. Refreshes are recorded in usage, never added to context, and can be intercepted by extensions via `cache_warming_decision`.
- **Fast and Ultrafast models.** Fast and Ultrafast tiers are selected using their canonical `<model-id>-fast` and `<model-id>-ultrafast` IDs anywhere models are configured (`/model`, `enabledModels`, `fallbackModels`, and subagents)—not via a separate setting. Reasoning suffixes work normally (for example `openai-codex/gpt-5.6-sol-fast:medium`), and standard, fast, and ultrafast IDs act as separate candidates. See [Fast models](/providers#fast-models).
- **Compaction model (`compactionModel`).** Configured under [Compaction](#compaction) (default `""`/`"auto"` for memory compaction, or a registered compactor ID such as `morph/morph-compactor`). See [Custom compaction models](/compaction/custom-compactors).
- **Unsupported saved default provider.** If `defaultProvider` and `defaultModel` name a provider still unsupported after extensions load, Atomic does not switch providers silently. Interactive mode warns, print and JSON modes warn on stderr and exit nonzero (stdout stays valid JSONL), and RPC rejects `prompt` until an explicit model switch succeeds. If the provider is supported but the model is unknown or unauthenticated, normal auto-selection applies.
- **Subagents (`model: "auto"`).** Subagents use `defaultProvider`/`defaultModel` when authenticated (at agent `thinking`, else `modelThinkingLevels`, else `defaultThinkingLevel`, else `medium`), falling back to the launching session's model. When `enabledModels` or `--models` is active, subagent model selection must stay inside that scope. Built-in agent overrides live under `subagents.agentOverrides`; see [Subagent reference](/subagents/reference#automatic-model-selection).

### Model scope (enabledModels) {#enabledmodels}

`enabledModels` (and the one-run CLI flag `--models`) restricts the active set of authenticated models for a session. Omit it or set `[]` to leave every authenticated model active.

```json
{
  "enabledModels": [
    "anthropic/claude-opus-5:high",
    "openai-codex/gpt-6*",
    "qwen/qwen3-coder:exacto"
  ]
}
```

#### How patterns match

Atomic resolves `enabledModels` and `--models` patterns against **authenticated, available models only** (including models registered by extensions once they finish loading). Each pattern is evaluated in three steps:

1. **Exact unmodified match first.** Checks for a case-insensitive exact match against `provider/id` or bare `id` before interpreting `:thinking` suffixes or glob characters. Literal catalog IDs containing colons or brackets (such as `qwen/qwen3-coder:exacto` or `provider/model[1m]`) match directly.
2. **Glob patterns (`*`, `?`, `[`).** If the pattern contains glob characters and did not match verbatim, Atomic strips any valid trailing `:thinking` suffix (`:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, or `:max`, case-insensitive), checks for an exact match on the base ID (so `provider/model[1m]:high` matches literally), and otherwise runs case-insensitive glob matching against both `provider/id` and bare `id`.
3. **Fuzzy substring match (non-globs).** If the pattern has no glob characters and did not match verbatim, Atomic checks for a trailing `:thinking` suffix (invalid suffixes warn and are dropped), then matches the remaining text as a case-insensitive substring against `model.id` or `model.name`. Among multiple matches, non-dated aliases beat dated `YYYYMMDD` IDs, and reverse-alphabetical order prefers newer versions.

Additional matching rules:

- **Provider-qualified vs. bare IDs.** Use `provider/id` to pin a single provider. A bare ID or pattern matching multiple authenticated providers adds **every** matching provider to the scope.
- **Fast and Ultrafast IDs.** Fast and Ultrafast versions have distinct IDs ending in `-fast` or `-ultrafast`, and a `*` in the provider part does not match into the model ID. `"openai-*/gpt-6.2-sol"` matches standard models only; use `"openai-*/gpt-6.2-sol*"` or list each ID explicitly to include faster tiers. Patterns never add a version the provider does not offer.
- **Order, deduplication, and project overrides.** Results keep pattern order and deduplicate `(provider, id)` while preserving the first `:thinking` suffix. Setting `"enabledModels": []` in `.atomic/settings.json` clears a global scope for that project.

#### What `enabledModels` controls

- **New-session startup model.** Without `--model`, `--continue`, or `--resume`, Atomic starts on `defaultProvider`/`defaultModel` if it is in scope (applying the scope entry's `:thinking` suffix unless `--thinking` overrides it), or on the **first matched model** in `enabledModels` otherwise.
- **`Ctrl+P` cycling and `/model`.** `Ctrl+P` cycles only through scoped models in order. `/model` opens filtered to scoped models (`Tab` toggles scoped vs. all models; `←`/`→` adjusts thinking effort before selecting). Direct `/model <name>` searches only scoped models.
- **Subagent allowlist.** Child subagents inherit the active `enabledModels` / `--models` scope. Any subagent start model (`model: "auto"`, agent frontmatter, or per-call override) or child fallback outside scope is rejected. When a requested Fast or Ultrafast ID is out of scope while its base model is in scope, the error names the exact ID to add to `enabledModels`. If patterns match zero available models, subagent launches fail instead of widening to all models. Nonexistent catalog IDs report `no such model in the catalog.` instead of a scope error.
- **Main-chat fallbacks stay independent.** Main-chat `fallbackModels` is independent of `enabledModels`, so you can keep an out-of-scope emergency fallback for main chat while child subagent fallback chains remain bound by `enabledModels`.
- **Extensions and SDK.** Extensions read the resolved scope via [`ctx.scopedModels`](/extensions/api-reference#ctx-modelregistry-ctx-model-ctx-scopedmodels), and SDK hosts can resolve patterns with `resolveModelScopeFromModels()` ([Resolving scoped models](/sdk/reference#resolving-scoped-models)).

#### Side effects from `/model` and `/scoped-models`

- **Picking an out-of-scope model in `/model`:** Pressing `Tab` and picking a model outside scope adds it to the active session's scope. If global `settings.json` already has a non-empty `enabledModels` list, Atomic also appends `"provider/id"` to global `enabledModels` and saves it (project-only or `--models` scopes do not create a global list).
- **Editing in `/scoped-models`:** Every toggle, reorder, enable-all, or clear-all saves immediately to **global** `settings.json` as explicit `provider/id` entries, replacing hand-written globs and `:thinking` suffixes. Unmatched patterns remain visible as unavailable rows until unchecked.
- **Enabling or clearing all in `/scoped-models`:** Enabling every available model removes `enabledModels`. Clearing all saves `"enabledModels": []` and unscopes the active session.

#### Model-matching comparison

See [CLI model options](/reference/cli#model-options) for CLI flag precedence.

| Mechanism | Matching rules | Globs | Fuzzy | `:thinking` suffix | Ambiguous bare ID |
| --- | --- | --- | --- | --- | --- |
| `enabledModels` / `--models` | Exact, then glob, then fuzzy (authenticated models only) | Yes | Yes | Lenient (invalid warns and drops) | Adds all matching authenticated providers |
| `fallbackModels` / `--fallback-models` | Exact, then fuzzy (skips unauthenticated at runtime) | No | Yes | Strict (invalid fails match) | Prefers current or default provider; else skips |
| `--model` (CLI) | Exact, then fuzzy (all models; synthesizes unknown ID if provider known) | No | Yes | Strict (invalid kept literally) | Breaks tie by sole authenticated provider; else errors |
| `/model <name>` | Exact `provider/id` or bare `id` (scoped models when scoped; opens picker on miss) | No | No | No (use `←`/`→` or `/thinking`) | Opens picker instead of switching |
| `defaultProvider` + `defaultModel` | Exact ID lookup (`provider` normalized) | No | No | No (uses `modelThinkingLevels` / `defaultThinkingLevel`) | Not applicable (both required) |
| `decisionModel` | Exact case-sensitive `provider/model` (classifiers before chat models) | No | No | No | Not applicable (`provider/model` required) |
| `compactionModel` | Exact case-sensitive `provider/model` (registered compactors only) | No | No | No | Not applicable (`provider/model` required) |

### fallbackModels

Ordered fallback chain for main-chat turns when the active model fails:

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

- **Entry format and matching.** Use `provider/model` (preferred; bare IDs and fuzzy substrings also match, and exact unmodified IDs containing `/` or `:` such as `qwen/qwen3-coder:exacto` match first) with an optional case-insensitive `:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, or `:max` suffix (clamped to model support). Run `atomic --list-models` for IDs. Invalid `:thinking` suffixes or unmatched entries warn once after extensions load and are skipped. Ambiguous bare IDs prefer the current or default provider and skip if neither matches.
- **Thinking level without a suffix.** Uses `defaultThinkingLevel`, else the current session's thinking level, else `"medium"`, clamped to model support (`modelThinkingLevels` is not consulted during fallback).
- **CLI precedence.** `--model` runs strictly as named and falls back only to `--fallback-models`, ignoring settings `fallbackModels`. `--no-fallback` disables fallback for one run, and `--fallback-models` replaces this list for one run. Press `Esc` during a retry wait or model switch to cancel. See [CLI model options](/reference/cli#model-options).
- **What retries vs. falls back.** Fallback eligibility is broader than same-model retry eligibility:
  - **Retry same model, then fall back:** rate limits, transient server or network errors, timeouts, degenerate empty completions (no content and zero output tokens), and provider-intercepted zero-output canned safety refusals. Unrecognized errors (no status, code, or recognized message pattern) are retried on the same model first only when `fallbackModels` is configured, so a single unrecognized failure does not immediately switch models.
  - **Skip same-model retry and fall back immediately:** authentication failures (HTTP 401/403, Codex token invalidation), unavailable models, incompatible requests, refused TLS certificates (each fallback is tried once), quota exhaustion (`The usage limit has been reached`), and content-filter refusals (such as OpenAI HTTP 422 `cyber_policy`, Anthropic refusal, or `content_filter`, unless `retry.fallbackOnContentFilter: false` is set to retry on the same model instead).
  - **Context overflow:** compacts first, and falls back only if compaction is off, fails, or does not clear the overflow.
  - **Never falls back:** `Esc` cancellations and non-fallbackable task errors. With `retry.enabled: false`, retryable errors advance immediately.
- **Skipping broken providers or models during a turn.** Unauthenticated providers are skipped before sending a request (if none have credentials, Atomic fails immediately and lists the missing providers). Rejected credentials (HTTP 401, `invalid_api_key`, `authentication_error`) exclude that provider for the rest of the turn; model-scoped HTTP 403 or incompatible-request errors exclude only that model across all reasoning suffixes.
- **Persistence, print output, and billing.** Once a fallback runs, it stays active for later turns (keeping thinking-level changes) until you switch via `/model` or model cycling. In print mode (`-p`), fallback notices and the final `Model: ran on <fallback>, not the requested <model>.` line go to **stderr** so stdout stays clean. Because switching providers changes billing and data-handling terms, list only approved providers.

### decisionModel

```json
{ "decisionModel": "" }
```

Selects the model used for `structured_output` calls (when no explicit `model` is passed; classifiers answer finite `Choice` schemas, otherwise Atomic tries `fallbackModels` and then the current chat model) and extension [`decide()`](/sdk/structured-decisions#decide) calls. It never changes your chat model or subagent execution model.

- **Configure.** Set in JSON, open `/settings` and choose **Decision model** (updates project override if present, otherwise global), or update via SDK/RPC—changes made through `/settings`, the SDK, or RPC take effect immediately without `/reload`. `""` or `"auto"` uses the current chat model; pinning a model requires an exact case-sensitive `provider/model` of a registered classifier (such as `typesafe/jev-latest`, `vercel-ai-gateway/typesafe-ai/jev`, `opencode/jev-1.13`, or `opencode/jev-1.13-free`) or chat model (classifiers are checked before chat models). Run `/reload` only after editing `settings.json` externally.
- **Validation and runtime fallback.** A wrong JSON type or whitespace-padded string fails with an error when `decide()`, `structured_output`, or `/settings` reads `decisionModel`. An unregistered ID, bare ID without `provider/`, image model, or compactor model fails with an error during `decide()` or `structured_output` with no explicit `model` instead of falling back (`/settings` shows it as unavailable without failing). Once a registered classifier is selected, runtime failures (missing credentials, context error, refusal, or malformed output) fall back silently to the current chat model and log in [debug mode](#debug-mode). Chat models get 1 initial attempt plus 3 repair retries within [`httpIdleTimeoutMs`](#http). Cancellation does not fall back.
- **Credentials, cost, and legacy migration.** Authenticate a pinned classifier with its provider login (for example `/login typesafe` or `TYPESAFE_API_KEY`); classifiers do not appear in `/model`. An explicit `""` in project settings overrides a global selection. Valid legacy `routerModel` values migrate automatically when `decisionModel` is absent without rewriting the file; removed `modelRouting` and built-in override `modelConstraints`/`taskNeeds` keys are cleaned up automatically on startup with a one-time notice.

See [Structured decisions](/sdk/structured-decisions), [Classifier models](/models#use-classifier-models), [Local classification](/llama-cpp#classification), and [TypeSafe Jev](/providers#typesafe-jev).

### thinkingBudgets

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

Changes apply to new sessions. Resumed sessions keep the budget last used on the same model and thinking level so the provider does not re-bill the cached conversation; switching models or thinking levels applies the new setting.

## Interface and display

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `theme` | string | Auto-detected (`"dark"` or `"light"`) | `"dark"`, `"light"`, `"system"` (terminal-derived palette), Catppuccin built-in, custom theme name, or `"lightTheme/darkTheme"` pair in interactive mode to follow terminal appearance. When unset, Atomic detects terminal dark/light mode (`OSC 11` or `COLORFGBG`) and falls back to `"dark"`. Malformed values with extra `/` or an empty side fall back to the detected default. See [Themes](/themes) |
| `fullscreenScrollbar` | string | `"auto"` | `"auto"` (show while scrolling), `"always"` (reserved right column), or `"hidden"`. Draggable in the main chat; also shown when viewing a subagent or shell output (not draggable) |
| `fullscreenExitOutput` | string | `"transcript"` | `"transcript"` prints the final transcript and resume hint on exit; `"resume-hint"` restores the previous screen and prints only the resume hint. Configurable in `/settings` |
| `fullscreenCopyOnSelect` | boolean | `true` | Auto-copy text selection on mouse release (`false` highlights only; `/copy` copies the last assistant message). Configurable in `/settings` |
| `fullscreenWheelScrollLines` | `"auto"` or number | `"auto"` | Lines per wheel tick in the main chat, viewed subagent transcripts, and shell output (`"auto"` or `1` to `100`). Configurable in `/settings` |
| `quietStartup` | boolean or `"header"` | `false` | `true` hides the startup header and all startup details; `"header"` keeps the startup header while suppressing loaded resource listings, legacy workflow notices, and the model scope line. `--verbose` overrides both |
| `defaultProjectTrust` | string | `"ask"` | Fallback project trust (`"ask"`, `"always"`, `"never"`). Global setting only |
| `collapseChangelog` | boolean | `false` | Show a one-line update notice instead of What's New highlights (`/changelog` shows full history) |
| `doubleEscapeAction` | string | `"tree"` | Double-Esc action on an empty idle editor: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default `/tree` filter: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal input editor padding (`0` to `3`; clamped on save via `/settings` or SDK setters) |
| `outputPad` | number | `1` | Horizontal transcript padding (`0` or `1`) |
| `externalEditor` | string | unset | Command for `Ctrl+G` external editor (overrides `$VISUAL` and `$EDITOR`; defaults to Notepad on Windows, `nano` elsewhere) |
| `autocompleteMaxVisible` | number | `5` | Max visible autocomplete items (`3` to `20`; clamped on save via `/settings` or SDK setters) |
| `showHardwareCursor` | boolean | `false` | Use hardware terminal cursor instead of drawn cursor (still positioned for IME; falls back to `ATOMIC_HARDWARE_CURSOR=1` or legacy `PI_HARDWARE_CURSOR=1` when unset) |

Interactive mode runs fullscreen with stacked transient notices; closing an overlay clears text selection inside it. `Ctrl+G` checks `externalEditor`, `$VISUAL`, `$EDITOR`, then Notepad (Windows) or `nano` (POSIX) in main chat, embedded chat, and extension dialogs; saving empty clears text, while an editor error preserves the original text.

### Terminal and images

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

### Markdown

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |
| `markdown.mermaid` | string | `"streaming"` | Display-only Mermaid rendering: `"off"`, `"final"`, or `"streaming"` (invalid or oversized diagrams stay as code) |
| `markdown.latex` | boolean | `true` | Display-only Unicode math rendering (supports whitespace and matrix layouts; stored messages keep source Markdown) |

### Warnings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `warnings.anthropicExtraUsage` | boolean | `true` | Warn when Anthropic subscription auth may incur paid extra usage |

### Managed state keys

<Note>
Atomic writes these keys automatically in global `settings.json`. Leave them unchanged unless troubleshooting.
</Note>

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `firstRunOnboardingStartedVersion` | string | unset | Version when first-run onboarding started |
| `onboardedVersion` | string | unset | Version when onboarding completed |
| `lastChangelogVersion` | string | unset | Most recent version whose changelog notice was displayed |
| `enableAnalytics` | boolean | `false` | Opt-in flag saved during first-run setup (storage only; Atomic does not transmit analytics) |
| `trackingId` | string | unset | Locally generated analytics ID when `enableAnalytics` is enabled |
| `deviceId` | string | unset | Global install ID created when a provider sign-in needs one (project values ignored) |

## Message delivery

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `steeringMode` | string | `"one-at-a-time"` | Steering message delivery: `"one-at-a-time"` or `"all"` |
| `followUpMode` | string | `"one-at-a-time"` | Follow-up message delivery: `"one-at-a-time"` or `"all"` |
| `transport` | string | `"auto"` | Multi-transport provider preference: `"auto"`, `"websocket-cached"`, `"websocket"`, or `"sse"` (legacy boolean `websockets` migrates here) |
| `websocketConnectTimeoutMs` | number or string | `15000` | WebSocket handshake timeout (ms, duration string, or `"disabled"`/`0`) |
| `streamDeadlineMs` | number or string | `300000` | Max idle gap between provider stream events below HTTP (ms, duration string like `"30s"`, `"5m"`, `"1h"`, or `"disabled"`/`0`). Cuts stalled streams for retry or fallback; Anthropic `ping` events reset the timer |

How `transport` modes work on providers that support both WebSocket and SSE (such as OpenAI Codex):

- `"auto"` (default) and `"websocket-cached"`: use WebSocket with connection-scoped continuation (`previous_response_id`, 5-minute idle cache TTL, 55-minute max connection age), falling back to SSE for the rest of the session if WebSocket fails before streaming starts.
- `"websocket"`: use WebSocket without cached continuation (sends the full request body every turn), still falling back to SSE on pre-stream failures.
- `"sse"`: disable WebSocket and always stream over SSE (with zstd request-body compression on Codex).

For the global HTTP idle timeout, see [HTTP](#http) (`httpIdleTimeoutMs`).

## Compaction

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `compaction.enabled` | boolean | `true` | Enable automatic compaction |
| `compaction.reserveTokens` | number | `16384` | Non-negative safe integer; triggers auto-compaction when usage exceeds `contextWindow - reserveTokens` |
| `compactionModel` | string | `""` | `""` or `"auto"` uses [memory compaction](/compaction/memory-compaction); an exact case-sensitive registered compactor ID (such as `morph/morph-compactor`) sends context to that model. See [Custom compaction models](/compaction/custom-compactors) |

```json
{
  "compactionModel": "auto",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384
  }
}
```

- Selecting **Compaction model** in `/settings` updates the project override if one exists, otherwise global (saving `""` for Automatic), and takes effect immediately without `/reload`.
- Leading or trailing whitespace in `settings.json` is trimmed on read; non-string values fail with an error instead of falling back. Saved non-compactor IDs (chat, classifier, or image) reset to `"auto"` on startup, while unknown string IDs stay in the file and fall back to memory compaction with a notice.
- Removed legacy compaction keys (`compression_ratio`, `preserve_recent`, `keepContextShare`, `query`, `planningTimeoutMs`, `modelOverrides`, `background`, `backgroundThresholdPercent`, `historyRecall`) are ignored silently. See [Compaction](/compaction) and [Compactor request contract](/compaction/reference#compactor-request-contract).

### Branch summary

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved when selecting branch history for summary |
| `branchSummary.skipPrompt` | boolean | `false` | Skip the "Summarize branch?" prompt on `/tree` switches (defaults to no summary) |

### Session summary

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `sessionSummary.enabled` | boolean | `true` | Generate one-line summaries for saved sessions in `/resume` when idle (runs in interactive and RPC modes; skipped for `--no-session`, print mode `-p`, `--mode json`, and internal sessions) |

## Retry

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `retry.enabled` | boolean | `true` | Enable agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base exponential backoff delay (2s, 4s, 8s) |
| `retry.maxAgentDelayMs` | number | `60000` | Cap on agent-level backoff (`0` retries immediately) |
| `retry.fallbackOnContentFilter` | boolean | `true` | Advance to next `fallbackModels` entry on content-filter refusals (such as OpenAI HTTP 422 `cyber_policy`); `false` retries on the same model |
| `retry.provider.timeoutMs` | number | `httpIdleTimeoutMs` | Per-request provider timeout in ms. Defaults to `httpIdleTimeoutMs` (10 min by default, or `2147483647` ms when `httpIdleTimeoutMs` is `0`/`"disabled"`). Passing `0` explicitly times out immediately |
| `retry.provider.maxRetries` | number | unset | Provider client retries. Most providers default to `0` so agent-level retry controls backoff; Amazon Bedrock keeps AWS SDK defaults when unset, and classifier APIs default to `2` |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-hinted retry delay before failing fast (`0` disables cap; legacy `retry.maxDelayMs` migrates here) |

<Warning>
Do not set `retry.provider.timeoutMs` to `0` to disable timeouts—an explicit `0` is passed straight to provider clients and times out immediately. Leave `retry.provider.timeoutMs` unset and set `httpIdleTimeoutMs` to `0` or `"disabled"` instead.
</Warning>

- **Server retry hints.** Atomic honors `Retry-After-Ms`, `Retry-After`, Cloudflare 5xx `retry_after`, and Google `RetryInfo.retryDelay` up to `retry.provider.maxRetryDelayMs`, failing immediately if the server asks for longer (such as a 5-hour quota reset). This applies across OpenAI, OpenAI-compatible, Codex, Anthropic, Azure OpenAI, Mistral, Google, Vertex, and Bedrock. Cloudflare 520 to 524 and connection resets count as transient; non-retryable 4xx and quota errors fail immediately.
- **Refused TLS certificates.** Untrusted certificates (such as a self-signed certificate or corporate TLS proxy) are never retried. The error names the host, the error code (such as `SELF_SIGNED_CERT_IN_CHAIN`), and how to trust a private CA with [`NODE_EXTRA_CA_CERTS`](/environment-variables#tls-certificates). Connection resets during TLS handshakes still retry.
- **GitHub Copilot long cuts.** A stream cut after 5 minutes or more gets 1 retry; a second consecutive long cut switches to `fallbackModels` or fails with guidance. See [Streams cut after a long attempt](/providers#streams-cut-after-a-long-attempt).
- **SDK retry deadlines.** Programmatic callers can pass a monotonic `retryDeadline` with `signal` on provider requests to avoid starting backoff past a local budget; see [Custom provider streaming](/custom-provider/streaming).

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "maxAgentDelayMs": 60000,
    "provider": {
      "timeoutMs": 600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

## Tools

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultTools` | string[] | unset | Initial built-in tools: plain names replace defaults; `+name` and `-name` modify them |
| `codemode.mode` | `"on" \| "only"` | `"on"` | `"on"` keeps direct tools declared alongside codemode; `"only"` hides ordinary direct tools so the model uses scripts (model-only tools stay top-level) |
| `codemode.inlineBudget` | number | `3000` | Estimated token budget for inline codemode tool declarations (`0` lists namespaces only; omitted tools remain discoverable via `searchTools()`) |

Built-in tool names include `read`, `bash`, `powershell`, `kill`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`, `codemode`, `tool_search`, and `ls`.

```json
{ "defaultTools": ["bash", "edit", "write"] }
```

```json
{ "defaultTools": ["-bash", "+ls"] }
```

- **Merging and modifiers.** Modifier-only arrays start from standard defaults (project modifier-only arrays layer over global `defaultTools`). Plain names or `[]` replace the prior list (`[]` keeps extension and custom tools).
- **`codemode` and `tool_search`.** `codemode` is on by default (remove with `["-codemode"]`, or include explicitly in a replacement list); `tool_search` is opt-in (`["+tool_search"]`). See [codemode](/tools#codemode) and [tool search](/tools#tool_search).
- **CLI and `/reload`.** Plain `--tools` replaces the set as an allowlist; modifier-only `--tools` adjusts the resolved selection (including on `/reload`). `--no-tools` disables every tool even with an allowlist or modifiers. `--no-builtin-tools` suppresses coding defaults only when no allowlist is given. `--exclude-tools` filters the result. `/reload` adds newly enabled `defaultTools` without re-enabling tools disabled mid-session.

## Shell

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `shellPath` | string | unset | Custom Bash path or bare executable name. A bare name such as `bash` is looked up in absolute `PATH` directories; a path supports leading `~` expansion (`~/...` or `~\...` on Windows) and fails if missing. Does not change PowerShell used on native Windows `!` and `!!` |
| `shellCommandPrefix` | string | unset | Prefix prepended to every model `bash` tool call and interactive `!`/`!!` command (for example `"shopt -s expand_aliases"`). Leave unset on native Windows unless one side is disabled—`bash` runs Bash while `!`/`!!` runs PowerShell. See [Shell aliases](/shell-aliases) |
| `search.contextBefore` | number | `1` | Context lines before each `search` match |
| `search.contextAfter` | number | `3` | Context lines after each `search` match |
| `npmCommand` | string[] | unset | Command argv for npm lookup, install, uninstall, and git-package dependency installs (runs plain `install` when set, for example `["mise", "exec", "node@20", "--", "npm"]`). `atomic update` reads `npmCommand` from global settings only |
| `selfUpdateCommand` | string[] | unset | Command argv for `atomic update` using `{packageName}`, `{version}`, and `{installSpec}` (`ATOMIC_SELF_UPDATE_COMMAND` overrides; global settings only; [Custom update command](/reference/cli#custom-update-command)) |

<Warning>
**Native Windows and `shellCommandPrefix`:** On native Windows, Atomic prepends `shellCommandPrefix` to **both** model `bash` tool calls (which run in Bash) and interactive `!`/`!!` commands (which run in PowerShell), while the model `powershell` tool ignores it. PowerShell syntax breaks every `bash` tool call, and Bash syntax breaks every `!`/`!!` command. Leave `shellCommandPrefix` unset on native Windows unless one side is disabled (inside WSL, both run in Bash).
</Warning>

On Windows, write JSON paths with forward slashes or escaped backslashes:

```json
{ "shellPath": "C:/Program Files/Git/bin/bash.exe" }
```

```json
{ "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe" }
```

## Tasks

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `tasks.heartbeatMs` | number | `900000` | Task heartbeat interval in ms (`0` disables; minimum `60000`; invalid values fall back to default; per-call `heartbeatMs` overrides). See [Heartbeat sampling and batching](/background-tasks/reference#heartbeat-sampling-and-batching) |
| `tasks.heartbeatWakesIdleSession` | boolean | `true` | Wake an Esc-interrupted idle session immediately on heartbeat (`false` waits for your next message) |

```json
{ "tasks": { "heartbeatMs": 1800000 } }
```

## Sessions

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `sessions.storage` | object | Local SQLite | Session-only store: `{ "path": "...", "prefix"?: "..." }`, `{ "dir": "..." }` (JSONL; no `prefix`), `{ "memory": true }`, or `{ "adapter": "...", "options"?: {}, "secrets"?: {}, "prefix"?: "..." }` |
| `storage` | object | Local SQLite | Shared storage default (sessions when `sessions.storage` is unset; in global settings also selects Intercom broker storage, see [Running Intercom across machines](/intercom/operations#running-intercom-across-machines)). Same forms except `dir` |

```json
{ "sessions": { "storage": { "path": "sessions.sqlite", "prefix": "work_" } } }
```

- **Default.** `~/.atomic/workflows/journal.sqlite` (`session_` tables; under `<agentDir>/workflows/` when `ATOMIC_CODING_AGENT_DIR` is set unless it adopted a parent store; see [Storage home](/storage#storage-home)). JSONL is opt-in via `dir`, `--session-dir`, or `ATOMIC_CODING_AGENT_SESSION_DIR`. Optional `prefix` namespaces SQLite and adapter tables inside a shared database (accepted by the schema on `{ "memory": true }` as well, though ignored by in-memory stores).
- **Precedence.** Highest to lowest: SDK `sessionStore`, SDK `storage` ([SDK storage](/sdk/storage)), `--no-session` / `--session-dir` / `--session-store`, `--storage` / `--storage-file`, `ATOMIC_SESSIONS_STORAGE` / `ATOMIC_CODING_AGENT_SESSION_DIR`, `ATOMIC_STORAGE`, `sessions.storage`, `storage`, and default SQLite. Project selections replace global objects whole rather than merging; an explicit `{}` on `sessions.storage` selects default SQLite rather than inheriting `storage`. Relative paths in settings, JSON flags, and JSON env vars resolve from [storage home](/storage#storage-home); `--session-dir`, `--session-store`, and `ATOMIC_CODING_AGENT_SESSION_DIR` resolve from `cwd`. See [Storage and team variables](/environment-variables#storage-and-team-variables).
- **Validation and errors.** Only the winning setting from `settings.json` is validated, whereas process-level selections (`--storage`, `--storage-file`, `ATOMIC_STORAGE`, and `ATOMIC_SESSIONS_STORAGE`) are validated unconditionally even when outranked. Naming the removed `@bastani/atomic-storage-libsql` adapter or setting any removed `ATOMIC_PROFILE=ci` team variable fails startup with `libsql-removed` (see [Moving off libSQL](/storage#moving-off-libsql)). Open failures never fall back to memory silently. See [Choosing a store](/sessions#choosing-a-store) and [Storage](/storage).

### Storage adapters

Install an adapter [Atomic package](/storage/custom-adapters#adapters-from-atomic-packages) (such as [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres)), or pass its directory via `--extension` or SDK `additionalExtensionPaths` (which takes precedence over settings), and reference it in `storage` or `sessions.storage`:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": { "url": "postgresql://atomic@db.example.com:5432/atomic" },
    "secrets": { "password": { "env": "ATOMIC_DB_PASSWORD" } },
    "prefix": "project_"
  }
}
```

- An empty shared `storage: {}` uses `<storageHome>/storage.sqlite`.
- `secrets` accepts `{ "env": "VAR" }` or `{ "file": "token.txt" }` (relative paths resolve from [storage home](/storage#storage-home), falling back to parent if an existing file lives there; one trailing `\n` or `\r\n` is stripped).

<Warning>
Storage adapter modules execute code with Atomic's permissions. Review any adapter configured in `.atomic/settings.json` before trusting a project. See [Selecting an adapter](/storage/custom-adapters#selecting-an-adapter).
</Warning>

## Snapshots

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

See [Worktree snapshots](/worktree-snapshots) and [Worktree snapshots reference](/worktree-snapshots/reference).

## Resume

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `resume.waitForBlueprint` | `"prompt" \| "tools"` | `"prompt"` (interactive) / `"tools"` (non-interactive) | Wait for restored worktree builds before opening (`"prompt"`), or open immediately while holding tool calls until the build finishes (`"tools"`). Falls back to `"tools"` whenever a `project_trust` hook can still decline trust. See [Start the first turn while the build runs](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs) |
| `resume.cache` | array | unset | Extra entries for [`atomic blueprint cache-key`](/guides/resume-on-any-machine#caches-for-runners): `{ "paths": [...], "kind"?: "store" \| "build", "keyFiles"?: [...] }`. `"store"` paths are absolute or `~` outside the repo; `"build"` paths are repo-relative. Globs, `!` exclusions, and credential paths are refused with a warning. Project list replaces global |
| `resume.setupCommand` | string | unset | Deprecated (global only; prints warning). Move commands into `.atomic/blueprint.yaml` `maintenance` ([Set the environment up with a blueprint](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint)) |

## HTTP

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `httpIdleTimeoutMs` | number or string | `600000` | Global HTTP dispatcher idle timeout in ms, integer duration string (`"30s"`, `"5m"`, `"1h"`), or `"disabled"`/`0` |

Accepted duration forms for `httpIdleTimeoutMs`, `websocketConnectTimeoutMs`, and `streamDeadlineMs`:

- Non-negative finite number (floored to whole milliseconds; `0` disables).
- Numeric string (such as `"60000"`).
- Integer duration with unit `ms`, `s`, `m`, or `h`, case-insensitive (such as `"500ms"`, `"30s"`, `"5m"`, `"1h"`). Decimal durations (`"1.5m"`), negative values, blank strings, and other units (`"d"`) are rejected.
- `"disabled"` (case-insensitive), equivalent to `0`.

`httpIdleTimeoutMs` applies to `fetch`, provider HTTP clients (including the default for `retry.provider.timeoutMs`), and the default total wall-clock budget for one [structured decision](/sdk/structured-decisions#cancellation-and-failures). `/settings` presets offer `30 sec` (`30000`), `1 min` (`60000`), `5 min` (`300000`), `10 min` (`600000`), `30 min` (`1800000`), and `Disabled` (`"disabled"` or `0`). The standalone binary checks this timeout on a coarse timer, ending a silent request up to about 8 seconds late (or up to about two minutes late for timeouts longer than four minutes).

## Network proxy

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `httpProxy` | string | unset | HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY` when those environment variables are unset. Global setting only |

```json
{ "httpProxy": "http://127.0.0.1:7890" }
```

Existing `HTTP_PROXY` and `HTTPS_PROXY` environment variables take precedence over `httpProxy` in `settings.json`. For `NO_PROXY`, `ALL_PROXY`, OpenAI Codex WebSocket proxying, and differences between npm-installed `atomic` and the standalone binary, see [Proxy variables](/environment-variables#proxy-variables).

## Resources

Paths in `~/.atomic/agent/settings.json` resolve from `~/.atomic/agent`; paths in `.atomic/settings.json` resolve from `.atomic`. Supports absolute paths, `~`, globs, `!exclusions`, `+exact-include`, and `-exact-exclude`.

All five resource lists (`packages`, `extensions`, `skills`, `prompts`, and `themes`) combine global and project entries rather than replacing them.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `packages` | array | `[]` | npm, git, or local packages (string or object filter form) |
| `extensions` | string[] | `[]` | Local extension files or directories |
| `skills` | string[] | `[]` | Local skill files or directories (legacy `{ enableSkillCommands, customDirectories }` objects migrate automatically) |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme files or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:<name>` commands |

Legacy `workflows` settings no longer run workflows. Atomic reads their paths only when you ask to [convert a workflow to a skill](/orchestration/migrating-workflows).

### packages

Load all resources with a string entry, or filter specific resources with an object entry (`"autoload": false` starts empty and applies only explicit patterns). Supported filter keys are `extensions`, `skills`, `prompts`, `themes`, `mcpServers`, and `agents`:

```json
{
  "packages": [
    "npm:@org/team-skills",
    {
      "source": "@org/my-extension",
      "autoload": false,
      "skills": ["brave-search", "transcribe"],
      "prompts": ["review.md"],
      "themes": [],
      "extensions": [],
      "mcpServers": ["linear"],
      "agents": ["reviewer"]
    }
  ]
}
```

See [Atomic packages](/packages).

## Integrations

- **Herdr:** Configure `herdr.enabled` below to control terminal pane status reporting.
- **MCP servers:** Configured separately in `mcp.json` (global and project); see [MCP servers](/mcp-servers).
- **Subagents:** Configure built-in agent overrides under `subagents.agentOverrides` in `settings.json`; see [Subagent reference](/subagents/reference).
- **Intercom:** Multi-node routing uses global `storage`; see [Intercom operations](/intercom/operations).
- **Codemode:** Configure `codemode.mode` and `codemode.inlineBudget` under [Tools](#tools).

### Herdr

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `herdr.enabled` | boolean | `true` | Enable the built-in Herdr status reporter in interactive terminal sessions running inside a Herdr pane (disabled for subagents and non-interactive modes). Run `/reload` or restart after changing; setting `false` releases the pane registration cleanly on `/reload` |

See [Herdr](/herdr) for state aggregation, reporter conflicts, and privacy.

## Telemetry and update checks

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `enableInstallTelemetry` | boolean | `true` | Send version-adoption ping on first interactive launch (fresh settings or after upgrade with changelog entries) and provider attribution headers; does not control update checks |

- **Version-adoption telemetry.** Controlled by `enableInstallTelemetry` (disable with `"enableInstallTelemetry": false` or `ATOMIC_TELEMETRY=0`; force on with `ATOMIC_TELEMETRY=1`/`true`/`yes`, where `ATOMIC_TELEMETRY` beats legacy `PI_TELEMETRY`). Sends one bodyless `GET https://atomic-version-adoption.bastani-atomic.workers.dev/v1/version-adoption?version=<version>` with `User-Agent: atomic/<version> (<platform>; <runtime>; <arch>)` and no UUID, cookie, auth header, or user content. Fires only in interactive mode on first launch with fresh settings or after upgrading to a release with changelog entries, never on every launch, npm install, or `-p`/RPC. Atomic stores only UTC date, version, and an aggregate count; Cloudflare processes transient connection metadata (IP, TLS) to serve the request. Separate from `enableAnalytics` and `trackingId`.
- **Update checks.** Queries `https://registry.npmjs.org/@bastani/atomic/latest`. Disable independently with `ATOMIC_SKIP_VERSION_CHECK=1` (`PI_SKIP_VERSION_CHECK=1`).
- **Offline mode.** `--offline` or `ATOMIC_OFFLINE=1` (`1`, `true`, or `yes`, falling back to `PI_OFFLINE`; `0` or `false` keeps network checks enabled) disables all startup network requests (update checks, package update checks, version-adoption telemetry, and model catalog refreshes).

## Debug mode

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `debug` | boolean | `false` | Write verbose debug output to the debug log shown by `/debug` (**Debug mode** in `/settings`). Global setting only |

Use `--debug` or `ATOMIC_DEBUG=1` for a single run (shows a `debug` badge in the footer). Toggling in `/settings` applies immediately to new work; already-running workers and the Intercom broker apply it on next restart. See [Debugging](/development#debugging).

For a complete example config and project-override walkthrough, see [Configure Atomic](/guides/configuration#example) and [Project overrides](/guides/configuration#project-overrides).
