# Partition 8 of 12 — Findings

## Scope
`.devcontainer/` (3 files, 651 LOC)

## Files in Scope
<!-- Source: codebase-locator sub-agent -->
# Partition 8 Locator: .devcontainer/

## Implementation

- `.devcontainer/devcontainer.json` — Root devcontainer manifest; references three agent-specific features (claude, copilot, opencode) and defines common environment setup for Atomic CLI development
- `.devcontainer/claude/devcontainer.json` — Per-agent devcontainer for Claude Code workflow; references GHCR feature `ghcr.io/flora131/atomic/claude:1`
- `.devcontainer/copilot/devcontainer.json` — Per-agent devcontainer for Copilot CLI workflow; references GHCR feature `ghcr.io/flora131/atomic/copilot:1`
- `.devcontainer/opencode/devcontainer.json` — Per-agent devcontainer for OpenCode workflow; references GHCR feature `ghcr.io/flora131/atomic/opencode:1`

## Configuration

- `.devcontainer/features/claude/devcontainer-feature.json` — GHCR feature manifest for Claude Code agent; declares version 1.0.15, specifies tmux, bun, and Claude Code SDK as dependencies
- `.devcontainer/features/copilot/devcontainer-feature.json` — GHCR feature manifest for Copilot CLI agent; declares version 1.0.15, specifies tmux, bun, and Copilot CLI as dependencies
- `.devcontainer/features/opencode/devcontainer-feature.json` — GHCR feature manifest for OpenCode agent; declares version 1.0.15, specifies tmux, bun, and OpenCode SDK as dependencies

## Examples / Fixtures

- `.devcontainer/features/claude/install.sh` — Install script for Claude Code agent feature; downloads @bastani/atomic package via bun, configures PATH across shell types (bash, zsh, fish), installs playwright and liteparse global tools, ensures UTF-8 locale for agent CLI rendering
- `.devcontainer/features/copilot/install.sh` — Install script for Copilot CLI agent feature; identical copy of claude/install.sh (per note in header: duplicated across three agents to keep in sync)
- `.devcontainer/features/opencode/install.sh` — Install script for OpenCode agent feature; identical copy of claude/install.sh (per note in header: duplicated across three agents to keep in sync)

## Notable Clusters

- `.devcontainer/features/` — 6 files (3 manifests, 3 shell scripts); per-agent GHCR feature definitions for tmux-based CLI integration; all three agents share identical install logic (common @bastani/atomic, playwright, liteparse toolchain)

The .devcontainer partition contains four agent-specific manifests (root + three per-agent variants) and three per-agent GHCR feature definitions. The feature manifests declare explicit dependencies on tmux-apt-get and agent SDKs (Claude Code, Copilot CLI, OpenCode), while install scripts are tripled (identical copies) and currently reference @bastani/atomic package from npm. This is the direct removal surface for the pi-coding-agent migration: tmux dependencies are hardcoded in feature manifests, agent SDK/CLI references are baked into devcontainer.json features arrays, and install scripts are synchronized triplets that would need consolidation onto a single pi-based flow.

## How It Works
<!-- Source: codebase-analyzer sub-agent -->
### Files Analysed

- `.devcontainer/devcontainer.json` — Root (all-agents) devcontainer manifest
- `.devcontainer/claude/devcontainer.json` — Per-agent Claude Code devcontainer manifest
- `.devcontainer/copilot/devcontainer.json` — Per-agent Copilot CLI devcontainer manifest
- `.devcontainer/opencode/devcontainer.json` — Per-agent OpenCode devcontainer manifest
- `.devcontainer/features/claude/devcontainer-feature.json` — GHCR feature manifest for Claude variant
- `.devcontainer/features/copilot/devcontainer-feature.json` — GHCR feature manifest for Copilot variant
- `.devcontainer/features/opencode/devcontainer-feature.json` — GHCR feature manifest for OpenCode variant
- `.devcontainer/features/claude/install.sh` — Feature install script (Claude; identical to copilot/opencode)
- `.devcontainer/features/copilot/install.sh` — Feature install script (Copilot; byte-for-byte copy of claude)
- `.devcontainer/features/opencode/install.sh` — Feature install script (OpenCode; byte-for-byte copy of claude)
- `.github/workflows/publish-features.yml` — GHCR feature publish workflow
- `.github/workflows/validate-features.yml` — GHCR feature schema validation workflow

---

### Per-File Notes

#### `.devcontainer/devcontainer.json`

- **Role:** Root devcontainer that installs all three agents simultaneously (Claude + Copilot + OpenCode) in a single container. Used for development of Atomic CLI itself.
- **Key symbols:**
  - `"image"` at line 3: `mcr.microsoft.com/devcontainers/base:ubuntu` — base image shared by all manifests
  - `"features"` at lines 4–11: references `ghcr.io/devcontainers/features/common-utils`, `github-cli:1`, `docker-in-docker:2`, `./features/claude`, `./features/copilot`, `./features/opencode`
  - `"remoteEnv"` at lines 12–16: passes `GH_TOKEN`, `COPILOT_GITHUB_TOKEN`, `ANTHROPIC_API_KEY` from host `localEnv`
  - `"postCreateCommand"` at line 17: `bun install` — installs project workspace dependencies after container creation
  - `"mounts"` at lines 18–29: bind-mounts `~/.ssh` and `~/.gitconfig` from host into `/home/vscode/`
  - `"customizations.vscode.extensions"` at lines 32–38: installs `oven.bun-vscode`, `oxc.oxc-vscode`, `shd101wyy.markdown-preview-enhanced`, `Anthropic.claude-code`, `sst-dev.opencode`
- **Control flow:** Devcontainer CLI resolves all six features (three community + three local) then runs `bun install` post-creation.
- **Data flow:** Host environment variables flow into container via `${localEnv:VAR}` substitution at lines 13–15. SSH identity and git config mount as read-only bind volumes at lines 19–28.
- **Dependencies:** Depends on devcontainers spec feature resolution; local features at `./features/{claude,copilot,opencode}` must be present on disk.

---

#### `.devcontainer/claude/devcontainer.json`

- **Role:** Isolated per-agent devcontainer for Claude Code only; uses the published GHCR feature instead of the local path feature.
- **Key symbols:**
  - `"name"` at line 2: `"Atomic + Claude Code"`
  - `"features"` at lines 4–9: `common-utils`, `ghcr.io/flora131/atomic/claude:1` (GHCR-published), `github-cli:1`, `docker-in-docker:2`
  - `"remoteEnv"` at lines 10–13: passes `GH_TOKEN` and `ANTHROPIC_API_KEY` only (no `COPILOT_GITHUB_TOKEN`)
  - `"postCreateCommand"` at line 14: `bun install`
  - `"customizations.vscode.extensions"` at lines 29–33: `oven.bun-vscode`, `shd101wyy.markdown-preview-enhanced`, `Anthropic.claude-code` (no OpenCode extension)
- **Control flow:** Pulls the published GHCR feature `ghcr.io/flora131/atomic/claude:1` which transitively depends on tmux, bun, and the Claude Code devcontainer feature.
- **Data flow:** Same SSH/gitconfig bind mounts at lines 15–26 as root manifest. Supplies only Claude-relevant env vars.
- **Dependencies:** `ghcr.io/flora131/atomic/claude:1` (GHCR), `ghcr.io/anthropics/devcontainer-features/claude-code:1` (transitively via feature's `dependsOn`).

---

#### `.devcontainer/copilot/devcontainer.json`

- **Role:** Isolated per-agent devcontainer for Copilot CLI only.
- **Key symbols:**
  - `"name"` at line 2: `"Atomic + Copilot CLI"`
  - `"features"` at lines 4–9: `common-utils`, `ghcr.io/flora131/atomic/copilot:1`, `github-cli:1`, `docker-in-docker:2`
  - `"remoteEnv"` at lines 10–13: passes `COPILOT_GITHUB_TOKEN` and `GH_TOKEN` only (no `ANTHROPIC_API_KEY`)
  - `"customizations.vscode.extensions"` at lines 29–32: `oven.bun-vscode`, `shd101wyy.markdown-preview-enhanced` only (no agent-specific extension)
- **Control flow:** Pulls `ghcr.io/flora131/atomic/copilot:1` which transitively installs `ghcr.io/devcontainers/features/copilot-cli:1`, bun, and tmux.
- **Data flow:** No `ANTHROPIC_API_KEY`; Copilot authenticates through GitHub token.
- **Dependencies:** `ghcr.io/flora131/atomic/copilot:1` (GHCR), `ghcr.io/devcontainers/features/copilot-cli:1` (transitively).

---

#### `.devcontainer/opencode/devcontainer.json`

- **Role:** Isolated per-agent devcontainer for OpenCode only.
- **Key symbols:**
  - `"name"` at line 2: `"Atomic + OpenCode"`
  - `"features"` at lines 4–9: `common-utils`, `ghcr.io/flora131/atomic/opencode:1`, `github-cli:1`, `docker-in-docker:2`
  - `"remoteEnv"` at lines 10–12: passes only `GH_TOKEN`
  - `"customizations.vscode.extensions"` at lines 29–33: `oven.bun-vscode`, `shd101wyy.markdown-preview-enhanced`, `sst-dev.opencode`
- **Control flow:** Pulls `ghcr.io/flora131/atomic/opencode:1` which transitively installs `ghcr.io/devcontainers-extra/features/opencode:1`, bun, and tmux.
- **Data flow:** Minimal env passthrough — only GH_TOKEN. OpenCode's own API key config is not passed here.
- **Dependencies:** `ghcr.io/flora131/atomic/opencode:1` (GHCR), `ghcr.io/devcontainers-extra/features/opencode:1` (transitively).

---

#### `.devcontainer/features/claude/devcontainer-feature.json`

- **Role:** GHCR-published feature manifest for the Claude variant, pinned at version `1.0.15`. Declares the feature's dependencies and options.
- **Key symbols:**
  - `"id"` at line 2: `"claude"`
  - `"version"` at line 3: `"1.0.15"`
  - `"options.version"` at lines 8–13: string option with proposals `["latest", "prerelease"]`, default `"latest"`. Passed into `install.sh` as `$VERSION`
  - `"dependsOn"` at lines 15–19:
    - `"ghcr.io/devcontainers-extra/features/tmux-apt-get:1"` — installs tmux
    - `"ghcr.io/devcontainers-extra/features/bun:1"` — installs bun runtime
    - `"ghcr.io/anthropics/devcontainer-features/claude-code:1"` — installs Claude Code CLI
  - `"installsAfter"` at lines 20–23: `common-utils` and `github-cli:1` must precede this feature
- **Control flow:** Devcontainer CLI resolves `dependsOn` first (tmux → bun → claude-code) then runs `install.sh`.
- **Data flow:** Option value `version` becomes env var `VERSION` in `install.sh` at line 24.
- **Dependencies:** Hard dependency on tmux, bun, and Claude Code devcontainer features.

---

#### `.devcontainer/features/copilot/devcontainer-feature.json`

- **Role:** GHCR-published feature manifest for the Copilot variant, structurally identical to claude manifest except for the agent-specific dependency.
- **Key symbols:**
  - `"id"` at line 2: `"copilot"`
  - `"version"` at line 3: `"1.0.15"`
  - `"dependsOn"` at lines 15–19:
    - `"ghcr.io/devcontainers-extra/features/tmux-apt-get:1"` — installs tmux
    - `"ghcr.io/devcontainers-extra/features/bun:1"` — installs bun
    - `"ghcr.io/devcontainers/features/copilot-cli:1"` — installs Copilot CLI (differs from claude/opencode)
  - `"installsAfter"` at lines 20–23: same as claude feature
- **Control flow:** Identical ordering to claude feature; agent-specific dependency swapped.
- **Data flow:** Same `VERSION` env var flow into `install.sh`.
- **Dependencies:** Hard dependency on tmux, bun, and the Copilot CLI devcontainer feature.

---

#### `.devcontainer/features/opencode/devcontainer-feature.json`

- **Role:** GHCR-published feature manifest for the OpenCode variant.
- **Key symbols:**
  - `"id"` at line 2: `"opencode"`
  - `"version"` at line 3: `"1.0.15"`
  - `"dependsOn"` at lines 15–19:
    - `"ghcr.io/devcontainers-extra/features/tmux-apt-get:1"` — installs tmux
    - `"ghcr.io/devcontainers-extra/features/bun:1"` — installs bun
    - `"ghcr.io/devcontainers-extra/features/opencode:1"` — installs OpenCode (community extra feature, differs from official namespace)
  - `"installsAfter"` at lines 20–23: same as other two features
- **Control flow:** Identical to the other two feature manifests in structure.
- **Data flow:** Same `VERSION` env var flow.
- **Dependencies:** Hard dependency on tmux, bun, and `devcontainers-extra/features/opencode:1`.

---

#### `.devcontainer/features/claude/install.sh` (canonical; copilot and opencode are byte-for-byte copies)

- **Role:** Bash script executed as root inside the container to install `@bastani/atomic` globally via bun, configure PATH across all shell types, generate a UTF-8 locale, and install global tool dependencies.
- **Key symbols:**
  - Line 14–17: root guard — exits with error if not running as root
  - Lines 24–43: `ATOMIC_VERSION`/`ATOMIC_SPEC` resolution via `case` on `$VERSION`:
    - `"latest"` → `@bastani/atomic@latest` (line 28)
    - `"prerelease"` → `@bastani/atomic@next` (line 31)
    - any other string → semver-validated, `v` prefix stripped (lines 35–42)
  - Lines 51–56: remote user resolution via `_REMOTE_USER` / `USERNAME` / fallback `vscode`; validates home directory exists
  - Line 62–65: bun availability check as remote user via `su -`
  - Line 66: `su - "${REMOTE_USER}" -c "bun add -g '${ATOMIC_SPEC}'"` — installs `@bastani/atomic` globally into user's `~/.bun/bin`
  - Lines 78–86: writes `/etc/profile.d/atomic-path.sh` for login shells — idempotent `$PATH` prepend of `~/.bun/bin`
  - Lines 89–100: appends to `/etc/bash.bashrc` for non-login bash shells (idempotency guard at line 89)
  - Lines 103–114: appends to `/etc/zsh/zshrc` for non-login zsh shells
  - Lines 117–127: writes `/etc/fish/conf.d/atomic-path.fish` for fish shells
  - Lines 143–163: locale setup block — branches on `apt-get` vs `apk`:
    - `apt-get` path (lines 143–157): installs `locales`, edits `/etc/locale.gen` to uncomment `en_US.UTF-8`, runs `locale-gen`, calls `update-locale`
    - `apk` path (lines 158–163): installs `musl-locales musl-locales-lang`
  - Lines 165–170: writes `/etc/profile.d/atomic-locale.sh` with `LANG`, `LC_ALL`, `LC_CTYPE` set to `en_US.UTF-8` (using `:-` default so existing values are not overwritten)
  - Lines 173–191: appends locale env exports to `/etc/bash.bashrc` and `/etc/zsh/zshrc` with idempotency guards
  - Lines 195–209: writes `/etc/fish/conf.d/atomic-locale.fish`
  - Line 215: `su - "${REMOTE_USER}" -c "bun install -g --trust @playwright/cli@latest @llamaindex/liteparse@latest"` — installs Playwright CLI and liteparse globally; non-fatal (line 216–217 uses `|| echo "⚠ ..."`)
- **Control flow:** Linear execution under `set -e`. Order: root check → version resolution → user resolution → bun check → atomic global install → PATH config (4 shell types) → locale setup (apt/apk branch) → locale env config (4 shell types) → global tools install.
- **Data flow:** `$VERSION` (from feature option) → `$ATOMIC_SPEC` → `bun add -g`. `_REMOTE_USER`/`_REMOTE_USER_HOME` from devcontainer CLI → `su -` invocations. No data written to files other than shell init scripts and locale config.
- **Dependencies:** Requires bun pre-installed (via `dependsOn`). Uses `apt-get` or `apk` for locale packages. Installs `@bastani/atomic`, `@playwright/cli`, `@llamaindex/liteparse` from npm registry.

---

#### `.github/workflows/publish-features.yml`

- **Role:** CI workflow that publishes the three GHCR devcontainer features to `ghcr.io/flora131/atomic/{claude,copilot,opencode}` whenever a PR touching `.devcontainer/features/**` is merged to `main`, or on manual dispatch.
- **Key symbols:**
  - `on.pull_request.types: [closed]` at line 6: triggers only on PR close events for `main` branch when `.devcontainer/features/**` paths change
  - `if` condition at lines 14–16: only runs job when PR was actually merged (`github.event.pull_request.merged == true`) or on `workflow_dispatch`
  - `permissions` at lines 18–20: `contents: write` and `packages: write` — the latter grants GHCR push rights using `GITHUB_TOKEN`
  - `uses: devcontainers/action@v1` at line 25: official devcontainers GitHub Action
  - `publish-features: "true"` at line 27: instructs the action to publish
  - `base-path-to-features: "./.devcontainer/features"` at line 28: scans that directory for all feature subdirectories
  - `GITHUB_TOKEN` at line 30: authenticates to GHCR — no separate NPM or registry token needed
- **Control flow:** Trigger → merged check → checkout → devcontainers/action reads all `devcontainer-feature.json` manifests under `.devcontainer/features/` → pushes each as an OCI artifact to GHCR under `ghcr.io/flora131/atomic/<id>:<version>`.
- **Data flow:** Feature manifests + install scripts read from disk; OCI artifacts pushed to GHCR. Version tag derived from `"version"` field in each `devcontainer-feature.json`.
- **Dependencies:** `devcontainers/action@v1`, `actions/checkout@v6`, `GITHUB_TOKEN` with packages write permission.

---

#### `.github/workflows/validate-features.yml`

- **Role:** CI workflow that validates the JSON schema of all feature manifests on PRs touching `.devcontainer/features/**` or on manual dispatch.
- **Key symbols:**
  - `on.pull_request.paths` at lines 5–6: `'.devcontainer/features/**'`
  - `uses: devcontainers/action@v1` at line 13 with `validate-only: "true"` at line 15: performs schema validation only, no publish
  - `base-path-to-features: "./.devcontainer/features"` at line 16: same scan path as publish workflow
- **Control flow:** PR open/sync → checkout → devcontainers/action validates each `devcontainer-feature.json` against the devcontainer feature schema. No write permissions or tokens required.
- **Data flow:** Read-only; validates structure of JSON manifests in-place.
- **Dependencies:** `devcontainers/action@v1`, `actions/checkout@v6`.

---

### Cross-Cutting Synthesis

The `.devcontainer/` layer implements a two-tier structure. The root manifest (`.devcontainer/devcontainer.json`) composes all three agents in one container for Atomic development, referencing local features via relative paths (`./features/{claude,copilot,opencode}`). The three per-agent manifests (`claude/`, `copilot/`, `opencode/`) each reference the corresponding published GHCR artifact (`ghcr.io/flora131/atomic/<agent>:1`) for isolated end-user usage.

Each GHCR feature (version `1.0.15`) declares a `dependsOn` triplet of exactly: tmux (via `tmux-apt-get`), bun, and the agent-specific CLI feature. The agent-specific dependency is the single point of differentiation: `claude-code:1` (Anthropics), `copilot-cli:1` (devcontainers), `opencode:1` (devcontainers-extra).

All three `install.sh` files are byte-for-byte identical — the comment at line 8 of each explicitly acknowledges this and instructs manual synchronization. Each script installs `@bastani/atomic` globally via bun, configures `~/.bun/bin` on `PATH` across bash/zsh/fish/login shells, generates an `en_US.UTF-8` locale (needed for agent CLI Unicode/figlet rendering), and installs `@playwright/cli` and `@llamaindex/liteparse` as global tools. No agent-specific SDK installation occurs in the script itself; that is deferred to "first `atomic chat` run via auto-init" (comment at line 5–6 of each `install.sh`).

GHCR publishing is handled by `publish-features.yml` using `devcontainers/action@v1` with `packages: write` permission; no external registry tokens are used.

---

### Out-of-Partition References

- `.github/workflows/publish-features.yml` — CI workflow triggering GHCR publish of `.devcontainer/features/`; out of the `.devcontainer/` partition but directly governs feature versioning
- `.github/workflows/validate-features.yml` — CI schema validation workflow for feature manifests; same boundary note
- `packages/atomic/` — The `@bastani/atomic` npm package installed by `install.sh:66`; its publish workflow is `.github/workflows/publish.yml`
- `packages/atomic/script/bump-version.ts` — Version bump script affecting `package.json`; feature manifests pin their own `"version"` field independently and are not wired to this script
- `.github/workflows/publish.yml` — npm publish workflow for `@bastani/atomic@latest` / `@bastani/atomic@next`; the `install.sh` resolves these dist-tags at lines 28 and 31

## Patterns
<!-- Source: codebase-pattern-finder sub-agent -->
# Pattern Findings: `.devcontainer/` Configuration & Installation Scripts

## Overview
The `.devcontainer/` partition contains agent-specific devcontainer configurations, GHCR feature definitions, and shared installation scripts. The current implementation supports three agents (Claude Code, Copilot CLI, OpenCode) with duplicated install scripts and agent-specific dependencies. For pi-coding-agent migration, these are direct removal/rewrite targets.

---

## Patterns Found

#### Pattern: Multi-Agent Devcontainer Feature Configuration (Agent-Specific)
**Where:** `.devcontainer/features/claude/devcontainer-feature.json:1-24`
**What:** Feature metadata manifest defining dependencies, installation order, and version constraints for a single agent-specific devcontainer feature.
```json
{
  "id": "claude",
  "version": "1.0.15",
  "name": "Atomic + Claude Code",
  "description": "Installs Atomic CLI with Claude Code agent, skills, and shared tooling (playwright, liteparse)",
  "documentationURL": "https://github.com/flora131/atomic",
  "options": {
    "version": {
      "type": "string",
      "proposals": ["latest", "prerelease"],
      "default": "latest",
      "description": "Select version of Atomic CLI, if not latest."
    }
  },
  "dependsOn": {
    "ghcr.io/devcontainers-extra/features/tmux-apt-get:1": {},
    "ghcr.io/devcontainers-extra/features/bun:1": {},
    "ghcr.io/anthropics/devcontainer-features/claude-code:1": {}
  },
  "installsAfter": [
    "ghcr.io/devcontainers/features/common-utils",
    "ghcr.io/devcontainers/features/github-cli:1"
  ]
}
```

**Variations / call-sites:**
- `.devcontainer/features/copilot/devcontainer-feature.json:1-24` (substitutes `ghcr.io/devcontainers/features/copilot-cli:1` for Claude Code)
- `.devcontainer/features/opencode/devcontainer-feature.json:1-24` (substitutes `ghcr.io/devcontainers-extra/features/opencode:1`)

---

#### Pattern: Root Devcontainer with Multi-Feature Composition
**Where:** `.devcontainer/devcontainer.json:1-41`
**What:** Main devcontainer config that composes all three agent features plus base platform features, centralizing credential env vars and VS Code extensions.
```json
{
  "name": "Atomic CLI",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/common-utils": {},
    "ghcr.io/devcontainers/features/github-cli:1": {},
    "ghcr.io/devcontainers/features/docker-in-docker:2": {},
    "./features/claude": {},
    "./features/copilot": {},
    "./features/opencode": {}
  },
  "remoteEnv": {
    "GH_TOKEN": "${localEnv:GH_TOKEN}",
    "COPILOT_GITHUB_TOKEN": "${localEnv:COPILOT_GITHUB_TOKEN}",
    "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}"
  },
  "postCreateCommand": "bun install",
  "mounts": [
    {
      "source": "${localEnv:HOME}${localEnv:USERPROFILE}/.ssh",
      "target": "/home/vscode/.ssh",
      "type": "bind"
    },
    {
      "source": "${localEnv:HOME}${localEnv:USERPROFILE}/.gitconfig",
      "target": "/home/vscode/.gitconfig",
      "type": "bind"
    }
  ],
  "customizations": {
    "vscode": {
      "extensions": [
        "oven.bun-vscode",
        "oxc.oxc-vscode",
        "shd101wyy.markdown-preview-enhanced",
        "Anthropic.claude-code",
        "sst-dev.opencode"
      ]
    }
  }
}
```

**Variations / call-sites:**
- `.devcontainer/claude/devcontainer.json:1-36` (single agent; includes only `"Anthropic.claude-code"` extension)
- `.devcontainer/copilot/devcontainer.json:1-35` (single agent; omits agent extension)
- `.devcontainer/opencode/devcontainer.json:1-35` (single agent; includes only `"sst-dev.opencode"` extension)

---

#### Pattern: Duplicated NPM Version Resolution Switch
**Where:** `.devcontainer/features/claude/install.sh:19-43`
**What:** Bash case statement resolving VERSION environment variable to npm dist-tag (latest/prerelease) or explicit semver, with validation and v-prefix stripping.
```bash
# ─── Resolve npm dist-tag / version ─────────────────────────────────────────
# Option -> npm package spec:
#   latest     → @bastani/atomic@latest  (stable releases)
#   prerelease → @bastani/atomic@next    (prereleases — matches `npm publish --tag next` in publish.yml)
#   <version>  → @bastani/atomic@<version>
ATOMIC_VERSION="${VERSION:-latest}"

case "${ATOMIC_VERSION}" in
    latest)
        ATOMIC_SPEC="@bastani/atomic@latest"
        ;;
    prerelease)
        ATOMIC_SPEC="@bastani/atomic@next"
        ;;
    *)
        # Validate semver (MAJOR.MINOR.PATCH with optional numeric prerelease suffix)
        if ! echo "${ATOMIC_VERSION}" | grep -qE '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?$'; then
            echo "Error: '${ATOMIC_VERSION}' is not a valid semver." >&2
            echo "Expected format: MAJOR.MINOR.PATCH (e.g., 1.0.0 or 1.0.0-1)" >&2
            exit 1
        fi
        # Strip leading v — npm specs don't use the v prefix
        ATOMIC_SPEC="@bastani/atomic@${ATOMIC_VERSION#v}"
        ;;
esac
```

**Variations / call-sites:**
- `.devcontainer/features/copilot/install.sh:19-43` (identical copy)
- `.devcontainer/features/opencode/install.sh:19-43` (identical copy)
- **Note at line 7-9**: Explicit warning that script is duplicated across all three features and must be kept in sync.

---

#### Pattern: Remote User Resolution with Fallback
**Where:** `.devcontainer/features/claude/install.sh:47-56`
**What:** Resolves devcontainer-exposed `_REMOTE_USER` and `_REMOTE_USER_HOME` variables with graceful fallback to defaults and validates home directory existence.
```bash
# ─── Resolve remote user ────────────────────────────────────────────────────
# Devcontainer CLI exposes _REMOTE_USER and _REMOTE_USER_HOME at feature-install
# time. Fall back gracefully if the feature is invoked outside the devcontainer
# CLI (e.g. local testing).
REMOTE_USER="${_REMOTE_USER:-${USERNAME:-vscode}}"
REMOTE_HOME="${_REMOTE_USER_HOME:-/home/${REMOTE_USER}}"
if [ ! -d "${REMOTE_HOME}" ]; then
    echo "Error: remote user home directory '${REMOTE_HOME}' does not exist" >&2
    exit 1
fi
```

**Variations / call-sites:**
- `.devcontainer/features/copilot/install.sh:47-56` (identical copy)
- `.devcontainer/features/opencode/install.sh:47-56` (identical copy)

---

#### Pattern: Bun Global Install with Login Shell Execution
**Where:** `.devcontainer/features/claude/install.sh:58-66`
**What:** Invokes `bun add -g` as the remote user via login shell to ensure bun's PATH setup is sourced and package lands in user's `~/.bun/bin`, with dependency validation.
```bash
# ─── Install atomic via bun (global) ────────────────────────────────────────
# bun is provided by the dependent ghcr.io/devcontainers-extra/features/bun:1
# feature. Install as the remote user via a login shell so bun's PATH setup is
# picked up and the package lands in their ~/.bun/bin (not root's home).
if ! su - "${REMOTE_USER}" -c 'command -v bun >/dev/null 2>&1'; then
    echo "Error: bun is not on ${REMOTE_USER}'s PATH. The bun devcontainer feature must install before this one." >&2
    exit 1
fi
su - "${REMOTE_USER}" -c "bun add -g '${ATOMIC_SPEC}'"
```

**Variations / call-sites:**
- `.devcontainer/features/copilot/install.sh:58-66` (identical copy)
- `.devcontainer/features/opencode/install.sh:58-66` (identical copy)

---

#### Pattern: Multi-Shell PATH Configuration (Shell-Specific RC Files)
**Where:** `.devcontainer/features/claude/install.sh:68-127`
**What:** Writes `~/.bun/bin` to PATH across five shell entry points (login, bash, zsh, fish) with idempotent grep checks and shell-specific syntax.
```bash
# ─── Ensure ~/.bun/bin is on PATH for ALL shell types ──────────────────────
# The bun feature may configure PATH in the user's rc files, but devcontainer
# terminals often run as non-login shells that skip /etc/profile.d/. Cover
# every entry point so `atomic` (and other bun globals) are always found:
#   - Login shells:          /etc/profile.d/
#   - Non-login bash shells: /etc/bash.bashrc
#   - Non-login zsh shells:  /etc/zsh/zshrc
#   - Fish shells:           /etc/fish/conf.d/

# Login shells
cat > /etc/profile.d/atomic-path.sh <<'PROFILE_EOF'
if [ -d "$HOME/.bun/bin" ]; then
    case ":$PATH:" in
        *":$HOME/.bun/bin:"*) ;;
        *) export PATH="$HOME/.bun/bin:$PATH" ;;
    esac
fi
PROFILE_EOF
chmod 644 /etc/profile.d/atomic-path.sh

# Non-login bash shells
if [ -f /etc/bash.bashrc ] && ! grep -q '.bun/bin' /etc/bash.bashrc 2>/dev/null; then
    cat >> /etc/bash.bashrc <<'BASHRC_EOF'

# bun global bin (atomic CLI + tools)
if [ -d "$HOME/.bun/bin" ]; then
    case ":$PATH:" in
        *":$HOME/.bun/bin:"*) ;;
        *) export PATH="$HOME/.bun/bin:$PATH" ;;
    esac
fi
BASHRC_EOF
fi

# Non-login zsh shells
if [ -f /etc/zsh/zshrc ] && ! grep -q '.bun/bin' /etc/zsh/zshrc 2>/dev/null; then
    cat >> /etc/zsh/zshrc <<'ZSHRC_EOF'

# bun global bin (atomic CLI + tools)
if [ -d "$HOME/.bun/bin" ]; then
    case ":$PATH:" in
        *":$HOME/.bun/bin:"*) ;;
        *) export PATH="$HOME/.bun/bin:$PATH" ;;
    esac
fi
ZSHRC_EOF
fi

# Fish shells (conf.d is auto-sourced on every fish startup)
if [ -d /etc/fish/conf.d ] && ! grep -q '.bun/bin' /etc/fish/conf.d/atomic-path.fish 2>/dev/null; then
    cat > /etc/fish/conf.d/atomic-path.fish <<'FISH_EOF'
# bun global bin (atomic CLI + tools)
if test -d "$HOME/.bun/bin"
    if not contains "$HOME/.bun/bin" $PATH
        set -gx PATH "$HOME/.bun/bin" $PATH
    end
end
FISH_EOF
    chmod 644 /etc/fish/conf.d/atomic-path.fish
fi
```

**Variations / call-sites:**
- `.devcontainer/features/copilot/install.sh:68-127` (identical copy)
- `.devcontainer/features/opencode/install.sh:68-127` (identical copy)

---

#### Pattern: Locale Configuration with Package Manager Branching
**Where:** `.devcontainer/features/claude/install.sh:131-209`
**What:** Ensures UTF-8 locale for proper Unicode/ASCII art rendering with conditional branches for apt-get (Debian/Ubuntu) and apk (Alpine), plus multi-shell locale env var setup.
```bash
# ─── Ensure UTF-8 locale for proper Unicode/ASCII art rendering ───────────
# Agent CLIs (e.g. Copilot) emit Unicode box-drawing / figlet characters.
# Without a UTF-8 locale the output is garbled when spawned as a Bun
# subprocess inside the devcontainer.
#
# Branches by host package manager:
#   apt-get → install `locales`, run `locale-gen en_US.UTF-8`, `update-locale`
#   apk     → install `musl-locales` (Alpine; no locale-gen needed)
#   neither → skip silently — the rc-file env exports below still set
#             LANG/LC_ALL so most agent CLIs render correctly even without
#             a generated locale archive.

if command -v apt-get >/dev/null 2>&1; then
    if ! command -v locale-gen >/dev/null 2>&1; then
        apt-get update -y
        apt-get install -y --no-install-recommends locales
    fi
    if [ -f /etc/locale.gen ]; then
        sed -i 's/^# *en_US\.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen
    fi
    if ! grep -q '^en_US\.UTF-8 UTF-8' /etc/locale.gen 2>/dev/null; then
        echo 'en_US.UTF-8 UTF-8' >> /etc/locale.gen
    fi
    locale-gen en_US.UTF-8
    if command -v update-locale >/dev/null 2>&1; then
        update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LC_CTYPE=en_US.UTF-8
    fi
elif command -v apk >/dev/null 2>&1; then
    # Alpine ships a stripped-down musl libc with no locale data. The
    # `musl-locales` community package installs the en_US.UTF-8 archive,
    # which the env exports below then activate.
    apk add --no-cache musl-locales musl-locales-lang 2>/dev/null || true
fi

cat > /etc/profile.d/atomic-locale.sh <<'LOCALE_EOF'
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"
LOCALE_EOF
chmod 644 /etc/profile.d/atomic-locale.sh

# Non-login bash shells
if [ -f /etc/bash.bashrc ] && ! grep -q 'atomic-locale' /etc/bash.bashrc 2>/dev/null; then
    cat >> /etc/bash.bashrc <<'BASHRC_LOCALE_EOF'

# atomic-locale: ensure UTF-8 for agent CLI Unicode rendering
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"
BASHRC_LOCALE_EOF
fi

# Non-login zsh shells
if [ -f /etc/zsh/zshrc ] && ! grep -q 'atomic-locale' /etc/zsh/zshrc 2>/dev/null; then
    cat >> /etc/zsh/zshrc <<'ZSHRC_LOCALE_EOF'

# atomic-locale: ensure UTF-8 for agent CLI Unicode rendering
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"
ZSHRC_LOCALE_EOF
fi

# Fish shells
if [ -d /etc/fish/conf.d ]; then
    cat > /etc/fish/conf.d/atomic-locale.fish <<'FISH_LOCALE_EOF'
# atomic-locale: ensure UTF-8 for agent CLI Unicode rendering
if not set -q LANG
    set -gx LANG en_US.UTF-8
end
if not set -q LC_ALL
    set -gx LC_ALL en_US.UTF-8
end
if not set -q LC_CTYPE
    set -gx LC_CTYPE en_US.UTF-8
end
FISH_LOCALE_EOF
    chmod 644 /etc/fish/conf.d/atomic-locale.fish
fi
```

**Variations / call-sites:**
- `.devcontainer/features/copilot/install.sh:131-209` (identical copy)
- `.devcontainer/features/opencode/install.sh:131-209` (identical copy)

---

#### Pattern: Global CLI Tool Installation with Error Tolerance
**Where:** `.devcontainer/features/claude/install.sh:211-217`
**What:** Installs additional global CLI tools (@playwright/cli, @llamaindex/liteparse) via bun with `--trust` flag and non-fatal error handling.
```bash
# ─── Install global CLI tools via bun ──────────────────────────────────────
# Use bun (already installed) with --trust to allow postinstall lifecycle
# scripts (e.g. playwright browser downloads).
echo "Installing global CLI tools..."
su - "${REMOTE_USER}" -c "bun install -g --trust @playwright/cli@latest @llamaindex/liteparse@latest" 2>&1 \
    && echo "✓ Global CLI tools installed" \
    || echo "⚠ Some global CLI tools failed to install (non-fatal)"
```

**Variations / call-sites:**
- `.devcontainer/features/copilot/install.sh:211-217` (identical copy)
- `.devcontainer/features/opencode/install.sh:211-217` (identical copy)

---

#### Pattern: Agent-Specific Environment Variables
**Where:** `.devcontainer/claude/devcontainer.json:10-12`
**What:** Credential environment variables mapped from local environment, with agent-specific keys (ANTHROPIC_API_KEY for Claude Code).
```json
"remoteEnv": {
  "GH_TOKEN": "${localEnv:GH_TOKEN}",
  "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}"
}
```

**Variations / call-sites:**
- `.devcontainer/copilot/devcontainer.json:10-12` (includes `COPILOT_GITHUB_TOKEN` instead of ANTHROPIC_API_KEY)
- `.devcontainer/opencode/devcontainer.json:10-11` (only GH_TOKEN)
- `.devcontainer/devcontainer.json:12-15` (combines all three agent tokens)

---

## Summary

The `.devcontainer/` partition exhibits a **template-with-substitution pattern** where three near-identical feature configurations (claude, copilot, opencode) differ primarily in:
- Agent-specific GHCR feature dependencies (line 16-18 in devcontainer-feature.json)
- Corresponding agent CLI installation packages (claude-code vs. copilot-cli vs. opencode)
- Credential environment variables (ANTHROPIC_API_KEY vs. COPILOT_GITHUB_TOKEN vs. GH_TOKEN)
- VS Code extension IDs

The install scripts are **explicitly duplicated** (as noted in lines 7-9 of each install.sh) across all three features with a requirement to keep them in sync. For pi-coding-agent migration, this duplication pattern will need to be consolidated into a single pi-specific feature with parameterization or a shared base script with agent-specific overrides.

Key removal/rewrite targets for the pi-coding-agent migration:
1. `.devcontainer/features/{claude,copilot,opencode}/devcontainer-feature.json` → Single `.devcontainer/features/pi/devcontainer-feature.json`
2. `.devcontainer/features/{claude,copilot,opencode}/install.sh` → Single `.devcontainer/features/pi/install.sh` (extract agent-specific vars to parameters)
3. `.devcontainer/{claude,copilot,opencode}/devcontainer.json` → `.devcontainer/pi/devcontainer.json` (or remove if unneeded)
4. Feature references in `.devcontainer/devcontainer.json:8-10` → `.devcontainer/features/pi` only

## Out-of-Partition References
Look for the **Out-of-Partition References** subsection inside the
"How It Works" section above — that is where the analyzer flagged files
outside this partition that other partitions should examine.
