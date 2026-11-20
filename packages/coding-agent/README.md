<p align="center">
  <a href="https://github.com/bastani-inc/atomic">
    <img alt="Atomic" src="https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/docs/logo.svg" width="324">
  </a>
</p>

<p align="center">
  <b>Terminal coding-agent runtime with codemode, subagents, MCP, web access, and Intercom.</b>
</p>

<p align="center">
  <a href="https://docs.bastani.ai/"><img alt="Docs" src="https://img.shields.io/badge/docs-atomic-blue?style=flat-square" /></a>
  <a href="https://discord.gg/9CvdXUGXR4"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@bastani/atomic"><img alt="npm" src="https://img.shields.io/npm/v/@bastani/atomic?style=flat-square" /></a>
  <a href="https://github.com/bastani-inc/atomic"><img alt="GitHub" src="https://img.shields.io/badge/github-bastani--inc%2Fatomic-181717?style=flat-square&logo=github" /></a>
</p>

---

Atomic is a terminal coding-agent runtime. Use built-in tools for file edits and shell commands, codemode to script multi-step checks, and subagents to delegate work to isolated contexts. Extend Atomic with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes), or bundle and share them as [Atomic Packages](#atomic-packages) via npm or git.

Atomic bundles first-party integrations for subagents, MCP, web access, and Intercom. See [Orchestration](docs/orchestration.md) for multi-step tasks and [Migrating workflows](docs/orchestration/migrating-workflows.md) to convert an earlier workflow file to a skill.

Run Atomic interactively, in print or JSON mode, over RPC for process integration, or embedded via the TypeScript SDK.

Full documentation: [docs.bastani.ai](https://docs.bastani.ai/) · Contributing: [CONTRIBUTING.md](https://github.com/bastani-inc/atomic/blob/main/CONTRIBUTING.md)

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Atomic Packages](#atomic-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

Install globally with npm or Bun:

```bash
npm install -g @bastani/atomic
# or: bun install -g @bastani/atomic
```

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
atomic
```

Or sign in with an existing subscription:

```bash
atomic
/login   # Select a provider
```

By default, Atomic provides built-in coding tools (`read`, `bash`, `kill`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`, `codemode`, plus `powershell` on native Windows when available). `edit` performs exact-text replacement without requiring an earlier `read`; see [docs/tools.md](docs/tools.md).

**Platform guides:** [Windows](docs/windows.md) | [Alpine/musl Linux](docs/getting-started/installation.md#alpine-and-musl-linux-archives) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

Atomic ships a curated list of tool-capable models for each built-in provider. Authenticate via `/login` or an API key, then pick any model with `/model` (`Ctrl+L`).

**Subscriptions (`/login`):**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot
- OpenRouter (browser PKCE, optional key minting)
- Kimi Code (device authorization with token refresh)
- xAI (Grok/X subscription)

**API keys:**
Anthropic, Ant Ling, OpenAI, Azure OpenAI, DeepSeek, NVIDIA NIM, Google Gemini, Google Vertex, Amazon Bedrock, Mistral, Groq, Cerebras, Cloudflare AI Gateway, Cloudflare Workers AI, xAI, OpenRouter, Vercel AI Gateway, ZAI, ZAI Coding Plan (China), OpenCode Zen, OpenCode Go, Hugging Face, Fireworks, Together AI, Baseten, Kimi For Coding, Meta, MiniMax, MiniMax (China), Moonshot AI, Moonshot AI (China), Qwen Token Plan, Qwen Token Plan (Individual), Qwen Token Plan (China), Xiaomi MiMo, Xiaomi MiMo Token Plan (China / Amsterdam / Singapore).

See [docs/providers.md](docs/providers.md) for provider setup and environment variables.

**Model runtime capabilities:**
- **Constrained tool sampling:** Model-capability-aware strict JSON-schema and OpenAI Lark/regex tool sampling. Unsupported `require` constraints fail instead of silently downgrading; RPC model listings expose flags via `ModelInfo.compat`. See [extensions](docs/extensions/authoring.md#constrained-sampling) and [RPC](docs/rpc/protocol.md#get_available_models).
- **Bearer auth for Anthropic:** Setting `ANTHROPIC_AUTH_TOKEN` enables Anthropic models using header-only bearer auth (no synthesized `x-api-key`) across chat and summary/compaction requests.
- **Custom providers & models:** Add OpenAI-, Anthropic-, or Google-compatible providers in the active agent directory's `models.json` (normally `~/.atomic/agent/models.json`; not merged with legacy `.pi`). Supports `samplingParams`, `compat.supportsThinkingTokenBudget`, `compat.supportsFinishReason`, and persisted `llama.cpp` models. Use extensions for custom APIs or OAuth. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The fullscreen TUI has four areas from top to bottom:

- **Startup header** — keybinding hints (`/hotkeys` for all), loaded context files, prompt templates, skills, and extensions.
- **Messages** — prompts, responses, tool calls and results, notices, errors, and extension UI.
- **Editor** — input box; border color reflects thinking level, and a status row shows streaming activity.
- **Footer** — working directory, session name, token/cache usage, cost, context usage, and active model.

[Extensions](#extensions) can replace the editor, show temporary UI (such as `/settings` or Q&A selectors), or add widgets, status lines, custom footers, and overlays.

### Editor

| Feature | How |
| --- | --- |
| File reference | Type `@` to fuzzy-search project files |
| Path completion | `Tab` to complete paths |
| Multi-line | `Shift+Enter` (or `Ctrl+Enter` on Windows Terminal) |
| Images | `Ctrl+V` (`Alt+V` on Windows) or drag onto terminal |
| Shell commands | `!command` runs and sends output to the model; `!!command` runs without sending output |

See [docs/keybindings.md](docs/keybindings.md) for editing shortcuts.

### Commands

Type `/` in the editor to open commands. [Extensions](#extensions) register custom commands, [skills](#skills) run as `/skill:<name>`, and [prompt templates](#prompt-templates) expand as `/<template>`.

| Command | Description |
| --- | --- |
| `/login`, `/logout` | OAuth and API key authentication |
| `/model` | Switch model and save as the startup default |
| `/thinking` | Switch thinking level and save as the startup default |
| `/scoped-models` | Enable or disable models for `Ctrl+P` cycling |
| `/settings` | Edit theme, message delivery, transport, and other preferences |
| `/resume` | Pick a previous session |
| `/new` | Start a new session |
| `/name <name>` | Set the session display name |
| `/session` | Show session ID, file, messages, tokens, and cost |
| `/tree` | Jump to any point in the session and branch from there |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the active branch into a new session |
| `/compact [instructions]` | Clear the context window; the agent recovers needed details from history |
| `/copy` | Copy the last assistant message to clipboard |
| `/export [file]` | Export the session to HTML |
| `/share` | Upload as a private GitHub gist with a shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files (themes hot-reload automatically) |
| `/hotkeys` | List all keyboard shortcuts |
| `/changelog` | Show version history |
| `/exit`, `/quit` | Exit Atomic |

### Keyboard Shortcuts

Run `/hotkeys` for the full list. Customize in `~/.atomic/agent/keybindings.json` (or under `ATOMIC_CODING_AGENT_DIR`). See [docs/keybindings.md](docs/keybindings.md).

| Key | Action |
| --- | --- |
| `Ctrl+C` | Interrupt active or queued work; when idle, clear editor |
| `Ctrl+C` twice (idle) | Quit |
| `Escape` | Abort active work and hold queued messages |
| `Escape` twice | Open `/tree` |
| `Ctrl+L` | Open model selector |
| `Ctrl+P` / `Shift+Ctrl+P` | Cycle scoped models forward / backward |
| `Shift+Tab` | Cycle thinking level |
| `Ctrl+O` | Collapse or expand tool output |
| `Ctrl+T` | Collapse or expand thinking blocks |
| `Ctrl+G` | Open the current editor buffer in your external editor |

### Message Queue

Send messages while the agent is still working:

- **`Enter`** queues a *steering* message, delivered after the current turn's tool calls finish.
- **`Alt+Enter`** queues a *follow-up* message, delivered after the agent finishes all work. (On Windows Terminal, remap `Alt+Enter` from fullscreen first; see [docs/terminal-setup.md](docs/terminal-setup.md).)
- **`Escape`** or **`Ctrl+C`** aborts active work and pauses queued messages in place. Sending the next regular message resumes held messages once in order. While idle, `Ctrl+C` clears the editor and a second quick press quits without releasing held messages.
- **`Alt+Up`** pulls queued messages back into the editor instead of resuming them.

Configure `steeringMode` and `followUpMode` (`"one-at-a-time"` default, or `"all"`) and `transport` (`"sse"`, `"websocket"`, `"websocket-cached"`, `"auto"`) in [settings](docs/settings.md).

---

## Sessions

Sessions store an append-only tree of entries (`id` and `parentId`), enabling in-place branching in one session. See [docs/session-format.md](docs/session-format.md).

### Management

Sessions auto-save per working directory in the default local SQLite store (`~/.atomic/workflows/journal.sqlite`; legacy `~/.atomic/agent/sessions/` and `~/.pi/agent/sessions/` JSONL files remain readable).

```bash
atomic -c                    # Continue the most recent session
atomic -r                    # Browse and pick a past session
atomic --no-session          # No resumable session (released history may use disk)
atomic --session <id|prefix> # Open an exact ID or unique 8-hex UUID prefix
atomic --import <file>       # Import a format-4 JSONL export into storage
atomic --session-id <id>     # Open or create an exact project-local session ID
atomic --name "Refactor"     # Set the session display name
atomic --fork <id|prefix>    # Fork an exact ID or unique 8-hex UUID prefix
```

Run `/session` interactively to copy the current session ID for `--session`, `--session-id`, or `--fork`.

### Branching

- **`/tree`** — Jump to any earlier entry and continue on a new branch without creating a new session.
  - Type to search, `Ctrl+←`/`Ctrl+→` or `Alt+←`/`Alt+→` to fold/jump branches, `←`/`→` to page.
  - `Ctrl+O` cycles filters (`default` → `no-tools` → `user-only` → `labeled-only` → `all`).
  - `Shift+L` bookmarks an entry with a label; `Shift+T` toggles label timestamps.
- **`/fork`** — Pick an earlier user message on the active branch, copy the path up to it into a new session, and load that prompt into the editor.
- **`/clone`** — Duplicate the full active branch into a new session at the current point.
- **`--fork <id|prefix>`** — Fork an existing session from the CLI into the current project.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

### Compaction

When a session approaches the context limit, compaction clears the active context window without a model call by default. Atomic leaves a recovery pointer telling the agent where earlier history lives and what to recover first (`<keepContext>` spans, requests, and constraints) using `read` and `search`. Setting `compactionModel` (such as `morph/morph-compactor`) replaces the context with that model's summary instead.

- **Manual:** `/compact [instructions]` (instructions guide what the agent recovers first).
- **Automatic:** Enabled by default on context overflow (compacts and retries once) or near the limit. Configure in `/settings` or `settings.json`.
- **Full history stays intact:** Use `/tree` to revisit earlier entries. See [docs/compaction.md](docs/compaction.md).

Extensions can hide or replace an earlier message for future model turns using `context_edit` without altering raw history or usage records (Atomic uses the same mechanism when retrying a failed attempt):

```typescript
const assistantId = sessionManager.appendMessage(partialAssistant);
sessionManager.appendContextEdit(assistantId, null); // Omitted from model context, kept in history.
```

---

## Settings

Use `/settings` interactively, or edit JSON files directly:

| Location | Scope |
| --- | --- |
| `~/.atomic/agent/settings.json` | Global (legacy `~/.pi/agent/settings.json` also works) |
| `.atomic/settings.json` | Project override (legacy `.pi/settings.json` also works once trusted) |

See [docs/settings.md](docs/settings.md) for every option and default.

### Telemetry and update checks

Atomic runs two independent startup network checks:

- **Update check:** Checks for a newer Atomic release. Disable with `ATOMIC_SKIP_VERSION_CHECK=1` (legacy `PI_SKIP_VERSION_CHECK=1`).
- **Version-adoption telemetry:** Sends one bodyless `GET` request to `https://atomic-version-adoption.bastani-atomic.workers.dev/v1/version-adoption?version=<version>` with the standard `atomic/<version> (<platform>; <runtime>; <arch>)` User-Agent (no UUID, cookie, auth header, or user data).
  - **When it fires:** Interactive mode only, and only on the first launch with fresh settings or the first launch after upgrading to a version with changelog entries. Never on every launch, npm install, reinstall keeping settings, or `-p`/RPC modes.
  - **What is stored:** UTC date, version, and aggregate count (Cloudflare processes standard transient IP/TLS metadata to serve the request).
  - **Opt out:** Set `"enableInstallTelemetry": false` in `settings.json` or `ATOMIC_TELEMETRY=0` (`PI_TELEMETRY=0`). Set `ATOMIC_TELEMETRY=1`/`true`/`yes` to force on. Does not affect update checks.

Pass `--offline` or set `ATOMIC_OFFLINE=1` (`PI_OFFLINE=1`) to disable all startup network calls (update checks, package update checks, and version-adoption telemetry).

---

## Context Files

At startup, Atomic loads `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` from:

1. `~/.atomic/agent/` (global; legacy `~/.pi/agent/` also works)
2. Parent directories walking down to the current directory
3. The current directory

Within a directory, `AGENTS.override.md` replaces `AGENTS.md` and `CLAUDE.md`; files from different directories concatenate. Disable with `--no-context-files` (`-nc`).

### System Prompt

Replace the default system prompt with `.atomic/SYSTEM.md` (project) or `~/.atomic/agent/SYSTEM.md` (global); append with `APPEND_SYSTEM.md` (legacy `.pi/` paths also work).

---

## Customization

### Prompt Templates

Save reusable Markdown prompts in `~/.atomic/agent/prompts/`, `.atomic/prompts/` (legacy `.pi/` paths work), or an [Atomic package](#atomic-packages). Expand them with `/<name>`:

```markdown
<!-- ~/.atomic/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Trigger with `/skill:<name>` or let the agent load them automatically:

```markdown
<!-- ~/.atomic/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Discovered from `~/.atomic/agent/skills/`, `~/.agents/skills/`, `.atomic/skills/`, `.agents/skills/` (walking up from `cwd`), legacy `.pi/skills/`, and [Atomic packages](#atomic-packages). See [docs/skills.md](docs/skills.md).

### Extensions

TypeScript modules that register tools, commands, keybindings, event handlers, and custom TUI components:

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

The default export may be `async`; Atomic awaits it before continuing startup (for example to fetch a remote model list before `pi.registerProvider()`).

`turn_end` and `agent_before_settle` handlers can append structural entries and request a one-shot continuation (later handlers see earlier proposals; error and aborted turns always exit):

```typescript
let replacedResponse = false;
pi.on("turn_end", (event) => {
  if (replacedResponse || event.outcome !== "completed" || event.toolResults.length > 0) return;
  replacedResponse = true;
  return {
    entries: [
      ...event.entries,
      { type: "context_edit", targetId: event.messageEntryId, replacement: null },
      {
        type: "custom_message",
        customType: "replacement-instruction",
        content: "Answer again using the persisted user request.",
        display: false,
      },
    ],
    continue: true,
  };
});
```

Always guard `continue: true` so it cannot loop indefinitely. Use `agent_before_settle` for final checks after retries, compaction, and queued input finish. See [docs/extensions/events.md](docs/extensions/events.md#agent_start-/-agent_end-/-agent_before_settle-/-agent_settled).

Place extensions in `~/.atomic/agent/extensions/`, `.atomic/extensions/` (legacy `.pi/` paths work), or an [Atomic package](#atomic-packages). See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in themes: `dark`, `light`, `catppuccin-frappe`, `catppuccin-latte`, `catppuccin-macchiato`, and `catppuccin-mocha`. Active custom themes hot-reload on save.

Place custom themes in `~/.atomic/agent/themes/`, `.atomic/themes/` (legacy `.pi/` paths work), or an [Atomic package](#atomic-packages). See [docs/themes.md](docs/themes.md).

### Atomic Packages

Share extensions, skills, prompts, themes, subagent definitions, MCP servers, and storage adapters via npm or git. Browse packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Aatomic-package) or [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** Atomic packages run with full system access. Review source code before installing third-party packages.

```bash
atomic install npm:@foo/atomic-tools
atomic install npm:@foo/atomic-tools@1.2.3      # Pinned version
atomic install git:github.com/user/repo
atomic install git:github.com/user/repo@v1      # Pinned tag or commit
atomic install git:git@github.com:user/repo
atomic install https://github.com/user/repo@v1
atomic install ssh://git@github.com/user/repo@v1
atomic remove npm:@foo/atomic-tools             # Alias: atomic uninstall
atomic list
atomic update                                   # Update Atomic only
atomic update --all                             # Update Atomic and packages
atomic update --extensions                      # Update packages only
atomic update --models                          # Force-refresh model catalogs
atomic update --self --force                    # Reinstall Atomic even if current
atomic update npm:@foo/atomic-tools             # Update one package
atomic config                                   # Enable/disable resources
```

- Pass `-l` for project-local installs (`.atomic/git/`, `.atomic/npm/`; global git installs go to `~/.atomic/agent/git/`).
- Pinned `@ref` git packages are skipped by `atomic update --extensions` / `--all`; run `atomic install git:host/user/repo@new-ref` to move to a new ref.
- Git packages run `npm install --omit=dev` (put runtime packages in `dependencies`). Set `npmCommand` in `settings.json` (for example `["mise", "exec", "node@20", "--", "npm"]`) to pin an npm wrapper; custom `npmCommand` runs plain `install`.

Declare resources under the `atomic` key in `package.json` (legacy `pi` key is still accepted), or rely on convention directories (`extensions/`, `skills/`, `prompts/`, `themes/`):

```json
{
  "name": "my-atomic-package",
  "keywords": ["atomic-package"],
  "atomic": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { createAgentSession, SessionManager } from "@bastani/atomic";

// Builds a ModelRuntime from the active agent directory's auth.json and models.json by default.
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

await session.prompt("What files are in the current directory?");
```

For multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`. See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

Integrate from any language over stdin/stdout:

```bash
atomic --mode rpc
```

RPC uses strict LF-delimited JSONL framing. Split records on `\n` only—avoid line readers like Node `readline` that also split on Unicode line separators inside JSON payloads. See [docs/rpc.md](docs/rpc.md).

---

## Philosophy

Atomic pairs a small, extensible core with bundled first-party integrations for common engineering workflows:

- **Extensible core:** Swap tools, UI components, providers, and workflows through [extensions](#extensions), [skills](#skills), and [Atomic packages](#atomic-packages).
- **Bundled integrations:** Subagents, MCP, web access, and Intercom ship as packaged extensions so they remain configurable and replaceable.
- **Explicit security:** Control trust per project with `/trust`, isolate execution in containers, or add custom confirmation hooks via extensions.
- **Composable task execution:** Combine codemode scripts, subagents, background tasks (`/tasks`), and file-based todos rather than locking into one rigid pipeline.

---

## CLI Reference

```bash
atomic [options] [--] [@files...] [messages...]
```

### Package Commands

```bash
atomic install <source> [-l]         # Install package (-l for project-local)
atomic remove <source> [-l]          # Remove package (alias: uninstall)
atomic update [source|self|atomic]   # Update Atomic or one package
atomic update --all                  # Update Atomic and packages
atomic update --extensions           # Update packages only
atomic update --models               # Force-refresh authenticated model catalogs
atomic update --self                 # Update Atomic only
atomic update --self --force         # Reinstall Atomic even if current
atomic update --extension <src>      # Update one package
atomic list                          # List installed packages
atomic config                        # Enable/disable package resources
```

### Modes

| Flag | Description |
| --- | --- |
| *(default)* | Interactive fullscreen TUI |
| `-p`, `--print` | Print response and exit (also merges piped stdin into the initial prompt) |
| `--mode json` | Stream events as JSON lines ([docs/json.md](docs/json.md)) |
| `--mode rpc` | JSON-RPC over stdin/stdout ([docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export a session to HTML |

### Model Options

| Option | Description |
| --- | --- |
| `--provider <name>` | Select provider (`anthropic`, `openai`, `google`, etc.) |
| `--model <pattern>` | Model ID or pattern (supports `provider/id` and `:<thinking>`) |
| `--api-key <key>` | API key override |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for `Ctrl+P` cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
| --- | --- |
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and pick a past session |
| `--session <id\|prefix>` | Open by exact ID or unique 8-hex UUID prefix |
| `--import <file>` | Import a format-4 JSONL export into storage |
| `--session-id <id>` | Open or create an exact project session ID |
| `--fork <id\|prefix>` | Fork by exact ID or unique 8-hex UUID prefix |
| `--session-dir <dir>` | Custom session storage directory |
| `--name <name>`, `-n <name>` | Set session display name |
| `--no-session` | No resumable session ([released history may use disk](docs/sessions.md)) |

### Tool Options

| Option | Description |
| --- | --- |
| `--tools <list>`, `-t <list>` | Allowlist tool names (built-in, extension, custom); ordinary `intercom` remains available |
| `--exclude-tools <list>`, `-xt <list>` | Denylist tool names; ordinary `intercom` cannot be excluded |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools while keeping extension/custom tools |
| `--no-tools`, `-nt` | Disable all tools except ordinary `intercom` |

Default built-in tools: `read`, `bash`, `kill`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`, `codemode`, plus `powershell` on native Windows when available. See [docs/tools.md](docs/tools.md).

### Project Trust Options

| Option | Description |
| --- | --- |
| `--approve`, `-a` | Trust project-local resources for this run |
| `--no-approve`, `-na` | Ignore project-local resources for this run |

Project trust gates `.atomic`/`.pi` resources, project settings, project context files, and project `.agents/skills`. Manage saved decisions with `/trust`; see [docs/security.md](docs/security.md).

### Resource Options

| Option | Description |
| --- | --- |
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions`, `-ne` | Disable optional extension discovery (Intercom stays loaded) |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills`, `-ns` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates`, `-np` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable context-file loading |

Combine `--no-*` with explicit flags to override `settings.json` (for example `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
| --- | --- |
| `--system-prompt <text>` | Replace default system prompt (context files and skills still append) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--offline` | Disable startup network operations (update checks, package updates, telemetry) |
| `--verbose` | Force verbose startup |
| `--` | Stop option parsing; remaining args are prompts or `@file` inputs |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to attach them to the prompt:

```bash
atomic @prompt.md "Answer this"
atomic -p @screenshot.png "What's in this image?"
atomic @code.ts @test.ts "Review these files"
```

### Examples

```bash
atomic "List all .ts files in src/"                     # Interactive with initial prompt
atomic -p "Summarize this codebase"                     # Non-interactive print mode
atomic -p -- "- Summarize these points"                 # Prompt starting with a dash
cat README.md | atomic -p "Summarize this text"         # Piped stdin
atomic --model openai/gpt-4o "Help me refactor"         # Provider/model prefix
atomic --model sonnet:high "Solve this complex problem" # Thinking level shorthand
atomic --models "claude-*,gpt-4o"                       # Scope Ctrl+P cycling
atomic --tools read,search,find -p "Review the code"    # Read-only mode
atomic --thinking high "Solve this complex problem"     # Explicit thinking level
```

### Environment Variables

| Variable | Description |
| --- | --- |
| `AI_AGENT` | Set to `atomic` by CLI, RPC, binary entry points, and Atomic-owned child processes so tooling can identify them (caller env object is not mutated). |
| `ATOMIC_CODING_AGENT_DIR` | Override config directory (default `~/.atomic/agent`; legacy `PI_CODING_AGENT_DIR`). |
| `ATOMIC_CODING_AGENT_SESSION_DIR` | Override session directory (overridden by `--session-dir`; legacy `PI_CODING_AGENT_SESSION_DIR`). |
| `ATOMIC_PACKAGE_DIR` | Override package directory (for Nix/Guix store paths; legacy `PI_PACKAGE_DIR`). |
| `ATOMIC_OFFLINE` | Disable startup network calls (legacy `PI_OFFLINE`). |
| `ATOMIC_SKIP_VERSION_CHECK` | Skip startup version check (legacy `PI_SKIP_VERSION_CHECK`). |
| `ATOMIC_TELEMETRY` | Override version-adoption pings (`1`/`true`/`yes` or `0`/`false`/`no`; legacy `PI_TELEMETRY`). |
| `ATOMIC_REDUCED_MOTION` | Set to `1` to skip startup animations and use a static working indicator. |
| `ATOMIC_NO_PTY` | Set to `1` to disable PTY allocation for bash commands (legacy `PI_NO_PTY`). |
| `NODE_COMPILE_CACHE` | Override Node's compile-cache directory (`NODE_DISABLE_COMPILE_CACHE=1` disables it). |
| `PI_CACHE_RETENTION` | Provider prompt-cache retention knob (`long` where supported; no `ATOMIC_*` alias). |
| `VISUAL`, `EDITOR` | External editor opened by `Ctrl+G`. |

Shell commands (`bash` and `powershell`) receive an execution-time session snapshot in `ATOMIC_SESSION_ID`, `ATOMIC_PROVIDER`, `ATOMIC_MODEL`, and `ATOMIC_REASONING_LEVEL` (with matching `PI_*` aliases). Session file paths are not exposed, and other environment variables pass through unchanged.

---

## Contributing & Development

See [CONTRIBUTING.md](../../CONTRIBUTING.md) and [docs/development.md](docs/development.md).

## License

MIT

## See Also

- [@bastani/atomic-ai](https://www.npmjs.com/package/@bastani/atomic-ai): Core LLM toolkit
- [@bastani/atomic-agent-core](https://www.npmjs.com/package/@bastani/atomic-agent-core): Agent framework
- [@bastani/atomic-tui](https://www.npmjs.com/package/@bastani/atomic-tui): Terminal UI components
