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
  "defaultModel": "claude-sonnet-4-20250514",
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
  "httpIdleTimeoutMs": 300000,
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project overrides

Project settings override global settings:

- Nested objects merge recursively. You can change one field without repeating its siblings.
- Arrays and scalar values replace the global value.

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
