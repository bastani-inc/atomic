---
title: "Pi / Atomic runtime and intercom compatibility evidence"
date: 2026-07-08
researcher: atomic research specialist
status: synthesized
breaking_changes_allowed: false
sources:
  - https://docs.bastani.ai/quickstart.md
  - https://docs.bastani.ai/packages.md
  - https://docs.bastani.ai/extensions.md
  - https://pi.dev/docs/latest/quickstart.md
  - https://github.com/earendil-works/pi
  - https://github.com/bastani-inc/atomic
  - https://github.com/nicobailon/pi-intercom
cache_note: "Fetched public docs and cloned GitHub repos. Source citations should use full-SHA permalinks from the recorded SHAs below."
repo_shas:
  earendil_works_pi: 351efc828b6fc5250fa50d6b32b20b0f0cb22cb4
  bastani_inc_atomic: a05fc5fe47443c691e7057c213fb8b86ba917840
  nicobailon_pi_intercom: e234a4446e2b3f9c13a1ec3151ae2169315c810f
---

## Summary

Public docs and source point to this compatibility posture:

- Do **not** assume packaged Atomic/Pi users have a bare `bun` executable on `PATH`.
- Atomic npm/bun installs run the CLI under Node (`#!/usr/bin/env node`); Atomic docs list **Node.js 24 LTS** as a prerequisite and Bun only as one possible package manager / workflow-authoring runtime.
- Pi npm installs are distributed as a Node CLI package; Pi also publishes Bun-compiled binary release artifacts, where `process.execPath` is the compiled executable path.
- Upstream `pi-intercom` intentionally hardened default broker spawning away from `npx`/PATH lookup: default config still says `brokerCommand: "npx"` and `brokerArgs: ["--no-install", "tsx"]`, but the implementation recognizes that default and launches the resolved bundled `tsx` CLI with the current runtime executable (`process.execPath`). Bare `bun` is documented only as an opt-in trusted custom broker command.
- Atomic's current bundled intercom fork still has docs/defaults that mention `npx`/`tsx`, and its source only applies the `process.execPath + tsx` hardening on Windows; on non-Windows it still spawns the configured command (`npx --no-install tsx ...`). That is less robust for packaged/bundled Atomic than upstream `pi-intercom`.

## Runtime evidence

### Atomic public install/runtime assumption

Official Atomic quickstart says prerequisites are "Node.js 24 LTS or newer" plus a package manager; Bun is one option among npm/pnpm/Yarn/Bun and is specifically called out for Bun installs or workflow-authoring examples. It documents global install via npm, pnpm, or Bun and then running `atomic`.

Source: https://docs.bastani.ai/quickstart.md

Atomic's package metadata matches a Node-based installed CLI: package bin maps `atomic` to `dist/cli.js`, and `engines.node` is `>=22.19.0`.

Permalink: https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/packages/coding-agent/package.json#L16-L18 and https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/packages/coding-agent/package.json#L150-L152

Atomic CI explicitly comments that the installed package bin runs via `#!/usr/bin/env node` for npm/bun installs.

Permalink: https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/.github/workflows/test.yml#L33-L38

Atomic also has a Bun-compiled binary build path for release artifacts, using `bun build --compile --target=bun-$platform` to produce `atomic` / `atomic.exe`.

Permalink: https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/scripts/build-binaries.sh#L103-L110

### Pi public install/runtime assumption

Official Pi quickstart says Pi is distributed as an npm package and installs with:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

It also says to uninstall with the same package manager that installed Pi, listing npm/pnpm/Yarn/Bun as package-manager variants. That is not evidence of a bare `bun` runtime being present for every user; it is evidence that Bun may be the installer for some users.

Source: https://pi.dev/docs/latest/quickstart.md

Pi package metadata maps `pi` to `dist/cli.js`, i.e. a package-manager installed CLI entrypoint.

Permalink: https://github.com/earendil-works/pi/blob/351efc828b6fc5250fa50d6b32b20b0f0cb22cb4/packages/coding-agent/package.json#L1-L12

Pi also builds compiled standalone binaries with Bun at release time. The package script and build-binaries script use `bun build --compile`, but that is a maintainer/release-build dependency rather than a packaged-user PATH guarantee.

Permalinks:
- https://github.com/earendil-works/pi/blob/351efc828b6fc5250fa50d6b32b20b0f0cb22cb4/packages/coding-agent/package.json#L31-L36
- https://github.com/earendil-works/pi/blob/351efc828b6fc5250fa50d6b32b20b0f0cb22cb4/scripts/build-binaries.sh#L131-L140

Pi runtime path logic explicitly distinguishes Bun-compiled binaries from Node/tsx source runs: for a Bun binary, `process.execPath` points to the compiled executable and is used to locate assets.

Permalink: https://github.com/earendil-works/pi/blob/351efc828b6fc5250fa50d6b32b20b0f0cb22cb4/packages/coding-agent/src/config.ts#L361-L388

## Config directories and extension manifests

Atomic package metadata declares both `atomicConfig` and legacy `piConfig` with app name `atomic` and config dir `.atomic`.

Permalink: https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/packages/coding-agent/package.json#L6-L18

Atomic config code reads `<appName>Config` first, falls back to `piConfig`, uses `.atomic` for Atomic, and keeps `.pi` as a legacy config dir.

Permalink: https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/packages/coding-agent/src/config.ts#L220-L240

Atomic agent/config path helpers return primary dirs first and legacy `.pi` fallbacks unless an explicit agent-dir env var overrides scanning.

Permalink: https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/packages/coding-agent/src/config.ts#L347-L388

Atomic extension discovery reads the configured app manifest key first, then falls back to legacy `pi` package manifest fields. It discovers direct files, one-level subdirectories, and package.json-declared extensions.

Permalinks:
- https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/packages/coding-agent/src/core/extensions/loader-discovery.ts#L16-L25
- https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/packages/coding-agent/src/core/extensions/loader-discovery.ts#L81-L120

## pi-intercom broker spawn behavior

### Upstream pi-intercom

Upstream `pi-intercom` defaults config to `brokerCommand: "npx"`, `brokerArgs: ["--no-install", "tsx"]`, but treats that pair as a special default.

Permalink: https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/config.ts#L49-L56

The README explains the compatibility intent: default is "hardened internally to launch the resolved bundled `tsx` CLI through the current Node executable instead of resolving `npx` through `PATH`." It documents `bun` only as a custom trusted config example, "if you have Bun installed".

Permalink: https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/README.md#L360-L395

Implementation details:

- `getTsxCliPath()` resolves `tsx` via Node module resolution and falls back to `extensionDir/node_modules/tsx/dist/cli.mjs`.
- For the default `npx --no-install tsx` config, non-Windows launch spec becomes `command: process.execPath` and args `[resolvedTsxCli, brokerPath]`.
- Windows writes a hidden VBS launcher that similarly runs `process.execPath`, resolved `tsx`, and the broker path for the default.
- Custom broker command/args are still supported and are passed through directly.
- Spawn is detached, stdio ignored, cwd is extension dir, and env includes `PI_CODING_AGENT_DIR: getAgentDirPath(env)` and `NODE_NO_WARNINGS: "1"`.

Permalinks:
- https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/broker/spawn.ts#L44-L57
- https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/broker/spawn.ts#L67-L86
- https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/broker/spawn.ts#L121-L154
- https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/broker/spawn.ts#L156-L172
- https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/broker/spawn.ts#L179-L240

### Atomic bundled intercom fork

Atomic's bundled intercom package is a fork of `pi-intercom` and currently declares a Bun engine for the extension package itself.

Permalink: https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/packages/intercom/package.json#L1-L18

However, its README/config still default to `npx --no-install tsx` and present bare `bun` only as an example for users who have Bun installed.

Permalink: https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/packages/intercom/README.md#L360-L390

Atomic's current `packages/intercom/broker/spawn.ts` differs from upstream: `getTsxCliPath()` is a fixed `extensionDir/node_modules/tsx/dist/cli.mjs`; Windows default uses `process.execPath + tsx`, but non-Windows `getBrokerLaunchSpec()` always returns the configured `brokerCommand` and args, so the default still attempts to spawn `npx --no-install tsx <broker.ts>` on PATH.

Permalink: https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/packages/intercom/broker/spawn.ts#L34-L65 and https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/packages/intercom/broker/spawn.ts#L85-L110

Atomic's spawn code still detaches the broker, ignores stdio, waits for broker readiness, and errors if it exits before startup.

Permalink: https://github.com/bastani-inc/atomic/blob/a05fc5fe47443c691e7057c213fb8b86ba917840/packages/intercom/broker/spawn.ts#L112-L194

## Compatibility conclusions

1. **Bare `bun` on PATH is not a safe assumption** for packaged Atomic/Pi users. Atomic docs require Node 24 and list Bun only as one package-manager/runtime option; Pi docs describe an npm package install and separate Bun-built binary releases. Users can have npm-installed CLIs, pnpm/yarn-installed CLIs, Bun-installed CLIs, or standalone Bun-compiled binaries.
2. **Default broker spawn should prefer the current runtime (`process.execPath`) plus bundled/resolved `tsx` or compiled/bundled assets**, not `bun` or `npx` PATH lookup, unless the user explicitly configures a trusted override.
3. **For Bun-compiled binaries, `process.execPath` is the packaged executable** (Pi source documents this), so spawning through `process.execPath` is more compatible with standalone releases than assuming a separate `bun` binary exists.
4. **For npm/pnpm/yarn/bun package installs, Node is the reliable runtime for the installed bin**; Atomic CI explicitly smoke-tests that installed packages run via `#!/usr/bin/env node`.
5. **Atomic should keep `.atomic` primary and `.pi` fallback semantics** for config/extension compatibility, and should accept legacy `pi` manifests while preferring `atomic` manifests.

## Caveats / gaps

- Atomic public docs currently say Node 24 LTS; package metadata says `>=22.19.0`. Treat Node 24 as the user-facing support baseline unless maintainers clarify.
- Atomic bundled intercom currently lags upstream `pi-intercom` broker-spawn hardening on non-Windows. If changing it, preserve advanced custom `brokerCommand`/`brokerArgs` compatibility and avoid breaking users who intentionally configured `bun` or another command.
- Atomic intercom package `engines.bun` is package metadata, not sufficient evidence that every packaged Atomic user has bare `bun` on PATH.
- Upstream `pi-intercom` centralizes runtime/config under `PI_CODING_AGENT_DIR` or `~/.pi/agent`; Atomic needs aliases/path bridging if it wants `.atomic` defaults plus Pi compatibility.
