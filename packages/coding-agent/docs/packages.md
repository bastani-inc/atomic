---
title: "Install and manage packages"
sidebarTitle: "Install and manage"
description: "Install, update, remove, and configure Atomic packages from npm, git, or local directories."
---

Atomic packages bundle extensions, skills, [subagents](/packages/authoring#subagents), prompt templates, themes, MCP servers, and [storage adapters](/storage/custom-adapters#adapters-from-atomic-packages) for distribution over npm, git, or local directories.

<Columns cols={2}>
  <Card title="Create and publish packages" href="/packages/authoring">
    Declare package manifests, subagents, MCP servers, storage adapters, convention directories, and dependencies.
  </Card>
  <Card title="Package reference" href="/packages/reference">
    Look up filter patterns, `autoload: false` overrides, resource precedence, deduplication, and cache paths.
  </Card>
  <Card title="Package CLI commands" href="/reference/cli#package-commands">
    Full reference for `install`, `remove`, `update`, `list`, and `config` flags.
  </Card>
  <Card title="SDK extensions" href="/sdk/reference#extensions">
    Load local packages and extensions programmatically with `DefaultResourceLoader`.
  </Card>
</Columns>

## Install and manage

<Warning>
Atomic packages run with full user permissions—extensions execute arbitrary code and skills instruct the model. Review third-party source code before installing. See [Security](/security) for project trust rules.
</Warning>

```bash
# Install globally (default) or into the current project (-l / --local)
atomic install npm:@foo/bar@1.0.0
atomic install git:github.com/user/repo@v1
atomic install https://github.com/user/repo        # Raw protocol URLs work directly
atomic install ./relative/path/to/package
atomic install -l npm:@foo/bar                     # Write to .atomic/settings.json

# Inspect and remove
atomic list                                        # Show global and project packages
atomic remove npm:@foo/bar                         # Alias: atomic uninstall

# Update packages
atomic update --extensions                         # Update all packages and reconcile git refs
atomic update --all                                # Update Atomic CLI + packages + git refs
atomic update npm:@foo/bar                         # Update one package (or --extension <src>)
atomic update --models                             # Refresh authenticated model catalogs (15s timeout)
```

<Note>
Plain `atomic update` (or `atomic update --self`) updates only the Atomic CLI and reminds you to run `atomic update --extensions` for packages. Self-update verifies `atomic --version` on `PATH` and runs `atomic intercom upgrade`; see [Installation](/getting-started/installation) for self-update overrides (`selfUpdateCommand` / `ATOMIC_SELF_UPDATE_COMMAND`) and uninstall steps.
</Note>

### Scope and project trust

- **Global vs. project scope.** `install` and `remove` edit `~/.atomic/agent/settings.json` by default ([Settings](/settings)). Pass `-l` / `--local` to edit `.atomic/settings.json` (legacy `.pi/settings.json` is also read). Missing project packages install automatically on startup once the project is trusted.
- **Project trust gate.** In an untrusted project, `atomic install -l` and `atomic remove -l` exit with code 1 (`Project is not trusted. Use --approve to modify local package config.`) unless you trust the project first ([Security](/security)) or pass `-a` / `--approve`. Both `-a` / `--approve` and `-na` / `--no-approve` work on `install`, `remove`, `update`, `list`, and `config`.

### Updating packages and offline mode

- **Flag combinations.** `--all`, `--models`, and `--extension` are mutually exclusive and cannot be combined with positional sources; `--extension` may be passed only once.
- **Output and partial failures.** Atomic reports each updated npm version or git commit (for example `npm:@foo/bar 1.2.0 -> 1.3.0`, tagged `(project)` for project scope) or prints `Packages are already up to date`. When some packages fail during a batch update, Atomic still prints the packages that succeeded before exiting non-zero.
- **Offline mode.** Pass `--offline` or set `ATOMIC_OFFLINE` to `1`, `true`, or `yes` (case-insensitive; legacy `PI_OFFLINE` is also read) to skip automatic startup installs and package updates.
- **Startup resilience.** If an automatic startup install fails (for example offline), Atomic warns with the matching `atomic remove` command, skips that package's resources, and retries on the next start or `/reload` (`atomic install` and `atomic update --extensions` still exit non-zero). Concurrent installs serialize per package, interrupted git clones re-clone on retry, and `atomic remove` cleans up orphaned directories.

### Preview a package with `-e`

Try a package for a single run without editing `settings.json`:

```bash
atomic -e npm:@foo/bar
atomic -e git:github.com/user/repo
```

`-e` / `--extension` installs remote sources into a private user-owned cache (see [Temporary package cache](/packages/reference#temporary-package-cache) for exact paths). Unpinned npm specs and branch or tag git refs refresh on start and `/reload` (falling back to cache offline or on error), while exact `@1.2.3` npm pins and matching git commit hashes skip network checks. Local `-e <dir>` paths can also load `<dir>/.atomic`, `<dir>/.pi`, and `<dir>/.agents/skills` after resolving trust for that directory.

## Package sources

### npm

```text
npm:@scope/pkg@1.2.3
npm:@scope/pkg@^1.2.0
npm:pkg@next
npm:pkg
```

- **Install locations.** Global npm packages install under `~/.atomic/agent/npm/` (managed by Atomic rather than your system global `npm -g` root; Atomic checks system global `npm`, `pnpm`, or `bun` roots only for legacy installs already there). Project installs (`-l`) install under `.atomic/npm/` (legacy `.pi/npm/` fallback).
- **Pinning, ranges, and dist-tags.** Exact semver versions (`npm:pkg@1.2.3`) stay pinned and are skipped by `atomic update --extensions` and `--all`. Semver ranges (`^1.2.3`, `~1.2.3`) and dist-tags (`@next`) update when you run `atomic update --extensions` or `--all`. Dist-tags also check the registry on online startup and re-install when the tag moves.
- **Custom package manager (`npmCommand`).** Override the installer in `settings.json` when using `pnpm`, `bun`, or version managers such as `mise` or `asdf`:

```json
{
  "npmCommand": ["mise", "exec", "node@24", "--", "npm"]
}
```

Atomic detects `npm`, `pnpm`, and `bun` even inside wrapper commands (use `--` if a wrapper mentions more than one manager name, or Atomic fails with `Ambiguous npmCommand package managers`) and passes manager-specific flags to avoid installing host peer dependencies:

- `npm`: `--legacy-peer-deps --no-audit --no-fund` (plus `--omit=dev` for git package dependencies)
- `pnpm`: `--config.auto-install-peers=false --config.strict-peer-dependencies=false --config.strict-dep-builds=false` (plus `--prod` for git dependencies)
- `bun`: `--omit=peer` (plus `--omit=dev` for git dependencies)

### git

```text
git:github.com/user/repo@v1
git:git@github.com:user/repo@main
https://github.com/user/repo@v1
https://github.com/user/repo#v1
ssh://git@github.com/user/repo@v1
```

- **URL syntax.** Bare protocol URLs (`https://`, `http://`, `ssh://`, `git://`) work directly; shorthand (`github.com/user/repo`, `git@github.com:user/repo`) requires the `git:` prefix. Hosted URLs accept `#ref` alongside `@ref`. Repository paths must have at least two segments (`owner/repo`) and cannot contain traversal (`..`, `.`), backslashes, or null bytes. Case-only path collisions on case-insensitive filesystems abort with an error.
- **SSH and CI.** SSH uses your keys and `~/.ssh/config`. For non-interactive or CI runs, set `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5"`.
- **Clone locations.** Repositories clone to `~/.atomic/agent/git/<host>/<path>` (global) or `.atomic/git/<host>/<path>` (project; legacy `.pi/git/` fallback).
- **Refs and updates.** `@ref` / `#ref` accepts a branch, tag, or commit hash. Running `atomic update --extensions` or `--all` fetches a pinned ref (`git fetch origin -- <ref>`) and resets hard to `FETCH_HEAD` (advancing branches and reconciling tags or commits). Unpinned checkouts track `@{upstream}` (when on `origin/`) or refresh `origin/HEAD`, and repair missing `dependencies` even when `HEAD` has not changed. Whenever `HEAD` changes, Atomic runs `git clean -fdx` and installs production dependencies if `package.json` exists (on Windows, locked files during cleanup warn and retry on a later update). Change a ref with `atomic install git:host/user/repo@new-ref`.

### Local paths

```text
/absolute/path/to/package
./relative/path/to/package
```

Local paths load in place without copying. `atomic install /absolute/path/to/package` stores the path in `settings.json` relative to the settings directory (`~/.atomic/agent` or `.atomic`). A file loads as a single extension; a directory loads as a package. `atomic remove <local-path>` removes only the settings entry and never deletes local files.

## Enable and disable resources

Run `atomic config` to toggle extensions, skills, prompt templates, and themes interactively:

- Opens global settings (`~/.atomic/agent/settings.json`). Press `Tab` to switch between global and project scope in trusted projects (`Tab` is disabled in untrusted projects).
- Run `atomic config -l` (`--local`) to open project overrides (`.atomic/settings.json`) with inherited global entries dimmed. In an untrusted project, `atomic config -l` exits with code 1 unless you pass `--approve`.
- Package **subagents, MCP servers, and storage adapters** do not appear in `atomic config`. Filter `agents` and `mcpServers` per package in `settings.json` ([Package filtering](/packages/reference#package-filtering)), and select storage adapters via `storage.adapter`.
- Toggle built-in extensions (`llama.cpp`, `codemode`, `tool-search`) with `builtin:<name>` entries ([Built-in extension resources](/extensions#built-in-extension-resources)).
- If an interactive session crashes with an uncaught error whose stack crosses a loaded extension, Atomic names the extension in the exit output and suggests `atomic config` or `atomic -ne` to isolate the cause.
