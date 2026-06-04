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