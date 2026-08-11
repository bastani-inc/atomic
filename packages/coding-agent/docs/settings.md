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
| `fallbackModels` | string[] | - | Ordered fallback models, written as `"provider/model"` with optional model-supported reasoning suffixes such as `:high`, `:xhigh`, or `:max`. Used by main-chat turns and, since compaction fallback rungs, borrowed for compaction planner requests |

`defaultProvider` and `defaultModel` form one exact saved selection when both are present. Atomic waits for built-in, configured, and extension provider registration before classifying that provider. If it remains unsupported, Atomic does not silently switch providers: interactive mode stays live with a generic configuration warning; print and JSON modes write the warning to stderr and exit nonzero before prompting (with JSON stdout remaining JSONL-clean); and RPC rejects `prompt` until a successful explicit `set_model` selects an available model or an explicit model cycle returns a different available model. A null or unchanged cycle does not clear the condition. If the provider is supported but its saved model is unknown or lacks configured authentication, normal automatic selection of an available authenticated model remains enabled; the same is true when either field is omitted. Valid extension-provider defaults can resolve after deferred extension loading. Update an unsupported pair or choose a model with `/model`.

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

`fallbackModels` gives ordinary main-chat turns an ordered model fallback chain. Atomic starts with the selected/default model. If that model exhausts the normal same-model auto-retry loop for a retryable provider/model failure — including rate limits and quota/usage-limit exhaustion such as a provider reporting `The usage limit has been reached` — Atomic switches to the next configured fallback model and continues the same turn. If `retry.enabled` is `false`, Atomic skips same-model retries and moves directly to the next fallback for retryable failures. Non-retryable task failures and cancellations do not trigger model fallback. After a successful or exhausted fallback turn, Atomic restores the user-selected primary before the next user turn; an explicit `/model` choice during fallback cancels that restore.

A failure that another request to the same model cannot repair — a rejected credential, an unavailable model, a request that model cannot serve — takes that model out of the chain for the rest of the turn at **every** reasoning level, so a candidate that differs only by its `:low`/`:high` suffix is skipped rather than spent. Transient rate-limit and transport failures keep those reasoning variants, because retrying them can succeed.

Context overflow keeps its normal recovery order: compaction runs first, and a compactable overflow costs no fallback candidate. Only once compaction is disabled, fails, or reports the overflow unresolved does Atomic advance to the next configured candidate, which is how a larger-context model gets a chance at the turn.

Changing the reasoning level during a fallback turn is not a model choice, so it does not cancel the restore: the next turn still starts on the user-selected primary, carrying the reasoning level you picked. Only an explicit `/model` selection or model cycle cancels it.

The same list is also **borrowed by compaction**. When the compaction range planner cannot produce a usable plan on the current model — a rate limit, quota exhaustion, provider error, context overflow, or an empty plan — Atomic runs one planner request against the next configured candidate, using that candidate's own credentials. **A configured fallback model may therefore receive the compaction transcript.** Borrowing is planner-only: it never changes the session model, thinking level, or model history, it appends no model-change entry, and it emits no fallback status. See [Compaction](/compaction#planning-rungs-and-failure-behavior).

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
| `fullscreenScrollbar` | string | `"auto"` | Fullscreen transcript scrollbar: `"auto"` shows it temporarily while scrolling, `"always"` reserves the rightmost transcript column and keeps it visible, and `"hidden"` hides it. The thumb can be dragged when shown. |
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
| `autocompleteMaxVisible` | number | `5` | Max visible items in the default editor and custom editors installed through `ctx.ui.setEditorComponent()` (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |

Interactive sessions always use the fullscreen renderer. The transcript scrolls in its own viewport while the editor, status line, usage meter, extension widgets, and footer stay docked at the bottom. Wheel and trackpad gestures go first to a focused workflow overlay, including workflow graphs and stage chats. Events that overlay does not consume fall through to the alternate-screen viewport; non-overlay focused components leave mouse input with pi-tui so transcript scrolling, scrollbar interaction, and drag selection remain available.

The fullscreen renderer keeps minimum sizes for nested layout stacks during resize, and transient fullscreen notices stack instead of replacing a notice that is still visible.

The alternate screen restores the terminal's prior contents on exit, so an interactive transcript does not remain in terminal scrollback. Use `/export` before exit for an HTML copy, or resume the saved session later to review it in Atomic.

Ctrl+G in main chat, embedded chat, and extension editor dialogs uses one shared asynchronous launcher. Atomic chooses `externalEditor`, then `$VISUAL`, then `$EDITOR`, then Notepad on Windows or `nano` elsewhere. Each edit uses a private `atomic-editor-*` directory containing only `prompt.md`, removes the directory recursively afterward, and never scans the system temporary directory. A successful empty edit is preserved; a failed editor leaves the original text unchanged, and the TUI always restarts and renders after the editor exits.

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
| `websocketConnectTimeoutMs` | number or string | `15000` | WebSocket connect/open handshake timeout; accepts milliseconds, a duration string, or `"disabled"`/`0` to disable. |

Older settings with a boolean `websockets` value are migrated to `transport`: `true` becomes `"websocket"` and `false` becomes `"sse"` when `transport` is not already set.

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `terminal.showTerminalProgress` | boolean | `false` | Show OSC 9;4 progress indicators in the terminal tab bar |
| `images.autoResize` | boolean | `true` | Resize oversized images to a 2000x2000 maximum. Applies to `@file` attachments, `read`, and images returned by tools |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

When `images.autoResize` is enabled, Atomic normalizes images before sending them to the model. Tool-result images are normalized after `tool_result` extension handlers run, so images an extension inserts receive the same limit; if processing fails, Atomic keeps the original image. Set it to `false` to preserve source dimensions.

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

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"],
  "fallbackModels": ["anthropic/claude-opus-4-8:xhigh", "github-copilot/gpt-5.5:high"]
}
```

`fallbackModels` is independent of `enabledModels`: it is consulted only after a retryable main-chat provider/model failure or a terminal compaction planner outcome.

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |
| `markdown.mermaid` | string | `"streaming"` | Mermaid rendering mode: `"off"`, `"final"`, or `"streaming"` |
| `markdown.latex` | boolean | `true` | Render LaTeX expressions as terminal-friendly Unicode math |

Mermaid code blocks render as themed Unicode diagrams in interactive transcripts when they fit the available width. `"off"` keeps the Markdown fence, `"final"` renders only finalized responses, and `"streaming"` also renders partial assistant responses. Invalid or too-wide diagrams remain as code, and rendering is display-only: stored messages and model context keep the original Markdown. LaTeX rendering is also display-only and converts supported expressions to terminal-friendly Unicode math; set `markdown.latex` to `false` to keep the source form.

The installed pi-tui 0.84.1 LaTeX renderer also handles whitespace and matrix layouts correctly.

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

Set `autoload` to `false` on an object-form package entry to start that package with no discovered resources and apply only its explicit `extensions`, `skills`, `prompts`, `themes`, or `workflows` patterns. This is useful when a package contains resources you do not want to load by default.

See [Atomic packages](/packages) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
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

Project settings (`.atomic/settings.json`) override global settings. Nested objects merge recursively; arrays and scalar values replace global values:

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
