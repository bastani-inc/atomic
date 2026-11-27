---
title: "Create and publish packages"
sidebarTitle: "Create packages"
description: "Declare Atomic package manifests for extensions, skills, subagents, prompts, themes, MCP servers, and storage adapters."
---

Bundle extensions, skills, prompt templates, themes, subagents, MCP servers, or storage adapters into an npm, git, or local Atomic package.

To install and update packages, see [Install and manage packages](/packages) and [Package CLI commands](/reference/cli#package-commands). For filtering and precedence rules, see [Package reference](/packages/reference).

## Package manifest

Declare resources under the `atomic` key in `package.json` (legacy `pi` is also supported) and add `"atomic-package"` to `keywords`:

```json
{
  "name": "my-package",
  "keywords": ["atomic-package"],
  "atomic": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"],
    "agents": ["./agents"]
  }
}
```

<Warning>
**Manifest vs. convention discovery.** For an unfiltered string package entry (`"npm:my-package"`), adding an `"atomic"` (or legacy `"pi"`) key stops auto-discovery of omitted convention directories—for example, declaring only `"mcpServers"` prevents `extensions/` from loading automatically. List every resource directory your package exposes.

Note that if a user configures a **package filter object** in `settings.json` (`{ "source": "...", ... }`), omitted manifest keys—and omitted or empty (`[]`) manifest arrays under a configured filter or `autoload: false`—fall back to scanning the package's convention directories (`extensions/`, `skills/`, `prompts/`, `themes/`).
</Warning>

Manifest array rules:

- Every entry in `extensions`, `skills`, `prompts`, `themes`, `agents`, and `storageAdapters` must be a string (non-string arrays are ignored).
- In `extensions`, `skills`, `prompts`, `themes`, and `agents`, paths resolve relative to the package root, glob patterns skip dotfiles and dot-directories, and `!`, `+`, and `-` entries filter the files matched by plain entries in the same array. Plain globs do **not** honor `.gitignore`, `.ignore`, or `.fdignore`, whereas plain directory entries do.
- In `storageAdapters`, every entry is treated as a **literal relative path only**—globs and `!`, `+`, `-` filters are not supported.

## Subagents

Ship [custom subagents](/subagents/authoring) via the `agents` array (relative `.md` files or directories searched recursively). Package subagents are manifest-only and are never auto-discovered from an `agents/` directory.

```json
{
  "name": "@acme/review-kit",
  "keywords": ["atomic-package"],
  "atomic": {
    "skills": ["./skills"],
    "agents": ["./agents"],
    "mcpServers": {
      "acme-search": { "url": "https://mcp.acme.dev", "headers": { "Authorization": "Bearer ${ACME_TOKEN}" } }
    }
  }
}
```

`agents/reviewer.md`:

```markdown
---
name: reviewer
description: Review a diff for correctness and security regressions without editing files
model: anthropic/claude-sonnet-5-5:high
fallbackModels: openai/gpt-6-sol:medium, anthropic/claude-haiku-5-5:low
tools: read, search, bash, mcp:acme-search
---

Review the change you are given without editing files. Cite each issue with file:line evidence and stop once the diff and its call paths are covered.
```

| Aspect | Behavior |
| --- | --- |
| **Qualified name** | Runs as `<namespace>.<name>`, where `<namespace>` is the lowercased `package.json` `name` with `@scope/` converted to `scope.` (`@acme/review-kit` + `reviewer` → `acme.review-kit.reviewer`; unnamed packages use their directory name). Frontmatter `package:` is ignored. Subagent names with dots, or packages without a valid namespace identifier, are skipped with a diagnostic. |
| **Models and tools** | Attach [reasoning levels](/subagents/reference#reasoning-levels) directly to `model` and `fallbackModels`. `tools` is an exact allowlist: `mcp:<server>` adds every tool on that server and `mcp:<server>/<tool>` adds one. Ship the server via [`mcpServers`](#mcp-servers). |
| **Launching** | From codemode, call `await tools.subagent({ agent: "acme.review-kit.reviewer", task })` without a per-call `model` so the agent's model pins apply. |
| **Overrides and trust** | User or project agents with matching `name:` and `package:` override the package agent. Builtins have no dots and cannot be replaced by packages. Project-installed package agents require [project trust](/security); `-e` package agents load for that run. |
| **Lifecycle and filtering** | Run `/reload` after install, update, or remove (running children keep their launch definition). Filter per package with `agents` in [`settings.json`](/packages/reference#package-filtering) (`atomic config` omits agents). `subagent` `update` and `delete` refuse package agents—edit the package or add an override instead. |

## MCP servers

Contribute [MCP servers](/mcp-servers) via `mcpServers` in the manifest (manifest-only, never convention-discovered), pointing either to a JSON file or an inline object:

```json
{
  "atomic": {
    "mcpServers": "./mcp.json"
  }
}
```

```json
{
  "atomic": {
    "mcpServers": {
      "acme-search": { "url": "https://mcp.acme.dev", "headers": { "Authorization": "Bearer ${ACME_TOKEN}" } },
      "acme-local": { "command": "node", "args": ["./dist/server.js"], "cwd": "." }
    }
  }
}
```

- A referenced JSON file accepts a top-level `"mcpServers"` or `"mcp-servers"` key.
- Contributed servers follow the standard `mcp.json` schema (URL environment interpolation, `exposure`, `toolExposure`, positive `timeout` in seconds), and server names must match `^[A-Za-z0-9_-]+$`.
- Relative `cwd` values resolve against the package root when they do not start with `/`, `~`, or `$` (`"cwd": "."` points at the package root; absolute, home-relative, and `$VAR` paths stay as written).
- `type: "sse"` is rejected (use streamable HTTP), and `auth.provider` is not allowed in package manifests.
- Contributed servers have lowest precedence so user and project configs can override or disable them by name, and settings can filter them with `mcpServers` patterns. Project packages contribute servers only in trusted projects.
- For dynamically computed server configs, call [`atomic.registerMcpServer()`](/extensions/api-reference#atomic-registermcpserver-name-config) from an extension.

## Storage adapters

Expose [storage adapters](/storage/custom-adapters#selecting-an-adapter) via `storageAdapters` (manifest-only; literal relative file paths without globs or filter prefixes). Declare database drivers in `dependencies` and `@bastani/atomic` in `peerDependencies`:

```json
{
  "name": "@example/atomic-mydb",
  "dependencies": { "mydb-client": "1.0.0" },
  "peerDependencies": { "@bastani/atomic": "*" },
  "atomic": { "storageAdapters": ["./mydb-adapter.ts"] }
}
```

- Select a package's default adapter by package name (`"storage": { "adapter": "@example/atomic-mydb" }`), which picks the first entry in `storageAdapters`.
- Select a specific adapter from a multi-adapter package with `<package>/<file-stem>`, where `<file-stem>` is the filename without its extension (for example `"@example/atomic-mydb/mydb-adapter"`).
- Storage adapters load only from user-settings packages or **local** `--extension <dir>` / [`DefaultResourceLoader({ additionalExtensionPaths })`](/sdk/reference#extensions) directories (which take precedence over settings). Non-local `npm:` and `git:` `--extension` sources never register storage adapters, project-installed packages cannot supply them, and global npm lookup checks `~/.atomic/agent/npm/` only. See [Adapters from Atomic packages](/storage/custom-adapters#adapters-from-atomic-packages).

## Gallery metadata

When publishing a package for Atomic package gallery listings and previews, include `"atomic-package"` (and optionally legacy `"pi-package"`) in `keywords`, plus optional `video` (MP4; autoplays on hover in gallery cards and takes precedence over `image`) or `image` (PNG, JPEG, GIF, WebP):

```json
{
  "name": "my-package",
  "keywords": ["atomic-package", "pi-package"],
  "atomic": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

## Package structure

### Convention directories

When `package.json` has no `atomic` (or legacy `pi`) key, Atomic auto-discovers these directories:

| Directory | Loaded files |
| --- | --- |
| `extensions/` | Top-level `.ts` and `.js` files, plus subdirectories containing `index.ts`, `index.js`, or a `package.json` with `atomic.extensions` (or legacy `pi.extensions`, whose entries resolve as literal relative paths without globs or filters) |
| `skills/` | Recursive `SKILL.md` folders and top-level `.md` files |
| `prompts/` | `.md` files (scanned recursively in package convention directories, unlike `.atomic/prompts/` which is non-recursive) |
| `themes/` | `.json` files (scanned recursively in package convention directories, unlike `.atomic/themes/` which is non-recursive) |

Subagents, MCP servers, and storage adapters always require an explicit manifest entry.

<Note>
**Legacy package workflows.** Ship repeatable procedures as [skills](/skills). Legacy workflow files in packages are never executed. Ask Atomic to [convert them into skills](/orchestration/migrating-workflows), which leaves the package untouched.
</Note>

## Dependencies

- **Third-party runtime dependencies.** Declare them in `dependencies`. Atomic installs them automatically for npm and git packages; local path packages manage their own `node_modules`.
- **Host-provided packages (`peerDependencies: "*"` only).** Never list Atomic host packages or TypeBox in `dependencies` (doing so duplicates host registries and triggers a startup warning). Declare them in `peerDependencies` with `"*"` and do not bundle them:
  - `@bastani/atomic`
  - `@bastani/atomic-ai`
  - `@bastani/atomic-agent-core`
  - `@bastani/atomic-tui`
  - `@bastani/atomic-codemode`
  - `@bastani/atomic-schema`
  - `@bastani/atomic-telemetry`
  - `typebox` and `@sinclair/typebox`
  - *(Legacy aliases `@earendil-works/pi-*`, `@mariozechner/pi-*`, and `@bastani/pi-ai` are also host-provided.)*
- **Depending on other Atomic packages.** Add them to both `dependencies` and `bundledDependencies`, then point at their resources under `node_modules/...` (each package resolves dependencies from its own directory):

```json
{
  "dependencies": {
    "my-team-extensions": "^1.0.1"
  },
  "bundledDependencies": ["my-team-extensions"],
  "atomic": {
    "extensions": ["extensions", "node_modules/my-team-extensions/extensions"],
    "skills": ["skills", "node_modules/my-team-extensions/skills"]
  }
}
```
