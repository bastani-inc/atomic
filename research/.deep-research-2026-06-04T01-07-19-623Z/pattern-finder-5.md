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