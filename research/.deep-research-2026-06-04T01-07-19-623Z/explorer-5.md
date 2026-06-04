## Partition 5: Config, environment variables, app paths, `.atomic`, and legacy `.pi` compatibility

### Locator
## 1. Must-read paths

- `packages/coding-agent/src/config.ts`  
  Main source of truth for `APP_NAME`, `CONFIG_DIR_NAME`, `ENV_*`, `.atomic` vs `.pi`, and env aliasing.

- `packages/coding-agent/docs/settings.md`  
  Documents user-facing config locations, precedence, `sessionDir`, resource paths, and legacy `.pi` fallbacks.

- `packages/coding-agent/docs/development.md`  
  Explains rebranding knobs in `package.json` (`atomicConfig` / legacy `piConfig`) and how they affect paths/env names.

- `packages/coding-agent/src/core/settings-manager.ts`  
  Reads/writes global + project settings, including project `.atomic`/`.pi` behavior and merge precedence.

- `packages/coding-agent/src/core/package-manager.ts`  
  Handles resource/package discovery and legacy manifest compatibility (`pkg.atomicConfig`, `pkg.piConfig`, `pkg.pi`), plus project config directory resolution.

- `packages/coding-agent/test/config.test.ts`  
  Verifies install-method/path logic and environment-sensitive config behavior.

- `packages/coding-agent/test/settings-manager.test.ts`  
  Best evidence for `.atomic` write behavior and `.pi` read compatibility.

- `packages/coding-agent/test/package-manager.test.ts`  
  Strong signal for legacy `.pi` discovery, project path resolution, and manifest compatibility.

## 2. Supporting paths

- `packages/coding-agent/package.json`  
  Defines `atomicConfig`, legacy `piConfig`, bin name, and published package identity.

- `packages/coding-agent/test/package-command-paths.test.ts`  
  Shows how project settings and package paths interact with `.pi`/`.atomic` directories.

- `packages/coding-agent/test/resource-loader.test.ts`  
  Confirms resource discovery through project config dirs and legacy `.pi` layouts.

- `packages/coding-agent/test/restore-sandbox-env.test.ts`  
  Likely relevant for env-var propagation/cleanup in sandboxed runs.

- `packages/coding-agent/test/version-check.test.ts`  
  Covers `ATOMIC_SKIP_VERSION_CHECK` / `ATOMIC_OFFLINE` behavior.

- `packages/coding-agent/test/rpc.test.ts`  
  Shows `PI_CODING_AGENT_DIR` compatibility in runtime env setup.

- `packages/coding-agent/test/theme-export.test.ts`  
  Uses `ATOMIC_CODING_AGENT_DIR`; useful for app-path derivation.

## 3. Entry points / symbols

- `APP_NAME`, `APP_TITLE`, `CONFIG_DIR_NAME`, `CONFIG_DIR_NAMES`
- `LEGACY_CONFIG_DIR_NAME`
- `ENV_PREFIX`, `LEGACY_ENV_PREFIX`
- `ENV_AGENT_DIR`, `ENV_SESSION_DIR`, `ENV_PACKAGE_DIR`, `ENV_OFFLINE`, `ENV_SKIP_VERSION_CHECK`
- `getEnvNames()`, `getEnvValue()`, `hasEnvValue()`
- `getAgentDir()`, `getLegacyAgentDir()`, `getAgentDirs()`
- `getUserConfigDirs()`, `getProjectConfigDirs(cwd)`
- `getAgentConfigPaths()`, `getProjectConfigPaths()`
- `getSettingsPath()`, `getSessionsDir()`, `getDebugLogPath()`
- `readAppConfig()` and `appNameFromPackageName()`
- `SettingsManager.create()`, `FileSettingsStorage`
- `PackageManager` path helpers + legacy manifest handling (`pkg.pi`, `piConfig`)

## 4. Gaps or uncertainty

- I verified `.atomic`/`.pi` compatibility in docs and tests, but not every env alias path was exhaustively traced.
- `PI_*` alias support is clearly documented and implemented in `config.ts`, but the full alias matrix may extend beyond the examples surfaced here.
- Some package-manager behavior is inferred from tests/rg hits; a full Rust migration will still need a complete scan of `config.ts` and `settings-manager.ts` for all path builders and precedence rules.

### Pattern Finder
## 1. Established patterns

- **App identity is derived from `package.json`, with a legacy `piConfig` shim.**  
  `packages/coding-agent/src/config.ts` reads `<appName>Config` first, then falls back to `piConfig`. For Atomic, the effective defaults are `APP_NAME="atomic"`, `CONFIG_DIR_NAME=".atomic"`, while legacy `".pi"` stays in the search list.

- **Env vars are app-prefixed, but legacy `PI_*` aliases are preserved.**  
  `getEnvNames()` returns both `ATOMIC_*` and `PI_*` for Atomic-specific vars, so `ATOMIC_OFFLINE`/`PI_OFFLINE`, `ATOMIC_PACKAGE_DIR`/`PI_PACKAGE_DIR`, etc. all work.

- **Config directories are dual-scope: global + project, with legacy fallback.**  
  User config lives in `~/.atomic/agent`, project config in `./.atomic`; legacy `~/.pi/agent` and `./.pi` are still read.

- **Path helpers are the contract surface.**  
  The repo centralizes path logic in `src/config.ts` (`getAgentDir`, `getProjectConfigDirs`, `getSessionsDir`, `getModelsPath`, etc.) and avoids ad-hoc `__dirname` usage for shipped assets.

- **Package asset paths are resolved from install mode.**  
  `getPackageDir()` handles Bun binary, installed package, and source checkout. This is the main boundary for locating bundled docs/themes/export templates.

- **Project settings are read-only until mutated.**  
  Tests show reading project settings should not create `.atomic`; writing does (`packages/coding-agent/test/settings-manager.test.ts`).

## 2. Variations / exceptions

- **Legacy `.pi` is not just read; it’s sometimes preferred in mixed installs.**  
  `CONFIG_DIR_NAMES` can be `[CONFIG_DIR_NAME, ".pi"]`, and many loaders/searchers merge both roots.

- **Some behaviors still key off “pi” in generated output and docs.**  
  Examples: `getShareViewerUrl()` defaults to `https://pi.dev/session/`, and docs/tests still mention `~/.pi/...` in compatibility scenarios.

- **Path precedence differs by resource type.**  
  `packages/coding-agent/src/core/resource-loader.ts` treats project resources as higher precedence than user resources, and local settings entries can override auto-discovered entries.

- **Environment-based package dir override is intentionally special-cased.**  
  `ATOMIC_PACKAGE_DIR` exists mainly for Nix/Guix-style installs and is consulted before reading package metadata.

## 3. Anti-patterns or risks

- **Rust migration risk: config behavior is a compatibility matrix, not just a file rename.**  
  A Rust rewrite must preserve `.atomic`/`.pi` precedence, env aliases, and install-mode-specific path resolution or break existing users.

- **Path inference is OS/install-shape sensitive.**  
  `detectInstallMethod()` and `getGlobalPackageRoots()` infer npm/pnpm/yarn/bun from executable paths and `npm root -g`-style commands. That’s brittle to reimplement incorrectly.

- **`package.json` is part of runtime behavior.**  
  App name/config-dir selection comes from metadata, so a Rust port still needs a source of truth for branding and compatibility shims.

- **There are tests that explicitly guard “don’t create dirs on read.”**  
  That implies side-effect-free reads are a contract worth preserving in Rust.

## 4. Evidence index

- `packages/coding-agent/src/config.ts`
  - `APP_NAME`, `CONFIG_DIR_NAME`, `LEGACY_CONFIG_DIR_NAME`, `CONFIG_DIR_NAMES`
  - `getEnvNames()`, `getEnvValue()`, `ENV_*`
  - `getPackageDir()`, `getAgentDir()`, `getProjectConfigDirs()`
- `packages/coding-agent/src/core/resource-loader.ts`
  - `getAgentDirs()`, `getProjectConfigDirs()`, `.atomic`/`.pi` resource resolution
- `packages/coding-agent/docs/settings.md`
  - `.atomic` primary, `.pi` fallback, `ATOMIC_SKIP_VERSION_CHECK`, `ATOMIC_OFFLINE`
- `packages/coding-agent/docs/development.md`
  - rebranding via `package.json` (`name`, `configDir`), legacy `piConfig`
- `packages/coding-agent/test/config.test.ts`
  - install-method detection and `ATOMIC_PACKAGE_DIR` override behavior
- `packages/coding-agent/test/settings-manager.test.ts`
  - “should not create .pi folder when only reading project settings”
  - “should create .atomic folder when writing project settings”
- `packages/coding-agent/test/package-manager.test.ts`
  - `.pi`-relative project paths and symlink dedupe behavior

### Analyzer
## 1. Behavioral model

This partition is the **path + environment compatibility layer** for the CLI.

- `src/config.ts` derives the app identity from `package.json`:
  - `atomicConfig` / app-specific `"<appName>Config"` wins
  - legacy `piConfig` is fallback
  - defaults to `pi` if nothing is set
- That identity controls:
  - `APP_NAME`
  - `APP_TITLE`
  - config directory name: `.atomic` vs `.pi`
  - env var prefix: `ATOMIC_*` vs legacy `PI_*`
- `getEnvValue()` transparently checks both new and legacy env names.
- `getAgentDir()`, `getProjectConfigDirs()`, `getSessionsDir()`, etc. centralize all filesystem locations.

Settings and package/resource discovery are layered on top:

- `SettingsManager` reads **global** settings from the agent dir and **project** settings from the project config dir.
- Project settings override global settings.
- Reads are compatibility-aware: `.atomic` takes precedence, but `.pi` is still read.
- Writes go to the new config path (`.atomic`), not legacy.

`PackageManager` extends that same contract to resources:

- It resolves extensions/skills/prompts/themes/workflows from user/project config dirs.
- It supports legacy `pi` manifests in `package.json`.
- It supports legacy `.pi` directory layouts and legacy installed package paths.

## 2. Key flows and invariants

### App identity / path invariants
- If the app name is not `pi`, config dir becomes `.<appName>` (for Atomic: `.atomic`).
- Legacy `.pi` remains readable whenever `CONFIG_DIR_NAME !== ".pi"`.
- Env vars are also aliased: `ATOMIC_FOO` falls back to `PI_FOO`.

### Settings precedence
- Load order is effectively:
  1. legacy + primary global paths
  2. legacy + primary project paths
  3. runtime overrides
- Merge behavior:
  - nested objects are shallow-merged recursively
  - arrays replace
  - undefined does not overwrite
- On write, `SettingsManager` preserves externally added keys by merging current disk state with in-memory modified fields.

### No accidental directory creation on read
- Reading project settings should not create `.atomic`/`.pi`.
- Writing project settings should create `.atomic` if needed.

### Package/resource resolution
- Resource precedence is:
  - project local settings > project auto-discovery > user local settings > user auto-discovery > package resources
- Legacy manifests are supported:
  - `pkg.atomic`
  - fallback `pkg.pi`
- Workflows accept both `workflows` and singular `workflow`.
- Extension discovery is special:
  - `package.json` manifest entries win
  - otherwise `index.ts` / `index.js`
  - otherwise directory scan

## 3. Tests / validation

Good coverage exists for this partition:

- `packages/coding-agent/test/config.test.ts`
  - install-method detection
  - self-update command generation
  - path/prefix inference edge cases
- `packages/coding-agent/test/settings-manager.test.ts`
  - merge/preserve behavior
  - reload behavior
  - invalid JSON handling
  - `.pi` read compatibility and `.atomic` write behavior
- `packages/coding-agent/test/package-manager.test.ts`
  - project vs user path resolution
  - `.pi` directory compatibility
  - legacy manifest handling
  - precedence and deduping across symlinks

## 4. Risks, unknowns, and verification steps

### Main migration risk
A Rust rewrite must preserve this compatibility layer exactly, or users will lose:
- existing `.pi` configs
- `PI_*` env vars
- legacy `pi` manifests
- legacy resource layouts

### Unknowns
- Whether every env alias is covered beyond the obvious `ATOMIC_*` ↔ `PI_*` pattern.
- Whether there are additional path helpers used outside this partition that also encode `.pi` assumptions.
- Whether all resource types have identical semantics when loaded from package manifests vs filesystem conventions.

### Verify before porting
1. Diff all `get*Dir` / `get*Path` callers to find hidden path assumptions.
2. Enumerate every `PI_*` env var use site.
3. Run the settings/package-manager tests as a compatibility baseline.
4. Decide whether Rust should:
   - preserve `.pi` forever,
   - support it only for read/migration,
   - or drop it behind a flag.

For a Rust migration, this partition is the **first compatibility shim to reimplement**, not just a utility module.

### Online Researcher
## 1. Relevant external facts

- `package.json` currently drives app identity via `atomicConfig` / legacy `piConfig`.
  - `name: "atomic"`
  - `configDir: ".atomic"`
  - `changelogUrl: ...`
- `src/config.ts` uses that metadata to derive:
  - `APP_NAME = "atomic"`
  - `CONFIG_DIR_NAME = ".atomic"`
  - `ENV_*` names like `ATOMIC_CODING_AGENT_DIR`
- `getEnvValue()` supports legacy `PI_*` aliases for any `ATOMIC_*` env var.
- Docs confirm config precedence and compatibility:
  - Global: `~/.atomic/agent/settings.json`
  - Project: `.atomic/settings.json`
  - Legacy fallbacks: `~/.pi/agent/settings.json`, `.pi/settings.json`
- `SettingsManager` and `PackageManager` both read `CONFIG_DIR_NAME` and `CONFIG_DIR_NAMES`, so `.atomic`/`.pi` compatibility is not just docs—it affects runtime resolution.

## 2. Local implications

For a Rust migration, this area is mostly a **compatibility contract** you must preserve:

- Keep **new writes** going to `.atomic`, but keep **reads** accepting `.pi`.
- Keep **env var names** as `ATOMIC_*`, but continue accepting `PI_*` aliases.
- Keep `sessionDir`, `settings.json`, resource paths, and debug log paths derived from the same app root.
- Preserve precedence:
  1. explicit env var
  2. `.atomic`
  3. legacy `.pi`
- Preserve `package.json`-style app metadata behavior somehow:
  - either hardcode Atomic defaults in Rust,
  - or load equivalent config from a manifest file at startup.

In practice, Rust should reimplement `config.ts` as a small path/env compatibility layer, because many subsystems depend on it.

## 3. Version/API assumptions

- Current app identity is **Atomic**, not Pi.
- `CONFIG_DIR_NAME` is `.atomic`, but legacy `.pi` remains readable.
- Env aliasing is one-way:
  - `ATOMIC_*` → also checks `PI_*`
  - not the reverse for non-app-specific names.
- `sessionDir` is a settings value, not an env-only path; it still resolves through the same config root logic.

## 4. Unverified or unnecessary research

- I didn’t need external Rust ecosystem docs for this partition.
- The repo-local docs/tests already define the required behavior.
- If you want, I can do the next partition as a **Rust migration checklist for config/path/env code**.