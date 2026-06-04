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