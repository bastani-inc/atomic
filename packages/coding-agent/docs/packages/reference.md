---
title: Package reference
description: Package filtering, scope, and deduplication contracts.
---

# Package reference

## Package filtering

Use the object form in `settings.json` to filter which resources load from a package:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"],
      "agents": ["agents/reviewer.md"],
      "mcpServers": ["acme-*", "!acme-legacy"]
    }
  ]
}
```

Pattern rules (applied on top of the package manifest):

| Pattern | Meaning |
| --- | --- |
| *(key omitted)* | Load all resources of this type |
| `[]` | Load none of this type |
| `!pattern` | Exclude matching entries |
| `+path` / `+name` | Force-include an exact relative path (or server name for `mcpServers`) |
| `-path` / `-name` | Force-exclude an exact relative path (or server name for `mcpServers`) |

- In top-level `extensions`, `skills`, `prompts`, and `themes` arrays, patterns expand `~` to your home directory (for example `!~/skills/legacy-*` or `-~/skills/legacy`).
- Package [subagents](/packages/authoring#subagents) have no top-level settings array. Filter them per package with `agents` (matching paths relative to the package root).
- `mcpServers` matches server names from the manifest rather than file paths.

## Scope and deduplication

- **Project overrides global.** When the same package appears in both global and project settings, the project entry wins.
- **Adjusting without autoloading.** Set `"autoload": false` on a project entry to filter inherited global resources without discovering new ones.
- **Subagent collisions.** When multiple packages define the same full subagent name, `-e` packages take precedence over project-installed packages, which take precedence over globally installed packages.
- **Package identity.** Atomic matches packages by npm package name (`npm`), repository URL without `@ref` (`git`), or resolved absolute path (`local`).
