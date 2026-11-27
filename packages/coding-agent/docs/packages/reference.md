---
title: "Package reference"
sidebarTitle: "Packages"
description: "Reference for package resource filtering patterns, glob vs exact matching, autoload overrides, precedence, deduplication, and cache paths."
---

Reference for package filtering, `autoload: false`, precedence, deduplication, and temporary cache paths. To install and manage packages, see [Install and manage packages](/packages) and [Package CLI commands](/reference/cli#package-commands). To publish a package, see [Create and publish packages](/packages/authoring).

## Package filtering

Use the object form in [`settings.json`](/settings) to filter which resources load from a package:

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

How package filters interact with the package manifest:

- When the package manifest defines a non-empty array for a resource type, filters run only over the files enabled by that manifest entry and cannot force-include files the manifest excluded.
- When a package filter object is configured in `settings.json`, any resource type omitted from the package's `atomic` manifest—or set to `[]` under an active filter or `autoload: false`—falls back to scanning the package's convention directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

### Pattern syntax

| Entry | Mode | Meaning |
| --- | --- | --- |
| *(key omitted)* | Default | Load all resources of this type exposed by the package |
| `[]` | Empty | Load no resources of this type |
| `pattern` (plain) | Glob | Restrict to entries matching at least one plain pattern (or enable matching items under `autoload: false`) |
| `!pattern` | Glob | Exclude matching entries |
| `+path` / `+name` | Exact match | Force-include an exact relative path, full path, or MCP server name |
| `-path` / `-name` | Exact match | Force-exclude an exact relative path, full path, or MCP server name |

### Glob vs. exact matching rules

- **Glob patterns (plain and `!pattern`)** are case-sensitive and always use POSIX `/` separators (`*` matches within one path segment, `**` crosses segments, `?` matches a single character):
  - For file resources (`extensions`, `skills`, `prompts`, `themes`, `agents`), globs test the relative path from the package root (or settings directory), the bare filename (`basename`), and the full path.
  - For `SKILL.md` files, globs also test the skill's parent directory (relative path, directory basename, and full path). `"!my-skill"` excludes `skills/my-skill/SKILL.md`.
  - For `mcpServers`, globs test the server name from the manifest.
- **Exact patterns (`+path` and `-path`)** strip leading `./` or `.\`, expand `~` in top-level settings arrays, and normalize slashes to `/`:
  - For file resources, exact patterns match **only** the exact relative path or exact full path, plus the exact parent directory path for `SKILL.md` files (`"-skills/my-skill"` excludes `skills/my-skill/SKILL.md`).
  - Exact patterns do **not** match bare filenames. `"-legacy.json"` will not exclude `themes/legacy.json`; write `"-themes/legacy.json"` or `"!legacy.json"` instead.
  - For `mcpServers`, `+name` and `-name` match exact server names.

### Evaluation order

In **normal mode** (`autoload` omitted or `true`), operator type decides precedence regardless of array order:

1. **Plain include globs:** if any plain patterns exist, narrow the set to files matching at least one of them; otherwise start with every resource collected from the package.
2. **`!pattern` glob excludes:** remove matching entries.
3. **`+path` / `+name` exact force-includes:** re-add matching entries (overrides plain filters and `!pattern`).
4. **`-path` / `-name` exact force-excludes:** remove matching entries last (`-` always beats `+`).

With **`"autoload": false`**, evaluation switches to **array order (last match wins)** across all four forms: plain globs and `+path`/`+name` enable matching items, while `!pattern` and `-path`/`-name` disable them.

- On a **project** entry matching a **global** package, `"autoload": false` reuses the user-scoped package installation on disk (without re-installing into `.atomic/npm` or `.atomic/git`), starts from the inherited global selection, and applies each entry in array order as a delta override.
- On a **standalone** package (not present in global settings), `"autoload": false` starts empty and loads only resources enabled by matching entries in array order.

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
- Toggle built-in extensions (`builtin:codemode`, `builtin:tool-search`, `builtin:llama.cpp`) in top-level `extensions` with `"-builtin:<name>"` or `"+builtin:<name>"`. Global `extensions` evaluates `builtin:<name>` overrides by operator precedence (`!` < `+` < `-`), whereas project `extensions` evaluates override entries (`!`, `+`, `-`) in array order (last match wins).
- Package [subagents](/packages/authoring#subagents) have no top-level settings array—filter them per package with `agents`.
- `mcpServers` filters match server names rather than file paths.

<Note>
Putting a plain glob (containing `*` or `?`, without `!`, `+`, or `-`) in a top-level `extensions`, `skills`, `prompts`, or `themes` array does **not** discover files from disk. It filters only the other plain paths listed in that same array and does not filter auto-discovered directories (auto-discovered directories evaluate `!`, `+`, and `-` overrides only).
</Note>

## Scope and deduplication

- **Project overrides global.** When the same package appears in both global and project settings, the project entry wins (unless `"autoload": false` is set on the project entry to apply delta overrides on top of the inherited global selection).
- **Listing packages.** `atomic list` displays `User packages` and `Project packages` separately and marks object-form entries with `(filtered)`.
- **Package identity.** Atomic deduplicates packages by npm package name (`npm`), normalized repository URL without `@ref`/`#ref` (`git`), or resolved canonical path (`local`, so `./pkg` and `/abs/path/to/pkg` match as the same package).
- **Subagent collisions.** When multiple packages define the same full subagent name, `-e` packages take precedence over project-installed packages, which take precedence over globally installed packages.

### Temporary package cache

Remote packages passed with `-e` / `--extension` install into a private user-owned cache directory chosen in this order:

1. `$XDG_RUNTIME_DIR/atomic/extensions`
2. `<agentDir>/cache/tmp/extensions`
3. `<tmpdir>/atomic-<uid>/extensions`

Symlinked, shared, or other-user-owned cache directories are refused. Unpinned npm specs and branch or tag git refs refresh on start and `/reload` (falling back to cached copies when offline or on error); exact `@1.2.3` npm pins and checked-out git commit hashes (7 to 64 hex characters matching `HEAD`) skip network refresh.

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

Special cases:

- Because explicit CLI flags (`--skill`, `--prompt-template`, `--theme`) apply last, pass `--no-skills` (`-ns`), `--no-prompt-templates` (`-np`), or `--no-themes` if you want a CLI path to override an existing or bundled resource with the same name.
- For prompt templates, an inherited legacy `.pi` template yields to a bundled template with the same name.
- For extensions, `-e` flags load before configured and auto-discovered extensions.
