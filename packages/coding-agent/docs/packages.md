> Atomic can help you create packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# Atomic Packages

Atomic packages bundle extensions, skills, prompt templates, themes, and workflow definitions so you can share them through npm or git. Declare resources in `package.json` under the `atomic` key, or use conventional directories.

## Table of Contents

- [Atomic Packages](#atomic-packages)
  - [Table of Contents](#table-of-contents)
  - [Install and Manage](#install-and-manage)
  - [Package Sources](#package-sources)
    - [npm](#npm)
    - [git](#git)
    - [Local Paths](#local-paths)
  - [Creating an Atomic Package](#creating-an-atomic-package)
    - [Gallery Metadata](#gallery-metadata)
  - [Package Structure](#package-structure)
    - [Convention Directories](#convention-directories)
  - [Dependencies](#dependencies)
  - [Package Filtering](#package-filtering)
  - [Enable and Disable Resources](#enable-and-disable-resources)
  - [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Atomic packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
atomic install npm:@foo/bar@1.0.0
atomic install git:github.com/user/repo@v1
atomic install https://github.com/user/repo  # raw URLs work too
atomic install /absolute/path/to/package
atomic install ./relative/path/to/package

atomic remove npm:@foo/bar
atomic list                     # show installed packages from settings
atomic update                   # update Atomic and all non-pinned packages
atomic update --extensions      # update all non-pinned packages only
atomic update --self            # update Atomic only
atomic update --self --force    # reinstall Atomic even if current
atomic update npm:@foo/bar      # update one package
atomic update --extension npm:@foo/bar
```

By default, `install` and `remove` write to global settings (`~/.atomic/agent/settings.json`). Use `-l` to write to project settings (`.atomic/settings.json`) instead. Project settings can be shared with your team, and Atomic installs any missing packages automatically on startup after the project is trusted.

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
atomic -e npm:@foo/bar
atomic -e git:github.com/user/repo
```

For local directories, `-e <dir>` also borrows project-local Atomic resources under `<dir>/.atomic`, legacy `<dir>/.pi`, and `<dir>/.agents/skills` when present. Because borrowed extensions and workflows can execute code, Atomic resolves trust for that extension source before loading those borrowed project-local resources.

## Package Sources

Atomic accepts three source types in settings and `atomic install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`atomic update`, `atomic update --extensions`).
- Global installs use the configured npm-compatible package-manager command (npm by default).
- Project installs go under `.atomic/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs pin the package and skip package updates (`atomic update`, `atomic update --extensions`).
- Cloned to `~/.atomic/agent/git/<host>/<path>` (global) or `.atomic/git/<host>/<path>` (project).
- Runs the configured npm-compatible install command after clone or pull if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
atomic install git:git@github.com:user/repo

# ssh:// protocol format
atomic install ssh://git@github.com/user/repo

# With version ref
atomic install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, Atomic loads resources using package rules. Temporary local directories supplied with `-e` may also expose `.atomic`/`.pi` project-local resources and `.agents/skills` after the extension source is trusted.

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
- `workflows/` loads workflow SDK files (`.ts`, `.js`, `.mjs`, `.cjs`); `workflow/` is also accepted as a singular alias. Workflow files should `import { defineWorkflow, Type } from "@bastani/workflows"` and export `defineWorkflow(...).compile()` output. TypeScript package authors do not need a hand-authored `.d.ts`, a `declare module` shim, or a `tsconfig` `paths` alias for the SDK import — the SDK types ship with `@bastani/atomic`. A package that also imports `@bastani/atomic` picks them up automatically; a pure workflow-only package adds one opt-in line (`compilerOptions.types: ["@bastani/atomic/workflows/ambient"]` or a `/// <reference types="@bastani/atomic/workflows/ambient" />` directive). See the workflow SDK typing guidance under Programmatic Usage in the workflows guide.

When a package manifest exists, declared resource arrays normally define what loads. Workflows are the exception: if `atomic.workflows` / legacy `pi.workflows` is omitted, Atomic still checks conventional `workflows/` and `workflow/` directories.

## Dependencies

Third-party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, themes, or workflows also belong in `dependencies`. When Atomic installs a package from npm or git, it runs the configured npm-compatible install command, so those dependencies are installed automatically.

Atomic bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@bastani/atomic`, `@earendil-works/pi-tui`, `typebox`.

Workflow packages should author workflow files with `import { defineWorkflow, Type } from "@bastani/workflows"` and export definitions produced by `defineWorkflow(...).compile()`. Do not use the removed `runWorkflow` object-form API, and do not hand-roll objects with `__piWorkflow: true`; discovery accepts only compiled definitions. `@bastani/workflows` is not a separate npm package: its types resolve through `@bastani/atomic`, so list `@bastani/atomic` and `typebox` in `peerDependencies` (the workflow SDK's emitted types reference `typebox`). A pure workflow-only package also adds the one-line ambient opt-in noted above; a package that imports `@bastani/atomic` elsewhere picks the types up automatically.

Package-authored workflows should follow the same guiding principles as project workflows mentioned in docs/workflows.md.

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
      "workflows": ["workflows/*.ts"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `atomic config` to enable or disable extensions, skills, prompt templates, and themes from installed packages and local directories. Works for both global (`~/.atomic/agent`) and project (`.atomic/`) scopes. Workflow package filters can be configured in settings with `workflows` patterns.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
