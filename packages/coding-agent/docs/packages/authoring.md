---
title: Creating packages
description: Create an Atomic package, lay out its structure, and declare dependencies.
---

# Creating packages

## Creating an Atomic Package

Add an app manifest to `package.json` or use conventional directories. The manifest key is the configured app name (`atomic` here, from `atomicConfig.name`; legacy `piConfig.name` is also read). The legacy `pi` key remains supported as a backwards-compatible shim. Include the `atomic-package` keyword for discoverability.

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

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.

### Subagents

A package can ship [custom subagents](/subagents/authoring) with `agents`: a list of agent `.md` files or directories, relative to the package root. Directories are searched recursively for `.md` files. Agents are only read from the manifest, never from a convention directory.

Use package agents for named roles that need fixed settings: a model and fallback chain with their thinking levels, an exact tool list, and the MCP servers the role may use. A skill in the same package can then launch them by name.

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
model: anthropic/claude-sonnet-4:high
fallbackModels: openai/gpt-5:medium, anthropic/claude-haiku-4-5:low
tools: read, search, bash, mcp:acme-search
---

Review the change you are given without editing files. Cite each issue with file:line evidence and stop once the diff and its call paths are covered.
```

- **Name.** A package agent runs as `<namespace>.<name>`. The namespace is the package's `name`, lowercased, with an npm scope turned into a dotted prefix, so this agent is `acme.review-kit.reviewer`. A package without a `name` uses its directory name. A `package:` field in the agent's frontmatter is ignored, and an agent whose `name` contains a dot is not loaded.
- **Pins.** Put a [reasoning level](/subagents/reference#reasoning-levels) on `model` and on each `fallbackModels` entry. `tools` is the exact tool list; `mcp:<server>` adds all of a server's tools and `mcp:<server>/<tool>` adds one. Ship the server itself with [`mcpServers`](#mcp-servers).
- **Launching.** From codemode, `await tools.subagent({ agent: "acme.review-kit.reviewer", task })`. Leave out `model` on the call to keep the agent's model.
- **Overrides.** A user or project agent with the same full name replaces the package's agent. For example, `~/.atomic/agent/agents/reviewer.md` with `name: reviewer` and `package: acme.review-kit` overrides the agent above. Builtin agent names contain no dot, so package agents never replace builtins.
- **Trust.** Agents from a project-installed package are offered only in a trusted project. Agents from a package passed with `-e` are available for that run.
- **Updates.** Run `/reload` after installing, updating, or removing a package. After `atomic remove`, its agents disappear on `/reload` or in the next session. A running subagent keeps the definition it started with.
- **Filtering.** Narrow which agents load with an `agents` entry in the package's [settings filter](/packages/reference#package-filtering). `atomic config` does not list agents.

`subagent({ action: "list" })`, `get`, and `/agents` show the package each agent comes from. `update` and `delete` refuse to change a package agent; edit the package or override the agent instead.

### MCP Servers

A package can contribute [MCP servers](/mcp-servers) with `mcpServers`. Point it at a JSON file in the standard `{ "mcpServers": { ... } }` shape, relative to the package root, or declare the servers inline:

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

Entries use the same schema as `mcp.json`, including URL environment-variable interpolation, tool `exposure`, per-tool `toolExposure`, and request `timeout` in seconds. A relative `cwd` is resolved against the package root, so `"cwd": "."` lets a stdio server run files shipped in the package. MCP servers are only read from the manifest, never from a convention directory. Package manifests cannot select provider login credentials with `auth.provider`.

Contributed servers have the lowest precedence: users can replace or disable one by name in their own MCP configuration, and filter them with `mcpServers` patterns in settings. Project packages contribute servers only in trusted projects. For a server whose configuration is computed at runtime, call [`pi.registerMcpServer()`](/extensions/api-reference#pi-registermcpserver-name-config) from an extension.

### Storage Adapters

A package can provide [storage adapters](/storage#selecting-an-adapter) with `storageAdapters`, a list of adapter module paths relative to the package root. Put the database driver in `dependencies` so `atomic install` installs it with the package, and list `@bastani/atomic` in `peerDependencies`:

```json
{
  "name": "@example/atomic-libsql",
  "dependencies": { "@libsql/client": "0.18.0" },
  "peerDependencies": { "@bastani/atomic": "*" },
  "atomic": { "storageAdapters": ["./libsql-adapter.ts"] }
}
```

Users select the adapter with the package name, for example `"storage": { "adapter": "@example/atomic-libsql" }`, or with `<package>/<name>` when the package lists several adapters, where `<name>` is the adapter file's name without its extension. Storage adapters are only read from the manifest, never from a convention directory, and only from packages in user settings or package directories the process was given as extension paths. An application that embeds Atomic and loads its own package with `additionalExtensionPaths: [packageRoot]` or `--extension <dir>` can select its adapter by its package name without installing the package; Atomic checks those packages before the ones in settings. See [Adapters from Atomic packages](/storage#adapters-from-atomic-packages).

### Gallery Metadata

The package gallery currently recognizes legacy `pi-package` metadata, while new Atomic packages should also include `atomic-package`. Add `video` or `image` fields to show a preview:

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

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If no app manifest (`atomic`, or legacy `pi`) is present, Atomic auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

Subagents, MCP servers, and storage adapters are only read from the manifest.

For reusable procedures, ship a [skill](/skills). Existing package workflow modules are never imported or executed. Ask the agent to [convert one to a skill](/orchestration/migrating-workflows). It locates the file through the older `workflows` or `workflow` manifest entry or directory. A project-installed package yields a project skill and is available only in a trusted project. Globally installed packages yield global skills. Conversion leaves the package untouched.

## Dependencies

Third-party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. When Atomic installs a package from npm or git, it runs the configured npm-compatible install command, so those dependencies are installed automatically.

Atomic bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@bastani/atomic`, `@bastani/atomic-ai`, `@bastani/atomic-agent-core`, `@bastani/atomic-tui`, `@bastani/atomic-codemode`, `@bastani/atomic-schema`, `@bastani/atomic-telemetry`, `typebox`. The legacy pi names of these packages (`@earendil-works/pi-*`, `@mariozechner/pi-*` and `@bastani/pi-ai`) still resolve to Atomic's copies and follow the same rule. Atomic does not install peer dependencies for npm packages or for git packages installed with npm, pnpm, or Bun. Local packages are not installed or modified, so their dependency tree is up to the package author.

Do not list these host-provided packages in `dependencies`. An installed copy can bypass Atomic's extension module mapping and create duplicate classes, registries, and startup work. Atomic shows an extension warning when a package's `dependencies` include one of them.

Other Atomic packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. Atomic loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "atomic": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```
