---
title: "Configure Atomic"
sidebarTitle: "Configuration"
description: "Set up global preferences in settings.json and override settings per project."
---

After your [first session](/getting-started/first-session), save global preferences in `~/.atomic/agent/settings.json`. Use `.atomic/settings.json` for overrides that apply only to the current project.

You can edit either file directly or run `/settings` inside an interactive session to change common options. Both files use strict JSON (no `//` comments or trailing commas).

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
