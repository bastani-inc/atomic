# Lazy Startup Current Diff Locations

Date: 2026-07-09
Repository: `<repo>`
Mode: read-only research
Breaking changes allowed: false

## Scope

Requested package surfaces:

- `packages/coding-agent`
- `packages/mcp`
- `packages/subagents`
- `packages/workflows`
- `packages/web-access`

This document maps current files, tests, docs, changelogs, validation commands, and expected PR evidence relevant to the lazy startup implementation.

---

## Implementation Files

### `packages/coding-agent` — Interactive deferred startup and resource deferral

- `packages/coding-agent/src/main.ts`
  - Entry point that imports deferred startup helpers and passes `{ deferExtensions: true, deferResources: true }` into resource loading when the deferred fast path applies.

- `packages/coding-agent/src/main-deferred-startup.ts`
  - Deferred startup predicate and early input capture predicate surface.
  - Searched hits include:
    - `computeDeferExtensions`
    - `computeStartupInputCaptureEnabled`

- `packages/coding-agent/src/main-early-input.ts`
  - Early raw input capture surface for startup typing before the visible editor/input handler is fully mounted.

- `packages/coding-agent/src/core/resource-loader-types.ts`
  - Resource loader option definitions.
  - Relevant options:
    - `deferExtensions`
    - `deferResources`

- `packages/coding-agent/src/core/resource-loader-reload.ts`
  - Resource reload path that supports deferred resources.
  - Searched hit: deferred mode creates an empty extension/runtime/resources state when `deferResources` is set and no trust resolver is active.

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - Imports interactive startup modules:
    - `interactive-startup.ts`
    - `interactive-deferred-startup.ts`
    - resource path/disclosure/rendering modules.

- `packages/coding-agent/src/modes/interactive/interactive-startup.ts`
  - Interactive startup lifecycle surface.

- `packages/coding-agent/src/modes/interactive/interactive-deferred-startup.ts`
  - Deferred startup completion/readiness surface.
  - Search hits point to:
    - first prompt readiness behavior
    - `ensureDeferredStartupComplete`
    - deferred model scope application
    - completion/reload behavior.

- `packages/coding-agent/src/modes/interactive/interactive-extension-runtime.ts`
  - Startup spinner behavior around prompt preflight.
  - Search hit notes that prompt preflight includes deferred startup before `agent_start`.

- `packages/coding-agent/src/utils/split-launcher.ts`
  - Related compiled/bundled startup path surface for dynamic sidecar/built-in extension loading.

### `packages/mcp` — Lazy MCP startup and background warmup

- `packages/mcp/index.ts`
  - MCP extension registration and session lifecycle entry.
  - Search hits include:
    - `startupWarmupCancel`
    - `cancelStartupWarmup`
    - dynamic imports of `./init.ts` and `./startup-warmup.ts`
    - `scheduleMcpStartupWarmup`
    - cancellation during session shutdown/disposal.

- `packages/mcp/init.ts`
  - MCP initialization surface imported lazily from `index.ts`.

- `packages/mcp/startup-warmup.ts`
  - Background MCP metadata/direct-tool warmup implementation.
  - Search hits include:
    - `McpStartupWarmupOptions`
    - `McpStartupWarmupHandle`
    - `scheduleMcpStartupWarmup`
    - background direct-tools warmup logging
    - cancellation handle.

### `packages/subagents` — Lazy startup maintenance surface

- `packages/subagents/src/extension/index.ts`
  - Subagents extension entry point.

- `packages/subagents/src/extension/startup-maintenance.ts`
  - Startup maintenance surface for subagents.

### `packages/workflows` — Workflow discovery warmup and lifecycle

- `packages/workflows/src/extension/extension-lifecycle.ts`
  - Workflow extension lifecycle surface.
  - Search hit: calls `runtimeState.startWorkflowDiscoveryWarmup(...)`.

- `packages/workflows/src/extension/extension-runtime-state.ts`
  - Workflow runtime state and lazy discovery surface.
  - Search hits include:
    - `startWorkflowDiscoveryWarmup`
    - `lazyDiscoveryPromise`
    - macrotask deferral
    - discovery notification settlement.

- `packages/workflows/src/extension/extension-factory.ts`
  - Workflow extension factory surface.

- `packages/workflows/src/extension/workflow-command-registration.ts`
  - Workflow command registration surface.

- `packages/workflows/src/extension/workflow-tool-registration.ts`
  - Workflow tool registration surface.

### `packages/web-access` — Lightweight wrapper / heavy dynamic import

- `packages/web-access/index.ts`
  - Lightweight registration surface.
  - Search hit: dynamic import of `./index-heavy.js` in `loadHeavy`.
  - Registers wrappers immediately and loads heavy implementation on explicit use.

- `packages/web-access/index-heavy.ts`
  - Heavy implementation loaded dynamically by `index.ts`.

---

## Test Files

### `packages/coding-agent` startup/deferred startup tests

- `packages/coding-agent/test/main-deferred-startup.test.ts`
  - Deferral decision tests and startup input capture predicate tests.

- `packages/coding-agent/test/main-early-input.test.ts`
  - Early input capture tests.

- `packages/coding-agent/test/interactive-deferred-startup.test.ts`
  - Interactive deferred startup behavior tests.

- `packages/coding-agent/test/interactive-deferred-startup-input.test.ts`
  - Tests `ensureDeferredStartupComplete` behavior and failure-open cases.

- `packages/coding-agent/test/interactive-deferred-startup-first-prompt.test.ts`
  - First prompt readiness behavior for deferred resources/extensions.

- `packages/coding-agent/test/interactive-mode-startup-latency.test.ts`
  - Startup latency tests.
  - Search hits include:
    - starts deferred startup in background after input readiness
    - waits for deferred startup before first normal prompt
    - waits for already-in-flight deferred startup before prompting.

- `packages/coding-agent/test/interactive-mode-startup-input.test.ts`
  - Startup input behavior.
  - Search hits include:
    - loads deferred startup before model slash commands
    - local slash commands stay responsive without deferred startup
    - explicit extension slash submissions wait for deferred startup.

- `packages/coding-agent/test/interactive-mode-startup-banner.test.ts`
  - Startup banner tests.

- `packages/coding-agent/test/interactive-mode-startup-latency.test.ts`
  - Startup first-frame/input readiness coverage.

- `packages/coding-agent/test/interactive-mode-footer-ordering.test.ts`
  - Footer ordering surface relevant to first paint/footer watcher deferral.

- `packages/coding-agent/test/resource-loader-defer-resources.test.ts`
  - Resource loader deferred resources tests.

- `packages/coding-agent/test/resource-loader.test.ts`
  - General resource loader coverage.

- `packages/coding-agent/test/extensions-discovery.test.ts`
  - Extension discovery coverage.

- `packages/coding-agent/test/extensions-loader-virtual-modules.test.ts`
  - Extension loading/virtual module coverage.

- `packages/coding-agent/test/extensions-runner.test.ts`
  - Extension runner behavior.

- `packages/coding-agent/test/extensions-input-event.test.ts`
  - Extension input event behavior.

- `packages/coding-agent/test/suite/regressions/1223-startup-lazy-builtins.test.ts`
  - Regression coverage for lazy built-in extension loading.
  - Search hits verify:
    - web-access/intercom cold registration does not import heavy modules
    - `index-heavy.js` is dynamically imported
    - MCP cold startup exposes proxy/direct tools according to cache state.

### `packages/subagents` tests

- `packages/subagents/src/runs/shared/mcp-direct-tool-allowlist.test.ts`
  - Related MCP/subagent direct-tool allowlist test surface.

### `packages/workflows` tests

Located test-like hits in workflow source directories:

- `packages/workflows/src/extension/workflow-tool-inspection.ts`
- `packages/workflows/src/shared/schema-introspection.ts`

No dedicated workflow lazy-startup test file was found in the requested package paths by `*test*`/`*spec*` filename search.

### `packages/mcp` tests

No dedicated `packages/mcp/**/*test*` or `packages/mcp/**/*spec*` file was surfaced in the requested path search output.

### `packages/web-access` tests

No dedicated `packages/web-access/**/*test*` or `packages/web-access/**/*spec*` file was surfaced in the requested path search output.

---

## Documentation Files

### Current / directly relevant docs

- `packages/coding-agent/docs/development.md`
  - Search hit documents startup profiling:
    - `ATOMIC_TIMING=1`
    - `ATOMIC_STARTUP_BENCHMARK=1`
    - first-frame/deferred-startup probes.

- `packages/coding-agent/docs/settings.md`
  - Search hit documents normal interactive TTY fast path:
    - paint/input first
    - resource loading in background
    - readiness gate before first prompt/model turn
    - synchronous path for provider/model/resource/system-prompt/metadata/trust cases.

- `packages/coding-agent/docs/workflows.md`
  - Search hit mentions workflow readiness gates in stage send/user-message context.

- `packages/coding-agent/docs/extensions.md`
  - Extension documentation surface.

### Current research docs in `research/docs`

- `research/docs/2026-07-09-atomic-command-extension-startup-analysis.md`
  - Contains detailed references to:
    - deferred startup gate
    - web-access lazy heavy built-ins
    - tests for deferred startup
    - settings/changelog evidence.

- `research/docs/2026-07-09-atomic-existing-lazy-patterns.md`
  - Existing lazy patterns locator.
  - Search hits identify:
    - `packages/coding-agent/src/main-deferred-startup.ts`
    - dynamic import startup split
    - lazy startup / deferral predicates.

- `research/docs/2026-07-09-atomic-lazy-startup-locations.md`
  - Prior locator document for lazy/non-blocking startup surfaces.
  - It also notes inability to write directly due to read/search/list-only tools.

- `research/docs/2026-07-09-atomic-mcp-startup-analysis.md`
  - MCP startup analysis document.

- `research/docs/2026-07-09-local-startup-research-analysis.md`
  - Current local startup research analysis.
  - Search hits mention:
    - startup responsiveness milestones
    - separation of first render/input vs first model request vs background work
    - MCP lazy lifecycle constraints.

- `research/docs/2026-03-03-bun-migration-startup-optimization.md`
  - Prior startup performance research.

- `research/docs/2026-03-01-opencode-tui-concurrency-bottlenecks.md`
  - Related TUI performance/concurrency research.

- `research/docs/2026-02-25-workflow-registration-flow.md`
  - Workflow registration/discovery background.

- `research/docs/2026-02-25-workflow-sdk-design.md`
  - Workflow SDK/discovery context.

- `research/docs/2026-02-25-workflow-sdk-patterns.md`
  - Workflow SDK patterns.

---

## Changelog Files

### `packages/coding-agent/CHANGELOG.md`

Relevant current entries from search:

- `[Unreleased]`
  - Improved interactive startup responsiveness.
  - Footer git watcher setup deferred out of first paint.
  - Deferred extension/resource loading starts after input readiness instead of blind post-paint timer.
  - First normal prompt/model turn waits on readiness gate when background load is still running.
  - Built-in extension lazy-startup model documented:
    - lightweight tools/commands register immediately
    - MCP warmup, workflow discovery, subagent maintenance, and web-access heavy provider loading run in background or on explicit use.

- `0.9.5-alpha.8`
  - Early input capture on deferred startup fast path.
  - Command-like early submissions preserved as startup commands.
  - Explicit provider/model/resource/trust/metadata paths remain synchronous.

- `0.9.5-alpha.7`
  - Deferred resource discovery for bundled packages/resources.
  - Cooperative yields for package resources, skills, prompts, themes, and extension-discovered resources.
  - Startup notice ordering fixes.

- `0.9.5-alpha.6`
  - Deferred extension loading and model scope restoration after extensions finish loading.

### `packages/mcp/CHANGELOG.md`

Relevant current entries from search:

- `[Unreleased]`
  - Improved startup responsiveness by keeping first-run/default lazy MCP metadata bootstrap out of `initializeMcp()` synchronous path.
  - Cached direct tools and MCP proxy register immediately.
  - Explicit `eager` / `keep-alive` servers still connect during initialization.
  - Missing direct-tool metadata warms in background.

- Earlier lazy startup history:
  - Lazy startup by default.
  - Servers default to `lifecycle: "lazy"`.
  - `eager` / `keep-alive` can restore old per-server behavior.
  - Direct tools register from cached metadata at startup.
  - Non-blocking startup / background connections.

### `packages/subagents/CHANGELOG.md`

Relevant package changelog file exists:

- `packages/subagents/CHANGELOG.md`

No direct `lazy|startup|warmup` search hit was surfaced in the current targeted output for this changelog, but it is part of the requested package scope and should be checked in PR evidence if changed.

### `packages/workflows/CHANGELOG.md`

Relevant package changelog file exists:

- `packages/workflows/CHANGELOG.md`

Search hits in this changelog are mostly readiness-gate workflow behavior rather than startup discovery warmup. It remains relevant if workflow discovery warmup behavior is changed.

### `packages/web-access/CHANGELOG.md`

Relevant package changelog file exists:

- `packages/web-access/CHANGELOG.md`

No direct targeted changelog hit was surfaced in the search output, but the package has lazy heavy import behavior in `index.ts`, so changelog evidence should be included if changed.

---

## Related Directories / Clusters

### Coding agent startup/resource clusters

- `packages/coding-agent/src/main*.ts`
  - Startup/bootstrap/session/stdio/deferred startup cluster.

- `packages/coding-agent/src/core/resource-loader-*`
  - Resource discovery/reload/package resource deferral cluster.

- `packages/coding-agent/src/modes/interactive/`
  - Interactive startup, deferred startup, input, resource disclosure/rendering, startup notices, and TUI behavior cluster.

- `packages/coding-agent/test/`
  - Main startup, interactive startup, deferred startup, resource loader, extension discovery, and TUI startup tests.

- `packages/coding-agent/test/suite/regressions/`
  - Regression tests for lazy built-ins and startup behavior.

### MCP startup cluster

- `packages/mcp/index.ts`
- `packages/mcp/init.ts`
- `packages/mcp/startup-warmup.ts`
- `packages/mcp/CHANGELOG.md`

### Subagents startup/maintenance cluster

- `packages/subagents/src/extension/`
  - `index.ts`
  - `startup-maintenance.ts`

### Workflows extension discovery cluster

- `packages/workflows/src/extension/`
  - `extension-lifecycle.ts`
  - `extension-runtime-state.ts`
  - `extension-factory.ts`
  - command/tool registration files.

### Web-access lazy-heavy cluster

- `packages/web-access/index.ts`
- `packages/web-access/index-heavy.ts`
- `packages/web-access/CHANGELOG.md`

---

## Validation Commands

These are commands expected to validate lazy startup changes.

### General repository validation

```bash
bun install
bun run typecheck
bun run lint
bun run check:file-length
```

Root scripts found in `package.json`:

- `bun run test`
- `bun run test:unit`
- `bun run test:integration`
- `bun run test:all`
- `bun run typecheck`
- `bun run lint`
- `bun run check:file-length`
- `bun run check:shrinkwrap`

### Coding-agent package validation

From `packages/coding-agent/package.json`:

```bash
bun --cwd packages/coding-agent run test
bun --cwd packages/coding-agent run build
bun --cwd packages/coding-agent run docs:check
bun --cwd packages/coding-agent run verify:workflow-types
```

### Targeted lazy startup tests

```bash
bun --cwd packages/coding-agent run test -- test/main-deferred-startup.test.ts
bun --cwd packages/coding-agent run test -- test/main-early-input.test.ts
bun --cwd packages/coding-agent run test -- test/interactive-deferred-startup.test.ts
bun --cwd packages/coding-agent run test -- test/interactive-deferred-startup-input.test.ts
bun --cwd packages/coding-agent run test -- test/interactive-deferred-startup-first-prompt.test.ts
bun --cwd packages/coding-agent run test -- test/interactive-mode-startup-latency.test.ts
bun --cwd packages/coding-agent run test -- test/interactive-mode-startup-input.test.ts
bun --cwd packages/coding-agent run test -- test/resource-loader-defer-resources.test.ts
bun --cwd packages/coding-agent run test -- test/suite/regressions/1223-startup-lazy-builtins.test.ts
```

### Startup profiling / manual validation commands

Docs search surfaced these environment flags:

```bash
ATOMIC_TIMING=1 bun --cwd packages/coding-agent run start:fast
ATOMIC_STARTUP_BENCHMARK=1 bun --cwd packages/coding-agent run start:fast
```

Expected startup profiling evidence should include at least:

- first render / first frame
- first key/input handling
- deferred startup start time
- deferred startup completion time
- first normal prompt readiness gate timing when background load is still running.

### Manual interactive checks

Expected manual scenarios:

```bash
bun --cwd packages/coding-agent run start:fast
```

Then verify:

- Interactive TTY paints before bundled resources/extensions finish loading.
- Typing immediately at startup is captured.
- Local slash commands remain responsive without forcing full deferred startup when appropriate.
- Model/extension slash submissions that require loaded extensions wait for readiness.
- First normal prompt waits for deferred startup completion if background load is still active.
- Startup notices preserve order:
  - `RESOURCES`
  - changelog
  - update/package/tmux/subscription notices
  - queued user prompts.

### MCP manual checks

Expected manual scenarios:

- MCP proxy tool registers immediately.
- Cached direct tools register immediately.
- Missing direct-tool metadata warms in background.
- Explicit `eager` / `keep-alive` servers connect during initialization.
- Lazy/default servers do not block initial startup.
- Session shutdown/disposal cancels startup warmup cleanly.

### Workflow manual checks

Expected manual scenarios:

- Workflow commands/tools register immediately.
- Workflow discovery warmup runs after lifecycle start without blocking first interactive input.
- Discovery diagnostics are reported after warmup settles.

### Web-access manual checks

Expected manual scenarios:

- `packages/web-access/index.ts` can cold-register without importing heavy modules.
- First web-access tool/command/shortcut use dynamically imports `index-heavy.js`.
- Session lifecycle events are replayed to the heavy module after load.

---

## Expected PR Evidence

A PR for this lazy startup implementation should include evidence in these categories.

### Changed files evidence

Show `git diff --stat` and/or PR file list covering relevant package scopes:

- `packages/coding-agent`
- `packages/mcp`
- `packages/subagents`
- `packages/workflows`
- `packages/web-access`

Expected high-signal changed files include some combination of:

- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/main-deferred-startup.ts`
- `packages/coding-agent/src/main-early-input.ts`
- `packages/coding-agent/src/core/resource-loader-types.ts`
- `packages/coding-agent/src/core/resource-loader-reload.ts`
- `packages/coding-agent/src/modes/interactive/interactive-deferred-startup.ts`
- `packages/coding-agent/src/modes/interactive/interactive-startup.ts`
- `packages/mcp/index.ts`
- `packages/mcp/startup-warmup.ts`
- `packages/subagents/src/extension/index.ts`
- `packages/subagents/src/extension/startup-maintenance.ts`
- `packages/workflows/src/extension/extension-lifecycle.ts`
- `packages/workflows/src/extension/extension-runtime-state.ts`
- `packages/web-access/index.ts`
- `packages/web-access/index-heavy.ts`

### Test evidence

PR should include passing output for targeted tests:

- `main-deferred-startup.test.ts`
- `main-early-input.test.ts`
- `interactive-deferred-startup*.test.ts`
- `interactive-mode-startup-latency.test.ts`
- `interactive-mode-startup-input.test.ts`
- `resource-loader-defer-resources.test.ts`
- `suite/regressions/1223-startup-lazy-builtins.test.ts`

### Type/build evidence

PR should include passing output for:

- root `bun run typecheck` or `bun run lint`
- `bun --cwd packages/coding-agent run build`
- `bun --cwd packages/coding-agent run verify:workflow-types`
- `bun --cwd packages/coding-agent run docs:check` if docs changed.

### Startup benchmark evidence

PR should include before/after or current-run evidence for:

- first frame / first paint
- first key/input handling
- deferred startup completion
- first prompt readiness wait when deferred startup still pending.

Recommended environment:

```bash
ATOMIC_STARTUP_BENCHMARK=1 bun --cwd packages/coding-agent run start:fast
```

Optional broader timing:

```bash
ATOMIC_TIMING=1 bun --cwd packages/coding-agent run start:fast
```

### Manual UX evidence

PR should include notes or screen recording/GIF/logs showing:

- immediate visible prompt/input responsiveness on normal interactive TTY startup
- early typed input is not lost
- first ordinary model prompt waits for readiness if needed
- local slash commands remain fast
- explicit extension/model/resource/trust paths still load synchronously where required
- startup notices retain order.

### Lazy built-in evidence

PR should include evidence that cold startup does not import heavy built-in modules unnecessarily:

- web-access heavy module is not statically imported during cold registration
- heavy module loads only on first tool/command/shortcut use
- MCP direct/proxy tool registration is available without eager server connection
- workflow discovery warmup does not block first input.

### Changelog/docs evidence

If behavior changed, PR should update or confirm entries in:

- `packages/coding-agent/CHANGELOG.md`
- `packages/mcp/CHANGELOG.md`
- `packages/subagents/CHANGELOG.md`
- `packages/workflows/CHANGELOG.md`
- `packages/web-access/CHANGELOG.md`
- `packages/coding-agent/docs/settings.md`
- `packages/coding-agent/docs/development.md`
