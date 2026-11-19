# Settings

Atomic uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.atomic/agent/settings.json` | Global (all projects) |
| `.atomic/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options. Choosing a model or thinking level with `/model`, `/thinking`, or their cycling shortcuts automatically saves it as the startup default. Thinking choices also update the active model's saved thinking level. `/scoped-models` saves cycle-list changes automatically. SDK calls, session restoration, and automatic fallbacks do not overwrite these defaults unless persistence is explicitly requested. Atomic also reads legacy `~/.pi/agent/settings.json` and `.pi/settings.json` as compatibility fallbacks, with `.atomic` paths taking precedence. Each file is read on its own before they are combined, so a legacy key such as `queueMode` in an `.atomic` file takes precedence over the current key, `steeringMode`, in the `.pi` file.

For editor completion and validation, add `"$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/settings.schema.json"` to `settings.json`. Atomic preserves `$schema` and settings it does not recognize, such as extension settings, when it saves. If you save `settings.json` in an editor while Atomic is saving it, Atomic merges its change into your save instead of replacing it.

Atomic checks the type of each setting when it loads a settings file. A value of the wrong type, such as a string where a list belongs (`"extensions": "./my-ext.ts"` instead of `["./my-ext.ts"]`), is ignored: Atomic behaves as if it were not set, so the other settings file or the default applies. A list entry of the wrong type, such as a number in `fallbackModels` or in the legacy `skills.customDirectories` form, is dropped and the rest of the list is kept. Each settings file is checked on its own, so a wrong-typed value in an `.atomic` file lets the value in the matching `.pi` file apply. Each ignored value is reported once as a warning that names the file and the key, and again if it comes back after being fixed, for example `Invalid settings file ~/.atomic/agent/settings.json: "extensions" must be array of string; ignoring it.` Atomic never rewrites the file; fix the value to clear the warning. Values of the right type that break a narrower rule, such as an out-of-range number, are reported by the feature that uses them, as described for each setting below. So are wrong-typed values of settings that check their own values and stop the request instead of switching to something else: `decisionModel`, `storage`, `sessions`, `snapshots`, `httpIdleTimeoutMs`, `websocketConnectTimeoutMs` and `streamDeadlineMs`.

Saving an Atomic setting applies only the changed fields to the corresponding `.atomic` file; it does not copy untouched fallback fields out of `.pi`. Within an object setting such as `modelThinkingLevels`, only the changed key is written, so keys another running Atomic process saved are kept. To intentionally override an inherited array such as `packages`, set it in `.atomic`, including an explicit empty array (`"packages": []`) when the inherited list should be disabled.

## On this page and its guide

This page is the exhaustive settings reference: every field, its default, and its constraints. If you are writing your first settings file or setting up a project-scoped override, start with the [Configure Atomic](/guides/configuration) guide.

## Project Trust

On interactive startup, Atomic asks before trusting a project folder that contains trust-gated project inputs and has no saved decision for the folder or a parent folder in `~/.atomic/agent/trust.json`. Trusting a project allows Atomic to load project-local `.atomic/settings.json` and `.atomic` resources, legacy `.pi/settings.json` and `.pi` resources, project-local context files, install missing project packages, and execute project extensions.

The startup prompt appears on its own, before the interface paints, and the interface appears once you choose. If you decline, the transcript warns that project resources are ignored; if you trust the project, it does not. Project resources and borrowed project-local code stay blocked until authorized. The trust dialog does not require a model request. Trusted global and explicitly authorized CLI extensions can report the wait.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore trust-gated project inputs, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run. When such a run ignores a project settings file, it prints a warning that names the file.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.atomic/agent/settings.json`, or change it with `/settings`.

`atomic config` and package commands use the same project trust flow. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.atomic/agent/trust.json` only; the current session is not reloaded, so restart Atomic for changes to take effect.

Atomic may treat a bare directory without trust-gated inputs as implicitly trusted. Inert state directories such as `.atomic/todos/` and `.atomic/sessions/` neither require trust nor disable deferred resource startup.

Interactive startup makes the editor available while resources load. If you submit early, the prompt waits with a spinner until the tools, skills, templates, and provider updates are ready. You can still type or cancel. Newly loaded resources appear in the normal disclosure; there is no separate loading spinner before submission.

Explicit provider/model choices, resource flags, system-prompt inputs, metadata commands, and non-TTY modes normally finish loading before becoming ready. Trust-requiring resources always wait for authorization.

If trust-requiring config appears later, Atomic asks again on the next launch until you save a persistent decision. Implicit startup trust is persisted automatically only by the existing `/reload` flow, when reload discovers trust-requiring resources in an already-trusted session.

Settings and trust JSON files may start with a UTF-8 BOM, as commonly written by older Windows tools; Atomic strips that leading marker before parsing.

## All Settings

### Herdr

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `herdr.enabled` | boolean | `true` | Enable the built-in reporter in an eligible Herdr pane. Set to `false`, then reload or restart to opt out. Requires `mode: "tui"`, a UI, and the Herdr environment variables. Child sessions and other modes never claim. |

See [Herdr](/herdr) for state aggregation, reporter conflicts, privacy, and Herdr 0.8.2 limitations.

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Startup provider, saved automatically when you switch models interactively |
| `defaultModel` | string | - | Startup model ID, saved automatically when you switch models interactively |
| `decisionModel` | string | `""` | The model every decision uses: `structured_output` calls that name no model and `decide()`. An exact `provider/model` selects a registered chat or classifier model. `auto` and empty use the current chat model. Does not change the chat model. See [decisionModel](#decisionmodel). |
| `defaultThinkingLevel` | string | - | Startup thinking level, saved automatically on interactive model/thinking changes: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`; clamped to the active model's supported levels |
| `modelThinkingLevels` | object | - | Per-model startup thinking levels keyed by `"provider/modelId"`; updated automatically on interactive model/thinking changes, or configured from `/settings` → Default thinking level per model |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level. Anthropic, Google, and Bedrock use these natively. OpenAI-compatible models use them when `compat.thinkingTokenBudgetField` (or `supportsThinkingTokenBudget`) is set. |
| `showCacheMissNotices` | boolean | `false` | Show transcript notices for significant prompt-cache misses, billed compaction or branch-summary usage, and provider recovery diagnostics such as dropped Anthropic thinking blocks, including when a persisted transcript is resumed |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"idle"` | Keep eligible provider prompt caches warm during active runs and, with `"idle"`, for up to 30 minutes between runs. `"streaming"` warms only during active runs; `"off"` never warms. Each refresh costs money. Global setting only; project settings are ignored. |
| `fallbackModels` | string[] | - | Ordered fallback models, written as `"provider/model"` with optional model-supported reasoning suffixes such as `:high`, `:xhigh`, or `:max`. Used by main-chat turns |

Cache warming runs only when the model declares a cache lifetime (`promptCache` in [Models Configuration](/models-configuration)) and Atomic estimates at least $0.05 in avoided cache-miss cost. Refreshes are recorded as usage entries and never enter the model's context. Extensions can override each decision with the `cache_warming_decision` event.

`defaultProvider` and `defaultModel` form one exact saved selection when both are present. Atomic waits for built-in, configured, and extension provider registration before classifying the provider.

If it remains unsupported, Atomic does not silently switch providers:

- Interactive mode stays live with a generic configuration warning.
- Print and JSON modes write the warning to stderr and exit nonzero before prompting. JSON stdout stays JSONL-clean.
- RPC rejects `prompt` until a successful explicit `set_model` selects an available model or an explicit model cycle returns a different available model. A null or unchanged cycle does not clear the condition.

Normal automatic selection of an available authenticated model remains enabled if the provider is supported but its saved model is unknown or lacks configured authentication. It also remains enabled when either field is omitted. Valid extension-provider defaults can resolve after deferred extension loading. Update an unsupported pair or choose a model with `/model`.

Subagents with `model: "auto"` run this default model when it has credentials, at the effort the subagent sets, otherwise at its `modelThinkingLevels` entry, then `defaultThinkingLevel`, then `medium`. Without a usable default model they run the launching session's model. See [Automatic model selection](/subagents/reference#automatic-model-selection).

#### decisionModel

```json
{ "decisionModel": "" }
```

`decisionModel` replaces the former `routerModel` setting. Global and trusted project settings files and SDK settings automatically migrate a valid legacy value when `decisionModel` is absent, without stopping startup. If both keys are present, `decisionModel` wins. Invalid legacy values (not a string, or with surrounding whitespace) are ignored. Atomic names an ignored `routerModel` once, and again only after you change its value; it remembers what it already showed in `shown-notices.json` in its agent directory. Loading settings does not rewrite the file, and saving another setting keeps `routerModel` and any other key as written (keys and values unchanged; formatting may change); use `decisionModel` in new configuration.

The former `modelRouting` setting was removed with automatic model routing; `"auto"` runs your default model. When Atomic starts and finds `modelRouting` in your global settings or a trusted project's `.atomic/settings.json`, it deletes that key from the file, keeps every other setting, and tells you once. If the file cannot be written, Atomic ignores the key and warns once, and again only after its value changes. The `modelConstraints` and `taskNeeds` fields of a builtin agent override (`subagents.agentOverrides.<agent>`) were removed with it and are deleted from the same files in the same way. Settings files Atomic does not write, such as a parent directory's `.atomic/settings.json` when you start Atomic in a subdirectory, or the legacy `~/.pi/agent/settings.json`, keep these fields; Atomic names them once, and again only after their values change.

The decision model is used by:

- the `structured_output` tool when the call names no `model` (a classifier answers when the result schema is a finite Choice; otherwise the call's `fallbackModels` and then the current chat model answer);
- [`decide()`](/sdk/structured-decisions#decide), which extensions call to make their own decisions.

A classifier answers with probabilities; a chat model's answer has none.

Use `/settings` → **Decision model** to change the effective selection. If the project already defines `decisionModel`, the picker edits that project override; otherwise it saves the global default in `~/.atomic/agent/settings.json`. The picker identifies which scope it will save. Choose **Automatic** to save `""` in that scope. `""` and `auto` both use the current chat model; saved classifier credentials do not change that choice. To pin a decision model, choose an exact ID from the current registry, such as `typesafe/jev-latest`, or a chat model by provider/model ID. A classifier is not a chat model and does not appear in `/model`. Run `/reload` or restart Atomic to apply the saved choice to an already-running isolated engine.

An explicit ID other than `auto` is resolved through the current model registry: a registered classifier first, otherwise a chat model. Built-in gateway classifiers include `vercel-ai-gateway/typesafe-ai/jev`, `opencode/jev-1.13`, and `opencode/jev-1.13-free`; authenticate their provider before choosing them. An invalid explicit ID, image-generation model, non-string value, or surrounding whitespace fails the decision instead of silently changing providers. An explicit empty project value overrides a global selection and restores the current chat model.

A failed explicit classifier decision switches to the current chat model when one exists. That includes missing credentials, an unavailable classify operation, a provider size or context rejection, a refusal, and a malformed answer. Transient retries follow the provider operation and retry settings. A chat model gets an initial attempt plus three corrective retries for invalid output, using the same context. Each decision must finish within a wall-clock deadline taken from [`httpIdleTimeoutMs`](#http), 10 minutes by default, covering its corrective retries and any chat fallback. Cancel the request to stop sooner. Independent provider, credential-preparation, and enclosing tool-request limits still apply. The fallback can incur chat-provider charges. Cancellation does not trigger fallback.

Classifier fallbacks are recovered automatically and are not printed to the terminal or added to the conversation. Turn on [debug mode](#debug-mode) to write them to the debug log.

This setting selects the model that makes each decision listed above. It does not select a subagent's execution model, and it does not change the selected chat model. An SDK `generateStructuredOutput()` call starts on it only when you pass `settings` and no `model`; otherwise the call uses only the models it names. The decision provider may be any registered classifier or chat model, never an image-generation model. The decision model's provider receives the decision context, so choose a provider permitted to process that data. Authenticate a pinned classifier with that provider's login, such as `/login typesafe` or `TYPESAFE_API_KEY` for TypeSafe Jev. See [Structured decisions](/sdk/structured-decisions) and [TypeSafe Jev](/providers#typesafe-jev).

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

`fallbackModels` gives main-chat turns an ordered model fallback chain. Atomic starts with the selected/default model and advances to the next configured model after exhausting same-model retries for a retryable provider/model failure. It continues the same turn. This includes rate limits and quota/usage-limit exhaustion, such as `The usage limit has been reached`. A provider error that Atomic does not recognize and that carries no status or code gets the same-model retries before it moves to a fallback, so a first unrecognized error never switches models. Without a fallback chain it fails at once.

A model named with `--model` on the command line runs as named. That session falls back only to the models `--fallback-models` names, never to this list, whether user or project. `--fallback-models` replaces this list for one run, and `--no-fallback` turns fallback off for one run. See [CLI model options](/reference/cli#model-options).

If `retry.enabled` is `false`, Atomic skips same-model retries and moves directly to the next fallback for retryable failures. Non-retryable task failures and cancellations do not trigger fallback. Press Esc during a retry wait or a model switch to stop the pending request. In a subagent chat, send a new message to continue.

A content-filter refusal, such as OpenAI's HTTP 422 `cyber_policy` ("This content was flagged for possible cybersecurity risk"), Anthropic's refusal stop, or a `content_filter` finish reason, also moves to the next fallback, without retrying the model that refused: the same request would be refused again. The refused model is recorded in the fallback history. Set `retry.fallbackOnContentFilter` to `false` to keep such a refusal on the model that gave it. Subagents follow the same setting for their own `fallbackModels`.

The fallback model and its thinking level remain active for later turns in the same main-chat session. Choose another model explicitly with `/model` or model cycle to change them.

A failure that another request to the same model cannot repair — a rejected credential, an unavailable model, a request that model cannot serve — takes that model out of the chain for the rest of the turn at **every** reasoning level, so a candidate that differs only by its `:low`/`:high` suffix is skipped rather than spent. Transient rate-limit and transport failures keep those reasoning variants, because retrying them can succeed.

A rejected credential takes the whole provider out of the chain for the rest of the turn. This includes HTTP 401, invalid request signatures, invalid or expired API keys, expired or invalid security tokens, suspended API consumers, and API keys blocked from the service or restricted by referrer, IP address, Android app, or iOS app. OpenAI's `invalid_api_key` under `invalid_request_error`, invalidated tokens, and `authentication_error` events without an HTTP status also count. The turn moves to the next model of another provider at once and never asks the rejecting provider again with the same credentials. A model-scoped HTTP 403, such as missing access to one model or provider moderation, blocks only that model and leaves other models on the same provider eligible.

A model whose provider has no credentials is skipped before any request. When the selected model has none, the turn starts on the chain's first model that has credentials, and the session's `model_change` entry records the move under `fallback`, with each model it skipped and why in `fallback.skipped` (`provider/model`, provider and reason, never a credential). A single model with no fallbacks, or a chain in which no model has credentials, fails at once with an error that names each model and the provider it needs; no other model runs in its place.

Context overflow keeps its normal recovery order: compaction runs first, and a compactable overflow costs no fallback candidate. Only once compaction is disabled, fails, or reports the overflow unresolved does Atomic advance to the next configured candidate, which is how a larger-context model gets a chance at the turn.

Changing the reasoning level after fallback is not a model choice, so the fallback model stays active with the reasoning level you selected. Only an explicit `/model` selection or model cycle changes the session model.

Fallback entries are written like `--model` and resolve the same way: `provider/model` or a bare model id, in any letter case, with an optional reasoning suffix. Ids that contain `/` or `:` themselves, such as OpenRouter's `qwen/qwen3-coder:exacto`, work as written. Fully qualified `provider/model` ids are clearest, because a bare id that several authenticated providers serve picks the current or default provider. Add a reasoning suffix to a candidate to override the effort for that fallback only; valid suffixes are `:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, and `:max`. Atomic clamps or hides levels that the selected model's capability map does not support.

A fallback can only use a model whose provider has credentials. Extension-registered providers work in `fallbackModels` and `--fallback-models` too. Atomic checks entries after extensions load and the active model is selected or restored, including after project trust approval. If extension loading, applying a model scope or restoring a saved model fails, it checks against the model that remains active, or the configured default provider when no model is selected. It warns once for each entry that matches no usable model, naming the entry. The chain skips it when a fallback is needed. Run `atomic --list-models` to see the available ids.

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

Fallback attempts are visible as model changes in the session transcript and as a fallback status in the UI. The model change records the model the turn asked for, the model that failed, and why. The fallback model's system prompt names the fallback model. In print mode (`-p`), each fallback is reported on stderr, and the run ends with `Model: ran on <fallback>, not the requested <model>.` Switching providers can change latency, billing, data-handling terms, and subscription/credit usage. Configure only providers you are comfortable sending the current conversation and tool context to.

`enabledModels` is separate: it only controls the interactive Ctrl+P model cycle list and is not used as an implicit fallback chain.

### Fast models

Fast inference is not a setting. Where a provider supports it, Atomic publishes a second selectable model whose canonical ID is the base model ID plus `-fast`, and you choose it the same way you choose any other model — in `/model`, as a startup default, in `fallbackModels`, in `enabledModels`, or in a subagent definition. Thinking suffixes work unchanged: `openai-codex/gpt-5.6-sol-fast:medium`.

Normal and fast IDs stay distinct everywhere, so `fallbackModels` can list both and each attempt is recorded separately:

```json
{
  "fallbackModels": [
    "openai-codex/gpt-5.6-sol-fast:medium",
    "openai-codex/gpt-5.6-sol:medium"
  ]
}
```

See [Providers](/providers#fast-models) for which providers publish fast variants, what each one sends upstream, and how an exact `-fast` model ID you own yourself takes precedence over the derived one.

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, `"system"`, a Catppuccin built-in, or custom). `"system"` derives its palette from the terminal; see [Themes](/themes) |
| `fullscreenScrollbar` | string | `"auto"` | Fullscreen transcript scrollbar: `"auto"` shows it temporarily while scrolling, `"always"` reserves the rightmost transcript column and keeps it visible, and `"hidden"` hides it. The thumb can be dragged when shown. `/tasks` transcripts show the same scrollbar, without dragging. |
| `fullscreenExitOutput` | string | `"transcript"` | Fullscreen exit output: `"transcript"` prints the final transcript and session resume hint, while `"resume-hint"` restores the terminal's previous screen and prints only the resume hint. Settable from `/settings` |
| `fullscreenCopyOnSelect` | boolean | `true` | Copy fullscreen text selections automatically on mouse release. When `false`, selection only highlights text. Ctrl+X does not copy; `/copy` copies the last assistant message. Settable from `/settings` |
| `fullscreenWheelScrollLines` | `"auto"` or number | `"auto"` | Lines per mouse-wheel tick in fullscreen views, including `/tasks` transcripts. `"auto"` uses terminal-aware scrolling; numeric values are clamped to 1–100. Settable from `/settings` |
| `quietStartup` | boolean or `"header"` | `false` | `true` hides the startup header. `"header"` keeps the startup header but hides the model scope line |
| `defaultProjectTrust` | string | `"ask"` | Fallback project trust behavior: `"ask"`, `"always"`, or `"never"`. Global setting only |
| `collapseChangelog` | boolean | `false` | Show a one-line update notice after updates instead of the What's New highlights; `/changelog` shows the full changelog |
| `enableInstallTelemetry` | boolean | `true` | Send a version-adoption ping on the first interactive launch with fresh settings, and on the first interactive launch after an update whose version has changelog entries. This does not control update checks |
| `firstRunOnboardingStartedVersion` | string | - | Managed onboarding state; leave unchanged |
| `onboardedVersion` | string | - | Managed onboarding completion state; leave unchanged |
| `teamJoin` | object | - | Managed record of the `storage` value `atomic team join` wrote. `atomic team leave` removes `storage` only while it still matches; leave unchanged |
| `enableAnalytics` | boolean | `false` | Opt in to analytics during first-run setup |
| `trackingId` | string | - | Locally generated analytics identifier when analytics is enabled |
| `deviceId` | string | - | Managed global installation identity, created only when a provider sign-in needs it. Project values are ignored |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `outputPad` | number | `1` | Horizontal transcript padding for messages, tool output, `!` command output, and summary blocks. `0` or `1` |
| `externalEditor` | string | - | Command for the Ctrl+G external editor; takes precedence over `$VISUAL`/`$EDITOR`. Defaults to Notepad on Windows and `nano` elsewhere |
| `autocompleteMaxVisible` | number | `5` | Max visible items in the default editor and custom editors installed through `ctx.ui.setEditorComponent()` (3-20) |
| `showHardwareCursor` | boolean | `false` | Use the terminal cursor instead of Atomic's drawn cursor. Atomic still positions it for IME support |

Interactive sessions use fullscreen, with the transcript above the docked editor and status area. Transcript scrolling, scrollbar dragging, and text selection remain available outside overlays. Overlay selections clear when returning to main chat and are not copied during that transition.

Transient notices stack while visible.

The alternate screen normally restores the terminal's prior contents on exit, so an interactive transcript does not remain in terminal scrollback. The `fullscreenExitOutput` setting changes what exiting prints: `"transcript"` (the default) paints the final transcript plus a session resume hint on the main screen, while `"resume-hint"` restores the previous screen and prints only the resume hint. Use `/export` before exit for an HTML copy, or resume the saved session later to review it in Atomic.

Ctrl+G uses `externalEditor`, then `$VISUAL`, then `$EDITOR`, then Notepad on Windows or `nano` elsewhere. This applies in main chat, embedded chat, and extension editor dialogs. Saving an empty edit clears the text; editor failure leaves the original unchanged. Atomic restores its interface after the editor exits.

### Debug mode

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `debug` | boolean | `false` | Turn on every debug output and write it to the debug log that `/debug` shows. Shown as **Debug mode** in `/settings`. Global setting only |

`--debug` and `ATOMIC_DEBUG=1` turn debug mode on for one run without changing the setting. While debug mode is on, the footer shows a `debug` badge.

Toggling **Debug mode** in `/settings` applies to new work at once, without a restart. Workers, the Intercom broker and other child processes that are already running keep the state they started with, and pick up the change the next time they start. See [Debugging](/development#debugging) for what each area writes.

### Telemetry and update checks

Version-adoption telemetry reports the running version on eligible interactive launches. It is separate from opt-in analytics.

`enableInstallTelemetry` controls this ping and Atomic's provider attribution headers; it does not control update checks. Atomic still fetches the npm registry latest package metadata at `https://registry.npmjs.org/@bastani/atomic/latest` unless update checks are disabled or offline mode is on.

Atomic sends one GET to `https://atomic-version-adoption.bastani-atomic.workers.dev/v1/version-adoption` with the running version as the `version` query parameter and the existing `atomic/<version> (<platform>; <runtime>; <arch>)` User-Agent. There is no request body, UUID, cookie, auth header, or user content.

The ping fires only in interactive mode, and only on:

- the first interactive launch with fresh settings (no recorded changelog version)
- the first interactive launch after an update whose version has changelog entries

It does not fire on every launch, on npm install, on a reinstall that kept settings, or in `-p` / RPC modes.

Atomic stores only UTC date, version, and an aggregate count, retained as aggregates. Cloudflare, the hosting provider, necessarily processes transient connection metadata (IP, TLS) to serve the request. That is not a promise of platform-wide zero logging.

Opt out by setting `enableInstallTelemetry` to `false` in `settings.json`, or by setting `ATOMIC_TELEMETRY=0` (`PI_TELEMETRY=0` remains a legacy alias). `ATOMIC_TELEMETRY=1`/`true`/`yes` forces the ping on even when the setting is false. `ATOMIC_TELEMETRY` wins when both it and `PI_TELEMETRY` are set.

Set `ATOMIC_SKIP_VERSION_CHECK=1` to disable the Atomic version update check. Use `--offline` or `ATOMIC_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, install/update telemetry, and model catalog refreshes. Legacy `PI_*` aliases are also supported for app-specific environment variables.

On a genuine first run, Atomic previews available themes and asks whether to opt into analytics. The choice and locally generated identifier are stored as `enableAnalytics` and `trackingId`; analytics remains off unless explicitly enabled.

### Network proxy

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `httpProxy` | string | - | HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY`. Global setting only. |

```json
{ "httpProxy": "http://127.0.0.1:7890" }
```

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable automatic compaction |
| `compaction.reserveTokens` | number | `16384` | Free context tokens below which automatic compaction starts: it runs when context usage exceeds the model's context window minus this reserve. Must be a non-negative safe integer |
| `compactionModel` | string | `"auto"` | `auto` or an empty value clears the context window and lets the agent recover from session history. An exact registered compactor model ID, such as `morph/morph-compactor`, compacts with that model instead. A saved chat or classifier model is reset to `auto` when a session starts. `/settings`: **Compaction model**. See [Compaction model](/compaction#compaction-model) |

```json
{
  "compactionModel": "auto",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384
  }
}
```

These compaction settings were removed and are ignored when present; settings still load without an error: `compaction.compression_ratio`, `compaction.preserve_recent`, `compaction.keepContextShare`, `compaction.query`, `compaction.planningTimeoutMs`, `compaction.modelOverrides`, `compaction.background`, `compaction.backgroundThresholdPercent` and `compaction.historyRecall`. See [Compaction](/compaction) for how compaction works now.

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved when selecting branch history; the provider sizes summary output |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Session Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionSummary.enabled` | boolean | `true` | Generate a one-line summary of each saved session for the `/resume` picker once the agent goes idle. `--no-session` sessions never generate one |

### Resume

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `resume.waitForBlueprint` | `"prompt"` \| `"tools"` | `"prompt"` in the TUI, `"tools"` without a UI | When a resume restores a worktree, what waits for its blueprint build. `"prompt"` opens the session once the build has finished. `"tools"` opens it and sends the first request while the build runs; every tool call waits for the build, and the first of them reports how it went. Unset, it is `"prompt"` in the interactive TUI and `"tools"` for `-p`, `--mode json`, `--mode rpc` and SDK sessions. See [Start the first turn while the build runs](/guides/resume-on-any-machine#start-the-first-turn-while-the-build-runs) |
| `resume.cache` | array | unset | Extra cache paths for [`atomic blueprint cache-key`](/guides/resume-on-any-machine#caches-for-runners), added to the package stores it detects from the repository's lockfiles. Each entry is `{ "paths": [...], "kind"?: "store" \| "build", "keyFiles"?: [...] }`: `"store"` (default) paths are absolute or under `~` and outside the repository; `"build"` paths are relative to the repository root. Paths that could hold credentials, globs and a leading `!` are refused with a warning. A project's list replaces the global one |
| `resume.setupCommand` | string | unset | Deprecated; remove it in favour of a blueprint. Kept for one release as an alias for one maintenance step of the global blueprint: the command runs in the root of each worktree restored on resume, or by a worker host for a pooled child, in a trusted project. A resume that builds a worktree prints a deprecation warning while it is set. Move the command into the `maintenance` section of `.atomic/blueprint.yaml`. Read from global settings only; a project's settings cannot set it. See [Set the environment up with a blueprint](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint) |

### Snapshots

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `snapshots.enabled` | boolean | `true` | Record worktree snapshots so sessions resume with their repository state |
| `snapshots.includeUntracked` | boolean | `true` | Capture untracked files that no ignore rule or deny pattern excludes |
| `snapshots.maxFileBytes` | number | `5242880` | Largest file a snapshot captures, in bytes |
| `snapshots.maxSnapshotBytes` | number | `52428800` | Largest total of captured content, and largest unpushed-commit bundle, in bytes |
| `snapshots.fullEvery` | number | `10` | Restart the patch chain from `HEAD` after this many snapshots |
| `snapshots.autoCollect` | boolean | `true` | Delete snapshot content nothing retains, in the background of an interactive session and after a session closes |
| `snapshots.collectIntervalSeconds` | number | `3600` | Shortest time between two automatic collections of one database, in seconds |
| `snapshots.graceSeconds` | number | `3600` | Snapshot content stored or reused less than this many seconds ago is never collected; `0` turns this protection off |
| `snapshots.pool.maxIdlePerRepository` | number | `2` | Idle restored worktrees kept per repository; a resume that restores another removes the oldest unchanged ones beyond it. See [Restored worktrees](/worktree-snapshots#restored-worktrees) |

See [Worktree snapshots](/worktree-snapshots).

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.maxAgentDelayMs` | number | `60000` | Maximum agent-level backoff delay (60s); `0` retries immediately |
| `retry.fallbackOnContentFilter` | boolean | `true` | Move to the next `fallbackModels` entry when a provider's content filter refuses a request (for example OpenAI's HTTP 422 `cyber_policy`), instead of retrying the same model. `false` retries the refusal on the same model and never falls back for it |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts. Leave unset/`0` to let Atomic's agent-level retry handle transient failures |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s); also caps how long an agent-level retry waits for a server retry hint |

Agent-level retries use exponential backoff capped by `retry.maxAgentDelayMs`, including main-chat retries and summary calls. When a failed response carries a server retry hint (`Retry-After-Ms` or `Retry-After` header, a Cloudflare 5xx `retry_after` body field, or a Google `RetryInfo.retryDelay` in the error body), Atomic waits as long as the server asks instead, up to `retry.provider.maxRetryDelayMs`. OpenAI, OpenAI-compatible, ChatGPT (Codex), Anthropic, Azure OpenAI, Mistral, Google (Generative AI and Vertex) and Amazon Bedrock providers report these hints. `retry.maxRetries` still limits the number of retries, so with the defaults a hinted outage can take up to about 3 × 60s before the turn fails or switches to a configured `fallbackModels` entry. Cloudflare 520-524 responses and connection resets count as transient errors; non-retryable 4xx and quota errors still stop immediately. This is independent of provider retry limits. Legacy `retry.maxDelayMs` still migrates to `retry.provider.maxRetryDelayMs`, not the agent cap.

A GitHub Copilot response that ends early after an attempt that ran 5 minutes or more is a long cut, and repeating it is likely to be cut again. A long cut gets one more retry, and a second one with no successful response in between stops retrying that model: the turn moves to the next `fallbackModels` entry when there is one, and otherwise ends with a message that suggests splitting the work into smaller steps, lowering the thinking effort or setting `fallbackModels`. Cuts after shorter attempts use the `retry.maxRetries` budget as above. Partial output is never replayed; each retry restarts the turn. See [GitHub Copilot errors](/providers#streams-cut-after-a-long-attempt).

**SDK retry deadline.** Pass `retryDeadline: performance.now() + budgetMs` alongside `signal` on a provider request, or in the fourth argument of `retryAssistantCall()`. Atomic won't start a backoff retry at or after that timestamp, even if a busy event loop hasn't delivered the abort yet. The timestamp is local to this process: don't use `Date.now()` or send it to another process. Keep passing `signal` to interrupt backoff and work already in flight. The deadline doesn't cancel the initial attempt.

If you own the timeout and need its specific abort reason, use `retryDeadline: { at, onExpired: () => controller.abort(reason) }`. The callback runs synchronously when Atomic refuses a retry. Without `retryDeadline`, retries keep their usual timing. Older SDK versions and providers that manage their own retries don't enforce this option.

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

`retry.provider.maxRetries` follows upstream Pi's behavior and defaults to `0` SDK/provider retries. Atomic still performs agent-level retries via `retry.maxRetries`; set `retry.provider.maxRetries` explicitly only when you want the underlying provider SDK to retry before Atomic observes the failure.

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
|---------|------|---------|-------------|
| `httpIdleTimeoutMs` | number or string | `600000` | HTTP idle timeout as milliseconds, a duration such as `"30s"`, `"5m"`, or `"1h"`, or `"disabled"`. `0` also disables it. |

Atomic applies this timeout to the global HTTP dispatcher used by `fetch` and provider SDK HTTP clients. The default is 600,000 ms (10 minutes), which keeps slow long-context requests working while reclaiming stale idle connections. Atomic does not impose a separate fixed connect-phase timeout; connection failures surface through the provider and agent retry/error paths.

The same value is the default wall-clock limit for one [structured decision](/sdk/structured-decisions#cancellation-and-failures): a `structured_output` call, a `generateStructuredOutput()` call, or a `decide()` call. The limit covers every repair attempt, retry, and fallback together, including time spent streaming. A disabled idle timeout leaves those calls effectively unbounded.

The `/settings` picker offers these presets:

| Label | Value |
|-------|-------|
| `30 sec` | `30000` |
| `1 min` | `60000` |
| `5 min` | `300000` |
| `10 min` | `600000` |
| `30 min` | `1800000` |
| `Disabled` | `"disabled"` (or `0`) |

```json
{
  "httpIdleTimeoutMs": 600000
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` |
| `httpIdleTimeoutMs` | number or string | `600000` | HTTP idle timeout in milliseconds, a duration string, or `"disabled"`; also used by providers with explicit stream idle timeouts. |
| `websocketConnectTimeoutMs` | number or string | `15000` | WebSocket connect/open handshake timeout; accepts milliseconds, a duration string, or `"disabled"`/`0` to disable. |
| `streamDeadlineMs` | number or string | `300000` | Maximum idle gap between two provider stream events, enforced below the HTTP layer; accepts milliseconds, duration strings such as `30s`, `5m`, or `1h`, or `"disabled"`/`0` to disable. A stream that stalls without an error — for example a response body that fails to decompress — is cut at this deadline and retried or failed over instead of hanging the request. Anthropic `ping` events count as activity, so a model that thinks silently while the server keeps the connection alive is not cut. |

Older settings with a boolean `websockets` value are migrated to `transport`: `true` becomes `"websocket"` and `false` becomes `"sse"` when `transport` is not already set.

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker). When unset, `ATOMIC_CLEAR_ON_SHRINK=1` enables it |
| `terminal.showTerminalProgress` | boolean | `false` | Show OSC 9;4 progress indicators in the terminal tab bar |
| `images.autoResize` | boolean | `true` | Resize oversized images to a 2000x2000 maximum. Applies to `@file` attachments, `read`, and images returned by tools |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |
| `terminal.hyperlinks` | boolean or `"auto"` | `"auto"` | JSON-only hyperlink capability override. `true`/`false` overrides detection; `"auto"`, omitted, and invalid values preserve detection. Not shown in `/settings` |
| `terminal.images` | `"kitty"`, `"iterm2"`, `"auto"`, or `false` | `"auto"` | JSON-only inline-image protocol override. `false` disables terminal images; `"auto"`, omitted, and invalid values preserve detection. Not shown in `/settings` |
| `terminal.trueColor` | boolean or `"auto"` | `"auto"` | JSON-only truecolor capability override. `true`/`false` overrides detection; `"auto"`, omitted, and invalid values preserve detection. Not shown in `/settings` |

The matching environment overrides are `ATOMIC_HYPERLINKS=1|0|auto`, `ATOMIC_IMAGE_PROTOCOL=kitty|iterm2|none|auto`, and `ATOMIC_TRUE_COLOR=1|0|auto`; their `PI_*` names are legacy aliases. Explicit JSON booleans/protocols take precedence over those environment values. Use `"auto"` or omit a JSON value to leave environment and terminal detection in control.
When `images.autoResize` is enabled, Atomic normalizes images before sending them to the model. Tool-result images are normalized after `tool_result` extension handlers run, so images an extension inserts receive the same limit; if processing fails, Atomic keeps the original image. Set it to `false` to preserve source dimensions.

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom Bash path (e.g., for Cygwin on Windows); does not select the PowerShell used by native Windows `!`/`!!` or the interactive subshell |
| `shellCommandPrefix` | string | - | Prefix for shell commands, including `!`/`!!`; use PowerShell syntax for native Windows interactive commands and Bash syntax elsewhere (e.g., `"shopt -s expand_aliases"`) |
| `search.contextBefore` | number | `1` | Number of context lines before each `search` match. |
| `search.contextAfter` | number | `3` | Number of context lines after each `search` match. |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |
| `selfUpdateCommand` | string[] | - | Command argv `atomic update` runs to update Atomic itself, with `{packageName}`, `{version}`, and `{installSpec}` placeholders. `ATOMIC_SELF_UPDATE_COMMAND` takes precedence. **Read only from the global settings file.** See [Custom update command](/reference/cli#custom-update-command) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

Package-manager wrapper commands must support Atomic's lookup operations.

On Windows, JSON paths must use forward slashes or escaped backslashes:

```json
{
  "shellPath": "C:/Program Files/Git/bin/bash.exe"
}
```

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

### Tools

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultTools` | string[] | - | Initial built-in tools. Plain names replace the defaults; `+name` and `-name` add or remove tools |
| `codemode.mode` | `"on"` or `"only"` | `"on"` | While codemode is active, `"on"` keeps direct tool declarations visible with script-call information; `"only"` hides ordinary direct callable declarations so the model uses scripts. Model-only tools remain directly available |
| `codemode.inlineBudget` | number | `3000` | Estimated token budget for inline script-tool declarations. Omitted tools remain discoverable with `searchTools()`. `0` lists namespaces without inline declarations |

`defaultTools` selects the built-in tools a session starts with. Extension and SDK custom tools retain their own activation behavior. Available built-ins include `read`, `bash`, `powershell`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`, and `ls`:

```json
{
  "defaultTools": ["bash", "edit", "write"]
}
```

On Windows, select `powershell` instead of `bash`, or include both:

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

An empty array starts with no coding tools while preserving extension/custom tools. `--tools` with plain names replaces this behavior with an allowlist including Intercom; modifier-only lists change the resolved selection instead. `--no-tools` disables every tool even with an allowlist or modifiers. `--no-builtin-tools` suppresses coding defaults when no allowlist is given. `--exclude-tools` filters the result, including Intercom.

A list containing only modifiers starts from Atomic's standard defaults. Modifiers are applied in order; adding an existing name or removing an absent one has no effect:

```json
{ "defaultTools": ["-bash", "+ls"] }
```

Plain names establish a replacement list before its modifiers apply. A project list of only modifiers layers over the global selection. A project list with plain names, or an empty list, replaces the global selection. For example, global `["read", "bash"]` plus project `["-bash", "+ls"]` resolves to `["read", "ls"]`.

`/reload` enables tools newly added to `defaultTools`. It does not disable removed tools or re-enable unchanged tools you turned off during the session. `--tools` with plain names, `--no-tools`, and `--no-builtin-tools` override the setting on reload too; excluded tools remain excluded. Modifier-only `--tools` lists apply on top of the reloaded setting, so a tool removed with `-name` stays removed.

`codemode` and `tool_search` are built-in extension tools registered inactive. Add `"+codemode"` or `"+tool_search"` to `defaultTools` to activate them alongside ordinary defaults. See [codemode](/tools#codemode) and [tool search](/tools#tool_search) for usage and safety boundaries.

### Tasks

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tasks.heartbeatMs` | number | `900000` | How often, in milliseconds, a running background shell or subagent sends its chat a [task heartbeat](/background-tasks#task-heartbeats). `0` turns heartbeats off; other values must be at least `60000`. An invalid value uses the default. A tool call's `heartbeatMs` overrides it for that task. |
| `tasks.heartbeatWakesIdleSession` | boolean | `true` | Whether a [task heartbeat](/background-tasks#task-heartbeats) that arrives while the chat is idle after an interrupt (Esc) starts a turn at once. When `false`, it waits for your next message, as Intercom messages and finished-task notices do. |

```json
{ "tasks": { "heartbeatMs": 1800000 } }
```

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessions.storage` | object | Local SQLite | Session-only storage selection: `{ "path": "..." }`, `{ "dir": "..." }`, `{ "memory": true }`, or `{ "adapter": "...", "options": {}, "secrets": {}, "prefix": "..." }`. |
| `storage` | object | Local SQLite | Storage selection for sessions when `sessions.storage` is unset. Accepts the same forms except `dir`. |

```json
{ "sessions": { "storage": { "path": "sessions.sqlite" } } }
```

Without configuration, sessions use `~/.atomic/workflows/journal.sqlite` with `session_` table names. If `ATOMIC_CODING_AGENT_DIR` changes the agent directory, the database lives under `<agentDir>/workflows/` inside that directory, unless that directory adopted an existing store in its parent directory `<parent>` from an earlier build (see [Storage home](/storage#storage-home)). JSONL is opt-in through `dir`, `--session-dir`, or `ATOMIC_CODING_AGENT_SESSION_DIR`. The `sessionDir` setting has been removed; use `sessions.storage.dir` instead.

Session precedence is SDK `sessionStore`, `--no-session`, `--session-dir` or `--session-store` (mutually exclusive CLI selections), `--storage` or `--storage-file`, `ATOMIC_SESSIONS_STORAGE` or non-empty `ATOMIC_CODING_AGENT_SESSION_DIR`, `ATOMIC_STORAGE`, `sessions.storage`, shared `storage`, then the default SQLite file. Empty environment values are ignored. Project selections replace global selections as whole objects, including options, secrets and prefix; fields are never merged. A present empty `sessions.storage` selects the default session database rather than inheriting `storage`. Relative settings paths resolve against the [storage home](/storage#storage-home) (`~/.atomic` by default, `<agentDir>` when `ATOMIC_CODING_AGENT_DIR` is customized, or `<parent>` for the single directory that adopted an existing parent store), and so do relative paths in the JSON selections of `--storage`, `ATOMIC_STORAGE`, and `ATOMIC_SESSIONS_STORAGE`. `--session-dir`, `--session-store`, and `ATOMIC_CODING_AGENT_SESSION_DIR` resolve against the working directory.

To select storage for one process without editing settings, pass the same JSON selection in `ATOMIC_STORAGE`, `ATOMIC_SESSIONS_STORAGE`, `--storage`, or `--storage-file`. See [Selecting storage per process](/storage#selecting-storage-per-process).

See [Choosing a store](/sessions#choosing-a-store) for CLI selection, prefix rules, and conflicts.

Only the selected setting is validated; invalid lower-precedence settings do not block an explicit override. `ATOMIC_STORAGE` and `ATOMIC_SESSIONS_STORAGE` are each validated when set, even when outranked. Memory must be selected explicitly and is lost on exit. Invalid selected configuration raises `StorageConfigError`, whose `source`, `field`, and `reason` identify the problem. If a selected store cannot open, Atomic raises a typed storage error rather than falling back to memory. See [Sessions](/sessions#session-storage) and [Storage errors](/storage#storage-errors).

### Models

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for CTRL+P cycling (same format as `--models` CLI flag). In interactive TTY startup, these patterns are resolved again after deferred extension/resource loading so extension-provided providers can match without blocking first paint. |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"],
  "fallbackModels": ["anthropic/claude-opus-4-8:xhigh", "github-copilot/gpt-5.5:high"]
}
```

`fallbackModels` is independent of `enabledModels`: it is consulted only after a retryable main-chat provider/model failure.

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |
| `markdown.mermaid` | string | `"streaming"` | Mermaid rendering mode: `"off"`, `"final"`, or `"streaming"` |
| `markdown.latex` | boolean | `true` | Render LaTeX expressions as terminal-friendly Unicode math |

Mermaid code blocks render as themed Unicode diagrams in interactive transcripts when they fit the available width. `"off"` keeps the Markdown fence, `"final"` renders only finalized responses, and `"streaming"` also renders partial assistant responses. Invalid or too-wide diagrams remain as code, and rendering is display-only: stored messages and model context keep the original Markdown. LaTeX rendering is also display-only and converts supported expressions to terminal-friendly Unicode math; set `markdown.latex` to `false` to keep the source form.

LaTeX rendering supports whitespace and matrix layouts.

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.atomic/agent/settings.json` resolve relative to `~/.atomic/agent`. Paths in `.atomic/settings.json` resolve relative to `.atomic`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

<a id="workflow-storage" />
<a id="local-worker-pools" />

Old `workflows` settings no longer configure execution. You can leave them in place: Atomic uses the path entries only to locate files for [conversion to skills](/orchestration/migrating-workflows). Ask to migrate or run a workflow; the agent reads the file as text and uses `skill-creator` to save a skill in the matching project or global skills directory. Startup does not create skills, and the original file stays untouched. Worker, journal, admission, and auto-advance options have no effect.

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### Storage adapters

To use your own database driver, install an adapter module, for example as an [Atomic package](/storage#adapters-from-atomic-packages), and select it by package name or module path. A package name also selects an adapter from a package directory the process was given with `--extension` or the SDK's `additionalExtensionPaths`, ahead of the packages in settings:

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

Use `sessions.storage` to override `storage` for sessions. A shared empty selection uses `storage.sqlite` under the [storage home](/storage#storage-home) (`~/.atomic/storage.sqlite` by default, or `<agentDir>/storage.sqlite` when `ATOMIC_CODING_AGENT_DIR` is customized). Atomic bundles no remote driver. Adapter modules execute code, so review them before trusting project settings. Secret references accept `{ "env": "VARIABLE" }` or `{ "file": "token.txt" }`; relative secret files resolve against the [storage home](/storage#storage-home) (falling back to the parent directory when an existing secret file lives there), and their contents are passed as written except for one trailing line ending (`\n` or `\r\n`), which is removed. See [Storage adapters](/storage#selecting-an-adapter).

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

Set `autoload` to `false` on an object-form package entry to start that package with no discovered resources and apply only its explicit `extensions`, `skills`, `prompts`, `themes`, or `mcpServers` patterns. This is useful when a package contains resources you do not want to load by default.

See [Atomic packages](/packages) for package management details.

## Example

Moved to [Configure Atomic](/guides/configuration#example).

## Project Overrides

Moved to [Configure Atomic](/guides/configuration#project-overrides).
