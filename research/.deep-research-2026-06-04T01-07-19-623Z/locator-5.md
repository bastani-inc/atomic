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