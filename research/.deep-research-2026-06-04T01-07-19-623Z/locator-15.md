## 1. Must-read paths

- `packages/coding-agent/src/core/extensions/loader.ts` — the main TS/JS extension loader; uses `jiti/static`, `virtualModules`, `alias`, and discovery/loading logic.
- `packages/coding-agent/src/core/extensions/types.ts` — the extension ABI (`ExtensionAPI`, `ExtensionRuntime`, tools, commands, UI hooks). This is the contract a Rust plugin system would have to preserve or replace.
- `packages/coding-agent/docs/extensions.md` — user-facing extension model, auto-discovery rules, hot reload, and supported imports.
- `packages/coding-agent/test/extensions-discovery.test.ts` — verifies discovery behavior for `.ts`, `.js`, `index.ts/js`, and `package.json` manifests.
- `packages/coding-agent/test/extensions-runner.test.ts` — verifies runtime behavior after load: conflicts, shortcuts, event handling, tool wrapping.
- `packages/coding-agent/test/extensions-input-event.test.ts` — verifies extension event semantics during input processing.
- `packages/workflows/src/extension/workflow-module-loader.ts` — second `jiti`-based loader, but for workflows; useful because it shows the same dynamic-module pattern in another subsystem.
- `packages/workflows/src/extension/index.ts` — workflow extension entrypoint; shows how extension APIs are consumed beyond core CLI.
- `packages/coding-agent/package.json` — declares `jiti`, extension-related runtime deps, and the shipped CLI/package surface.
- `packages/workflows/package.json` — raw TypeScript package with `jiti` dependency and `pi.extensions` manifest wiring.

## 2. Supporting paths

- `packages/coding-agent/docs/sdk.md` — `createAgentSession()` and `DefaultResourceLoader` notes; shows how extensions are loaded into sessions.
- `packages/coding-agent/docs/rpc.md` — extension commands/UI protocol in RPC mode; relevant if Rust needs a plugin protocol.
- `packages/coding-agent/src/core/resource-loader.ts` — where extension discovery is plugged into broader resource loading.
- `packages/coding-agent/src/core/package-manager.ts` — package manifest discovery; relevant because extensions can be shipped as packages.
- `packages/coding-agent/src/core/extensions/runner.ts` — post-load runtime wiring and event dispatch.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — contains jiti boundary comments and reload behavior.
- `packages/workflows/src/extension/discovery.ts` — workflow discovery rules around `.ts/.js/.mjs/.cjs`.
- `packages/workflows/src/extension/config-loader.ts` — workflow extension config resolution paths.
- `docs/ci.md` — packaging/bundling expectations that currently assume TS extensions are included in the build.
- `scripts/build-binaries.sh` / `packages/coding-agent/package.json#build:binary` — binary build path that bundles runtime + TS extension ecosystem.

## 3. Entry points / symbols

- `createJiti(...)` in:
  - `packages/coding-agent/src/core/extensions/loader.ts`
  - `packages/workflows/src/extension/workflow-module-loader.ts`
- `VIRTUAL_MODULES` in `packages/coding-agent/src/core/extensions/loader.ts` — bundled module map for binary mode.
- `getAliases()` in `packages/coding-agent/src/core/extensions/loader.ts` — dev-mode module resolution shim.
- `loadExtensionModule()` / `loadExtension()` / `loadExtensions()` / `discoverAndLoadExtensions()` in `packages/coding-agent/src/core/extensions/loader.ts`.
- `createExtensionRuntime()` in `packages/coding-agent/src/core/extensions/loader.ts` — runtime stubs and lifecycle invalidation.
- `ExtensionAPI.registerTool()` / `registerCommand()` / `registerShortcut()` / `registerFlag()` in `packages/coding-agent/src/core/extensions/types.ts`.
- `ExtensionUIContext.custom()` / `setWidget()` / `setFooter()` / `setEditorComponent()` in `packages/coding-agent/src/core/extensions/types.ts` — large part of the plugin surface.
- `validateWorkflowDefinitionShape()` / `loadWorkflowModule()` / `collectWorkflowModuleCandidates()` in `packages/workflows/src/extension/workflow-module-loader.ts`.
- `discoverExtensionsInDir()` / `resolveExtensionEntries()` in `packages/coding-agent/src/core/extensions/loader.ts` — exact discovery semantics.

## 4. Gaps or uncertainty

- No Rust crate/workspace is present here; I could not verify any existing Rust plugin ABI or host integration.
- No Rust-equivalent plugin loader is implemented yet, so “Rust alternatives” are still a design decision, not a codepath.
- The true replacement boundary is unclear: preserve JS plugins via an embedded JS engine, spawn plugin subprocesses, or redesign the extension API.
- I could not verify whether `packages/coding-agent/test/*` is fully covered by CI beyond the root test flow.
- `jiti` is also used in workflows, so replacing only core extensions would still leave another dynamic-loader dependency.