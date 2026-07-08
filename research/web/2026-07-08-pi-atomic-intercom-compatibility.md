---
title: "Pi / Atomic intercom compatibility expectations"
date: 2026-07-08
researcher: atomic research specialist
status: synthesized
breaking_changes_allowed: false
sources:
  - https://docs.bastani.ai/llms.txt
  - https://docs.bastani.ai/extensions.md
  - https://docs.bastani.ai/settings.md
  - https://docs.bastani.ai/sessions.md
  - https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
  - https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md
  - https://github.com/nicobailon/pi-intercom/blob/main/README.md
  - https://github.com/bastani-inc/atomic
  - https://github.com/earendil-works/pi
  - https://github.com/nicobailon/pi-intercom
cache_note: "Fetched Atomic llms.txt first, then markdown docs and GitHub repositories. GitHub code claims below use permalinks pinned to full commit SHAs."
---

## Summary

Atomic should preserve Pi compatibility while preferring Atomic-branded paths and manifests. Expected behavior:

- Primary Atomic config/state lives under `.atomic` / `~/.atomic/agent`; legacy Pi `.pi` / `~/.pi/agent` remains a fallback where compatibility is documented.
- Atomic-branded environment variables should be preferred, while `PI_*` aliases remain compatibility inputs for app-specific variables.
- Atomic extension/package manifests should prefer the running app key (`atomic`) and accept legacy `pi` manifests.
- Intercom should keep Pi's public 1:1 session communication conventions (`intercom`, `/intercom`, Alt+M, `send` / `ask` / `reply`, session-history entries, same-machine IPC), with Atomic path behavior layered on top and no regression for Pi users.
- Because `breaking_changes_allowed=false`, Atomic changes should not make Pi-compatible configs, extension packages, or intercom conventions stop working.

## Detailed Findings

### 1. Upstream Pi config-directory behavior

**Source**: [`earendil-works/pi` source at `351efc828b6fc5250fa50d6b32b20b0f0cb22cb4`](https://github.com/earendil-works/pi/tree/351efc828b6fc5250fa50d6b32b20b0f0cb22cb4)

Pi derives app identity from `package.json` `piConfig`, defaults to app name `pi`, config dir `.pi`, and agent dir `~/.pi/agent` unless `${APP_NAME}_CODING_AGENT_DIR` is set:

```ts
export const APP_NAME: string = piConfigName || "pi";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export function getAgentDir(): string {
  const envDir = process.env[ENV_AGENT_DIR];
  if (envDir) return expandTildePath(envDir);
  return join(homedir(), CONFIG_DIR_NAME, "agent");
}
```

Permalink: [`packages/coding-agent/src/config.ts#L487-L520`](https://github.com/earendil-works/pi/blob/351efc828b6fc5250fa50d6b32b20b0f0cb22cb4/packages/coding-agent/src/config.ts#L487-L520)

Pi extension package directories use the `package.json` `pi.extensions` manifest field before falling back to `index.ts` / `index.js`:

```ts
if (pkg.pi && typeof pkg.pi === "object") {
  return pkg.pi as PiManifest;
}
```

Permalink: [`packages/coding-agent/src/core/extensions/loader.ts#L539-L590`](https://github.com/earendil-works/pi/blob/351efc828b6fc5250fa50d6b32b20b0f0cb22cb4/packages/coding-agent/src/core/extensions/loader.ts#L539-L590)

**Compatibility expectation**: Atomic must not require upstream Pi extensions/packages to rename `pi` manifest keys to `atomic` to work under Atomic; and Pi itself must continue to work with `.pi` / `PI_*` semantics.

### 2. Atomic config-directory compatibility behavior

**Source**: Atomic repository at `80c3b297482131e6ae23e422bb95ebfed38eb15b`

Atomic publishes both `atomicConfig` and legacy `piConfig` with `name: "atomic"` and `configDir: ".atomic"` in package metadata:

```json
"atomicConfig": { "name": "atomic", "configDir": ".atomic" },
"piConfig": { "name": "atomic", "configDir": ".atomic" }
```

Permalink: [`packages/coding-agent/package.json#L1-L15`](https://github.com/bastani-inc/atomic/blob/80c3b297482131e6ae23e422bb95ebfed38eb15b/packages/coding-agent/package.json#L1-L15)

Atomic's runtime reads `<appName>Config` first, falls back to `piConfig`, computes `.atomic` from app name/config, and keeps `.pi` as a legacy config dir. It also maps Atomic env names to Pi aliases through `getEnvNames()`:

```ts
function readAppConfig(packageJson: PackageJson, appName: string | undefined): AppConfig | undefined {
  if (appName) {
    const appConfig = packageJson[`${appName}Config`];
    if (appConfig && typeof appConfig === "object" && !Array.isArray(appConfig)) return appConfig as AppConfig;
  }
  return packageJson.piConfig;
}
export const CONFIG_DIR_NAME = appConfig?.configDir || (APP_NAME === "pi" ? ".pi" : `.${APP_NAME}`);
export const LEGACY_CONFIG_DIR_NAME = ".pi";
export const CONFIG_DIR_NAMES = CONFIG_DIR_NAME === LEGACY_CONFIG_DIR_NAME ? [CONFIG_DIR_NAME] : [CONFIG_DIR_NAME, LEGACY_CONFIG_DIR_NAME];
```

Permalink: [`packages/coding-agent/src/config.ts#L222-L240`](https://github.com/bastani-inc/atomic/blob/80c3b297482131e6ae23e422bb95ebfed38eb15b/packages/coding-agent/src/config.ts#L222-L240)

```ts
export function getEnvNames(name: string): string[] {
  if (ENV_PREFIX === LEGACY_ENV_PREFIX || !name.startsWith(`${ENV_PREFIX}_`)) return [name];
  return [name, `${LEGACY_ENV_PREFIX}_${name.slice(ENV_PREFIX.length + 1)}`];
}
```

Permalink: [`packages/coding-agent/src/config.ts#L244-L325`](https://github.com/bastani-inc/atomic/blob/80c3b297482131e6ae23e422bb95ebfed38eb15b/packages/coding-agent/src/config.ts#L244-L325)

Atomic exposes helper paths in precedence order: primary `.atomic` first, then legacy `.pi` unless an explicit agent-dir env var is set:

```ts
export function getAgentDirs(): string[] {
  const primary = getAgentDir();
  if (hasEnvValue(ENV_AGENT_DIR) || CONFIG_DIR_NAME === LEGACY_CONFIG_DIR_NAME) return [primary];
  const legacy = getLegacyAgentDir();
  return legacy === primary ? [primary] : [primary, legacy];
}
export function getAgentConfigPaths(...segments: string[]): string[] {
  return getAgentDirs().map((dir) => join(dir, ...segments));
}
```

Permalink: [`packages/coding-agent/src/config.ts#L348-L389`](https://github.com/bastani-inc/atomic/blob/80c3b297482131e6ae23e422bb95ebfed38eb15b/packages/coding-agent/src/config.ts#L348-L389)

Public Atomic docs match this expectation: settings are documented at `~/.atomic/agent/settings.json` and `.atomic/settings.json`, while Atomic also reads legacy `~/.pi/agent/settings.json` and `.pi/settings.json` as fallbacks, with `.atomic` taking precedence. Source: [Atomic settings docs](https://docs.bastani.ai/settings.md).

### 3. Atomic extension registration and manifest compatibility

**Source**: [Atomic extensions docs](https://docs.bastani.ai/extensions.md) and Atomic source at `80c3b297482131e6ae23e422bb95ebfed38eb15b`

Public docs state extension auto-discovery under `~/.atomic/agent/extensions` and `.atomic/extensions`, with legacy `.pi` paths supported for compatibility. Docs also say package manifests should use the configured app key (`atomic` here), while legacy `pi` is accepted.

The source implements app-key-first, `pi`-fallback manifest handling:

```ts
function manifestFromPackageJson(pkg: Record<string, unknown>): PiManifest | null {
  const appManifest = pkg[APP_NAME];
  if (appManifest && typeof appManifest === "object" && !Array.isArray(appManifest)) return appManifest as PiManifest;
  const legacyManifest = pkg.pi;
  if (legacyManifest && typeof legacyManifest === "object" && !Array.isArray(legacyManifest)) return legacyManifest as PiManifest;
  return null;
}
```

Permalink: [`packages/coding-agent/src/core/extensions/loader-discovery.ts#L16-L25`](https://github.com/bastani-inc/atomic/blob/80c3b297482131e6ae23e422bb95ebfed38eb15b/packages/coding-agent/src/core/extensions/loader-discovery.ts#L16-L25)

Atomic discovers direct extension files, one-level subdirectories, and package manifests in extension dirs:

```ts
if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) discovered.push(entryPath);
...
const childEntries = resolveExtensionEntries(entryPath);
```

Permalink: [`packages/coding-agent/src/core/extensions/loader-discovery.ts#L81-L120`](https://github.com/bastani-inc/atomic/blob/80c3b297482131e6ae23e422bb95ebfed38eb15b/packages/coding-agent/src/core/extensions/loader-discovery.ts#L81-L120)

**Compatibility expectation**: Atomic extension packages can move toward `atomic.extensions`, but existing `pi.extensions` packages should continue to register tools, commands, shortcuts, flags, providers, and event handlers without manifest changes.

### 4. Inter-session communication conventions from public `pi-intercom`

**Source**: [`nicobailon/pi-intercom` README](https://github.com/nicobailon/pi-intercom/blob/main/README.md) and source at `e234a4446e2b3f9c13a1ec3151ae2169315c810f`

Public conventions to preserve:

- Direct same-machine 1:1 session messaging via local broker/IPC.
- User UI through `/intercom` and Alt+M.
- Agent tool named `intercom` with actions `list`, `send`, `ask`, `reply`, `pending`, `status`.
- `send` is fire-and-forget; `ask` waits for a reply; `reply` targets the current/pending ask.
- Messages render inline and persist in session history as extension entries.
- Subagent bridge uses `contact_supervisor` only when Pi-subagents environment metadata exists.

Upstream `pi-intercom` uses `PI_CODING_AGENT_DIR` when set and otherwise defaults runtime/config to `~/.pi/agent/intercom`:

```ts
const configured = env.PI_CODING_AGENT_DIR?.trim();
if (!configured) return join(homeDir, ".pi/agent");
return isAbsolute(configured) ? configured : resolve(cwd, configured);
```

Permalink: [`broker/paths.ts#L27-L42`](https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/broker/paths.ts#L27-L42)

Upstream uses Unix sockets under the intercom dir on macOS/Linux and Windows named pipes by default:

```ts
if (platform === "win32") return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(agentDir)}`;
return join(getIntercomDirPath(agentDir), "broker.sock");
```

Permalink: [`broker/paths.ts#L65-L74`](https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/broker/paths.ts#L65-L74)

Upstream registers `contact_supervisor` only when child metadata env vars are present, and always registers the normal `intercom` tool:

```ts
if (childOrchestratorMetadata) {
  pi.registerTool({ name: "contact_supervisor", ... });
}
...
pi.registerTool({ name: "intercom", ... });
```

Permalinks: [`index.ts#L1163-L1167`](https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/index.ts#L1163-L1167), [`index.ts#L1424-L1428`](https://github.com/nicobailon/pi-intercom/blob/e234a4446e2b3f9c13a1ec3151ae2169315c810f/index.ts#L1424-L1428)

### 5. Atomic bundled intercom compatibility expectations

**Source**: Atomic intercom source at `80c3b297482131e6ae23e422bb95ebfed38eb15b`

Atomic's bundled intercom config uses Atomic's agent config-path helper, which means it should read `.atomic` first and legacy `.pi` fallbacks according to `getAgentConfigPaths()`:

```ts
const CONFIG_PATHS = getAgentConfigPaths("intercom", "config.json");
const CONFIG_PATH = CONFIG_PATHS.find((path) => existsSync(path)) ?? CONFIG_PATHS[0]!;
```

Permalink: [`packages/intercom/config.ts#L1-L25`](https://github.com/bastani-inc/atomic/blob/80c3b297482131e6ae23e422bb95ebfed38eb15b/packages/intercom/config.ts#L1-L25)

Atomic's current broker socket helper uses the Atomic `CONFIG_DIR_NAME`, yielding `~/.atomic/agent/intercom/broker.sock` on non-Windows for the default Atomic app name:

```ts
return join(homeDir, CONFIG_DIR_NAME, "agent", "intercom", "broker.sock");
```

Permalink: [`packages/intercom/broker/paths.ts#L12-L20`](https://github.com/bastani-inc/atomic/blob/80c3b297482131e6ae23e422bb95ebfed38eb15b/packages/intercom/broker/paths.ts#L12-L20)

Atomic lazily exposes the public tool/command surface before loading the heavy intercom implementation: `intercom` tool, conditional `contact_supervisor`, and `/intercom` command.

Permalink: [`packages/intercom/index.ts#L314-L407`](https://github.com/bastani-inc/atomic/blob/80c3b297482131e6ae23e422bb95ebfed38eb15b/packages/intercom/index.ts#L314-L407)

**Compatibility expectation**:

- Atomic users should configure intercom at `~/.atomic/agent/intercom/config.json` primarily.
- Legacy `~/.pi/agent/intercom/config.json` should remain usable as a fallback through `getAgentConfigPaths()` unless an explicit Atomic agent dir overrides fallback scanning.
- Tool names and behavior should stay Pi-compatible (`intercom`, `contact_supervisor`, `/intercom`) so existing prompts, skills, subagent instructions, and session transcripts remain meaningful.
- Atomic should avoid changing Pi-specific env var names required by third-party Pi subagent tooling unless aliases are also supported; public `pi-intercom` documents `PI_SUBAGENT_ORCHESTRATOR_TARGET`, `PI_SUBAGENT_RUN_ID`, `PI_SUBAGENT_CHILD_AGENT`, and `PI_SUBAGENT_CHILD_INDEX`.

## Compatibility Checklist (Expected Behavior Only)

- Config precedence: prefer Atomic `.atomic` paths; fall back to `.pi` for legacy configs; do not write new Atomic state into `.pi` unless explicitly running as Pi or instructed by env/config.
- Environment aliases: prefer `ATOMIC_*` for Atomic docs/UI, but continue honoring compatible `PI_*` aliases for app-specific env vars.
- Extension placement: support `~/.atomic/agent/extensions` and `.atomic/extensions`; preserve legacy `.pi` extension/package support as documented.
- Extension manifests: prefer `atomic` manifest key in Atomic packages; accept `pi` manifest key for existing Pi packages.
- Intercom config: prefer `~/.atomic/agent/intercom/config.json`; fallback to `~/.pi/agent/intercom/config.json` for compatibility.
- Intercom IPC: same-machine only; Unix socket on macOS/Linux and named pipe on Windows are the public Pi convention. Any Atomic branding of runtime paths should not break the `intercom` protocol/tool behavior.
- Session communication: keep `send` non-blocking, `ask` blocking-until-reply, `reply` sugar, inline rendering, and session-history persistence.
- Subagent bridge: expose `contact_supervisor` only in child sessions with bridge metadata; normal sessions should only see regular `intercom`.

## Gaps or Limitations

- This document records expected compatibility behavior only and intentionally does not prescribe implementation changes.
- The Atomic public docs state legacy `.pi` extension paths remain supported. The specific implementation path for project-local legacy `.pi/extensions` should be verified in tests if changed, because source snippets above show the primary discovery helper building paths from `CONFIG_DIR_NAME`.
- Public `pi-intercom` has newer options (`inboundTrigger`, `PI_CODING_AGENT_DIR` centralized runtime dir) than the current Atomic bundled README/source excerpts inspected here; if Atomic intends full parity with latest upstream `pi-intercom`, compare those options separately before changing behavior.
