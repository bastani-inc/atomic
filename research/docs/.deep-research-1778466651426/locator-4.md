# Partition 4 Locator Report: tests/ (10,395 LOC)

## Summary

The `tests/` directory contains **45 test files** (9,742 LOC in .test.ts/.test.tsx files) organized across 9 functional clusters: CI infrastructure guards, SDK/runtime behavior, UI component tests, agent provider tests, config/settings validation, and integration fixtures. Key findings:

- **3 files spawn subprocess processes**: `tests/ci/onboarding.test.ts` uses `spawnSync()` for binary preflight; `tests/fixtures/sdk-compiled-consumer/scripts/smoke.ts` spawns 6-step fixture workflow validation; `tests/ci/_helpers/binary.ts` spawns `bun build.ts`.
- **Real agent/tmux tests identified**: `tests/sdk/runtime/tmux.test.ts` (15 describe blocks, 664 LOC) directly tests tmux binary detection, session parsing, pane attachment; `tests/sdk/providers/copilot.test.ts`, `tests/sdk/providers/claude-wait-for-idle.test.ts`, `tests/sdk/providers/claude-watch-hil-marker.test.ts` test agent-specific signal flows (fs.watch markers for Claude Code stop-hook, Copilot env).
- **Orchestrator/workflow tests**: `tests/sdk/runtime/executor.test.ts` validates orchestrator env-var contract; `tests/sdk/registry.test.ts` tests workflow registry immutability; `tests/sdk/runtime/graph-inference.test.ts` tests stage dependency inference (ralph-loop patterns).
- **Component tests (9 .tsx files, 4,492 LOC)**: UI layer test fixtures for OpenTUI panels/graphs—no subprocess spawns, pure React/OpenTUI reconciler tests.
- **Fixture suite for SDK distribution**: `tests/fixtures/sdk-compiled-consumer/` is a complete end-to-end fixture testing both host-bun and compiled-binary SDK dispatch modes.

---

## Implementation

- `tests/sdk/runtime/tmux.test.ts` — 664 LOC; tests tmux binary resolution, session name parsing, pane-exit hooks, SOCKET_NAME detection (atomic socket vs. default); exercises all public exported functions from `packages/atomic-sdk/src/runtime/tmux.ts`; does NOT spawn real tmux processes, mocks process.platform and PATH.
- `tests/sdk/providers/copilot.test.ts` — Provider env and CLI path resolution; mocks CommandPathResolver; tests NODE_NO_WARNINGS normalization, UTF-8 locale handling, secret-token exclusion.
- `tests/sdk/providers/claude-wait-for-idle.test.ts` — Tests marker-file watcher flow for Claude Code stop-hook; mocks `@anthropic-ai/claude-agent-sdk` getSessionMessages; real fs.watch on unique UUID marker dir; simulates transcript slicing and mid-loop async-flush race detection.
- `tests/sdk/providers/claude-watch-hil-marker.test.ts` — Tests fs.watch on HIL (Human-in-the-Loop) marker dir; detects Claude Code PreToolUse/PostToolUse hook state; no mocking, real fs.watch on uuid-scoped paths.
- `tests/sdk/runtime/executor.test.ts` — Validates WorkflowRunOptions shape (definition + agent + inputs); env-var contract validation (ATOMIC_WF_ID, ATOMIC_WF_TMUX, ATOMIC_WF_AGENT, ATOMIC_WF_CWD); asserts launcher entry script uses orchestrator-entry.ts, not old re-entry signals.
- `tests/sdk/runtime/graph-inference.test.ts` — GraphFrontierTracker tests; ralph-loop patterns (sequential chains across iterations); parallel fan-out/fan-in; conditional skips.
- `tests/sdk/runtime/cc-debounce.test.ts` — Debounce utility for Claude Code idle detection.
- `tests/sdk/runtime/version-compat.test.ts` — Version compatibility checks.
- `tests/sdk/registry.test.ts` — Workflow registry (createRegistry) immutability and chaining.
- `tests/commands/cli/chat/chat-integration.test.ts` — resolveChatCommand, buildLauncherEnv, buildSpawnEnv, buildTmuxEnv; copilot special case (COPILOT_CLI_PATH); secret exclusion (GH_TOKEN, COPILOT_GITHUB_TOKEN, ANTHROPIC_API_KEY); tmux outer-multiplexer stripping (TMUX, PSMUX, WINDOWID removal).
- `tests/commands/cli/chat/buildLauncherScript.test.ts` — Platform-shimmed bash/pwsh launcher script generation; shebang, cd, arg escaping, env export, exit-code capture.
- `tests/sdk/primitives/inputs.test.ts` — Workflow input parsing/validation.
- `tests/sdk/primitives/metadata.test.ts` — Workflow metadata extraction.
- `tests/sdk/primitives/sessions.test.ts` — Session primitive tests.

---

## Tests

### CI Infrastructure (7 files)
- `tests/ci/onboarding.test.ts` — E2E binary preflight (RUN_CI_E2E gate); spawns compiled binary via `spawnSync()` for agent config onboarding; tests `.mcp.json`, `.claude/settings.json` materialization; sandbox HOME/XDG_CACHE_HOME isolation.
- `tests/ci/coverage-paths.test.ts` — Validates coveragePathIgnorePatterns in bunfig.toml against real files (whitelist guard for infra dirs).
- `tests/ci/mcp-bundle-source.test.ts` — MCP bundle asset provenance checks.
- `tests/ci/no-import-meta-dir-in-runtime.test.ts` — Guards against `import.meta.dir` in runtime entry (bunfs incompatibility).
- `tests/ci/no-ts-file-asset-import.test.ts` — Prevents `.ts` file assets (must be compiled `.js`).
- `tests/ci/publish-workflow-shape.test.ts` — Package.json "exports" shape validation.
- `tests/ci/skill-description-length.test.ts` — Checks skill manifest description length.
- `tests/ci/_helpers/binary.ts` — Helper to ensureBinary(); spawns `bun build.ts` if binary missing; memoised per-process.

### SDK Runtime & Providers (6 files)
- `tests/sdk/runtime/tmux.test.ts` — 15 describe blocks, full tmux utilities test suite.
- `tests/sdk/runtime/executor.test.ts` — Orchestrator env-var validation, WorkflowRunOptions shape.
- `tests/sdk/runtime/graph-inference.test.ts` — Stage frontier tracking (ralph-loop, parallel, fan-in/fan-out).
- `tests/sdk/runtime/cc-debounce.test.ts` — Claude Code debounce.
- `tests/sdk/runtime/version-compat.test.ts` — Version checks.
- `tests/sdk/providers/copilot.test.ts` — Copilot CLI path resolution, env normalization.
- `tests/sdk/providers/claude-wait-for-idle.test.ts` — Marker-file watcher for Claude Code stop-hook.
- `tests/sdk/providers/claude-watch-hil-marker.test.ts` — HIL marker watcher for PreToolUse/PostToolUse hooks.

### SDK Primitives & Registry (3 files)
- `tests/sdk/primitives/inputs.test.ts` — Input type validation.
- `tests/sdk/primitives/metadata.test.ts` — Metadata shape.
- `tests/sdk/primitives/sessions.test.ts` — Session lifecycle.
- `tests/sdk/registry.test.ts` — Immutable chainable registry tests (8 describe blocks).

### Chat Commands & Environment (2 files)
- `tests/commands/cli/chat/chat-integration.test.ts` — 5 describe blocks; resolveChatCommand, buildLauncherEnv, buildSpawnEnv, buildTmuxEnv wiring (140 total LOC across test suite).
- `tests/commands/cli/chat/buildLauncherScript.test.ts` — Platform-shimmed launcher generation (bash/pwsh branches).

### UI Components (9 files, ~4,492 LOC)
- `tests/sdk/components/node-card.test.tsx` — Graph node card rendering.
- `tests/sdk/components/edge.test.tsx` — Graph edge rendering.
- `tests/sdk/components/session-graph-panel.test.tsx` — Session graph display.
- `tests/sdk/components/header.test.tsx` — Header component.
- `tests/sdk/components/orchestrator-panel.test.tsx` — Main orchestrator panel (2 describe blocks).
- `tests/sdk/components/error-boundary.test.tsx` — Error boundary.
- `tests/sdk/components/orchestrator-panel-contexts.test.tsx` — Context providers (3 describe blocks).
- `tests/sdk/components/workflow-picker-panel.test.tsx` — Workflow selection (13 describe blocks; snapshot file: `__snapshots__/workflow-picker-panel.test.tsx.snap`).
- `tests/sdk/components/layout.test.ts` — Grid layout (2 describe blocks).
- `tests/sdk/components/orchestrator-panel-store.test.ts` — Zustand store state management (11 describe blocks).
- `tests/sdk/components/color-utils.test.ts` — Color utility functions (3 describe blocks).
- `tests/sdk/components/connectors.test.ts` — Graph connectors (2 describe blocks).
- `tests/sdk/components/renderer-background.test.ts` — Background rendering (3 describe blocks).
- `tests/sdk/components/status-helpers.test.ts` — Status helpers (4 describe blocks).
- `tests/sdk/components/graph-theme.test.ts` — Graph theme (1 describe block).
- `tests/sdk/components/tui-diagnostics.test.ts` — Diagnostics panel (3 describe blocks).
- `tests/sdk/components/test-helpers.tsx` — Shared test helpers (React/OpenTUI fixtures).

### Library Utilities (3 files)
- `tests/lib/merge.test.ts` — Config/object merge logic (5 describe blocks).
- `tests/lib/common-ignore.test.ts` — `.gitignore` / common patterns (1 describe block).
- `tests/lib/path-root-guard.test.ts` — Root path validation (3 describe blocks).

### Services Config & System (5 files)
- `tests/services/config/settings.test.ts` — Settings load/save (3 describe blocks).
- `tests/services/config/scm-sync.test.ts` — SCM sync logic (5 describe blocks).
- `tests/services/config/settings-seed-envvars.test.ts` — Environment variable seeding (1 describe block).
- `tests/services/system/detect.test.ts` — System detection (9 describe blocks).
- `tests/services/system/copy.test.ts` — File copy operations (11 describe blocks).

---

## Fixtures / Integration Scenarios

### SDK Distribution Fixtures
- `tests/fixtures/sdk-compiled-consumer/` — Complete end-to-end fixture for compiled SDK scenario; 6-step smoke test matrix:
  - `tests/fixtures/sdk-compiled-consumer/src/workflow.ts` — `greetWorkflow` fixture; single claude stage calling `ctx.stage.query()`.
  - `tests/fixtures/sdk-compiled-consumer/src/cli.ts` — CLI entry point; demonstrates SDK dispatcher auto-detection.
  - `tests/fixtures/sdk-compiled-consumer/scripts/smoke.ts` — **Subprocess spawner**: 6-step validation (bun install → host-bun invocation → bun build --compile → compiled-binary invocation → no-dispatcher error → host-bun rerun); uses `spawnSync()` with HOME/ATOMIC_SETTINGS_HOME/XDG_CACHE_HOME sandbox isolation; spawns real tmux sessions via fixture workflow.
  - `tests/fixtures/sdk-compiled-consumer/tsconfig.json`, `package.json` — Fixture config.
  - `tests/fixtures/sdk-compiled-consumer/README.md` — Fixture documentation.

### Host-Local SDK Fixture
- `tests/fixtures/sdk-host-consumer/index.ts` — Minimal host-bun fixture; calls `hostLocalWorkflows([wf])` to validate SDK's entrypoint resolution in non-compiled scenario.
- `tests/fixtures/sdk-host-consumer/package.json` — Host fixture config.

---

## Configuration

- `tests/tsconfig.json` — Dedicated test TypeScript config.

---

## Documentation

- `tests/fixtures/sdk-compiled-consumer/README.md` — SDK distribution fixture overview.

---

## Notable Clusters

### `tests/sdk/runtime/` (5 files, ~1,400 LOC)
Core orchestrator and execution-layer tests; includes tmux abstraction (15 describe blocks validating all public exports), graph frontier inference for ralph-loop/parallel patterns, executor env-var contract, version compatibility. **Critical for pi-rewrite: tmux.test.ts must be rewritten to mock/stub subprocess calls instead of relying on live system tmux binary.**

### `tests/sdk/providers/` (3 files, ~600 LOC)
Agent-specific signal flows: Copilot CLI path resolution + env normalization (3 describe blocks), Claude Code fs.watch marker detection for stop-hook (waitForIdle) and human-in-the-loop (watchHILMarker). **Critical for pi-rewrite: claude-wait-for-idle.test.ts and claude-watch-hil-marker.test.ts mock @anthropic-ai/claude-agent-sdk; these mocks must be replaced with pi-coding-agent SDK mocks.**

### `tests/sdk/components/` (17 files, ~4,500 LOC)
OpenTUI React component tests; no subprocess spawning; pure UI layer validation. **Safe for rewrite: no tmux/agent dependency.**

### `tests/commands/cli/chat/` (2 files, ~220 LOC)
Environment variable and launcher-script wiring for chat command; platform-shimmed bash/pwsh branches. **Must validate in pi-rewrite: buildTmuxEnv must be refactored to not assume tmux availability.**

### `tests/ci/` (7 files + _helpers, ~520 LOC)
CI guards: coverage patterns, asset bundling, onboarding preflight. **onboarding.test.ts spawns real binary and tests .mcp.json materialization; this test must be adapted to test pi-coding-agent asset paths instead of agent-specific provider configs.**

### `tests/fixtures/sdk-compiled-consumer/` (scripts/smoke.ts is test-driver, not test-file)
Smoke matrix spawns real orchestrator sessions under tmux; 6-step validation. **Critical for pi-rewrite: smoke.ts must be refactored to spawn workflows without tmux, or made conditional on tmux availability with graceful fallback.**

---

## Entry Points

- `tests/ci/onboarding.test.ts` — Gate: `RUN_CI_E2E=1`; entry point for preflight validation; uses `spawnSync(getBinaryPath(), ["chat", "-a", agent, "--preflight-only"])`.
- `tests/fixtures/sdk-compiled-consumer/scripts/smoke.ts` — Gate: no gate (runs manually or from CI); entry point for end-to-end fixture validation; spawns 6-step matrix including compiled binary and real tmux orchestrator sessions.
- `tests/ci/_helpers/binary.ts` — Builds host-platform binary via `spawnSync("bun", [buildScript])`.

---

## Process Spawning Summary

| File | Spawn Type | Subprocess | Agent/TMux Dependency | Notes |
|------|-----------|-----------|-------|-------|
| `tests/ci/onboarding.test.ts` | `spawnSync()` | Compiled `atomic` binary | Yes (agent CLI invocation) | Env: ATOMIC_SETTINGS_HOME, HOME, XDG_CACHE_HOME, LOCALAPPDATA sandbox isolation |
| `tests/fixtures/sdk-compiled-consumer/scripts/smoke.ts` | `spawnSync()` | `bun`, compiled `my-app`, `tmux` | Yes (real tmux orchestra) | 6-step matrix; kills spawned sessions via tmux CLI |
| `tests/ci/_helpers/binary.ts` | `spawnSync()` | `bun build.ts` | No | Build artifact creation; memoised |

**Zero spawn calls in core .test.ts files** — all test suites mock modules and fs operations instead of spawning agents. Only integration fixtures (`onboarding.test.ts`) and the smoke driver (`smoke.ts`) spawn subprocesses.

---

This report documents the existing test infrastructure as-is. The rewrite to pi-coding-agent will require:

1. **Refactoring tmux abstraction** (`tmux.test.ts`): Replace platform mocking with subprocess stubs; ensure test suite doesn't depend on system tmux binary.
2. **Replacing agent SDK mocks** (`claude-*.test.ts`, `copilot.test.ts`): Swap `@anthropic-ai/claude-agent-sdk` and `@github/copilot-sdk` mocks for pi-coding-agent SDK mocks.
3. **Adapting integration fixtures** (`onboarding.test.ts`, `smoke.ts`): Test pi-coding-agent asset bundling and dispatch; remove assumptions about agent-specific config files.
4. **Preserving component tests**: UI layer tests have zero agent/tmux dependency and can run unchanged.
