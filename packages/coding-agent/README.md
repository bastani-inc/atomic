<p align="center">
  <a href="https://github.com/bastani-inc/atomic">
    <img alt="Atomic logo" src="https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/docs/logo.svg" width="324">
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

Atomic is a terminal coding-agent runtime. Use built-in tools for file edits and shell commands, [codemode](docs/codemode.md) to script multi-step checks, and [subagents](docs/subagents.md) to delegate work to isolated contexts. Extend Atomic with TypeScript [extensions](#extensions), [skills](#skills), [prompt templates](#prompt-templates), and [themes](#themes), or share them as [Atomic packages](#atomic-packages) via npm or git.

Atomic bundles first-party integrations for [subagents](docs/subagents.md), [MCP servers](docs/mcp-servers.md), [web access](docs/web-access.md), and [Intercom](docs/intercom.md). Sessions save to local SQLite by default or share state across machines over PostgreSQL or libSQL/Turso ([Storage](docs/storage.md)), with [worktree snapshots](docs/worktree-snapshots.md) and [environment blueprints](docs/guides/resume-on-any-machine.md#set-the-environment-up-with-a-blueprint) for cross-machine resume. See [Orchestration](docs/orchestration.md) for multi-step tasks and [Migrating workflows](docs/orchestration/migrating-workflows.md) to convert an earlier workflow file to a skill.

Run Atomic interactively, in print or JSON mode, over RPC for process integration, or embedded through the TypeScript SDK.

Full documentation: [docs.bastani.ai](https://docs.bastani.ai/) | Contributing: [CONTRIBUTING.md](https://github.com/bastani-inc/atomic/blob/main/CONTRIBUTING.md)

## Table of contents

- [Quick start](#quick-start)
- [Providers and models](#providers-and-models)
- [Interactive mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard shortcuts](#keyboard-shortcuts)
  - [Message queue](#message-queue)
- [Sessions](#sessions)
  - [Management](#management)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
  - [Model scoping with enabledModels](#model-scoping-with-enabledmodels)
  - [Telemetry and update checks](#telemetry-and-update-checks)
- [Context files](#context-files)
- [Customization](#customization)
  - [Prompt templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Atomic packages](#atomic-packages)
- [Programmatic usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI reference](#cli-reference)
- [Contributing and development](#contributing-and-development)
- [License](#license)
- [See also](#see-also)

---

## Quick start

Install globally with npm, pnpm, or Bun (Node.js 24 LTS, version 24.20.0 or newer, or Bun 1.4.5+). Check with `node --version`; [Node.js version](docs/getting-started/installation.md#nodejs-version) explains why and how to upgrade:

```bash
npm install -g @bastani/atomic
# or: pnpm add -g @bastani/atomic
# or: bun add -g @bastani/atomic
```

For environments without Node.js or a package manager, use the self-contained release archive installer (`install.sh` on macOS/Linux or `install.ps1` on Windows). See [Installation](docs/getting-started/installation.md).

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
atomic
```

Or sign in with an existing subscription or browser login:

```bash
atomic
/login   # Select a provider
```

By default, Atomic provides built-in coding tools (`read`, `bash`, `kill`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`, `codemode`, plus `powershell` on native Windows when available). `edit` performs exact-text replacement without requiring an earlier `read`. See [docs/tools.md](docs/tools.md).

**Platform guides:** [Windows](docs/windows.md) | [Alpine/musl Linux](docs/getting-started/installation.md#alpine-and-musl-linux-archives) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Herdr](docs/herdr.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

<div id="providers--models"></div>

## Providers and models

Atomic ships a curated list of tool-capable models for each built-in provider. Authenticate via `/login` or an API key, then pick any model with `/model` (`Ctrl+L`).

**Subscriptions and browser logins (`/login`):**

- OpenRouter (browser PKCE, optional key minting)
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- OpenAI ChatGPT sign-in (`openai`)
- GitHub Copilot
- Kimi Code (device authorization with automatic token refresh)
- Meta (Muse subscription)
- xAI (Grok/X subscription)

**API keys:**
Anthropic, Anthropic API (`anthropic-api`), Ant Ling, OpenAI, OpenAI API (`openai-api`), OpenAI Decisions (`openai-decisions`), OpenAI Images (`openai-images`), Azure OpenAI, DeepSeek, NVIDIA NIM, Google Gemini, Google Vertex, Amazon Bedrock, Mistral, Groq, Cerebras, Cloudflare AI Gateway, Cloudflare Workers AI, xAI, OpenRouter, Vercel AI Gateway, ZAI, ZAI Coding Plan (China), OpenCode Zen, OpenCode Go, Hugging Face, Fireworks, Together AI, Baseten, Kimi For Coding, Meta, MiniMax, MiniMax (China), Moonshot AI, Moonshot AI (China), Morph, Qwen Token Plan, Qwen Token Plan (Individual), Qwen Token Plan (China), Qwen Token Plan (Individual, China), TypeSafe, Xiaomi MiMo, Xiaomi MiMo Token Plan (China / Amsterdam / Singapore).

See [docs/providers.md](docs/providers.md) for provider setup and environment variables.

**Model capabilities and custom endpoints:**

- **Structured tool arguments:** Models that support strict JSON-schema or grammar-constrained tool calling enforce tool input schemas automatically. When a tool requires strict constraints that a model does not support, the call fails with an error instead of silently falling back. See [Extension authoring](docs/extensions/authoring.md#constrained-sampling) and [RPC protocol](docs/rpc/protocol.md#get_available_models).
- **Bearer auth for Anthropic:** Setting `ANTHROPIC_AUTH_TOKEN` authenticates Anthropic-compatible gateways with an `Authorization: Bearer` header (without sending `x-api-key`) across chat and summary requests.
- **Custom providers and models:** Add OpenAI-, Anthropic-, or Google-compatible providers in the active agent directory's `models.json` (normally `~/.atomic/agent/models.json`; not merged with legacy `.pi`). Configure custom sampling parameters, thinking token budgets, finish-reason behavior, and persisted `llama.cpp` models there, or write an extension for custom APIs and OAuth. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Atomic interactive terminal UI showing the startup header, conversation messages, prompt editor, and footer status bar" width="600"></p>

The fullscreen TUI has four areas from top to bottom:

- **Startup header:** Keybinding hints (`/hotkeys` for all), loaded context files, prompt templates, skills, and extensions.
- **Messages:** Prompts, responses, tool calls and results, notices, errors, and extension UI.
- **Editor:** Input box whose border color reflects the active thinking level, with a status row showing streaming activity.
- **Footer:** Working directory, session name, token and cache usage, cost, context usage, and active model.

[Extensions](#extensions) can replace the editor, show temporary dialogs (such as `/settings` or selectors), or add widgets, status lines, custom footers, and overlays.

### Editor

| Feature | How |
| --- | --- |
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press `Tab` to complete paths |
| Multi-line input | Press `Shift+Enter` or `Ctrl+J` (`Ctrl+Enter` or `Shift+Enter` on Windows Terminal) |
| Images | Press `Ctrl+V` (`Alt+V` or `Ctrl+V` on Windows and WSL) or drag onto the terminal |
| Shell commands | `!command` runs and sends output to the model; `!!command` runs without sending output |

See [docs/keybindings.md](docs/keybindings.md) for all editing shortcuts.

### Commands

Type `/` in the editor to browse commands. [Extensions](#extensions) register custom commands, [skills](#skills) run as `/skill:<name>`, and [prompt templates](#prompt-templates) expand as `/<template>`.

**Core commands:**

| Command | Description |
| --- | --- |
| `/login [provider]`, `/logout [provider]` | Configure or remove OAuth and API key credentials |
| `/model [provider/model]` | Switch model and save as the startup default |
| `/thinking [level]` | Switch thinking level and save as the startup default |
| `/scoped-models` | Enable or disable models for `Ctrl+P` cycling |
| `/settings` | Edit theme, message delivery, transport, and other preferences |
| `/resume [id]` | Browse and pick a past session, or open one directly |
| `/new` | Start a new session |
| `/name <name>` | Set the session display name |
| `/session [snapshot]` | Show session ID, storage, messages, tokens, and cost, or inspect worktree snapshots |
| `/tree` | Jump to any point in the session and branch from there |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the active branch into a new session |
| `/compact [instructions]` | Clear or compact the context window; the agent recovers needed details from history |
| `/copy` | Copy the last assistant message to clipboard |
| `/export [file]` | Export the session to HTML (default) or `.jsonl` |
| `/import <file>` | Import and resume a session from a JSONL export |
| `/share` | Upload as a secret GitHub gist with a shareable HTML link |
| `/tools` | Show active, inactive, and missing tools |
| `/tasks` | Inspect and manage running subagents and background shells |
| `/trust` | Save the project trust decision for future sessions |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files (active custom themes hot-reload on save) |
| `/hotkeys` | List all keyboard shortcuts |
| `/changelog` | Show version history |
| `/exit`, `/quit` | Exit Atomic |

**Bundled extension commands:** `/agents` ([subagents](docs/subagents.md)), `/mcp` ([MCP servers](docs/mcp-servers.md)), `/intercom` ([Intercom](docs/intercom.md)), `/websearch`, `/curator`, `/search`, `/google-account` ([web access](docs/web-access.md)), and `/llama` ([`llama.cpp`](docs/llama-cpp.md) router models).

### Keyboard shortcuts

Run `/hotkeys` for the full list. Customize bindings in `~/.atomic/agent/keybindings.json` (or under `ATOMIC_CODING_AGENT_DIR`). See [docs/keybindings.md](docs/keybindings.md).

| Key | Action |
| --- | --- |
| `Ctrl+C` | Interrupt active or queued work; when idle, clear editor |
| `Ctrl+C` twice (idle) | Quit |
| `Escape` | Abort active work and hold queued messages |
| `Escape` twice | Open `/tree` |
| `Ctrl+L` | Open model selector |
| `Ctrl+P` / `Shift+Ctrl+P` (`Alt+P` on Windows/WSL) | Cycle scoped models forward / backward |
| `Shift+Tab` | Cycle thinking level |
| `Ctrl+O` | Collapse or expand tool output |
| `Ctrl+T` | Collapse or expand thinking blocks |
| `Ctrl+G` | Open the current editor buffer in your external editor |

### Message queue

Send messages while the agent is still working:

- **`Enter`** queues a steering message, delivered after the current turn's tool calls finish.
- **`Alt+Enter`** on macOS/Linux or **`Ctrl+Q`** on Windows and WSL queues a follow-up message, delivered after the agent finishes all work.
- **`Escape`** or **`Ctrl+C`** aborts active work and pauses queued messages in place. Sending the next regular message resumes held messages once in order. While idle, `Ctrl+C` clears the editor and a second quick press quits without releasing held messages.
- **`Alt+Up`** on macOS/Linux or **`Alt+Q`** on Windows and WSL pulls queued messages back into the editor instead of resuming them.

Configure `steeringMode` and `followUpMode` (`"one-at-a-time"` default, or `"all"`) and `transport` (`"sse"`, `"websocket"`, `"websocket-cached"`, `"auto"`) in [docs/settings.md](docs/settings.md).

---

## Sessions

Sessions store an append-only tree of entries (`id` and `parentId`), enabling in-place branching in one session. See [docs/session-format.md](docs/session-format.md), [docs/storage.md](docs/storage.md), [docs/worktree-snapshots.md](docs/worktree-snapshots.md), and [Resume on any machine & blueprints](docs/guides/resume-on-any-machine.md#set-the-environment-up-with-a-blueprint).

### Management

Sessions auto-save per working directory in the default local SQLite store (`~/.atomic/workflows/journal.sqlite`), or in a shared PostgreSQL or Turso/libSQL database via [Storage backends](docs/storage.md). Legacy `~/.atomic/agent/sessions/` and `~/.pi/agent/sessions/` JSONL files remain readable.

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

- **`/tree`:** Jump to any earlier entry and continue on a new branch without creating a new session.
  - Type to search, `Ctrl+Left`/`Ctrl+Right` or `Alt+Left`/`Alt+Right` to fold or jump branches, `Left`/`Right` to page.
  - `Ctrl+O` cycles filters in order: `default`, `no-tools`, `user-only`, `labeled-only`, and `all`.
  - `Shift+L` bookmarks an entry with a label; `Shift+T` toggles label timestamps.
- **`/fork`:** Pick an earlier user message on the active branch, copy the path up to it into a new session, and load that prompt into the editor.
- **`/clone`:** Duplicate the full active branch into a new session at the current point.
- **`--fork <id|prefix>`:** Fork an existing session from the CLI into the current project.

<p align="center"><img src="docs/images/tree-view.png" alt="Atomic interactive session tree view displaying branched turns, bookmarks, and filter options" width="600"></p>

### Compaction

When a session approaches the context limit, compaction clears the active context window without a model call by default. Atomic leaves a recovery pointer telling the agent where earlier history lives and what to recover first (`<keepContext>` spans, requests, and constraints) using `read` and `search`. Setting `compactionModel` (such as `morph/morph-compactor` or a [custom remote compactor](docs/compaction.md#customize-morph-or-add-a-remote-compactor)) replaces the context with that model's summary instead.

- **Manual:** Run `/compact [instructions]` (instructions guide what the agent recovers first).
- **Automatic:** Enabled by default on context overflow (compacts and retries once) or near the limit. Configure in `/settings` or `settings.json`.
- **Full history stays intact:** Use `/tree` to revisit earlier entries. See [docs/compaction.md](docs/compaction.md).

Extensions can hide or replace an earlier message for future model turns using `context_edit` without altering raw history or usage records:

```typescript
const assistantId = await sessionManager.appendMessage(partialAssistant);
await sessionManager.appendContextEdit(assistantId, null); // Omitted from model context, kept in history.
```

---

## Settings

Use `/settings` interactively, or edit JSON files directly:

| Location | Scope |
| --- | --- |
| `~/.atomic/agent/settings.json` | Global (legacy `~/.pi/agent/settings.json` also works) |
| `.atomic/settings.json` | Project override (legacy `.pi/settings.json` also works once trusted) |

See [docs/settings.md](docs/settings.md) for every option and default.

### Model scoping with enabledModels

Set `enabledModels` in `settings.json` (or pass `--models <patterns>` on the CLI) to limit the models cycled with `Ctrl+P` and restrict which models subagents can choose.

- **Exact matches:** `provider/model-id` (for example `anthropic/claude-sonnet-4-6`) matches that model directly, case-insensitively.
- **Glob patterns:** Entries containing `*`, `?`, or `[...]` match against both `provider/id` and the bare model ID (for example `anthropic/claude-*` or `*:high`).
- **Fuzzy matching:** Entries without glob characters that do not match an exact ID fall back to substring matching across available models.
- **Thinking suffixes:** Append `:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, or `:max` (case-insensitive) to pin a thinking level for that entry.
- **Interactive behavior:** Saving selections in `/scoped-models` writes exact `provider/id` entries. Picking an out-of-scope model with `/model` automatically appends it to global `enabledModels`.

See [docs/settings.md](docs/settings.md) for full precedence, deduplication, and `fallbackModels` details.

### Telemetry and update checks

Atomic runs two independent startup network checks:

- **Update check:** Checks for a newer Atomic release. Disable with `ATOMIC_SKIP_VERSION_CHECK=1` (legacy `PI_SKIP_VERSION_CHECK=1`).
- **Version-adoption telemetry:** Measures whether releases reach real interactive launches and which versions stay in use. The metric is version-adoption pings and first-interactive-launch pings, not installs, users, MAU, or retention. Repeated eligible launches on several machines overcount; opt-outs, offline mode, and dropped best-effort requests undercount. Atomic sends one bodyless `GET` request to `https://atomic-version-adoption.bastani-atomic.workers.dev/v1/version-adoption?version=<version>` with the standard `atomic/<version> (<platform>; <runtime>; <arch>)` User-Agent (no UUID, cookie, auth header, or user data).
  - **When it fires:** Interactive mode only, and only on the first launch with fresh settings or the first launch after upgrading to a version with changelog entries. Never on every launch, npm install, reinstall keeping settings, or `-p`/RPC modes.
  - **What is stored:** Atomic stores only UTC date, version, and an aggregate count. Cloudflare, the hosting provider, processes transient connection metadata (IP, TLS) to serve the request.
  - **Opt out:** Set `"enableInstallTelemetry": false` in `settings.json` or `ATOMIC_TELEMETRY=0` (`PI_TELEMETRY=0`). Set `ATOMIC_TELEMETRY=1`/`true`/`yes` to force on. This setting does not affect update checks.

Pass `--offline` or set `ATOMIC_OFFLINE=1` (`PI_OFFLINE=1`) to disable all startup network calls (update checks, package update checks, and version-adoption telemetry). Setting `ATOMIC_OFFLINE=0` or `false` keeps Atomic online.

---

## Context files

At startup, Atomic loads `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` from:

1. `~/.atomic/agent/` (global; legacy `~/.pi/agent/` also works)
2. Parent directories walking down to the current directory
3. The current directory

Within a directory, `AGENTS.override.md` replaces `AGENTS.md` and `CLAUDE.md`. Files from different directories concatenate. Disable with `--no-context-files` (`-nc`).

### System prompt

Replace the default system prompt with `.atomic/SYSTEM.md` (project) or `~/.atomic/agent/SYSTEM.md` (global). Append to it with `APPEND_SYSTEM.md` (legacy `.pi/` paths also work).

---

## Customization

### Prompt templates

Save reusable Markdown prompts in `~/.atomic/agent/prompts/`, `.atomic/prompts/` (legacy `.pi/` paths work), or an [Atomic package](#atomic-packages). Expand them with `/<name>` using positional arguments (`$1`, `$2`, `$@`, `$ARGUMENTS`, or defaults like `${1:-correctness}`):

```markdown
<!-- ~/.atomic/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: ${1:-correctness}
Additional context: $ARGUMENTS
```

See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

Skills are on-demand capability packages following the [Agent Skills standard](https://agentskills.io). Trigger a skill with `/skill:<name>` or let the agent load it automatically from its description. Every `SKILL.md` requires YAML frontmatter with `name` and a non-empty `description`:

```markdown
---
name: my-skill
description: Use this skill when the user asks about X.
---

# My skill

## Steps
1. Do this
2. Then that
```

Skills are discovered from `~/.atomic/agent/skills/`, `~/.agents/skills/`, `.atomic/skills/`, `.agents/skills/` (walking up from `cwd`), legacy `.pi/skills/`, and [Atomic packages](#atomic-packages). See [docs/skills.md](docs/skills.md).

### Extensions

Extensions are TypeScript modules that register tools, commands, keybindings, event handlers, and custom TUI components:

```typescript
import type { ExtensionAPI } from "@bastani/atomic";

export default function (atomic: ExtensionAPI) {
  atomic.registerTool({ name: "deploy", ... });
  atomic.registerCommand("stats", { ... });
  atomic.on("tool_call", async (event, ctx) => { ... });
}
```

The default export may be `async`; Atomic awaits it before continuing startup (for example, to fetch a remote model list before calling `atomic.registerProvider()`). The factory parameter can have any name; older extensions and examples call it `pi`.

`turn_end` and `agent_before_settle` handlers can append structural entries and request a one-shot continuation (always guard `continue: true` so it cannot loop indefinitely; error and aborted turns always exit). See [Extension events](docs/extensions/events.md#agent_start--agent_end--agent_before_settle--agent_settled).

Place extensions in `~/.atomic/agent/extensions/`, `.atomic/extensions/` (legacy `.pi/` paths work), or an [Atomic package](#atomic-packages). See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in themes: `dark`, `light`, `catppuccin-frappe`, `catppuccin-latte`, `catppuccin-macchiato`, and `catppuccin-mocha`. Active custom themes watch their file path and hot-reload automatically on save (including project, package, `--theme`, and renamed themes).

Place custom themes in `~/.atomic/agent/themes/`, `.atomic/themes/` (legacy `.pi/` paths work), or an [Atomic package](#atomic-packages). See [docs/themes.md](docs/themes.md).

### Atomic packages

Share extensions, skills, prompts, themes, subagent definitions, MCP servers, and storage adapters via npm or git. Browse packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Aatomic-package) or [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** Atomic packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

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
atomic config [-l]                              # Enable/disable resources
```

- Pass `-l` for project-local installs (`.atomic/git/`, `.atomic/npm/`; global git installs go to `~/.atomic/agent/git/`).
- Pinned `@ref` git packages are skipped by `atomic update --extensions` and `--all`. Run `atomic install git:host/user/repo@new-ref` to move to a new ref.
- Git packages install runtime dependencies automatically: `npm` runs `install --omit=dev --legacy-peer-deps --no-audit --no-fund`, `bun` runs `install --omit=dev --omit=peer`, and `pnpm` runs `install --prod ...`. Set `npmCommand` in `settings.json` (for example `["mise", "exec", "node@20", "--", "npm"]`) to wrap a package manager; Atomic detects the underlying `npm`, `bun`, or `pnpm` command and only falls back to plain `install` for unrecognized package managers.

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

## Programmatic usage

### SDK

```typescript
import { createAgentSession } from "@bastani/atomic";

// Builds a ModelRuntime from the active agent directory's auth.json and models.json by default.
// Pass `sessionStore` for SQLite, JSONL, in-memory, libSQL/Turso, or PostgreSQL persistence.
const { session } = await createAgentSession({
  sessionStore: { kind: "sqlite", path: "./sessions.sqlite" },
});

try {
  await session.prompt("What files are in the current directory?");
} finally {
  await session.dispose();
}
```

- **Storage backends:** Configure SQLite, JSONL, in-memory, libSQL/Turso (`@bastani/atomic-storage-libsql`), and PostgreSQL 16+ (`@bastani/atomic-storage-postgres`) with `createAgentSession()` or `createAgentSessionRuntime()`. See [SDK storage backends](docs/sdk/storage.md) ([docs.bastani.ai/sdk/storage](https://docs.bastani.ai/sdk/storage)).
- **Structured decisions:** Make typed, schema-validated classifier or chat decisions without starting a session using `decide()` and `generateStructuredOutput()`. See [Structured decisions](docs/sdk/structured-decisions.md).
- **Multi-session runtimes and guides:** See [docs/sdk.md](docs/sdk.md), [docs/sdk/web-server.md](docs/sdk/web-server.md), and [examples/sdk/](examples/sdk/).

### RPC mode

Integrate from any language over stdin/stdout:

```bash
atomic --mode rpc
```

RPC uses strict LF-delimited JSONL framing. Split records on `\n` only, and avoid line readers like Node `readline` that also split on Unicode line separators inside JSON payloads. See [docs/rpc.md](docs/rpc.md).

---

## Philosophy

Atomic pairs a small, extensible core with bundled first-party integrations for common engineering workflows:

- **Extensible core:** Swap tools, UI components, providers, and procedures through [extensions](#extensions), [skills](#skills), and [Atomic packages](#atomic-packages).
- **Bundled integrations:** Subagents, MCP, web access, and Intercom ship as packaged extensions so they remain configurable and replaceable.
- **Explicit security:** Control trust per project with `/trust`, isolate execution in containers, or add custom confirmation hooks via extensions.
- **Composable task execution:** Combine codemode scripts, subagents, background tasks (`/tasks`), and file-based todos rather than locking into one rigid pipeline.

---

## CLI reference

```bash
atomic [options] [--] [@files...] [messages...]
```

### Subcommands

```bash
# Packages and resources
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
atomic config [-l]                   # Enable/disable package resources

# Credentials, integrations, and storage
atomic auth <login|logout|check|print-api-key|print-bearer-token>
atomic mcp <add|remove|list|login|logout>
atomic storage <status|join|migrate|move-snapshot-chunks|search-session|export|import>
atomic team <join|status|leave>
atomic intercom <status|restart|upgrade>
atomic blueprint <cache-key|prebuild>   # Environment blueprint cache keys and worktree prebuilds
```

Run `atomic <command> --help` for full subcommand options, or see [docs/reference/cli.md](docs/reference/cli.md).

### Modes

| Flag | Description |
| --- | --- |
| *(default)* | Interactive fullscreen TUI |
| `-p`, `--print` | Print response and exit (merges piped stdin separated by a newline from prompt text) |
| `--mode json` | Stream events as JSON lines ([docs/json.md](docs/json.md)) |
| `--mode rpc` | JSON-RPC over stdin/stdout ([docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export a session to HTML |

### Model options

| Option | Description |
| --- | --- |
| `--provider <name>` | Provider to search for `--model` (requires `--model`) |
| `--model <pattern>` | Model ID or pattern (supports `provider/id` and case-insensitive `:<thinking>`) |
| `--api-key <key>` | API key override |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for `Ctrl+P` cycling (globs and fuzzy matching) |
| `--fallback-models <models>` | Comma-separated `provider/model[:thinking]` IDs to fall back to in order for this run |
| `--no-fallback` | Disable automatic model fallback for this run |
| `--list-models [search]` | List available models |

### Session and storage options

| Option | Description |
| --- | --- |
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and pick a past session |
| `--session <id\|prefix>` | Open by exact ID or unique 8-hex UUID prefix |
| `--import <file>` | Import a format-4 JSONL export into storage |
| `--session-id <id>` | Open or create an exact project session ID |
| `--fork <id\|prefix>` | Fork by exact ID or unique 8-hex UUID prefix |
| `--session-dir <dir>` | Select JSONL session storage and lookup directory |
| `--session-store <path>` | Select a SQLite session database |
| `--session-prefix <prefix>` | Table prefix for `--session-store` (default: empty) |
| `--storage <json>` | Shared storage selection JSON for this process (never saved) |
| `--storage-file <path>` | Read the `--storage` JSON selection from a file |
| `--name <name>`, `-n <name>` | Set session display name |
| `--no-session` | No resumable session ([released history may use disk](docs/sessions.md)) |

### Tool options

| Option | Description |
| --- | --- |
| `--tools <list>`, `-t <list>` | Comma-separated allowlist of tool names or `*` patterns (built-in, extension, custom). Keeps MCP tools unless an entry starts with `mcp__`. Only `+name`/`-name` entries modify the default selection. Intercom follows the allowlist and exclusions. |
| `--exclude-tools <list>`, `-xt <list>` | Comma-separated denylist of tool names or `*` patterns, including MCP tools and Intercom |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools by default while keeping extension and custom tools enabled |
| `--no-tools`, `-nt` | Disable every tool, including Intercom, even when `--tools` is also passed |

Default built-in tools: `read`, `bash`, `kill`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`, `codemode`, plus `powershell` on native Windows when available. See [docs/tools.md](docs/tools.md).

### Project trust options

| Option | Description |
| --- | --- |
| `--approve`, `-a` | Trust project-local resources for this run |
| `--no-approve`, `-na` | Ignore project-local resources for this run |

Project trust gates `.atomic`/`.pi` resources, project settings, project context files, and project `.agents/skills`. Manage saved decisions with `/trust`. See [docs/security.md](docs/security.md).

### Resource options

| Option | Description |
| --- | --- |
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions`, `-ne` | Disable optional extension discovery (bundled Intercom stays loaded) |
| `--no-mcp` | Disable built-in MCP support for this run |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills`, `-ns` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates`, `-np` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--use-theme <name[/name]>` | Set the interactive theme for this run without saving it |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable context-file loading |

Combine `--no-*` with explicit flags to override `settings.json` (for example, `--no-extensions -e ./my-ext.ts`).

### Other options

| Option | Description |
| --- | --- |
| `--system-prompt <text>` | Replace default system prompt (context files and skills still append) |
| `--append-system-prompt <text>` | Append text or file contents to the system prompt (repeatable) |
| `--offline` | Disable startup network operations (update checks, package updates, telemetry) |
| `--debug` | Turn on debug mode for this run (same as `ATOMIC_DEBUG=1`) |
| `--verbose` | Force verbose startup |
| `--` | Stop option parsing; remaining args are prompts or `@file` inputs |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File arguments

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

### Environment variables

When both an `ATOMIC_*` variable and its legacy `PI_*` alias are set, the `ATOMIC_*` variable takes precedence. See [docs/environment-variables.md](docs/environment-variables.md) for the complete reference.

| Variable | Description |
| --- | --- |
| `AI_AGENT` | Set to `atomic` by CLI, RPC, binary entry points, and Atomic-owned child processes so tooling can identify them (the caller environment object is not mutated). |
| `ATOMIC_CODING_AGENT_DIR` | Override config directory (default `~/.atomic/agent`; legacy `PI_CODING_AGENT_DIR`). |
| `ATOMIC_CODING_AGENT_SESSION_DIR` | Non-empty value selects a JSONL session directory (overridden by `--session-dir` and `--no-session`; no legacy `PI_*` alias). |
| `ATOMIC_STORAGE` | Shared storage selection JSON for sessions and Intercom. |
| `ATOMIC_SESSIONS_STORAGE` | Session-only storage selection JSON (conflicts with `ATOMIC_CODING_AGENT_SESSION_DIR`). |
| `ATOMIC_PROFILE` | Set to `ci` to select the team database from `ATOMIC_TEAM_*` without writing settings. |
| `ATOMIC_TEAM_URL`, `ATOMIC_TEAM_TOKEN`, `ATOMIC_TEAM_TOKEN_FILE`, `ATOMIC_TEAM_PREFIX` | Team database settings used with `ATOMIC_PROFILE=ci`. |
| `ATOMIC_PACKAGE_DIR` | Override package directory (for Nix/Guix store paths; legacy `PI_PACKAGE_DIR`). |
| `ATOMIC_OFFLINE` | Set to `1`, `true`, or `yes` to disable startup network calls (`0`/`false` stays online; legacy `PI_OFFLINE`). |
| `ATOMIC_SKIP_VERSION_CHECK` | Skip startup version check (legacy `PI_SKIP_VERSION_CHECK`). |
| `ATOMIC_SELF_UPDATE_COMMAND` | Custom command for `atomic update` self-updates (legacy `PI_SELF_UPDATE_COMMAND`). |
| `ATOMIC_TELEMETRY` | Override version-adoption pings (`1`/`true`/`yes` or `0`/`false`/`no`; legacy `PI_TELEMETRY`). |
| `ATOMIC_DEBUG` | Set to `1` to enable debug mode for this run (legacy `PI_DEBUG`). |
| `ATOMIC_REDUCED_MOTION` | Set to `1` to skip startup animations and use a static working indicator. |
| `ATOMIC_NO_PTY` | Set to `1` to disable PTY allocation for `bash` and `powershell` commands (legacy `PI_NO_PTY`). |
| `ATOMIC_CACHE_RETENTION` | Provider prompt-cache retention (`long` default, `short`, or `none`; legacy `PI_CACHE_RETENTION`). |
| `ATOMIC_OAUTH_CALLBACK_HOST` | Bind host for the local OAuth callback server during `/login` (default `127.0.0.1`; legacy `PI_OAUTH_CALLBACK_HOST`). |
| `ATOMIC_SHARE_VIEWER_URL` | Base URL for `/share` links (default `https://bastani.ai/session/`; legacy `PI_SHARE_VIEWER_URL`). |
| `ATOMIC_STDIN_TIMEOUT_MS` | Print-mode wait in milliseconds for piped stdin before starting (default `2000`; `0` waits until EOF; legacy `PI_STDIN_TIMEOUT_MS`). |
| `ATOMIC_TOOL_ABORT_GRACE_MS` | Grace period in milliseconds for an interrupted tool call before moving on (default `10000`). |
| `ATOMIC_HEAP_MB` | Node heap limit in MiB for the agent process (`0` keeps Node's default; legacy `PI_HEAP_MB`). |
| `NODE_COMPILE_CACHE` | Override Node's compile-cache directory (`NODE_DISABLE_COMPILE_CACHE=1` disables it). |
| `VISUAL`, `EDITOR` | External editor opened by `Ctrl+G`. |

Shell commands (`bash` and `powershell`) receive an execution-time session snapshot in `ATOMIC_SESSION_ID`, `ATOMIC_PROVIDER`, `ATOMIC_MODEL`, and `ATOMIC_REASONING_LEVEL` (with matching `PI_*` aliases). Session file paths are not exposed, and other environment variables pass through unchanged.

---

## Contributing and development

See [CONTRIBUTING.md](https://github.com/bastani-inc/atomic/blob/main/CONTRIBUTING.md) and [docs/development.md](docs/development.md).

## License

MIT

## See also

- [@bastani/atomic-ai](https://www.npmjs.com/package/@bastani/atomic-ai): Unified LLM client and provider catalog
- [@bastani/atomic-agent-core](https://www.npmjs.com/package/@bastani/atomic-agent-core): Agent loop with tool execution, streaming, and hooks
- [@bastani/atomic-tui](https://www.npmjs.com/package/@bastani/atomic-tui): Differential terminal UI library
- [@bastani/atomic-codemode](https://www.npmjs.com/package/@bastani/atomic-codemode): Sandboxed JavaScript execution for tool scripting
- [@bastani/atomic-schema](https://www.npmjs.com/package/@bastani/atomic-schema): TypeScript-first JSON Schema builder and validator
- [@bastani/atomic-telemetry](https://www.npmjs.com/package/@bastani/atomic-telemetry): Vendor-neutral telemetry contracts, metrics, and trace renderers ([docs](docs/libraries/telemetry.md))
- [@bastani/atomic-storage-libsql](https://www.npmjs.com/package/@bastani/atomic-storage-libsql): Optional Turso / libSQL storage adapter ([docs](docs/libraries/storage-libsql.md))
- [@bastani/atomic-storage-postgres](https://www.npmjs.com/package/@bastani/atomic-storage-postgres): Optional PostgreSQL 16+ storage adapter ([docs](docs/libraries/storage-postgres.md))
