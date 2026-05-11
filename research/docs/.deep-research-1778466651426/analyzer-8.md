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
