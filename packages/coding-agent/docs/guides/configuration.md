---
title: "Configure Atomic"
sidebarTitle: "Configure Atomic"
description: "Understand Atomic's configuration files and directories, set global defaults in settings.json, and override settings per project."
---

After your [first session](/getting-started/first-session), save global preferences in `~/.atomic/agent/settings.json`. Use `.atomic/settings.json` inside a repository for overrides that apply only to that project.

You can edit either file directly or run `/settings` in an interactive session to change common options. Both files use strict JSON (no `//` comments or trailing commas).

## Where to configure what

| What you want to configure | Where to put it | Guide |
| --- | --- | --- |
| Subscriptions, API keys, and cloud credentials | `/login`, `~/.atomic/agent/auth.json`, or provider env vars | [Model providers](/providers) |
| Everyday model selection, thinking defaults, and fallbacks | `/model`, `/scoped-models`, or `settings.json` | [Choose a model](/models/choose-a-model) |
| Custom models, local servers, proxies, overrides, and remote compactors | `~/.atomic/agent/models.json` | [Configure custom models](/models) |
| Persistent preferences, tools, compaction, retries, and themes | `~/.atomic/agent/settings.json` and `.atomic/settings.json` | [Settings reference](/settings) |
| Local SQLite, JSONL, or shared PostgreSQL storage | `storage` / `sessions.storage`, or `atomic storage join` | [Storage](/storage) |
| Keyboard shortcuts | `~/.atomic/agent/keybindings.json` | [Keybindings](/keybindings) |
| One-run overrides for a single command | CLI flags (`--model`, `--models`, `--tools`, `--storage`) | [CLI reference](/reference/cli) |
| Process, CI, terminal, and diagnostic overrides | `ATOMIC_*` environment variables | [Environment variables](/environment-variables) |

<Note>
Building extensions or embedding Atomic in TypeScript? Extensions can register custom provider APIs and OAuth flows ([Build custom providers](/custom-provider)), and TypeScript hosts can pass settings and storage programmatically ([SDK](/sdk) and [SDK storage](/sdk/storage)).
</Note>

## Configuration files and directories

### Global files (`~/.atomic/`)

Set `ATOMIC_CODING_AGENT_DIR` to relocate `~/.atomic/agent/`. When a file does not exist in `~/.atomic/agent/`, Atomic falls back to legacy `~/.pi/agent/` where supported.

| Path | Purpose |
| --- | --- |
| `~/.atomic/agent/settings.json` | Global preferences, defaults, tools, storage, compaction, and packages ([Settings](/settings)) |
| `~/.atomic/agent/auth.json` | Saved OAuth tokens and API keys from `/login` and `atomic auth login` ([Providers](/providers)) |
| `~/.atomic/agent/models.json` | Custom chat, classifier, and compactor models, proxies, and overrides ([Custom models](/models)) |
| `~/.atomic/agent/models-store.json` | Cached provider model catalogs refreshed in the background |
| `~/.atomic/agent/keybindings.json` | Custom keyboard shortcuts ([Keybindings](/keybindings)) |
| `~/.atomic/agent/mcp.json` | Global MCP server configurations ([MCP servers](/mcp-servers)) |
| `~/.atomic/agent/trust.json` | Saved per-project trust decisions ([Security](/security#project-trust)) |
| `~/.atomic/agent/SYSTEM.md`, `APPEND_SYSTEM.md` | Global system prompt replacement or standing instructions ([Project instructions](/getting-started/project-instructions)) |
| `~/.atomic/agent/blueprint.yaml` | Global environment setup blueprint for restored worktrees ([Resume anywhere](/guides/resume-on-any-machine)) |
| `~/.atomic/agent/extensions/`, `skills/`, `prompts/`, `themes/` | User-level extensions, skills, prompt templates, and themes |
| `~/.atomic/agent/sessions/` | Opt-in JSONL session files when JSONL storage is enabled ([JSONL storage](/storage/jsonl)) |
| `~/.atomic/agent/worktree-snapshots/` | Local restored worktrees and snapshot cache ([Worktree snapshots](/worktree-snapshots)) |
| `~/.atomic/agent/bin/`, `cache/` | Managed helper binaries (`fd`, `rg`) and extension transpile cache |
| `~/.atomic/agent/atomic-debug.log` | Debug event log and `/debug` snapshots ([Diagnostics](/development#debugging)) |
| `~/.atomic/workflows/journal.sqlite` | Default local SQLite database for sessions and snapshots ([SQLite storage](/storage/sqlite)) |
| `~/.atomic/web-search.json` | Web-access search provider settings and shortcuts ([Web access](/web-access)) |

### Project files (`.atomic/` and repository root)

Atomic also checks legacy `.pi/` directories at lower precedence than `.atomic/`.

| Path | Requires trust | Purpose |
| --- | --- | --- |
| `.atomic/settings.json` | Yes | Project-specific setting overrides |
| `.atomic/mcp.json` | Yes | Project MCP servers ([MCP servers](/mcp-servers)) |
| `.atomic/blueprint.yaml` | Yes | Repository setup blueprint for cross-machine resume ([Resume anywhere](/guides/resume-on-any-machine)) |
| `.atomic/SYSTEM.md`, `APPEND_SYSTEM.md` | Yes | Project system prompt replacement or appendix ([Project instructions](/getting-started/project-instructions)) |
| `.atomic/extensions/`, `skills/`, `prompts/`, `themes/`, `agents/` | Yes | Project-local extensions, skills, templates, themes, and custom subagents (legacy `.atomic/workflows/` is also trust-gated) |
| `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` | Yes | Project instructions at the repo root or subdirectories ([Project instructions](/getting-started/project-instructions)) |
| `.atomic/snapshot-ignore` | No | Extra `.gitignore`-style exclusions for worktree snapshots ([Worktree snapshots](/worktree-snapshots)) |
| `.atomic/todos/` | No | File-based task items managed by the built-in `todo` tool ([Tools](/tools)) |

## Create a global settings file {#example}

Add `"$schema"` for editor autocomplete and validation, then set the provider, model, and preferences you want in `~/.atomic/agent/settings.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/settings.schema.json",
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-6",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "httpIdleTimeoutMs": 600000,
  "enabledModels": ["claude-*", "gpt-5*"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["npm:@example/atomic-tools"]
}
```

In this example, `enabledModels` restricts startup fallback, `Ctrl+P` cycling, `/model`, and child subagents to authenticated models matching `"claude-*"` or `"gpt-5*"`. Omit it or set `[]` to leave all authenticated models active. See [Model scope (`enabledModels`)](/settings#enabledmodels).

## Project overrides

<Warning>
Project settings in `.atomic/settings.json` (and legacy `.pi/settings.json`) load only when the project is trusted. Interactive sessions prompt once before trusting a project; non-interactive runs skip untrusted project settings unless you pass `--approve` (`-a`) or set global `defaultProjectTrust` to `"always"`. See [Project trust](/security#project-trust).
</Warning>

When a project is trusted, `.atomic/settings.json` merges over `~/.atomic/agent/settings.json` using these rules:

- **Nested objects merge recursively.** Override a single nested field (such as `compaction.reserveTokens`) without repeating its siblings.
- **`storage` and `sessions.storage` replace as whole objects.** Setting either in a project file replaces the global object instead of merging individual fields.
- **Resource arrays combine across scopes.** `packages`, `extensions`, `skills`, `prompts`, and `themes` combine entries from global and project settings. When both scopes name the same package, the project entry wins. Use `!pattern` or `-exact` exclusions to suppress a resource. Setting `"packages": []` in `.atomic/settings.json` clears only a legacy `.pi/settings.json` in the same project, not global `~/.atomic/agent/settings.json`.
- **Other arrays and scalars replace global values.** Settings such as `enabledModels`, `fallbackModels`, `npmCommand`, `resume.cache`, and scalar values replace the global value. Setting `"enabledModels": []` in a project file clears a global model scope for that project.
- **`defaultTools` supports additive modifiers.** A project `defaultTools` array containing only `+tool` or `-tool` entries layers on top of global `defaultTools`. Any plain tool name or `[]` replaces the global list.
- **Security-sensitive and host-level settings are global-only.** Atomic ignores project values for global-only keys such as `defaultProjectTrust`, `httpProxy`, and `debug` (see [Settings reference](/settings) for every global-only key). Project `storage` applies only to sessions—not Intercom multi-node routing—and `atomic update` reads `npmCommand` only from global settings.

For example, to add `tool_search`, drop `codemode`, and exclude a global skill in one project:

```json
{
  "defaultTools": ["+tool_search", "-codemode"],
  "skills": ["!legacy-deploy"]
}
```

Or override only `compaction.reserveTokens` while keeping the rest of your global config:

Global `~/.atomic/agent/settings.json`:

```json
{
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384
  }
}
```

Project `.atomic/settings.json`:

```json
{
  "compaction": {
    "reserveTokens": 8192
  }
}
```

Effective settings for the project:

```json
{
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 8192
  }
}
```

## Next steps

<Columns cols={2}>
  <Card title="Settings reference" href="/settings">
    Every supported key, type, default, and global-only rule.
  </Card>
  <Card title="Choose a model" href="/models/choose-a-model">
    Switch models daily, scope cycling, and configure fallbacks.
  </Card>
  <Card title="Storage" href="/storage">
    Choose between local SQLite, JSONL, and shared PostgreSQL.
  </Card>
  <Card title="CLI reference" href="/reference/cli">
    Override configuration for a single run with CLI flags.
  </Card>
</Columns>
