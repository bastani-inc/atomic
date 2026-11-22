---
title: Configure Atomic
description: Write your first settings file and override settings per project.
---

# Configure Atomic

After your [first session](/getting-started/first-session), save global preferences in `~/.atomic/agent/settings.json`. Use `.atomic/settings.json` for overrides that apply only to the current project.

## Example

Choose the provider and model you have configured, then add the settings you need:

```json
{
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

Project settings in `.atomic/settings.json` override global settings in `~/.atomic/agent/settings.json` when the project is trusted:

- Nested objects merge recursively, so you can override one field without repeating its siblings.
- `storage` and `sessions.storage` replace as whole objects rather than merging field by field.
- Arrays and scalar values replace the global value. An exception is `defaultTools`: a project array containing only `+tool` or `-tool` modifiers applies on top of the global tool list.
- Global-only settings are ignored in project settings: `defaultProjectTrust`, `debug`, `httpProxy`, `cacheWarming`, `selfUpdateCommand`, `deviceId`, and the deprecated `resume.setupCommand`.

This example changes only the compaction token reserve:

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

## Next step

Every field is listed in the [Settings reference](/settings).
