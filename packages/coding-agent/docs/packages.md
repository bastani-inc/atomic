---
title: "Install and manage packages"
sidebarTitle: "Atomic packages"
description: "Install, update, remove, and configure Atomic packages from npm, git, or local directories."
---

Atomic packages bundle extensions, skills, [subagents](/packages/authoring#subagents), prompt templates, themes, MCP servers, and [storage adapters](/storage#adapters-from-atomic-packages) for distribution over npm, git, or local paths. Declare resources under the `atomic` key in `package.json`, or use convention directories.

## Where to go next

- [Create and publish packages](/packages/authoring). Configure the package manifest, subagents, MCP servers, storage adapters, directory structure, and dependencies.
- [Package reference](/packages/reference). Review pattern matching, `autoload: false` overrides, resource precedence, and deduplication rules.

## Install and manage

> **Security:** Atomic packages run with full system access. Extensions execute arbitrary code and skills instruct the agent. Review source code before installing third-party packages.

```bash
atomic install npm:@foo/bar@1.0.0
atomic install git:github.com/user/repo@v1
atomic install https://github.com/user/repo        # Raw URLs work too
atomic install /absolute/path/to/package
atomic install ./relative/path/to/package
atomic install -l npm:@foo/bar                     # Install into project settings (--local)

atomic remove npm:@foo/bar                         # Alias: atomic uninstall
atomic list                                        # Show packages configured in settings
atomic update                                      # Update Atomic CLI only
atomic update --all                                # Update Atomic + packages + reconcile git refs
atomic update --extensions                         # Update packages + reconcile git refs only
atomic update --models                             # Force-refresh authenticated model catalogs (15s timeout)
atomic update --self                               # Update Atomic CLI only (also: atomic update self | atomic)
atomic update --self --force                       # Reinstall Atomic even if current
atomic update --self --extensions                  # Same as atomic update --all
atomic update npm:@foo/bar                         # Update one package (or --extension <src>)
```

Install, trust, and update behavior:

- **Global and project scope.** `install` and `remove` edit `~/.atomic/agent/settings.json` by default. Pass `-l` or `--local` to write to `.atomic/settings.json` (legacy `.pi/settings.json` is also read). Missing project packages install automatically on startup once you trust the project.
- **Project trust gate.** In an untrusted project, `atomic install -l` and `atomic remove -l` exit with code 1 (`Project is not trusted. Use --approve to modify local package config.`) unless you trust the project first or pass `-a` / `--approve`. Both `-a` / `--approve` and `-na` / `--no-approve` are accepted on `install`, `remove`, `update`, `list`, and `config`.
- **Update output.** Atomic lists each updated npm version or git commit (for example `npm:@foo/bar 1.2.0 -> 1.3.0`), prints `Packages are already up to date` when nothing changed, prints warnings when no package upgraded, and reports skipped updates in offline mode.
- **Offline mode.** Pass `--offline` or set `ATOMIC_OFFLINE=1` to skip automatic startup installs and package updates.
- **Self-update safety.** Atomic installs the exact advertised version (showing any release note first) and only modifies installations managed and writable by the detected global package manager. On Windows, automatic self-update supports `npm` and `pnpm` installs only unless you override the command. Override auto-detection with `selfUpdateCommand` in global `settings.json` or the `ATOMIC_SELF_UPDATE_COMMAND` environment variable; otherwise Atomic prints the manual update command. To uninstall Atomic itself, see [Uninstall](/getting-started/installation#uninstall).
- **Resilience and concurrency.** Startup install failures (such as offline registries) warn with the `atomic remove` command, skip that package's resources, and retry on the next start or `/reload` (`atomic install` and `atomic update --extensions` still exit non-zero). Concurrent installs serialize per package, interrupted git clones re-clone on retry, and `atomic remove` cleans up orphaned package directories.

Try a package for one run with `-e` or `--extension`:

```bash
atomic -e npm:@foo/bar
atomic -e git:github.com/user/repo
```

`-e` installs into a private user-owned cache (`$XDG_RUNTIME_DIR/atomic/extensions`, else `<agentDir>/cache/tmp/extensions`, else `<tmpdir>/atomic-<uid>/extensions`; symlinks and shared or other-owned directories are refused). Unpinned npm specs and branch or tag git refs refresh on start and `/reload` (falling back to cache offline or on error). Exact `@1.2.3` npm pins and checked-out git commit hashes (7 to 64 hex characters matching `HEAD`) skip network refresh. Local `-e <dir>` paths can also load `<dir>/.atomic`, `<dir>/.pi`, and `<dir>/.agents/skills` after resolving trust for that directory.

## Package sources

### npm

```text
npm:@scope/pkg@1.2.3
npm:@scope/pkg@^1.2.0
npm:pkg@next
npm:pkg
```

- **Install locations.** Global npm packages install under `~/.atomic/agent/npm/` (a dedicated directory managed by Atomic, not your system global `npm -g` root). Atomic falls back to reading your system global `npm`, `pnpm`, or `bun` root only for legacy global installs already present there. Project installs (`-l` / `--local`) install under `.atomic/npm/` (legacy `.pi/npm/` fallback).
- **Pinning and ranges.** Exact semver versions (`npm:pkg@1.2.3`) are pinned and skipped by `atomic update --extensions` and `--all`. Semver ranges (`^1.2.3`, `~1.2.3`) and dist-tags (`@next`) update within that range or tag when you run `atomic update --extensions` or `--all`.
- **Custom package manager.** Override the npm executable with `npmCommand` in `settings.json` when using `pnpm`, `bun`, or version managers such as `mise` or `asdf`. Atomic detects `npm`, `pnpm`, and `bun` even inside wrapper commands and passes manager-specific flags to avoid unwanted peer-dependency installs (`--legacy-peer-deps` for npm, `--omit=peer` for bun, `--config.auto-install-peers=false` for pnpm):

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```text
git:github.com/user/repo@v1
git:git@github.com:user/repo@main
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Bare protocol URLs (`https://`, `http://`, `ssh://`, `git://`) work directly. Shorthand (`github.com/user/repo`, `git@github.com:user/repo`) requires the `git:` prefix.
- Repository paths must include at least two path segments (`owner/repo`). Single-segment paths, path traversal (`..`, `.`), backslashes, and null bytes are rejected.
- SSH uses your configured keys and `~/.ssh/config`. For CI or non-interactive use, set `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5"`.
- Repositories clone to `~/.atomic/agent/git/<host>/<path>` (global) or `.atomic/git/<host>/<path>` (project; legacy `.pi/git/` fallback).
- `@ref` accepts a branch name, tag, or commit hash. Running `atomic update --extensions` or `--all` fetches that ref (`git fetch origin -- <ref>`) and resets hard to `FETCH_HEAD`: branch refs advance to new commits on that branch, while tags and commit hashes reconcile to their exact target. Whenever the checked-out commit changes, Atomic runs `git clean -fdx` (removing untracked files in the clone) and installs production dependencies if `package.json` exists. Change a pin with `atomic install git:host/user/repo@new-ref`.

```bash
atomic install git:git@github.com:user/repo
atomic install ssh://git@github.com/user/repo
atomic install git:git@github.com/user/repo@v1.0.0
```

### Local paths

```text
/absolute/path/to/package
./relative/path/to/package
```

Local paths are referenced in place without copying. When you run `atomic install /absolute/path/to/package`, Atomic stores the path in `settings.json` relative to the settings directory (`~/.atomic/agent` or `.atomic`). A file loads as a single extension; a directory loads as a package.

Running `atomic remove <local-path>` deletes only the entry from `settings.json` and never deletes files from your local directory.

## Enable and disable resources

Run `atomic config` to toggle extensions, skills, prompt templates, and themes interactively:

- Opens global settings (`~/.atomic/agent/settings.json`). Press `Tab` to switch between global and project scope.
- Run `atomic config -l` (or `--local`) to open project overrides (`.atomic/settings.json`) with inherited global entries dimmed.
- Package subagents do not appear in `atomic config`. Filter them per package with `agents` in settings ([Package filtering](/packages/reference#package-filtering)).
- Toggle built-in extensions (`llama.cpp`, `codemode`, `tool-search`) using `builtin:<name>` entries rather than filesystem paths ([Built-in extension resources](/extensions#built-in-extension-resources)).
- If an interactive session crashes with an uncaught error whose stack crosses a loaded extension, Atomic names the extension in the exit output and suggests `atomic config` or `atomic -ne` to narrow down the cause.

## Authoring and reference

- [Create and publish packages](/packages/authoring#creating-an-atomic-package). Review manifest fields, [subagents](/packages/authoring#subagents), [MCP servers](/packages/authoring#mcp-servers), [storage adapters](/packages/authoring#storage-adapters), [gallery metadata](/packages/authoring#gallery-metadata), [convention directories](/packages/authoring#convention-directories), and [dependencies](/packages/authoring#dependencies).
- [Package reference](/packages/reference). Review [package filtering](/packages/reference#package-filtering) and [scope and deduplication](/packages/reference#scope-and-deduplication).
