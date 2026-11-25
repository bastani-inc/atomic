---
title: "Settings reference"
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
- **Schema and safe merges.** Add `"$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/settings.schema.json"` for editor completion and validation. Atomic preserves `$schema`, unknown keys (such as extension settings like `subagents.agentOverrides`), symlinks, and concurrent edits from external editors. Saving writes only changed fields to `.atomic` (and only changed keys inside object settings such as `modelThinkingLevels`).
- **Scope merging and legacy `.pi` files.** Within a single scope, `.atomic` overrides `.pi` per file, so legacy `queueMode` in `.atomic` beats `steeringMode` in `.pi`, and setting an array to `[]` in `.atomic` clears the `.pi` array in that same scope. Across global and project scopes, `packages`, `extensions`, `skills`, `prompts`, and `themes` combine rather than replace; setting `"packages": []` in `.atomic/settings.json` clears only a legacy `.pi/settings.json` in that project, not global `~/.atomic/agent/settings.json`. Non-resource arrays (`enabledModels`, `fallbackModels`, `npmCommand`, `resume.cache`) replace the global array.
- **Invalid values.** For most settings, a wrong-typed value is ignored with a one-time warning without rewriting your file, and wrong-typed entries in list settings are dropped while keeping valid entries. The settings below behave more strictly:
  - **Stops startup (or `/reload`) with an error:** an invalid `httpIdleTimeoutMs`, or an invalid active `storage` or `sessions.storage` selection (`StorageConfigError`).
  - **Stops the first model request with an error:** an invalid `websocketConnectTimeoutMs` or `streamDeadlineMs`.
  - **Stops the feature with an error:** an invalid `decisionModel` throws `DecisionConfigError` (wrong type or whitespace-padded string) when `getDecisionModel()` runs during `decide()`, `structured_output`, or opening `/settings`. An unregistered ID, bare ID without `provider/`, image model, or compactor model throws `DecisionModelUnavailableError` when calling `decide()` or `structured_output` with no explicit `model` (opening `/settings` shows it as unavailable without throwing). An invalid `snapshots` block throws `WorkspaceConfigError` at session creation, resume, or `atomic blueprint` (except `snapshots.pool.maxIdlePerRepository`, which falls back to `2`). A negative or non-integer `compaction.reserveTokens` throws a plain `Error` when compaction settings are read.
  - **Special handling for `compactionModel`:** a non-string value throws a plain `Error` when compaction runs or `/settings` opens instead of falling back to `"auto"`. Leading or trailing whitespace in `settings.json` is trimmed on read, while `setCompactionModel()` and RPC `set_compaction_model` reject whitespace-padded strings with `CompactionConfigError`. Saved non-compactor model IDs (chat, classifier, or image) reset to `"auto"` on startup (rewriting trusted `settings.json`). Unknown string IDs stay in the file and clear context with a notice on compaction.

## Project trust

Project settings in `.atomic/settings.json` (and legacy `.pi/settings.json`) load only when the project is trusted.

- Interactive sessions prompt once before trusting a project with trust-gated files and save decisions in `~/.atomic/agent/trust.json` (manage them with `/trust`).
- Non-interactive modes (`-p`, `--mode json`, `--mode rpc`) never prompt; they follow global `defaultProjectTrust` (`"ask"` and `"never"` ignore project settings; `"always"` trusts them). Override for one run with `--approve`/`-a` or `--no-approve`/`-na`.
- Eligible interactive starts open the [early editor](/usage#startup-typing) immediately while non-trust-gated resources load; trust-gated resources always wait for authorization.

See [Project trust](/security#project-trust) for the full list of trust-gated inputs and saved-decision behavior.

## All settings

### Models and thinking

Set up provider credentials in [Model providers](/providers) and define custom endpoints or overrides in [Configure custom models](/models).

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultProvider` | string | unset | Startup provider, saved automatically on interactive model switch |
| `defaultModel` | string | unset | Startup model ID, saved automatically on interactive model switch |
| `enabledModels` | string[] | unset | Model patterns that limit the startup model, `Ctrl+P` cycling, `/model`, and the models subagents may use. Fast and Ultrafast versions have their own model IDs, so a pattern must match them too. See [Model scope (`enabledModels`)](#enabledmodels). |
| `fallbackModels` | string[] | unset | Ordered main-chat fallback chain (`provider/model` with optional `:effort` suffix). See [`fallbackModels`](#fallbackmodels). |
| `decisionModel` | string | `""` | Model for `structured_output` (when omitted) and `decide()`: exact `provider/model` (chat or classifier), or `""`/`"auto"` for the current chat model. See [`decisionModel`](#decisionmodel). |
| `defaultThinkingLevel` | string | unset | Startup thinking level (`"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`), clamped to model support |
| `modelThinkingLevels` | object | unset | Per-model startup thinking levels keyed by `"provider/modelId"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | unset | Custom token budgets per thinking level (native on Anthropic, Google, and Bedrock; OpenAI-compatible when `compat.thinkingTokenBudgetField` or `supportsThinkingTokenBudget` is set) |
| `showCacheMissNotices` | boolean | `false` | Show notices for significant prompt-cache misses, billed compaction or branch summaries, and provider recovery diagnostics (such as dropped Anthropic thinking blocks), including on resume |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"idle"` | Keep eligible prompt caches warm during runs (`"streaming"`, up to 60 min after the starting request) or up to 30 min between runs (`"idle"`). `"off"` disables. Refreshes incur provider cost. Global setting only. |

- **Cache warming.** Runs only when the model declares `promptCache` ([`models.json` field reference](/models-configuration)) and estimated avoided miss cost is at least $0.05. Recorded in usage and never added to context; extensions can intercept via `cache_warming_decision`.
- **Compaction model (`compactionModel`).** Compaction is configured under [Compaction](#compaction) (default `""`, equivalent to `"auto"`, or a registered compactor ID such as `morph/morph-compactor`). See [Remote compaction models](/models#remote-compaction-models).
- **Unsupported saved default provider.** If `defaultProvider` and `defaultModel` name a provider that is still unsupported after extensions load, Atomic does not switch providers silently. Interactive mode warns, print and JSON modes warn on stderr and exit nonzero (stdout stays valid JSONL), and RPC rejects `prompt` until an explicit `set_model` or model cycle succeeds. If the provider is supported but the model is unknown or unauthenticated, normal auto-selection applies.
- **Subagents (`model: "auto"`).** Subagents use `defaultProvider`/`defaultModel` when authenticated (at agent `thinking`, else `modelThinkingLevels`, else `defaultThinkingLevel`, else `medium`), falling back to the launching session's model. When `enabledModels` or `--models` is active, subagent model selection must stay inside that scope. Built-in agent overrides can also be configured under `subagents.agentOverrides` in `settings.json`; see [Subagent reference](/subagents/reference#automatic-model-selection).

#### Model scope (enabledModels) {#enabledmodels}

`enabledModels` (and the one-run CLI flag `--models`) restricts the active set of authenticated models for a session. Setting `enabledModels` to `[]` or omitting it disables scoping so every authenticated model is active.

```json
{
  "enabledModels": [
    "anthropic/claude-opus-5:high",
    "openai-codex/gpt-6*",
    "qwen/qwen3-coder:exacto"
  ]
}
```

##### How patterns match

Atomic resolves `enabledModels` and `--models` patterns against **authenticated, available models only** (including models registered by extensions once they finish loading). Each pattern is resolved in three steps:

1. **Exact unmodified match first.** Atomic checks for a case-insensitive exact match against `provider/id` or bare `id` before interpreting `:thinking` suffixes or glob characters. Literal catalog IDs containing colons or brackets (such as `qwen/qwen3-coder:exacto` or `provider/model[1m]`) match directly without being parsed as suffixes or globs.
2. **Glob patterns (`*`, `?`, `[`).** If the pattern contains `*`, `?`, or `[` and did not match verbatim:
   - Atomic checks for a valid trailing `:thinking` suffix (`:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, or `:max`, case-insensitive).
   - It tries an exact match on the base ID before globbing, so a literal bracketed ID with a suffix (such as `provider/model[1m]:high`) still matches exactly.
   - Otherwise, it runs case-insensitive glob matching against **both** `provider/id` and bare `id`.
3. **Fuzzy substring match (non-globs).** If the pattern has no glob characters and did not match verbatim:
   - Atomic checks for a trailing `:thinking` suffix (case-insensitive). If the suffix is not a valid thinking level, Atomic warns and drops the suffix so the model still resolves at its default thinking level.
   - It matches the remaining text as a case-insensitive substring against `model.id` or `model.name`. When multiple IDs match a fuzzy pattern, Atomic prefers non-dated aliases over dated `YYYYMMDD` IDs, then sorts reverse-alphabetically by model ID so newer versions win.

Additional matching rules:

- **Provider-qualified vs bare IDs.** Use `provider/id` to pin a single provider. A bare ID or pattern matching multiple authenticated providers adds **every** matching provider to the scope.
- **Fast and Ultrafast versions.** Some OpenAI models also come in Fast and Ultrafast versions, which use a faster, more expensive service tier (see [Fast and Ultrafast tiers](/providers#fast-and-ultrafast-tiers)). Each version has its own model ID ending in `-fast` or `-ultrafast`, and a pattern must match that ID. A `*` in the provider part of a pattern does not reach into the model ID. For example, `"openai-*/gpt-6.2-sol"` matches `openai-api/gpt-6.2-sol` and `openai-codex/gpt-6.2-sol`, but not `openai-codex/gpt-6.2-sol-fast`. To include the faster versions, end the pattern with `*`, as in `"openai-*/gpt-6.2-sol*"`, or list each ID you want. A pattern never adds a version that the provider does not offer.
- **Order and deduplication.** Results keep the order of your patterns. Duplicate `(provider, id)` matches are removed while preserving the first occurrence (and its `:thinking` suffix, if any).
- **Project overrides.** Setting `"enabledModels": []` in `.atomic/settings.json` clears a global `enabledModels` list for that project.

##### What `enabledModels` controls

When a scope is active, it governs five areas across your session:

- **New-session startup model.** On a new session (without `--model`, `--continue`, or `--resume`), Atomic starts on your saved `defaultProvider`/`defaultModel` if it is in scope (applying that scope entry's `:thinking` suffix unless `--thinking` overrides it). If your saved default is outside scope, Atomic starts on the **first matched model** in `enabledModels` / `--models` instead.
- **`Ctrl+P` model cycling.** Cycles only through your scoped models in order.
- **`/model` picker and `/model <name>`.** `/model` opens filtered to your scoped models (press `Tab` to toggle between scoped models and all models; press `←`/`→` on a reasoning model row to set thinking effort before selecting). Direct `/model <name>` searches only your scoped models.
- **Subagent allowlist.** Child subagents inherit the active `enabledModels` / `--models` scope using the same matching rules. Any subagent start model (including `model: "auto"`, agent frontmatter `model`, or per-call `model` overrides) and any child fallback candidate outside scope is rejected with an error. If your `enabledModels` patterns match zero available models, subagent launches are blocked rather than widening to all models.
- **Extensions and SDK.** Extensions read the active resolved scope through [`ctx.scopedModels`](/extensions/api-reference#ctx-modelregistry-ctx-model-ctx-scopedmodels) (read-only). SDK hosts can resolve patterns with `resolveModelScopeFromModels()`; see [Resolving scoped models](/sdk/reference#resolving-scoped-models).

**What stays independent:** Main-chat `fallbackModels` is independent of `enabledModels`, so you can keep an out-of-scope emergency fallback for main-chat turns. Child subagent fallback chains remain bound by the parent session's `enabledModels` scope.

##### When a subagent's model is out of scope

Atomic skips any model outside your scope when it launches a subagent. If no allowed model is left, the launch fails and the error says why. When you name a Fast or Ultrafast version whose base model is already in scope, the error gives the exact ID to add:

```text
Model openai-codex/gpt-6.2-sol-ultrafast:high is not available (Skipped openai-codex/gpt-6.2-sol-ultrafast:high: model is outside the session's enabledModels scope; its base model openai-codex/gpt-6.2-sol is in scope. Add "openai-codex/gpt-6.2-sol-ultrafast" to enabledModels.). No other model was used: a subagent launched on a named model runs only that model and its agent's fallbackModels.
```

To fix it, add that ID to `enabledModels`:

```json
{
  "enabledModels": ["openai-codex/gpt-6.2-sol", "openai-codex/gpt-6.2-sol-ultrafast"]
}
```

A model ID that does not exist at all, such as a typo or a version the provider does not offer, fails with `no such model in the catalog.` instead of the scope message.

##### Side effects from `/model` and `/scoped-models`

- **Picking an out-of-scope model in `/model`:** If you press `Tab` in `/model` and pick a model outside your active scope, Atomic adds it to the active session's scope. When global `settings.json` has a non-empty `enabledModels` list, Atomic also appends `"provider/id"` to global `enabledModels` and saves `settings.json`. (If the scope came only from project settings or `--models`, global `enabledModels` is not created.)
- **Editing in `/scoped-models`:** Every toggle, reorder, enable-all, or clear-all saves immediately to **global** `settings.json` as explicit `provider/id` entries. Hand-written globs (such as `"claude-*"`) and `:thinking` suffixes (such as `"anthropic/claude-opus-5:high"`) are replaced by exact `provider/id` strings without thinking suffixes. Unmatched patterns stay visible as unavailable rows until you uncheck them.
- **Enabling or clearing all in `/scoped-models`:** Enabling every available model deletes `enabledModels`. Clearing all saves `"enabledModels": []` and unscopes the active session so all models appear again.

##### Comparison of model-selection settings and flags

| Mechanism | Matching rules | Globs (`*`, `?`, `[`) | Fuzzy match | `:thinking` suffix | Ambiguous bare ID |
| --- | --- | --- | --- | --- | --- |
| `enabledModels` / `--models` | Exact, then glob, then fuzzy (authenticated models only) | Yes (case-insensitive) | Yes | Lenient (case-insensitive; invalid warns and drops) | Adds all matching authenticated providers (no warning) |
| `fallbackModels` / `--fallback-models` | Exact, then fuzzy (skips unauthenticated at runtime) | No | Yes | Strict (case-insensitive; invalid fails match) | Prefers current or default provider; else skips |
| `--model` (CLI) | Exact, then fuzzy (searches all models; synthesizes unknown ID if provider known) | No | Yes | Strict (case-insensitive; invalid kept literally) | Breaks tie by sole authenticated provider; else errors |
| `/model <name>` | Exact `provider/id` or bare `id` (scoped models only when scoped; opens picker on miss) | No | No | No (use `←`/`→` or `/thinking`) | Opens picker instead of switching |
| `defaultProvider` + `defaultModel` | Exact ID lookup (`provider` normalized) | No | No | No (uses `modelThinkingLevels` / `defaultThinkingLevel`) | Not applicable (both required) |
| `decisionModel` | Exact case-sensitive `provider/model` (classifiers before chat models) | No | No | No | Not applicable (`provider/model` required) |
| `compactionModel` | Exact case-sensitive `provider/model` (registered compactors only) | No | No | No | Not applicable (`provider/model` required) |

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

- **Entry format and matching.** Use `provider/model` (preferred; bare IDs and fuzzy substrings also match, and exact unmodified IDs containing `/` or `:` such as `qwen/qwen3-coder:exacto` match first) with an optional case-insensitive `:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, or `:max` suffix (clamped to model support). Run `atomic --list-models` for IDs. An invalid `:thinking` suffix or unmatched entry warns once after extensions load and is skipped. If an ambiguous bare ID matches multiple authenticated providers, Atomic prefers the current or default provider and skips the entry if neither matches.
- **Thinking level without a suffix.** When a fallback candidate omits `:effort`, Atomic uses `defaultThinkingLevel`, else the current session's thinking level, else `"medium"`, clamped to model support (`modelThinkingLevels` is not consulted during fallback).
- **CLI precedence.** `--model` runs strictly as named and falls back only to `--fallback-models`, ignoring settings `fallbackModels`. `--no-fallback` disables fallback for one run, and `--fallback-models` replaces this list for one run. Extension-registered providers work in both. Press `Esc` during a retry wait or model switch to stop the pending request. See [CLI model options](/reference/cli#model-options).
- **Triggers.** Rate limits, quota exhaustion (`The usage limit has been reached`), transient errors (unrecognized errors without a status code retry same-model first), content-filter refusals (OpenAI HTTP 422 `cyber_policy`, Anthropic refusal, or `content_filter`; skips same-model retry unless `retry.fallbackOnContentFilter: false`), and refused TLS certificates (skips same-model retry; each fallback is tried once). Context overflow compacts first and falls back only if compaction is off, fails, or does not clear the overflow. With `retry.enabled: false`, retryable errors advance immediately. Non-retryable errors and `Esc` cancellations never fall back.
- **Skipping broken providers or models during a turn.** Unauthenticated providers are skipped before sending a request (if none have credentials, Atomic fails immediately and lists the missing providers). Rejected credentials (HTTP 401, `invalid_api_key`, `authentication_error`) exclude the whole provider for the rest of the current turn. Model-scoped HTTP 403 or incompatible-request errors exclude only that model across all reasoning suffixes.
- **Persistence, print output, and billing.** Once a fallback runs, it stays active for later turns (keeping thinking-level changes) until you switch via `/model` or model cycling. In print mode (`-p`), both fallback progress notices and the final `Model: ran on <fallback>, not the requested <model>.` line are written to **stderr** so stdout stays clean. Main-chat `fallbackModels` is independent of `enabledModels`, whereas child subagents launched from a scoped session restrict their fallback candidates to the session's `enabledModels` scope. Because switching providers changes billing and data-handling terms, list only approved providers.

#### decisionModel

```json
{ "decisionModel": "" }
```

Controls which model answers `structured_output` calls (when no `model` is passed; classifiers answer finite `Choice` schemas, otherwise Atomic tries `fallbackModels` and then the current chat model) and extension [`decide()`](/sdk/structured-decisions#decide) calls. It does not change your chat model or subagent execution model.

- **Configure.** Set in JSON, open `/settings` and select **Decision model** (edits project override if present, otherwise global), or call `session.setDecisionModel(model, scope?)` / RPC `set_decision_model`. Selections made through `/settings`, the SDK, or RPC take effect immediately in the active session without running `/reload` or restarting. `""` or `"auto"` uses the current chat model. To pin a model, specify an exact case-sensitive `provider/model` of a registered classifier (such as `typesafe/jev-latest`, `vercel-ai-gateway/typesafe-ai/jev`, `opencode/jev-1.13`, or `opencode/jev-1.13-free`) or chat model (classifiers are checked before chat models). Run `/reload` only if you edited `settings.json` directly outside Atomic.
- **Errors and fallback.** A wrong JSON type or whitespace-padded string throws `DecisionConfigError` when `getDecisionModel()` runs during `decide()`, `structured_output`, or opening `/settings`. An unregistered ID, bare ID without `provider/`, image model, or compactor model throws `DecisionModelUnavailableError` during `decide()` or `structured_output` with no explicit `model` instead of falling back (opening `/settings` shows the ID as unavailable without throwing). Once a registered classifier is selected, runtime failures (missing credentials, context error, refusal, or malformed output) fall back silently to the current chat model and log in [debug mode](#debug-mode). Chat models get 1 initial attempt plus 3 corrective retries within [`httpIdleTimeoutMs`](#http) (default 10 minutes). Cancellation does not fall back.
- **Provider, credentials, and cost.** The decision model's provider receives the decision context, so choose a permitted provider. Authenticate a pinned classifier with its provider login (for example `/login typesafe` or `TYPESAFE_API_KEY`). Classifiers do not appear in `/model`. An explicit empty project value overrides a global selection and restores the current chat model. Falling back to the current chat model can incur chat-provider charges.
- **Legacy migration.** Valid legacy `routerModel` values migrate automatically when `decisionModel` is absent without rewriting the file. Removed `modelRouting` and built-in override `modelConstraints`/`taskNeeds` keys are removed automatically on startup from writable `.atomic` settings with a one-time notice.

See [Structured decisions](/sdk/structured-decisions), [Classifier models](/models#use-classifier-models), [Local classification](/llama-cpp#classification), and [TypeSafe Jev](/providers#typesafe-jev).

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

### Fast models

Fast and Ultrafast inference use canonical `<model-id>-fast` and `<model-id>-ultrafast` model IDs (not a separate setting) anywhere models are configured (`/model`, `fallbackModels`, `enabledModels`, and subagents). Reasoning suffixes work normally (`openai-codex/gpt-5.6-sol-fast:medium`, `openai/gpt-6.2-astra-ultrafast:high`), and standard, fast, and ultrafast IDs act as separate candidates:

```json
{
  "fallbackModels": [
    "openai-codex/gpt-5.6-sol-fast:medium",
    "openai-codex/gpt-5.6-sol:medium"
  ]
}
```

See [Fast models](/providers#fast-models) and [Fast and Ultrafast tiers](/providers#fast-and-ultrafast-tiers) for supported providers, eligibility, and precedence over custom `-fast` or `-ultrafast` IDs.

### Interface and display

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `theme` | string | `"dark"` | `"dark"`, `"light"`, `"system"` (terminal-derived palette), Catppuccin built-in, or custom theme ([Themes](/themes)). Values containing `/` are ignored. |
| `fullscreenScrollbar` | string | `"auto"` | `"auto"` (show while scrolling), `"always"` (reserved right column), or `"hidden"`. Draggable in the main chat; also shown when viewing a subagent or shell output (not draggable). |
| `fullscreenExitOutput` | string | `"transcript"` | `"transcript"` prints the final transcript and resume hint on exit; `"resume-hint"` restores the previous screen and prints only the resume hint. Configurable in `/settings`. |
| `fullscreenCopyOnSelect` | boolean | `true` | Auto-copy text selection on mouse release (`false` highlights only; `/copy` copies the last assistant message). Configurable in `/settings`. |
| `fullscreenWheelScrollLines` | `"auto"` or number | `"auto"` | Lines per wheel tick in the main chat, viewed subagent transcripts, and shell output (`"auto"` or `1` to `100`). Configurable in `/settings`. |
| `quietStartup` | boolean or `"header"` | `false` | `true` hides the startup header; `"header"` keeps it but hides the model scope line |
| `defaultProjectTrust` | string | `"ask"` | Fallback project trust (`"ask"`, `"always"`, `"never"`). Global setting only. |
| `collapseChangelog` | boolean | `false` | Show a one-line update notice instead of What's New highlights (`/changelog` shows full history) |
| `doubleEscapeAction` | string | `"tree"` | Double-Esc action: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default `/tree` filter: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal input editor padding (`0` to `3`) |
| `outputPad` | number | `1` | Horizontal transcript padding (`0` or `1`) |
| `externalEditor` | string | unset | Command for `Ctrl+G` external editor (overrides `$VISUAL` and `$EDITOR`; defaults to Notepad on Windows, `nano` elsewhere) |
| `autocompleteMaxVisible` | number | `5` | Max visible autocomplete items (`3` to `20`) in default and `ctx.ui.setEditorComponent()` editors |
| `showHardwareCursor` | boolean | `false` | Use hardware terminal cursor instead of drawn cursor (still positioned for IME; falls back to `ATOMIC_HARDWARE_CURSOR=1` or legacy `PI_HARDWARE_CURSOR=1` when unset) |

Interactive mode runs fullscreen with stacked transient notices. Closing an overlay clears text selection inside it. `Ctrl+G` checks `externalEditor`, then `$VISUAL`, then `$EDITOR`, then Notepad (Windows) or `nano` (POSIX) in main chat, embedded chat, and extension dialogs; saving empty clears text, while an editor error preserves the original text.

#### Terminal and images

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

#### Markdown

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |
| `markdown.mermaid` | string | `"streaming"` | Display-only Mermaid rendering: `"off"`, `"final"`, or `"streaming"` (invalid or oversized diagrams stay as code) |
| `markdown.latex` | boolean | `true` | Display-only Unicode math rendering (supports whitespace and matrix layouts; stored messages keep source Markdown) |

#### Warnings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `warnings.anthropicExtraUsage` | boolean | `true` | Warn when Anthropic subscription auth may incur paid extra usage |

#### Managed state keys

Atomic manages these keys automatically in global `settings.json`. Leave them unchanged unless troubleshooting:

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `firstRunOnboardingStartedVersion` | string | unset | Version when first-run onboarding started |
| `onboardedVersion` | string | unset | Version when onboarding completed |
| `lastChangelogVersion` | string | unset | Most recent version whose changelog notice was displayed |
| `teamJoin` | object | unset | `atomic team join` record used by `atomic team leave` |
| `enableAnalytics` | boolean | `false` | Opt-in flag saved during first-run setup (storage only; Atomic does not transmit analytics) |
| `trackingId` | string | unset | Locally generated analytics ID when `enableAnalytics` is enabled |
| `deviceId` | string | unset | Global install ID created when a provider sign-in needs one (project values ignored) |

### Message delivery

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `steeringMode` | string | `"one-at-a-time"` | Steering message delivery: `"one-at-a-time"` or `"all"` |
| `followUpMode` | string | `"one-at-a-time"` | Follow-up message delivery: `"one-at-a-time"` or `"all"` |
| `transport` | string | `"auto"` | Multi-transport provider preference: `"auto"`, `"websocket-cached"`, `"websocket"`, or `"sse"` (legacy boolean `websockets` migrates here) |
| `websocketConnectTimeoutMs` | number or string | `15000` | WebSocket handshake timeout (ms, duration string, or `"disabled"`/`0`) |
| `streamDeadlineMs` | number or string | `300000` | Max idle gap between provider stream events below HTTP (ms, duration string like `"30s"`, `"5m"`, `"1h"`, or `"disabled"`/`0`). Cuts stalled streams for retry or fallback; Anthropic `ping` events reset the timer. |

How `transport` modes work on providers that support both WebSocket and SSE (such as OpenAI Codex):

- `"auto"` (default) and `"websocket-cached"`: use WebSocket with connection-scoped continuation (`previous_response_id`, 5-minute idle cache TTL, 55-minute max connection age). If the WebSocket fails before streaming starts, Atomic falls back to SSE for the rest of the session.
- `"websocket"`: use WebSocket without cached continuation (sends the full request body on every turn), still falling back to SSE on pre-stream transport failures.
- `"sse"`: disable WebSocket and always stream over SSE (with zstd request-body compression on Codex).

For the global HTTP idle timeout, see [HTTP](#http) (`httpIdleTimeoutMs`).

### Compaction

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `compaction.enabled` | boolean | `true` | Enable automatic compaction |
| `compaction.reserveTokens` | number | `16384` | Non-negative safe integer; triggers auto-compaction when usage exceeds `contextWindow - reserveTokens` |
| `compactionModel` | string | `""` | `""` (equivalent to `"auto"`) clears context so the agent recovers from history; an exact registered compactor ID (such as `morph/morph-compactor`) compacts via that model. Selecting **Compaction model** in `/settings` edits the project override if set, otherwise global (saving `""` for Automatic). Whitespace in `settings.json` is trimmed on read, while `setCompactionModel()` and RPC `set_compaction_model` reject whitespace-padded strings with `CompactionConfigError`. Non-string values throw a plain `Error` when compaction runs or `/settings` opens. Saved non-compactor IDs (chat, classifier, or image) reset to `"auto"` on startup. See [Compaction model](/compaction#compaction-model), [Remote compaction models](/models#remote-compaction-models), and [Compactor request contract](/compaction/reference#compactor-request-contract). |

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

#### Branch summary

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved when selecting branch history for summary |
| `branchSummary.skipPrompt` | boolean | `false` | Skip the "Summarize branch?" prompt on `/tree` switches (defaults to no summary) |

#### Session summary

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `sessionSummary.enabled` | boolean | `true` | Generate one-line summaries for saved sessions in `/resume` when idle (skipped for `--no-session`) |

### Retry

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `retry.enabled` | boolean | `true` | Enable agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base exponential backoff delay (2s, 4s, 8s) |
| `retry.maxAgentDelayMs` | number | `60000` | Cap on agent-level backoff (`0` retries immediately) |
| `retry.fallbackOnContentFilter` | boolean | `true` | Advance to next `fallbackModels` entry on content-filter refusals (such as OpenAI HTTP 422 `cyber_policy`); `false` retries on the same model |
| `retry.provider.timeoutMs` | number | Provider client default | Per-request provider timeout in ms (when unset, uses the provider client's built-in timeout, such as 10 min for OpenAI/Anthropic or 60s for Mistral Conversations) |
| `retry.provider.maxRetries` | number | `0` | Provider client retries (leave `0` so agent-level retry controls backoff) |
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

### Shell

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `shellPath` | string | unset | Custom Bash path; a bare name such as `bash` is looked up in absolute `PATH` directories (does not change PowerShell used on native Windows `!` and `!!`) |
| `shellCommandPrefix` | string | unset | Prefix prepended to shell commands (PowerShell syntax on native Windows interactive shells; Bash syntax elsewhere, such as `"shopt -s expand_aliases"`) |
| `search.contextBefore` | number | `1` | Context lines before each `search` match |
| `search.contextAfter` | number | `3` | Context lines after each `search` match |
| `npmCommand` | string[] | unset | Command argv for npm lookup, install, uninstall, and git-package dependency installs (runs plain `install` when set, for example `["mise", "exec", "node@20", "--", "npm"]`). `atomic update` reads `npmCommand` from global settings only. |
| `selfUpdateCommand` | string[] | unset | Command argv for `atomic update` using `{packageName}`, `{version}`, and `{installSpec}` (`ATOMIC_SELF_UPDATE_COMMAND` overrides; global settings only; [Custom update command](/reference/cli#custom-update-command)) |

On Windows, write JSON paths with forward slashes or escaped backslashes:

```json
{ "shellPath": "C:/Program Files/Git/bin/bash.exe" }
```

```json
{ "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe" }
```

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
- **Precedence.** Highest to lowest: SDK `sessionStore`, SDK `storage` (`createAgentSession({ storage })`, see [SDK storage](/sdk/storage)), `--no-session`, `--session-dir`, or `--session-store`, `--storage` or `--storage-file`, `ATOMIC_SESSIONS_STORAGE` or `ATOMIC_CODING_AGENT_SESSION_DIR`, `ATOMIC_STORAGE`, `ATOMIC_PROFILE=ci`, `sessions.storage`, `storage`, and default SQLite. Project selections replace global objects whole rather than merging; an explicit `{}` on `sessions.storage` selects default SQLite rather than inheriting `storage`. Relative paths in settings and JSON flags or env vars resolve from [storage home](/storage#storage-home); `--session-dir`, `--session-store`, and `ATOMIC_CODING_AGENT_SESSION_DIR` resolve from `cwd`. See [Storage and team variables](/environment-variables#storage-and-team-variables).
- **Errors.** Only the winning setting is validated from `settings.json`, whereas process-level selections (`--storage`, `--storage-file`, `ATOMIC_STORAGE`, `ATOMIC_SESSIONS_STORAGE`, and `ATOMIC_PROFILE=ci` with `ATOMIC_TEAM_*`) are validated unconditionally even when outranked. Invalid config throws `StorageConfigError` (`source`, `field`, `reason`) or `TeamProfileConfigError`, and open failures throw typed errors without falling back to memory. See [Choosing a store](/sessions#choosing-a-store), [Selecting storage per process](/storage#selecting-storage-per-process), and [Storage errors](/storage#storage-errors).

#### Storage adapters

Install an adapter [Atomic package](/storage#adapters-from-atomic-packages) (such as [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres) or [`@bastani/atomic-storage-libsql`](/libraries/storage-libsql)), or pass its directory via `--extension` or SDK `additionalExtensionPaths` (which takes precedence over settings), and reference it in `storage` or `sessions.storage`:

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

### Resume

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `resume.waitForBlueprint` | `"prompt"` \| `"tools"` | `"prompt"` (interactive) / `"tools"` (non-interactive) | Controls whether restored worktree builds finish before opening (`"prompt"`) or run concurrently while holding tool calls (`"tools"`). Applies to `-p`, `--mode json`, `--mode rpc`, and SDK sessions as `"tools"` by default. When a `project_trust` extension handler can still decline a saved trust decision, Atomic behaves like `"tools"` so no project build step runs before trust settles. See [Start the first turn while the build runs](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs). |
| `resume.cache` | array | unset | Extra entries for [`atomic blueprint cache-key`](/guides/resume-on-any-machine#caches-for-runners): `{ "paths": [...], "kind"?: "store" \| "build", "keyFiles"?: [...] }`. `"store"` paths are absolute or `~` outside the repo; `"build"` paths are repo-relative. Globs, `!` exclusions, and credential paths are refused with a warning. Project list replaces global. |
| `resume.setupCommand` | string | unset | Deprecated (global only; prints warning). Move commands into `.atomic/blueprint.yaml` `maintenance` ([Set the environment up with a blueprint](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint)). |

### HTTP

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `httpIdleTimeoutMs` | number or string | `600000` | Global HTTP dispatcher idle timeout in ms, integer duration string (`"30s"`, `"5m"`, `"1h"`), or `"disabled"`/`0`. |

Accepted duration forms for `httpIdleTimeoutMs`, `websocketConnectTimeoutMs`, and `streamDeadlineMs`:

- Non-negative finite number (floored to whole milliseconds; `0` disables).
- Numeric string (such as `"60000"`).
- Integer duration with unit `ms`, `s`, `m`, or `h`, case-insensitive (such as `"500ms"`, `"30s"`, `"5m"`, `"1h"`). Decimal durations (`"1.5m"`), negative values, blank strings, and other units (`"d"`) are rejected.
- `"disabled"` (case-insensitive), equivalent to `0`.

`httpIdleTimeoutMs` applies to `fetch`, provider HTTP clients, and the default total wall-clock budget for one [structured decision](/sdk/structured-decisions#cancellation-and-failures) (`structured_output`, `generateStructuredOutput()`, `decide()`). `/settings` presets offer `30 sec` (`30000`), `1 min` (`60000`), `5 min` (`300000`), `10 min` (`600000`), `30 min` (`1800000`), and `Disabled` (`"disabled"` or `0`). The standalone binary checks this timeout on a coarse timer, ending a silent request up to about 8 seconds late (or up to about two minutes late for timeouts longer than four minutes).

### Network proxy

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `httpProxy` | string | unset | HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY` when those environment variables are unset. Global setting only. |

```json
{ "httpProxy": "http://127.0.0.1:7890" }
```

Existing `HTTP_PROXY` and `HTTPS_PROXY` environment variables take precedence over `httpProxy` in `settings.json`.

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

### Resources

Paths in `~/.atomic/agent/settings.json` resolve from `~/.atomic/agent`; paths in `.atomic/settings.json` resolve from `.atomic`. Supports absolute paths, `~`, globs, `!exclusions`, `+exact-include`, and `-exact-exclude`.

All five resource lists (`packages`, `extensions`, `skills`, `prompts`, and `themes`) combine global and project entries rather than replacing them.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `packages` | array | `[]` | npm, git, or local packages (string or object filter form) |
| `extensions` | string[] | `[]` | Local extension files or directories |
| `skills` | string[] | `[]` | Local skill files or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme files or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:<name>` commands |

Legacy `workflows` settings no longer run workflows. Atomic reads their paths only when you ask to [convert a workflow to a skill](/orchestration/migrating-workflows).

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

### Integrations

- **Herdr:** Configure `herdr.enabled` below to control terminal pane status reporting.
- **MCP servers:** Configured separately in `mcp.json` (global and project); see [MCP servers](/mcp-servers).
- **Subagents:** Configure built-in agent overrides under `subagents.agentOverrides` in `settings.json`; see [Subagent reference](/subagents/reference).
- **Intercom:** Multi-node routing uses global `storage`; see [Intercom operations](/intercom/operations).
- **Codemode:** Configure `codemode.mode` and `codemode.inlineBudget` under [Tools](#tools).

#### Herdr

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `herdr.enabled` | boolean | `true` | Enable the built-in Herdr status reporter in interactive terminal sessions running inside a Herdr pane (disabled for subagents and non-interactive modes). Run `/reload` or restart after changing; setting `false` releases the pane registration cleanly on `/reload`. |

See [Herdr](/herdr) for state aggregation, reporter conflicts, and privacy.

### Telemetry and update checks

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `enableInstallTelemetry` | boolean | `true` | Send version-adoption ping on first interactive launch (fresh settings or after upgrade with changelog entries) and provider attribution headers; does not control update checks |

- **Version-adoption telemetry.** Controlled by `enableInstallTelemetry` (disable with `"enableInstallTelemetry": false` or `ATOMIC_TELEMETRY=0`; force on with `ATOMIC_TELEMETRY=1`/`true`/`yes`, where `ATOMIC_TELEMETRY` beats legacy `PI_TELEMETRY`). Sends one bodyless `GET https://atomic-version-adoption.bastani-atomic.workers.dev/v1/version-adoption?version=<version>` with `User-Agent: atomic/<version> (<platform>; <runtime>; <arch>)` and no UUID, cookie, auth header, or user content. Fires only in interactive mode on first launch with fresh settings or after upgrading to a release with changelog entries, never on every launch, npm install, or `-p`/RPC. Atomic stores only UTC date, version, and an aggregate count; Cloudflare processes transient connection metadata (IP, TLS) to serve the request. Separate from `enableAnalytics` and `trackingId`.
- **Update checks.** Queries `https://registry.npmjs.org/@bastani/atomic/latest`. Disable independently with `ATOMIC_SKIP_VERSION_CHECK=1` (`PI_SKIP_VERSION_CHECK=1`).
- **Offline mode.** `--offline` or `ATOMIC_OFFLINE=1` (`1`, `true`, or `yes`, falling back to `PI_OFFLINE`; `0` or `false` keeps network checks enabled) disables all startup network requests (update checks, package update checks, version-adoption telemetry, and model catalog refreshes).

### Debug mode

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `debug` | boolean | `false` | Write verbose debug output to the debug log shown by `/debug` (**Debug mode** in `/settings`). Global setting only. |

Use `--debug` or `ATOMIC_DEBUG=1` for a single run (shows a `debug` badge in the footer). Toggling in `/settings` applies immediately to new work; already-running workers and the Intercom broker apply it on next restart. See [Debugging](/development#debugging).

For a complete example config and project-override walkthrough, see [Configure Atomic](/guides/configuration#example) and [Project overrides](/guides/configuration#project-overrides).
