---
title: "Atomic packages"
description: "Install, manage, and share Atomic packages that bundle extensions, skills, subagents, prompt templates, themes, MCP servers, and storage adapters."
---

# Atomic Packages

Atomic packages bundle extensions, skills, [subagents](/packages/authoring#subagents), prompt templates, themes, MCP servers, and [storage adapters](/storage#adapters-from-atomic-packages) for distribution over npm, git, or local paths. Declare resources under the `atomic` key in `package.json`, or use convention directories.

> Tip: Ask Atomic directly to bundle your extensions, skills, prompts, or themes into a package.

## Where to go next

- [Creating packages](/packages/authoring) — package manifest, subagents, MCP servers, storage adapters, structure, and dependencies.
- [Package reference](/packages/reference) — per-package filtering, scope precedence, and deduplication.

<a id="table-of-contents" />

## Install and Manage

> **Security:** Atomic packages run with full system access—extensions execute arbitrary code and skills instruct the agent. Review source code before installing third-party packages.

```bash
atomic install npm:@foo/bar@1.0.0
atomic install git:github.com/user/repo@v1
atomic install https://github.com/user/repo        # Raw URLs work too
atomic install /absolute/path/to/package
atomic install ./relative/path/to/package

atomic remove npm:@foo/bar                         # Alias: atomic uninstall
atomic list                                        # Show packages configured in settings
atomic update                                      # Update Atomic CLI only
atomic update --all                                # Update Atomic + packages + reconcile git refs
atomic update --extensions                         # Update packages + reconcile git refs only
atomic update --models                             # Force-refresh authenticated model catalogs
atomic update --self                               # Update Atomic CLI only
atomic update --self --force                       # Reinstall Atomic even if current
atomic update npm:@foo/bar                         # Update one package (or --extension <src>)
```

**Install and update behavior:**
- **Global vs. project scope:** `install` and `remove` edit `~/.atomic/agent/settings.json` by default. Pass `-l` to write to `.atomic/settings.json` (legacy `.pi/settings.json` is also read). Missing project packages install automatically on startup once the project is trusted.
- **Update output:** Lists each updated npm version or git commit (`npm:@foo/bar 1.2.0 -> 1.3.0`), prints `Packages are already up to date` when nothing changed, notes warnings when no package upgraded, and reports skipped updates in offline mode.
- **Self-update safety:** Installs the exact advertised version (showing any release note first) and only modifies installations managed and writable by the detected global package manager; otherwise prints the manual command. To uninstall Atomic itself, see [Uninstall](/getting-started/installation#uninstall).
- **Resilience & concurrency:** Startup install failures (such as offline registries) warn with the `atomic remove` command, skip that package's resources, and retry next start or `/reload` (`atomic install` / `atomic update --extensions` still exit non-zero). Concurrent installs serialize per package, interrupted git clones re-clone on retry, and `atomic remove` also cleans orphaned directories.

**Try a package for one run (`-e` / `--extension`):**

```bash
atomic -e npm:@foo/bar
atomic -e git:github.com/user/repo
```

`-e` installs into a private user-owned cache (`$XDG_RUNTIME_DIR/atomic/extensions`, else `<agentDir>/cache/tmp/extensions`, else `<tmpdir>/atomic-<uid>/extensions`; symlinks or shared/other-owned dirs are refused). Unpinned npm specs and non-commit git refs refresh on start and `/reload` (falling back to cache offline or on error); exact `@1.2.3` npm pins and checked-out git commit hashes are not re-fetched. Local `-e <dir>` paths can also load `<dir>/.atomic`, `<dir>/.pi`, and `<dir>/.agents/skills` after resolving trust for that directory.

## Package Sources

### npm

```text
npm:@scope/pkg@1.2.3
npm:pkg
```

- Pinned versions (`@1.2.3`) are skipped by `atomic update --extensions` and `--all`.
- Global installs use your npm command; project installs (`-l`) install under `.atomic/npm/` (legacy `.pi/npm/` fallback).
- Override the npm executable with `npmCommand` in `settings.json` when using version managers such as `mise` or `asdf`:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```text
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Bare protocol URLs (`https://`, `http://`, `ssh://`, `git://`) work directly; shorthand (`github.com/user/repo`, `git@github.com:user/repo`) requires the `git:` prefix.
- SSH uses your configured keys and `~/.ssh/config`. For CI/non-interactive use, set `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5"`.
- Cloned to `~/.atomic/agent/git/<host>/<path>` (global) or `.atomic/git/<host>/<path>` (project; legacy `.pi/git/` fallback).
- `@ref` pins a tag or commit: `atomic update --extensions` / `--all` reconciles the clone to that ref (resetting, cleaning, and re-running npm install if `package.json` exists) without advancing it. Move a pin with `atomic install git:host/user/repo@new-ref`.

```bash
atomic install git:git@github.com:user/repo
atomic install ssh://git@github.com/user/repo
atomic install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```text
/absolute/path/to/package
./relative/path/to/package
```

Added to settings in place without copying (relative paths resolve from the settings file). A file loads as a single extension; a directory loads as a package.

## Enable and Disable Resources

Run `atomic config` to toggle extensions, skills, prompt templates, and themes interactively:

- Opens global settings (`~/.atomic/agent/settings.json`); press `Tab` to switch between global and project scope.
- Run `atomic config -l` to open project overrides (`.atomic/settings.json`) with inherited global entries dimmed.
- Package subagents are not listed in `atomic config`—filter them per package with `agents` in settings ([Package filtering](/packages/reference#package-filtering)).
- Toggle built-in inline extensions (`llama.cpp`, `codemode`, `tool_search`) using `builtin:<name>` entries rather than filesystem paths ([Built-in extension resources](/extensions#built-in-extension-resources)).
- If an interactive session crashes with an uncaught error whose stack crosses a loaded extension, Atomic names the extension in the exit output and suggests `atomic config` or `atomic -ne` to isolate it.

<a id="creating-an-atomic-package" />
<a id="gallery-metadata" />
<a id="package-structure" />
<a id="convention-directories" />
<a id="dependencies" />
<a id="package-filtering" />
<a id="scope-and-deduplication" />

## Authoring and reference

- [Creating an Atomic Package](/packages/authoring#creating-an-atomic-package) — manifest fields, [subagents](/packages/authoring#subagents), [MCP servers](/packages/authoring#mcp-servers), [storage adapters](/packages/authoring#storage-adapters), [gallery metadata](/packages/authoring#gallery-metadata), [convention directories](/packages/authoring#convention-directories), and [dependencies](/packages/authoring#dependencies).
- [Package reference](/packages/reference) — [package filtering](/packages/reference#package-filtering) and [scope and deduplication](/packages/reference#scope-and-deduplication).
