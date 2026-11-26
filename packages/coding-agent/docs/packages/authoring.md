---
title: "Create and publish packages"
sidebarTitle: "Create packages"
description: "Declare Atomic package manifests for extensions, skills, subagents, prompts, themes, MCP servers, and storage adapters."
---

<div id="creating-an-atomic-package" />

To install and update packages, see [Install and manage packages](/packages) and [Package CLI commands](/reference/cli#package-commands). For filtering and precedence rules, see [Package reference](/packages/reference) and [Settings](/settings). For project trust requirements, see [Security](/security).

Declare package resources under the `atomic` key in `package.json` (legacy `pi` is also supported), and include `"atomic-package"` in `keywords`:

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

Manifest rules to know before adding an `atomic` key:

- **Manifest overrides convention discovery.** Once `package.json` contains an `"atomic"` (or legacy `"pi"`) key, Atomic stops auto-discovering omitted convention directories. For example, if you add `"atomic": { "mcpServers": "./mcp.json" }` without listing `"extensions": ["./extensions"]`, your `extensions/` directory is no longer loaded automatically. List every resource directory you want to expose.
- **Paths and filters.** Every array entry in `extensions`, `skills`, `prompts`, `themes`, `storageAdapters`, and `agents` must be a string (non-string arrays are ignored). Paths resolve relative to the package root, glob expansion skips dotfiles and dot-directories, and `!`, `+`, and `-` entries filter the files matched by plain entries in the same array.

## Subagents

Ship [custom subagents](/subagents/authoring) via the `agents` array (relative `.md` files or directories searched recursively). Package subagents are manifest-only and are never auto-discovered from an `agents/` convention directory.

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

- **Qualified name.** Package subagents run as `<namespace>.<name>`, where `<namespace>` is the lowercased package `name` with any `@scope/` converted to `<scope>.` (so `@acme/review-kit` with `reviewer` becomes `acme.review-kit.reviewer`; unnamed packages use their directory name). Frontmatter `package:` is ignored. Subagent names containing dots are skipped with a diagnostic, and if neither `package.json` `name` nor the directory name forms a valid namespace identifier, all agents in that package are skipped with a diagnostic.
- **Pins and tools.** Attach [reasoning levels](/subagents/reference#reasoning-levels) directly to `model` and `fallbackModels`. `tools` is an exact allowlist: `mcp:<server>` adds all tools from that server, and `mcp:<server>/<tool>` adds one. Ship the server itself with [`mcpServers`](#mcp-servers).
- **Launching.** From codemode, call `await tools.subagent({ agent: "acme.review-kit.reviewer", task })` without a per-call `model` so the agent's pins apply.
- **Overrides and trust.** User or project agents with a matching full name (`name: reviewer` with `package: acme.review-kit`) override the package agent. Builtins have no dots and cannot be replaced by packages. Project-installed package agents require project trust; `-e` package agents load for that run.
- **Lifecycle and filtering.** Run `/reload` after install, update, or remove (running subagents keep their launch definition). Filter per package with `agents` in [settings](/packages/reference#package-filtering) (`atomic config` does not list agents). `subagent` `update` and `delete` refuse package agents. Edit the package or add an override instead.

## MCP servers

Contribute [MCP servers](/mcp-servers) via `mcpServers` in the manifest (manifest-only, never convention-discovered), either pointing to a JSON file or inline:

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

- A referenced JSON file accepts either a top-level `"mcpServers"` or `"mcp-servers"` key.
- Contributed servers follow the standard `mcp.json` schema (URL environment interpolation, `exposure`, `toolExposure`, positive `timeout` in seconds). Server names must match `^[A-Za-z0-9_-]+$`.
- Relative `cwd` resolves against the package root when it does not start with `/`, `~`, or `$` (`"cwd": "."` targets files shipped in the package; absolute, home-relative, and `$VAR` paths stay as written).
- `type: "sse"` is rejected (use streamable HTTP), and `auth.provider` is not allowed in package manifests.
- Contributed servers have lowest precedence. User and project configurations can override or disable them by name, and settings can filter them via `mcpServers` patterns. Project packages contribute servers only in trusted projects.
- For dynamically computed server configs, call [`atomic.registerMcpServer()`](/extensions/api-reference#atomic-registermcpserver-name-config) from an extension.

## Storage adapters

Expose [storage adapters](/storage/custom-adapters#selecting-an-adapter) via `storageAdapters` (manifest-only, paths relative to the package root). Put database drivers in `dependencies` and `@bastani/atomic` in `peerDependencies`:

```json
{
  "name": "@example/atomic-mydb",
  "dependencies": { "mydb-client": "1.0.0" },
  "peerDependencies": { "@bastani/atomic": "*" },
  "atomic": { "storageAdapters": ["./mydb-adapter.ts"] }
}
```

- Select an adapter by package name (`"storage": { "adapter": "@example/atomic-mydb" }`), which selects the first entry in `storageAdapters` when a package lists multiple adapters.
- Select a specific adapter from a multi-adapter package with `<package>/<file-stem>`, where `<file-stem>` is the filename without its extension (for example `"@example/atomic-mydb/mydb-adapter"`).
- Storage adapters load only from user-settings packages or explicit extension paths (`--extension <dir>` in [CLI resource options](/reference/cli#resource-options) or [`DefaultResourceLoader({ additionalExtensionPaths })`](/sdk/reference#extensions), which take precedence over settings). Project-installed packages cannot supply storage adapters, and global npm adapter lookup checks `~/.atomic/agent/npm/` only (not the system global npm root). See [Adapters from Atomic packages](/storage/custom-adapters#adapters-from-atomic-packages).

## Gallery metadata

Include both `"atomic-package"` and legacy `"pi-package"` in `keywords` for gallery visibility, plus optional `video` (MP4; autoplays on hover and takes precedence over `image`) or `image` (PNG, JPEG, GIF, WebP):

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
| `extensions/` | Top-level `.ts` and `.js` files, plus subdirectories containing `index.ts`, `index.js`, or a `package.json` with `atomic.extensions` (or legacy `pi.extensions`) |
| `skills/` | Recursive `SKILL.md` folders and top-level `.md` files |
| `prompts/` | `.md` files (scanned recursively inside package convention directories, unlike `.atomic/prompts/` which is non-recursive) |
| `themes/` | `.json` files (scanned recursively inside package convention directories, unlike `.atomic/themes/` which is non-recursive) |

Subagents, MCP servers, and storage adapters require an explicit manifest entry.

**Legacy package workflows.** Ship repeatable procedures as [skills](/skills). Legacy workflow files in packages are never executed. Ask Atomic to [convert them into skills](/orchestration/migrating-workflows), which leaves the package untouched (project-installed packages produce project skills in trusted projects; global packages produce global skills).

## Dependencies

- **Third-party runtime dependencies.** Declare them in `dependencies`. Atomic runs your npm-compatible installer for npm and git packages automatically. Local path packages manage their own `node_modules`.
- **Host-provided packages (`peerDependencies: "*"` only).** Never list `@bastani/atomic`, `@bastani/atomic-ai`, `@bastani/atomic-agent-core`, `@bastani/atomic-tui`, `@bastani/atomic-codemode`, `@bastani/atomic-schema`, `@bastani/atomic-telemetry`, `typebox`, `@sinclair/typebox`, or their legacy `@earendil-works/pi-*`, `@mariozechner/pi-*`, or `@bastani/pi-ai` names in `dependencies` (doing so duplicates host registries and triggers a startup warning). Declare them in `peerDependencies` with `"*"` and do not bundle them.
- **Depending on other Atomic packages.** Add them to both `dependencies` and `bundledDependencies`, then reference their resources via `node_modules/...` paths (each package resolves dependencies from its own directory):

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
