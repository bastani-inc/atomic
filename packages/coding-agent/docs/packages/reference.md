---
title: Package reference
description: Package filtering, scope, and deduplication contracts.
---

# Package reference

## Package Filtering

Filter what a package loads using the object form in settings:

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
      "workflows": ["workflows/*.ts"],
      "mcpServers": ["acme-*", "!acme-legacy"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root. `mcpServers` patterns match server names from the package manifest instead of paths, and `+name`/`-name` match a name exactly.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Scope and Deduplication

Packages can appear in both global and project settings. The project entry normally wins.

A project entry with `autoload: false` instead adjusts the inherited global resources. It adds no newly auto-discovered resources; explicit include/exclude patterns control what loads.

Package identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
