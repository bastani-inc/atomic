---
title: "Atomic packages"
description: "Install, manage, and share Atomic packages that bundle extensions, skills, prompt templates, themes, workflows, and MCP servers."
---

> Atomic can help you create packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# Atomic Packages

Atomic packages bundle extensions, skills, prompt templates, themes, workflow definitions, and MCP servers so you can share them through npm or git. Declare resources in `package.json` under the `atomic` key, or use conventional directories.

## Where to go next

Read this page to install and manage packages, then continue:

- [Creating packages](/packages/authoring) — create a package, lay out its structure, and declare dependencies.
- [Package reference](/packages/reference) — filtering, scope, and deduplication contracts.

## Table of Contents

- [Atomic Packages](#atomic-packages)
  - [Table of Contents](#table-of-contents)
  - [Install and Manage](#install-and-manage)
  - [Package Sources](#package-sources)
    - [npm](#npm)
    - [git](#git)
    - [Local Paths](#local-paths)
  - [Creating an Atomic Package](/packages/authoring#creating-an-atomic-package)
    - [Gallery Metadata](/packages/authoring#gallery-metadata)
    - [MCP Servers](/packages/authoring#mcp-servers)
  - [Package Structure](/packages/authoring#package-structure)
    - [Convention Directories](/packages/authoring#convention-directories)
  - [Dependencies](/packages/authoring#dependencies)
  - [Package Filtering](/packages/reference#package-filtering)
  - [Enable and Disable Resources](#enable-and-disable-resources)
  - [Scope and Deduplication](/packages/reference#scope-and-deduplication)

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
atomic update                   # update Atomic only
atomic update --all             # update Atomic, update packages, and reconcile pinned git refs
atomic update --extensions      # update packages and reconcile pinned git refs only
atomic update --models          # force-refresh authenticated provider model catalogs
atomic update --self            # update Atomic only
atomic update --self --force    # reinstall Atomic even if current
atomic update npm:@foo/bar      # update one package
atomic update --extension npm:@foo/bar
```

These commands manage Atomic packages and `atomic update` can update the Atomic CLI installation. To uninstall Atomic itself, see [Quickstart](/getting-started/installation#uninstall).

Self-update installs an exact advertised package/version, so it cannot drift to a newer registry release during installation. Atomic shows any release note supplied by the update service before installing.

Atomic updates only installations it can verify are writable and managed by the detected global package manager. Otherwise, follow the manual command it prints.

By default, `install` and `remove` write to user settings (`~/.atomic/agent/settings.json`). Use `-l` to write to project settings (`.atomic/settings.json`; legacy `.pi/settings.json` is also read) instead. Project settings can be shared with your team, and Atomic installs any missing packages automatically on startup after the project is trusted.

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
atomic -e npm:@foo/bar
atomic -e git:github.com/user/repo
```

For local directories, `-e <dir>` also borrows project-local Atomic resources under `<dir>/.atomic`, legacy `<dir>/.pi`, and `<dir>/.agents/skills` when present. Because borrowed extensions and workflows can execute code, Atomic resolves trust for that extension source before loading those borrowed project-local resources.

Workflow stages launched through `-e` inherit the same trusted resources, including package tools, extensions, agent definitions, skills, prompts, themes, and workflows. An explicit stage `resourceLoader` overrides that inheritance.

## Package Sources

Atomic accepts three source types in settings and `atomic install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`atomic update --extensions`, `atomic update --all`).
- User installs use the configured npm-compatible package-manager command (npm by default) and resolve from the managed Atomic npm area.
- Project installs go under `.atomic/npm/` (legacy `.pi/npm/` remains a compatibility fallback).
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
- Refs are pinned tags or commits. `atomic update --extensions` and `atomic update --all` do not move them to newer refs, but they do reconcile an existing clone to the configured ref.
- Use `atomic install git:host/user/repo@new-ref` to update settings and move an existing package to a new pinned ref.
- Cloned to `~/.atomic/agent/git/<host>/<path>` (global) or `.atomic/git/<host>/<path>` (project; legacy `.pi/git/` remains a compatibility fallback).
- When reconciliation changes the checkout, Atomic resets and cleans the clone, then runs the configured npm-compatible install command if `package.json` exists.

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

Moved to [Creating packages](/packages/authoring#creating-an-atomic-package).

### Gallery Metadata

Moved to [Creating packages](/packages/authoring#gallery-metadata).

## Package Structure

Moved to [Creating packages](/packages/authoring#package-structure).

### Convention Directories

Moved to [Creating packages](/packages/authoring#convention-directories).

## Dependencies

Moved to [Creating packages](/packages/authoring#dependencies).

## Package Filtering

Moved to [Package reference](/packages/reference#package-filtering).

## Enable and Disable Resources

Use `atomic config` to enable or disable extensions, skills, prompt templates, and themes. It starts in global settings (`~/.atomic/agent/settings.json`); press Tab to switch global/project scope. Use `atomic config -l` to start in project overrides (`.atomic/settings.json`) with inherited global resources dimmed. Workflow package filters can be configured with `workflows` patterns.

When an uncaught exception or a fatal runtime error ends an interactive session, Atomic checks the crash stack for frames that belong to loaded extensions and names the matching extension packages or files in the exit message, suggesting `atomic config` to disable them or `atomic -ne` to confirm the crash reproduces without optional extensions.

## Scope and Deduplication

Moved to [Package reference](/packages/reference#scope-and-deduplication).
