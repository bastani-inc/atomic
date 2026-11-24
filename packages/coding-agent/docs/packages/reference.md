---
title: "Package reference"
sidebarTitle: "Packages"
description: "Reference for package resource filtering patterns, glob vs exact matching, autoload overrides, precedence, and deduplication."
---

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

Package filters run on top of the files collected from the package manifest (or convention directories when the package has no `atomic` manifest key). A filter cannot force-include files that the package manifest omitted or excluded.

### Pattern syntax

| Entry | Mode | Meaning |
| --- | --- | --- |
| *(key omitted)* | Default | Load all resources of this type exposed by the package |
| `[]` | Empty | Load no resources of this type |
| `pattern` (plain) | Glob (`minimatch`) | Restrict to entries matching at least one plain pattern |
| `!pattern` | Glob (`minimatch`) | Exclude matching entries |
| `+path` / `+name` | Exact match | Force-include an exact relative path, full path, or MCP server name |
| `-path` / `-name` | Exact match | Force-exclude an exact relative path, full path, or MCP server name |

### Glob vs exact matching rules

- **Glob patterns (plain and `!pattern`)** use `minimatch` (case-sensitive, POSIX `/` separators on all platforms; `*` matches within one path segment, `**` crosses segments, `?` matches one character):
  - For file resources (`extensions`, `skills`, `prompts`, `themes`, `agents`), globs test the relative path from the package root (or settings directory), the bare filename (`basename`), and the full path.
  - For `SKILL.md` files, globs also test the skill's parent directory (relative path, directory basename, and full path). Writing `"!my-skill"` excludes `skills/my-skill/SKILL.md`.
  - For `mcpServers`, globs test the server name from the manifest.
- **Exact patterns (`+path` and `-path`)** strip leading `./` or `.\`, expand `~` in top-level settings arrays, and normalize slashes to `/`:
  - For file resources, exact patterns match **only** the exact relative path or exact full path, plus the exact parent directory path for `SKILL.md` files (for example `"-skills/my-skill"` excludes `skills/my-skill/SKILL.md`).
  - Exact patterns do **not** match bare filenames. Writing `"-legacy.json"` will not exclude `themes/legacy.json`; use `"-themes/legacy.json"` or `"!legacy.json"` instead.
  - For `mcpServers`, `+name` and `-name` match exact server names.

### Evaluation order

In **normal mode** (`autoload` omitted or `true`), operator type decides precedence regardless of array order:

1. **Plain include globs:** if any plain patterns exist, narrow the set to files matching at least one of them; if none exist, start with every manifest resource.
2. **`!pattern` glob excludes:** remove matching entries.
3. **`+path` / `+name` exact force-includes:** re-add matching manifest entries (overrides plain filters and `!pattern`).
4. **`-path` / `-name` exact force-excludes:** remove matching entries last (`-` always beats `+`).

With **`"autoload": false`**, evaluation switches to **array order (last match wins)**:

- On a **project** entry matching a **global** package, `"autoload": false` starts from the inherited global selection and applies each entry in array order as a delta override without discovering new resources from the package.
- On a **standalone** package (not present in global settings), `"autoload": false` starts empty and loads only resources explicitly enabled by matching entries in array order.

```json
{
  "packages": [
    {
      "source": "npm:my-package",
      "autoload": false,
      "extensions": ["-extensions/heavy.ts", "+extensions/project-helper.ts"]
    }
  ]
}
```

### Top-level settings arrays

Top-level `extensions`, `skills`, `prompts`, and `themes` arrays in `settings.json` mix additive file or directory paths with `!`, `+`, and `-` filter patterns applied to both those paths and auto-discovered resources in the same scope:

- Patterns expand `~` to your home directory (for example `"!~/skills/legacy-*"` or `"-~/skills/legacy"`).
- Toggle built-in extensions (`builtin:codemode`, `builtin:tool-search`, `builtin:llama.cpp`) in the top-level `extensions` array with `"-builtin:<name>"` or `"+builtin:<name>"`.
- Package [subagents](/packages/authoring#subagents) have no top-level settings array. Filter them per package with `agents` (matching paths relative to the package root).
- `mcpServers` matches server names from the manifest rather than file paths.

## Scope and deduplication

- **Project overrides global.** When the same package appears in both global and project settings, the project entry wins (unless `"autoload": false` is set on the project entry to adjust the inherited global selection).
- **Listing packages.** `atomic list` displays `User packages` and `Project packages` separately and marks object-form entries with `(filtered)`.
- **Package identity.** Atomic deduplicates packages by npm package name (`npm`), normalized repository URL without `@ref` (`git`), or resolved canonical path (`local`, so `./pkg` and `/abs/path/to/pkg` match as the same package).
- **Subagent collisions.** When multiple packages define the same full subagent name, `-e` packages take precedence over project-installed packages, which take precedence over globally installed packages.

### Resource precedence order

When multiple sources declare a skill, prompt template, or theme with the same name, Atomic keeps the first match in this order:

1. Packages passed with `-e` / `--extension`
2. Project `settings.json` top-level resource arrays (`skills`, `prompts`, `themes`)
3. Project auto-discovered directories (`.atomic/`, then legacy `.pi/`, plus `.agents/skills/` for skills)
4. Global `settings.json` top-level resource arrays
5. Global auto-discovered directories (`~/.atomic/agent/`, then legacy `~/.pi/agent/`, plus `~/.agents/skills/` for skills)
6. Configured packages (project packages, then global packages)
7. Bundled packages (`@bastani/subagents`, `@bastani/intercom`)
8. Explicit CLI flags (`--skill`, `--prompt-template`, `--theme`)

For prompt templates, an inherited legacy `.pi` template yields to a bundled template with the same name. For extensions, `-e` flags load before configured and auto-discovered extensions.
