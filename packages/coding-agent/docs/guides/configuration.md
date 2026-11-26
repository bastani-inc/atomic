---
title: "Configure Atomic"
sidebarTitle: "Configuration"
description: "Choose the right configuration file, set global preferences in settings.json, and override settings per project."
---

After your [first session](/getting-started/first-session), save global preferences in `~/.atomic/agent/settings.json`. Use `.atomic/settings.json` for overrides that apply only to the current project.

You can edit either file directly or run `/settings` inside an interactive session to change common options. Both files use strict JSON (no `//` comments or trailing commas).

## Where to configure what

Atomic splits configuration by scope and purpose:

| What you want to configure | Where to put it | Guide |
| --- | --- | --- |
| Subscriptions, API keys, and cloud credentials | `/login`, `~/.atomic/agent/auth.json`, or provider env vars | [Model providers](/providers) |
| Custom models, local servers, proxies, overrides, and remote compactors | `~/.atomic/agent/models.json` | [Configure custom models](/models) |
| Custom provider APIs, OAuth flows, dynamic catalogs, and account aliases | Extension calling `atomic.registerProvider()` | [Build custom providers](/custom-provider) |
| Persistent defaults, `enabledModels`, `fallbackModels`, `decisionModel`, `compactionModel`, tools, and storage | `~/.atomic/agent/settings.json` and `.atomic/settings.json` | [Settings reference](/settings) |
| Local SQLite, JSONL, or PostgreSQL session and Intercom backends | `storage` / `sessions.storage`, `atomic storage join`, or SDK storage options | [Storage](/storage) and [SDK storage](/sdk/storage) |
| One-run overrides for a single command | CLI flags (`--model`, `--models`, `--tools`, `--storage`) | [CLI reference](/reference/cli) |
| Process, CI, terminal, and diagnostic overrides | `ATOMIC_*` environment variables | [Environment variables](/environment-variables) |
| Programmatic session setup in TypeScript | `createAgentSession()` and `SettingsManager` options | [SDK](/sdk) |

## Create a global settings file {#example}

Add `"$schema"` for editor autocomplete and validation, then set the provider, model, and preferences you want:

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

Project settings in `.atomic/settings.json` (and legacy `.pi/settings.json`) load only when the project is trusted. Interactive sessions prompt once before trusting a project; non-interactive runs skip untrusted project settings unless you pass `--approve` or set global `defaultProjectTrust` to `"always"`. See [Project trust](/security#project-trust).

When a project is trusted, `.atomic/settings.json` merges over `~/.atomic/agent/settings.json` using these rules:

- **Nested objects merge recursively.** You can override one field inside an object (such as `compaction.reserveTokens`) without repeating its siblings.
- **`storage` and `sessions.storage` replace as whole objects.** Setting either in a project file replaces the global object instead of merging individual fields.
- **Resource arrays combine across scopes.** `packages`, `extensions`, `skills`, `prompts`, and `themes` combine entries from global and project settings. When both scopes name the same package, the project entry wins. Use `!pattern` or `-exact` exclusions to suppress a resource. Setting `"packages": []` in `.atomic/settings.json` clears only a legacy `.pi/settings.json` in the same project, not global `~/.atomic/agent/settings.json`.
- **Other arrays and scalars replace global values.** Settings such as `enabledModels`, `fallbackModels`, `npmCommand`, `resume.cache`, and scalar values replace the global value. Setting `"enabledModels": []` in a project file clears a global model scope for that project.
- **`defaultTools` supports additive modifiers.** A project `defaultTools` array containing only `+tool` or `-tool` entries layers on top of global `defaultTools`. Any plain tool name or `[]` replaces the global list.
- **Global-only settings are ignored in project files.** Atomic ignores project values for `defaultProjectTrust`, `debug`, `httpProxy`, `cacheWarming`, `selfUpdateCommand`, `deviceId`, and the deprecated `resume.setupCommand`. Project `storage` applies to sessions, not Intercom multi-node routing, and `atomic update` reads `npmCommand` only from global settings.

This example overrides only `compaction.reserveTokens` for one project while keeping the rest of the global config.

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

- Review every supported key and default in the [Settings reference](/settings).
- Connect subscription logins or API keys in [Model providers](/providers).
- Add local servers, proxies, overrides, or remote compactors in [Configure custom models](/models), or register custom APIs and OAuth in [Build custom providers](/custom-provider).
- Choose local or shared databases in [Storage](/storage) and [SDK storage](/sdk/storage).
- Override settings for one run with [CLI reference](/reference/cli) flags or [Environment variables](/environment-variables), or configure hosts programmatically with the [SDK](/sdk).
