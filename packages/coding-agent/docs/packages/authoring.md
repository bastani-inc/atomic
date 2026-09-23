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
    "workflows": ["./workflows"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.

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
- `workflows/` loads workflow SDK files (`.ts`, `.js`, `.mjs`, `.cjs`); `workflow/` is also accepted as a singular alias.

Workflow files import `workflow` from `@bastani/atomic/workflows`, import `Type` from `typebox`, and export the definition returned by `workflow({ ... })`. TypeScript resolves the published `@bastani/atomic/workflows` specifier through the `@bastani/atomic` package.

The host supports `typebox`, `typebox/compile`, `typebox/value`, and legacy `@sinclair/typebox` imports. See [Programmatic usage](/workflows/api-reference#programmatic-usage).

When a package manifest exists, declared resource arrays normally define what loads. Workflows are the exception: if `atomic.workflows` / legacy `pi.workflows` is omitted, Atomic still checks conventional `workflows/` and `workflow/` directories.

## Dependencies

Third-party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, themes, or workflows also belong in `dependencies`. When Atomic installs a package from npm or git, it runs the configured npm-compatible install command, so those dependencies are installed automatically.

Atomic bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@bastani/pi-ai`, `@earendil-works/pi-agent-core`, `@bastani/atomic`, `@earendil-works/pi-tui`, `typebox`. Atomic does not install peer dependencies for npm packages or for git packages installed with npm, pnpm, or Bun. Local packages are not installed or modified, so their dependency tree is up to the package author.

Do not list these host-provided packages in `dependencies`. An installed copy can bypass Atomic's extension module mapping and create duplicate classes, registries, and startup work. Atomic shows an extension warning when a package's `dependencies` include one of them.

Workflow packages import `workflow` from `@bastani/atomic/workflows`, import `Type` from `typebox`, and export definitions returned by `workflow({ ... })`. List `@bastani/atomic` and `typebox` in `peerDependencies` so package consumers receive the workflow SDK and schema library.

Package-authored workflows should follow the same [guiding principles](/workflows/authoring#guiding-principles) as project workflows.

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
