---
title: Creating packages
description: Create an Atomic package, lay out its structure, and declare dependencies.
---

# Creating packages

## Creating an Atomic package

Declare resources under the `atomic` key in `package.json` (legacy `pi` is still supported as a shim; paths are relative to the package root and support globs and `!exclusions`), and include `"atomic-package"` in `keywords`:

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

### Subagents

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

- **Qualified name.** Package subagents run as `<namespace>.<name>`, where `<namespace>` is the lowercased package `name` with any `@scope/` converted to `<scope>.` (so `@acme/review-kit` with `reviewer` becomes `acme.review-kit.reviewer`; unnamed packages use their directory name). Frontmatter `package:` is ignored, and names containing dots are skipped.
- **Pins and tools.** Attach [reasoning levels](/subagents/reference#reasoning-levels) directly to `model` and `fallbackModels`. `tools` is an exact allowlist: `mcp:<server>` adds all tools from that server, and `mcp:<server>/<tool>` adds one. Ship the server itself with [`mcpServers`](#mcp-servers).
- **Launching.** From codemode, call `await tools.subagent({ agent: "acme.review-kit.reviewer", task })` without a per-call `model` so the agent's pins apply.
- **Overrides and trust.** User or project agents with a matching full name (`name: reviewer` with `package: acme.review-kit`) override the package agent. Builtins have no dots and cannot be replaced by packages. Project-installed package agents require project trust; `-e` package agents load for that run.
- **Lifecycle and filtering.** Run `/reload` after install, update, or remove (running subagents keep their launch definition). Filter per package with `agents` in [settings](/packages/reference#package-filtering) (`atomic config` does not list agents). `subagent` `update` and `delete` refuse package agents. Edit the package or add an override instead.

### MCP servers

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

- Contributed servers use the standard `mcp.json` schema (URL environment interpolation, `exposure`, `toolExposure`, `timeout` in seconds). Relative `cwd` resolves against the package root (`"cwd": "."` targets files shipped in the package). `auth.provider` is not allowed in package manifests.
- Contributed servers have lowest precedence. User and project configurations can override or disable them by name, and settings can filter them via `mcpServers` patterns. Project packages contribute servers only in trusted projects.
- For dynamically computed server configs, call [`pi.registerMcpServer()`](/extensions/api-reference#pi-registermcpserver-name-config) from an extension.

### Storage adapters

Expose [storage adapters](/storage#selecting-an-adapter) via `storageAdapters` (manifest-only, paths relative to the package root). Put database drivers in `dependencies` and `@bastani/atomic` in `peerDependencies`:

```json
{
  "name": "@example/atomic-libsql",
  "dependencies": { "@libsql/client": "0.18.0" },
  "peerDependencies": { "@bastani/atomic": "*" },
  "atomic": { "storageAdapters": ["./libsql-adapter.ts"] }
}
```

Select an adapter by package name (`"storage": { "adapter": "@example/atomic-libsql" }`) or `<package>/<file-stem>` when a package exports multiple adapters. Adapters load only from user-settings packages or explicit extension paths (`--extension <dir>` or `additionalExtensionPaths`, which take precedence over settings). See [Adapters from Atomic packages](/storage#adapters-from-atomic-packages).

### Gallery metadata

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

Without an `atomic` (or legacy `pi`) manifest key, Atomic auto-discovers:

| Directory | Loaded files |
| --- | --- |
| `extensions/` | `.ts` and `.js` files |
| `skills/` | Recursive `SKILL.md` folders and top-level `.md` files |
| `prompts/` | `.md` files |
| `themes/` | `.json` files |

Subagents, MCP servers, and storage adapters require an explicit manifest entry.

**Legacy package workflows.** Ship repeatable procedures as [skills](/skills). Legacy workflow files in packages are never executed. Ask Atomic to [convert them into skills](/orchestration/migrating-workflows), which leaves the package untouched (project-installed packages produce project skills in trusted projects; global packages produce global skills).

## Dependencies

- **Third-party runtime dependencies.** Declare them in `dependencies`. Atomic runs your npm-compatible installer for npm and git packages automatically. Local path packages manage their own `node_modules`.
- **Host-provided packages (`peerDependencies: "*"` only).** Never list `@bastani/atomic`, `@bastani/atomic-ai`, `@bastani/atomic-agent-core`, `@bastani/atomic-tui`, `@bastani/atomic-codemode`, `@bastani/atomic-schema`, `@bastani/atomic-telemetry`, `typebox`, or their legacy `@earendil-works/pi-*`, `@mariozechner/pi-*`, or `@bastani/pi-ai` names in `dependencies` (doing so duplicates host registries and triggers a startup warning). Declare them in `peerDependencies` with `"*"` and do not bundle them.
- **Depending on other Atomic packages.** Add them to both `dependencies` and `bundledDependencies`, then reference their resources via `node_modules/...` paths (each package loads with its own isolated module root):

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
