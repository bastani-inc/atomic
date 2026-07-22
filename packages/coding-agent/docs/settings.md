# Settings

Atomic uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.atomic/agent/settings.json` | Global (all projects) |
| `.atomic/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options. Atomic also reads legacy `~/.pi/agent/settings.json` and `.pi/settings.json` as compatibility fallbacks, with `.atomic` paths taking precedence.

## Project Trust

On interactive startup, Atomic asks before trusting a project folder that contains trust-gated project inputs and has no saved decision for the folder or a parent folder in `~/.atomic/agent/trust.json`. Trusting a project allows Atomic to load project-local `.atomic/settings.json` and `.atomic` resources, legacy `.pi/settings.json` and `.pi` resources, project-local context files, install missing project packages, and execute project extensions.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore trust-gated project inputs, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.atomic/agent/settings.json`, or change it with `/settings`.

`atomic config` and package commands use the same project trust flow. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.atomic/agent/trust.json` only; the current session is not reloaded, so restart Atomic for changes to take effect.

If a bare directory starts without trust-gated inputs, Atomic may run the interactive session as implicitly trusted. Inert state directories such as `.atomic/todos/` and `.atomic/sessions/` do not require trust and do not disable deferred resource startup. On the normal interactive TTY fast path, Atomic paints the shell and makes the input editor responsive before scanning bundled extension packages, skills, prompts, themes, context files, and system-prompt files. After the input handler is ready, Atomic starts extension/resource loading in the background. If the first submitted prompt arrives before that loading settles, Atomic keeps the prompt spinner visible and waits at the readiness gate before calling the model so extension tools, prompt templates, skills, resources, and extension-registered provider updates are available on that first turn. Deferred loading uses async discovery and cooperative yields around resource-loading work, so visible typing, Enter, Ctrl+C, rendering, and the normal prompt spinner remain responsive while the background work finishes. Startup does not show a resource-loading spinner before the user submits a prompt. Explicit provider/model selection, explicit resource flags, system-prompt inputs, metadata commands, non-TTY modes, and unresolved project-trust prompts stay on the synchronous path because those operations need complete resources before the session is created. When resources finish loading, Atomic shows the normal resources disclosure so newly added skills, prompts, themes, and extensions are visible. If trust-requiring config appears later, Atomic prompts again on the next launch until you explicitly save a persistent trust decision; the only automatic persistence of implicit startup trust is the existing `/reload` flow after reload discovers trust-requiring resources in an already-trusted session.

Settings and trust JSON files may start with a UTF-8 BOM, as commonly written by older Windows tools; Atomic strips that leading marker before parsing.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`; the active model must support the selected level |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |
| `showCacheMissNotices` | boolean | `false` | Show transcript notices for significant prompt-cache misses and their attributed wasted tokens |
| `fallbackModels` | string[] | - | Ordered main-chat fallback models, written as `"provider/model"` with optional model-supported reasoning suffixes such as `:high`, `:xhigh`, or `:max` |

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

`fallbackModels` gives ordinary main-chat turns an ordered model fallback chain. Atomic starts with the selected/default model. If that model exhausts the normal same-model auto-retry loop for a retryable provider/model failure — including rate limits and quota/usage-limit exhaustion such as a provider reporting `The usage limit has been reached` — Atomic switches to the next configured fallback model and continues the same turn. If `retry.enabled` is `false`, Atomic skips same-model retries and moves directly to the next fallback for retryable failures. Non-retryable task failures, cancellations, and context-overflow compaction paths do not trigger model fallback.

Fallback entries should be fully qualified `provider/model` ids. Add a reasoning suffix to a candidate to override the effort for that fallback only; valid suffixes are `:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, and `:max`. Atomic clamps or hides levels that the selected model's capability map does not support.

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

Fallback attempts are visible as model changes in the session transcript and as a fallback status in the UI. Switching providers can change latency, billing, data-handling terms, and subscription/credit usage. Configure only providers you are comfortable sending the current conversation and tool context to.

`enabledModels` is separate: it only controls the interactive Ctrl+P model cycle list and is not used as an implicit fallback chain.

### Codex Fast Mode

Use `/fast` in interactive mode to edit these settings. Atomic applies fast mode only to supported `openai/*` and `openai-codex/*` providers, not `github-copilot/*` or other OpenAI-compatible providers. Chat and workflow-stage scopes are independent. When fast mode is active for the current supported model, Atomic shows `fast` after the model name in the chat footer and workflow stage model labels. Enable the workflow scope deliberately for broad fan-outs because each eligible stage can consume priority-tier requests.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `codexFastMode.chat` | boolean | `false` | Use OpenAI priority service tier for supported normal chat requests |
| `codexFastMode.workflow` | boolean | `false` | Use OpenAI priority service tier for supported workflow-stage requests |

```json
{
  "codexFastMode": {
    "chat": true,
    "workflow": false
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, a Catppuccin built-in, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `defaultProjectTrust` | string | `"ask"` | Fallback project trust behavior: `"ask"`, `"always"`, or `"never"`. Global setting only |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableInstallTelemetry` | boolean | `true` | Send an anonymous install/update version ping after first install or changelog-detected updates. This does not control update checks |
| `firstRunOnboardingStartedVersion` | string | - | Internal first-run onboarding start marker used when no prior Atomic startup state identifies the user as returning |
| `onboardedVersion` | string | - | Internal one-time first-run onboarding completion marker. Returning-user detection from prior startup state or displaying the first-run workflow-engine explanation sets it |
| `enableAnalytics` | boolean | `false` | Opt in to analytics during first-run setup |
| `trackingId` | string | - | Locally generated analytics identifier when analytics is enabled |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `outputPad` | number | `1` | Horizontal padding for chat message output (user messages, assistant messages, thinking blocks). `0` or `1` |
| `externalEditor` | string | - | Command for the Ctrl+G external editor; takes precedence over `$VISUAL`/`$EDITOR`. Defaults to Notepad on Windows and `nano` elsewhere |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |

### Telemetry and update checks

`enableInstallTelemetry` only controls the anonymous install/update ping to `https://pi.dev/api/report-install`. Opting out of telemetry does not disable update checks; Atomic can still fetch the npm registry latest package metadata at `https://registry.npmjs.org/@bastani/atomic/latest` to look for the latest version.

Set `ATOMIC_SKIP_VERSION_CHECK=1` to disable the Atomic version update check. Use `--offline` or `ATOMIC_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry. Legacy `PI_*` aliases are also supported for app-specific environment variables.


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
| `compaction.enabled` | boolean | `true` | Enable automatic verbatim line compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for the next model response; automatic threshold compaction begins before this reserve is consumed |
| `compaction.compression_ratio` | number | `0.5` | Fraction of compactable transcript **lines to keep** (`0 < value < 1`) |
| `compaction.preserve_recent` | number | `2` | Exact number of newest context-visible messages kept outside the compactable region; `0` keeps none |
| `compaction.query` | string | last user message | Optional relevance focus for selecting older lines to retain |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "compression_ratio": 0.5,
    "preserve_recent": 2,
    "query": "optional focus"
  }
}
```

The model emits numbered line ranges only; Atomic reconstructs retained text mechanically. `preserve_recent` is enforced client-side and is not a provider parameter. Atomic does not widen this exact message count to a user-turn boundary or force a final logical turn to remain outside compaction.

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts. Leave unset/`0` to let Atomic's agent-level retry handle transient failures |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

`retry.provider.maxRetries` follows upstream Pi's behavior and defaults to `0` SDK/provider retries. Atomic still performs agent-level retries via `retry.maxRetries`; set `retry.provider.maxRetries` explicitly only when you want the underlying provider SDK to retry before Atomic observes the failure.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
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
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connect/open handshake timeout in milliseconds for providers that support WebSocket transports. Set to `0` to disable. |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `bashInterceptor.enabled` | boolean | `false` | When true, block shell commands that have dedicated tools and offer remaining `bash` tool calls to `user_bash` extension handlers before local execution. Also available in `/settings` as **Bash Interceptor**. |
| `search.contextBefore` | number | `1` | Number of context lines before each `search` match. |
| `search.contextAfter` | number | `3` | Number of context lines after each `search` match. |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`bashInterceptor.enabled` is intentionally `false` unless configured. Enable it from `/settings` or set it to `true` in JSON when you want Atomic to steer shell anti-patterns to `read`/`search`/`find`/`edit`/`write` and let extensions intercept model `bash` tool calls through the same `user_bash` event used by interactive `!` commands.

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

Normally the package manager's global modules location is queried using `root -g`. As a special case, if the first element of `npmCommand` is `"bun"`, the modules location will instead be queried with `pm bin -g`.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".atomic/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `ATOMIC_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

### Models

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for CTRL+P cycling (same format as `--models` CLI flag). In interactive TTY startup, these patterns are resolved again after deferred extension/resource loading so extension-provided providers can match without blocking first paint. |
| `defaultContextWindow` | number \| string | model default | Optional global fallback context window for models that expose selectable context windows. Accepts raw token counts or compact labels such as `400k` and `1m`. Unsupported values are ignored for models that do not support them. |
| `defaultContextWindows` | object | `{}` | Per-model preferred context windows keyed as `provider/modelId`. The interactive `/model` context picker writes this setting so a Copilot-specific prompt cap such as `936k` does not leak into Anthropic, Cursor, or other providers. |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"],
  "fallbackModels": ["anthropic/claude-opus-4-8:xhigh", "github-copilot/gpt-5.5:high"],
  "defaultContextWindow": "1m",
  "defaultContextWindows": {
    "github-copilot/claude-opus-4.8": "936k",
    "github-copilot/claude-sonnet-5": "936k",
    "github-copilot/gpt-5.5": "922k"
  }
}
```

Context-window settings are independent of `defaultThinkingLevel`: selecting a larger context window does not change reasoning effort. Interactive users can change the active model's budget through the `/model` selection flow, which prompts for a context window whenever the chosen model supports more than one window and persists the effective selection under `defaultContextWindows["provider/modelId"]`. Atomic treats `defaultContextWindow` as a broad fallback only: if the active model does not support that value, the model's own default is used without a startup warning; targeted `defaultContextWindows` entries still warn when they become unsupported for their exact model. Larger provider context windows can carry higher usage cost. For catalog-advertised GitHub Copilot long-context models (including dynamically populated plain catalog ids such as `github-copilot/claude-sonnet-5`, while namespaced enterprise deployment ids containing `/` are skipped), selecting `1m` raises Atomic's local prompt budget to the largest advertised long-context tier at or below that rounded request (for example `922k` or `936k`) and sends `X-GitHub-Api-Version: 2026-06-01`; GitHub then applies the long-context tier server-side by prompt token count. That tier consumes more Copilot AI credits and requires Copilot long-context/usage-based billing entitlement, otherwise requests over the server cap are rejected with a friendly hint. Custom providers and explicit model overrides can still declare their own selectable `contextWindowOptions`.

`fallbackModels` is independent of both context-window defaults and `enabledModels`: it is consulted only after a retryable main-chat provider/model failure, and each fallback candidate applies its own model-specific context-window defaults when selected.

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, themes, and workflows from.

Paths in `~/.atomic/agent/settings.json` resolve relative to `~/.atomic/agent`. Paths in `.atomic/settings.json` resolve relative to `.atomic`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `workflows` | string[] | `[]` | Local workflow file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

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
      "extensions": [],
      "workflows": []
    }
  ]
}
```

See [Atomic packages](/packages) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "defaultContextWindow": "400k",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "compression_ratio": 0.5,
    "preserve_recent": 2
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "httpIdleTimeoutMs": 300000,
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"],
  "workflows": ["./workflows/*.ts"]
}
```

## Project Overrides

Project settings (`.atomic/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.atomic/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .atomic/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
