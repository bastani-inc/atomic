# Partition 4 of 12 — Findings

## Scope
`tests/` (52 files, 10,395 LOC)

## Files in Scope
<!-- Source: codebase-locator sub-agent -->
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

## How It Works
<!-- Source: codebase-analyzer sub-agent -->
### Files Analysed

1. `tests/sdk/runtime/tmux.test.ts` (664 LOC)
2. `tests/sdk/runtime/executor.test.ts` (176 LOC)
3. `tests/sdk/runtime/graph-inference.test.ts` (206 LOC)
4. `tests/sdk/runtime/cc-debounce.test.ts` (64 LOC)
5. `tests/sdk/runtime/version-compat.test.ts` (67 LOC)
6. `tests/sdk/providers/claude-wait-for-idle.test.ts` (349 LOC)
7. `tests/sdk/providers/claude-watch-hil-marker.test.ts` (167 LOC)
8. `tests/sdk/providers/copilot.test.ts` (210 LOC)
9. `tests/sdk/registry.test.ts` (227 LOC)
10. `tests/commands/cli/chat/chat-integration.test.ts` (313 LOC)
11. `tests/ci/onboarding.test.ts` (223 LOC)
12. `tests/ci/_helpers/binary.ts` (60 LOC)
13. `tests/ci/no-import-meta-dir-in-runtime.test.ts` (117 LOC)
14. `tests/fixtures/sdk-compiled-consumer/scripts/smoke.ts` (230 LOC)
15. `tests/fixtures/sdk-compiled-consumer/src/workflow.ts` (33 LOC)
16. `tests/sdk/primitives/inputs.test.ts` (63 LOC)
17. `tests/sdk/components/orchestrator-panel-store.test.ts` (343 LOC)
18. `tests/sdk/components/workflow-picker-panel.test.tsx` (1564 LOC, header only)

---

### Per-File Notes

#### `tests/sdk/runtime/tmux.test.ts`

- **Role:** Exhaustive unit/integration contract for the `atomic-sdk` tmux abstraction layer. Documents every public symbol that the rewrite must re-implement or replace.
- **Key symbols:**
  - `getMuxBinary` / `resetMuxBinaryCache` (lines 6–7, 78–151): Tests that binary resolution is cached, that Windows ignores bare `tmux` shims, and that `psmux` wins on Windows over `tmux`.
  - `isTmuxInstalled` / `isInsideTmux` (lines 8–9, 158–203): Tests `TMUX` and `PSMUX` env-var presence.
  - `tmuxRun` (lines 10, 209–238): Synchronous subprocess wrapper returning `{ok, stdout}` or `{ok:false, stderr}`.
  - `normalizeTmuxCapture` / `normalizeTmuxLines` (lines 12–13, 244–322): Pure string-normalisation functions for tmux pane output; tested for whitespace collapsing, CR stripping, trimming.
  - `parseSessionName` (lines 22, 328–375): Parses `atomic-chat-<agent>-<id>` and `atomic-wf-<agent>-<wfname>-<id>` session name patterns. Returns `{type, agent}` or `{}` for non-atomic names. Documents the three known agents: `claude`, `copilot`, `opencode`.
  - `parseSessionEnvValue` (lines 23, 381–406): Extracts a single env key from psmux multi-line `KEY=VALUE` output; guards against psmux config-file leakage lines.
  - `parseListSessionsOutput` (lines 11, 412–489): Parses `tmux list-sessions -F` output; filters psmux metadata rows, reconstructs `{name, type, agent, attached}` session records, resolves `agent` via `ATOMIC_AGENT` env fallback for `atomic-senv-*` sessions.
  - `buildKillSessionOnPaneExitHooks` (lines 20, 492–523): Produces `{event, command}` hook pairs (`pane-exited` + `after-kill-pane`); the `guardPaneExited` option controls psmux vs. tmux pane-guard syntax.
  - `attachSession` / `spawnMuxAttach` / `detachAndAttachAtomic` (lines 14–15, 18–19, 615–640): All throw `"No terminal multiplexer"` when binary absent.
  - `getPanePid` (line 24, 646–663): Returns `null` when binary absent.
  - `SOCKET_NAME` (line 17): Constant tested in `isInsideAtomicSocket` (lines 16, 543–581).
- **Control flow:** Tests use `withEnvRestore()` helper (lines 34–47) to save/restore env vars, `withMockPlatform()` (lines 57–71) to temporarily override `process.platform`, and `writeFakeCommand()` (lines 49–55) to place stub executables in temp dirs. Tests marked `.serial` manipulate `process.env.PATH` and require isolated execution.
- **Data flow:** `parseListSessionsOutput` receives raw `tmux list-sessions` stdout and a `(name, key) => string|null` env-reader callback; the delimiter is `__ATOMIC_SESSION_FIELD__`. Session records flow through `parseSessionName` first; `atomic-senv-*` sessions fall back to the env-reader callback with key `ATOMIC_AGENT`.
- **Dependencies:** `packages/atomic-sdk/src/runtime/tmux.ts` (sole production import).

---

#### `tests/sdk/runtime/executor.test.ts`

- **Role:** Contracts for the orchestrator executor: `WorkflowRunOptions` shape, `validateOrchestratorEnv()` required env-var set, and `runOrchestrator()` signature.
- **Key symbols:**
  - `WorkflowRunOptions` (line 2, lines 14–35): Type tested via `satisfies` — must carry `definition` (compiled `WorkflowDefinition`), `agent`, `inputs`; must NOT carry legacy `entrypointFile`, `workflowKey`.
  - `runOrchestrator` (lines 3, 138–155): Accepts `WorkflowDefinition` directly (not a file path); function type is `(d: WorkflowDefinition, inputs?: Record<string, string>) => Promise<void>`.
  - `validateOrchestratorEnv` (line 6, lines 46–131): Imported from `executor-env.ts` (not `executor.ts`) to avoid mock interference. Requires `ATOMIC_WF_ID`, `ATOMIC_WF_TMUX`, `ATOMIC_WF_AGENT`, `ATOMIC_WF_CWD`. Valid agents: not `not-an-agent`, not `gpt` — throws `/Invalid ATOMIC_WF_AGENT/` with the bad value in message.
  - Source-file assertion (lines 162–175): Reads `executor.ts` text at test time and asserts presence of `"orchestrator-entry.ts"` and absence of `ATOMIC_ORCHESTRATOR_MODE`, `ATOMIC_WF_KEY`, `ATOMIC_WF_INPUTS`, `ATOMIC_WF_FILE`.
- **Control flow:** Tests save/restore env via manual `savedEnv` map pattern (lines 49–68). Each individual `REQUIRED_VARS` key is tested in isolation.
- **Data flow:** `defineWorkflow(...).for("claude").run(async () => {}).compile()` produces a `WorkflowDefinition` with `definition.source === import.meta.path` (set at compile time).
- **Dependencies:** `packages/atomic-sdk/src/runtime/executor.ts`, `packages/atomic-sdk/src/runtime/executor-env.ts`, `packages/atomic-sdk/src/types.ts`, `packages/atomic-sdk/src/define-workflow.ts`.

---

#### `tests/sdk/runtime/graph-inference.test.ts`

- **Role:** Complete behavioral specification for `GraphFrontierTracker` — the DAG edge-inference engine that converts the temporal sequence of `onSpawn()` / `onSettle(name)` calls into `dependsOn` parent arrays for the orchestrator panel graph.
- **Key symbols:**
  - `GraphFrontierTracker` (line 2): Constructor takes `scopeParent: string`. Two methods: `onSpawn() => string[]` (returns parent list for the next spawning stage), `onSettle(name: string) => void` (marks a stage as completed).
  - Named test scenarios: sequential chain (lines 10–23), parallel fan-out (lines 26–37), fan-in (lines 39–53), `hello-parallel` (lines 56–71), ralph loop (lines 73–92), conditional skip (lines 94–105), failed stage (lines 107–117), non-stage awaits (lines 119–130), nested scopes (lines 132–147), diamond pattern (lines 149–170), three-way parallel fan-out (lines 172–188), fire-and-forget (lines 190–204).
- **Control flow:** Fan-out pattern: when multiple `onSpawn()` calls happen before any `onSettle()`, the second and subsequent calls return the same parent list as the first (using `parallelAncestors` internally). Fan-in: after all parallel siblings settle, the next `onSpawn()` returns all settled names as parents.
- **Data flow:** Parent arrays accumulate through the tracker state machine. Each `onSpawn()` consumes the current frontier and returns parents. `onSettle()` adds a name to settled set / clears frontier appropriately.
- **Dependencies:** `packages/atomic-sdk/src/runtime/graph-inference.ts`.

---

#### `tests/sdk/runtime/cc-debounce.test.ts`

- **Role:** Pure-function spec for `shouldForward` — the Claude Code keypress debounce guard.
- **Key symbols:**
  - `shouldForward(now: number, last: number, quietMs?: number) => boolean` (line 2): Returns `true` only if `now - last > QUIET_MS` (strict greater-than, tested at boundary line 14).
  - `QUIET_MS` (line 2): The default quiet window constant, used directly in boundary tests.
- **Control flow:** Tests exercise: first press (`last=0`, lines 6–8), inside window (lines 10–12), at boundary (lines 14–16), one ms past (lines 18–20), custom window (lines 22–24), sustained spam (lines 26–43), burst-then-quiet (lines 45–62). The spam simulation walks `last` forward each iteration whether or not the press was forwarded, matching the caller's contract of always writing the timestamp.
- **Dependencies:** `packages/atomic-sdk/src/runtime/cc-debounce.ts`.

---

#### `tests/sdk/runtime/version-compat.test.ts`

- **Role:** Spec for `compareVersions` and `satisfiesMinVersion`.
- **Key symbols:**
  - `compareVersions(a: string, b: string) => number` (line 5): SemVer three-part comparison; prerelease ranks below equivalent stable (line 30); lexicographic prerelease strings (line 34); unparseable input returns 0 ("graceful fallback", line 39).
  - `satisfiesMinVersion(current: string, required: string|null|undefined) => boolean` (line 5): `null`/`undefined` always satisfies (line 50); satisfies when `current >= required` (line 55); does not satisfy when `current < required` (line 60). Note: `1.0.0-0` does NOT satisfy `1.0.0` (prerelease < stable, line 63).
- **Dependencies:** `packages/atomic-sdk/src/runtime/version-compat.ts`.

---

#### `tests/sdk/providers/claude-wait-for-idle.test.ts`

- **Role:** Integration tests for `waitForIdle` — the marker-file watcher that detects Claude Code's Stop hook firing.
- **Key symbols:**
  - `waitForIdle(claudeSessionId: string, transcriptBeforeCount: number) => Promise<SessionMessage[]>` (lines 50–52): Watches `~/.atomic/claude-stop/<sessionId>` via `fs.watch`; on marker appearance reads the session transcript via mocked `getSessionMessages`; returns the slice of messages starting at `transcriptBeforeCount`.
  - `markerDir() => string` / `markerPath(sessionId: string) => string` (lines 50–52): Path helpers exported for test use.
  - Module-level `mock.module("@anthropic-ai/claude-agent-sdk")` (lines 31–45): Spreads actual module exports and overrides `getSessionMessages` to pop from `sessionMessageQueue` array. Must be declared before the module under test is imported.
- **Control flow:** Four test scenarios:
  1. Normal flow (lines 109–169): `waitForIdle` races `fs.watch` vs. pre-existing marker; marker written 80ms after start; returns 2 new messages at indices 2 and 3.
  2. No new messages (lines 175–209): baseline equals transcript length; returns empty slice; last assistant must have `stop_reason: "end_turn"` (not `"tool_use"`) or the `_isMidAgentLoop` guard would continue watching.
  3. Async-flush race (lines 218–283): First transcript read shows mid-loop `stop_reason: "tool_use"`; subsequent reads show the flushed final message. `waitForIdle` polls until `stop_reason !== "tool_use"`. 20 finalMessages queued as retries; only one marker written.
  4. Race with pre-existing marker (lines 289–317): Marker written before `waitForIdle` call; no `fs.watch` event fires; must resolve immediately from existsSync.
- **Data flow:** `sessionMessageQueue` (line 30) is a shared `SessionMessage[][]`; each test pushes full transcript arrays; mocked `getSessionMessages` pops from front. `writeMarker` writes an empty file to `markerPath(sessionId)` triggering `fs.watch` event.
- **Dependencies:** `packages/atomic-sdk/src/providers/claude.ts`, `@anthropic-ai/claude-agent-sdk` (mocked).

---

#### `tests/sdk/providers/claude-watch-hil-marker.test.ts`

- **Role:** Tests for `watchHILMarker` — the Human-In-the-Loop detection watcher driven by Claude Code's `PreToolUse`/`PostToolUse` hooks on `AskUserQuestion`.
- **Key symbols:**
  - `watchHILMarker(sessionId: string, onHIL: (waiting: boolean) => void, signal: AbortSignal) => Promise<void>` (line 18): Watches `~/.atomic/claude-hil/<sessionId>`; calls `onHIL(true)` on file create, `onHIL(false)` on unlink; accepts AbortController signal for cleanup.
  - `claudeHookDirs().hil` (line 19): Resolves `~/.atomic/claude-hil/` directory.
- **Control flow:** Five tests:
  1. Create then unlink (lines 56–82): Sequential write + unlink; verifies `calls === [true, false]`.
  2. Pre-existing marker on attach (lines 84–101): Marker on disk when `watchHILMarker` is called; immediately fires `onHIL(true)` synchronously or on first poll.
  3. Ignores other session ids (lines 103–123): Write marker for different UUID; own `calls` array stays empty.
  4. Clean abort (lines 125–139): Abort before any events; promise resolves to `undefined`, no calls.
  5. Deduplication guard (lines 141–165): Writing marker twice; `wasHIL` guard suppresses the redundant callback; only one `true` emitted.
- **Dependencies:** `packages/atomic-sdk/src/providers/claude.ts`, `packages/atomic-sdk/src/providers/claude-stop-hook.ts`.

---

#### `tests/sdk/providers/copilot.test.ts`

- **Role:** Unit tests for Copilot CLI path resolution and subprocess env construction.
- **Key symbols:**
  - `CommandPathResolver` type (line 29): `(cmd: string) => string | null` injected to mock `Bun.which`.
  - `resolveCopilotCliPath(resolver: CommandPathResolver) => string | undefined` (line 19): Checks `COPILOT_CLI_PATH` env first; falls through to resolver; empty string falls through (line 92).
  - `copilotSubprocessEnv(base: NodeJS.ProcessEnv) => Record<string, string>` (line 19): Returns fresh object with `NODE_NO_WARNINGS=1` always set (overrides caller-supplied value); normalizes `LANG`/`LC_ALL`/`LC_CTYPE` to `en_US.UTF-8`.
  - `copilotSdkLaunchOptions(resolver) => {env, cliPath?}` (line 20): Combines the above; `cliPath` present only when resolved (line 207: `Object.prototype.hasOwnProperty.call(opts, "cliPath")`).
- **Control flow:** Env save/restore in `beforeEach`/`afterEach` blocks (lines 48–60, 164–171). Each group owns its `mockGetCommandPath` var.
- **Dependencies:** `packages/atomic-sdk/src/providers/copilot.ts`.

---

#### `tests/sdk/registry.test.ts`

- **Role:** Comprehensive spec for `createRegistry()` — the immutable chainable workflow registry.
- **Key symbols:**
  - `createRegistry() => Registry` (line 6): Factory, returns empty registry with `list()`, `has()`, `get()`, `register()`, `resolve()`.
  - `.register(wf) => Registry` (lines 37–71): Returns NEW instance; original unchanged (immutability, lines 43–49). Key is `${agent}/${name}`. Throws on duplicate: `'[atomic] Duplicate workflow registration: "claude/alpha" is already registered.'` (line 67).
  - `.get(key)` (lines 75–89): Throws `'[atomic] Workflow "claude/missing" is not registered.'` for unknown key.
  - `.list()` (lines 109–127): Insertion-ordered; returned array is frozen (`Object.isFrozen`, line 122).
  - `.resolve(name, agent)` (lines 130–143): Returns `undefined` for unknown pair (not throw).
  - Provider validator (lines 147–206): Called synchronously during `.register()`; emits `console.warn` with `[registry]` prefix when Copilot workflow source contains banned patterns (`new CopilotClient()`, `client.createSession()`). The `.toString()` of `wf.run` is inspected at registration time; tests patch `toString` to inject banned patterns since Bun strips function source comments.
- **Control flow:** Fixtures `wfA` (`claude/alpha`), `wfB` (`opencode/beta`), `wfC` (`copilot/gamma`) defined at module level (lines 15–17).
- **Dependencies:** `packages/atomic-sdk/src/registry.ts`, `packages/atomic-sdk/src/define-workflow.ts`, `packages/atomic-sdk/src/types.ts`.

---

#### `tests/commands/cli/chat/chat-integration.test.ts`

- **Role:** Integration-level tests for the chat command's env wiring — three distinct env builders and path resolution for each agent.
- **Key symbols:**
  - `resolveChatCommand(agent: string, resolver: CommandPathResolver) => string | undefined` (line 26): Copilot branch checks `COPILOT_CLI_PATH` first; other agents delegate to resolver only.
  - `buildLauncherEnv(envVars: Record<string,string>, base: NodeJS.ProcessEnv) => Record<string,string>` (line 26): Produces the minimal env set for the launcher bash/pwsh script. Includes only `TERMINAL_ENV_KEYS` + explicit `envVars`. Explicitly EXCLUDES secrets (`GH_TOKEN`, `COPILOT_GITHUB_TOKEN`, `ANTHROPIC_API_KEY`). Normalizes `LANG`/`LC_ALL`/`LC_CTYPE` to `en_US.UTF-8`, `TERM` to `xterm-256color`, `COLORTERM` to `truecolor`. Does NOT leak `HOME` or `PATH` from baseEnv.
  - `buildSpawnEnv(envVars, base) => Record<string,string>` (line 26): Full baseEnv inheritance including secrets (intentional — process already has access). Applies normalized terminal keys. `buildSpawnEnv` is symmetric with `buildTmuxEnv` for non-stripped keys (line 305).
  - `buildTmuxEnv(envVars, base) => Record<string,string>` (line 26): Full baseEnv inheritance (forwards user shell env for daemon-snapshot override). Strips `TMUX`, `TMUX_PANE`, `TMUX_TMPDIR`, `PSMUX`, `PSMUX_PANE`, `WINDOWID` (prevent nested tmux re-use, line 253). Normalizes terminal keys. Explicit `envVars` override base values.
  - `TERMINAL_ENV_KEYS` (line 27): Exported constant; tested for presence in all three builders.
- **Data flow:** `base` is `process.env` snapshot; `envVars` are Atomic-injected values (e.g., `ATOMIC_AGENT`, `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`).
- **Dependencies:** `packages/atomic/src/commands/cli/chat/index.ts`, `packages/atomic-sdk/src/providers/copilot.ts` (type import only).

---

#### `tests/ci/onboarding.test.ts`

- **Role:** E2E compiled-binary preflight test. Guards against `onboarding_files` omissions and embedded-asset resolver drift across platforms.
- **Key symbols:**
  - `isE2EEnabled`: `process.env.RUN_CI_E2E === "1"` gate (line 44); suite skips when unset.
  - `createSandbox(label)` (lines 71–77): Creates two temp dirs — `projectRoot` (project-scoped files) and `settingsHome` (global files + cache). Pushed into `sandboxes` array for cleanup.
  - `runPreflight(agent, sandbox)` (lines 103–126): `spawnSync(getBinaryPath(), ["chat", "-a", agent, "--preflight-only"], {cwd: sandbox.projectRoot, env: {...process.env, ATOMIC_SETTINGS_HOME: ..., HOME: ..., XDG_CACHE_HOME: ..., LOCALAPPDATA: ...}})`. 120s timeout.
  - `resolveSandboxPath(destination, sandbox)` (lines 133–139): Mirrors `resolveDestination` in `onboarding.ts`; redirects `~/` to `settingsHome`.
  - `EXPECTED` (lines 159–172): Hand-written invariants per agent: `claude` → `.mcp.json` (with `mcpServers`), `.claude/settings.json`, `~/.claude/settings.json`; `copilot` → `.mcp.json` (with `mcpServers`); `opencode` → `.opencode/opencode.json`. The copilot entry is a "regression guard for the mcp-setup bug" (comment line 167).
- **Control flow:** `describe.skipIf(!isE2EEnabled)` wraps all tests (line 176). Inner `for` loop over `EXPECTED` entries creates one test per agent. `afterAll` cleans up with 120s hook timeout to handle Windows file-lock delays.
- **Dependencies:** `tests/ci/_helpers/binary.ts`, `packages/atomic/script/targets.ts`.

---

#### `tests/ci/_helpers/binary.ts`

- **Role:** Shared binary build helper for CI integration tests.
- **Key symbols:**
  - `getBinaryPath() => string` (lines 21–28): Calls `hostTarget()` to get e.g. `linux-x64`; looks up in `TARGETS` array; returns `packages/atomic/dist/<target>/bin/atomic[.exe]`.
  - `ensureBinary()` (lines 39–59): Memoized via `binaryReady` flag. If binary absent, runs `bun packages/atomic/script/build.ts` with 600s timeout via `spawnSync`.
- **Dependencies:** `packages/atomic/script/targets.ts` (for `TARGETS`, `hostTarget`).

---

#### `tests/ci/no-import-meta-dir-in-runtime.test.ts`

- **Role:** G1 validation gate. Prevents path-arithmetic on `import.meta.dir` in runtime source, which breaks inside `bun build --compile` bunfs binaries.
- **Key symbols:**
  - `FORBIDDEN_PATTERNS` (lines 33–39): Five regexes for `join(import.meta.dir,…)`, `resolve(import.meta.dir,…)`, `import.meta.dir +`, `${import.meta.dir}`, `findRepoRoot`.
  - `ALLOWLISTED_FILES` (lines 41–44): `packages/atomic/src/lib/workspace-paths.ts`, `packages/atomic-sdk/src/lib/workspace-paths.ts`.
  - `isAllowlisted()` (lines 47–53): Allows `packages/atomic/script/**`, `packages/atomic-sdk/script/**`, allowlist files, and `*.test.ts`/`*.test.tsx`.
  - `collectViolations()` (lines 57–92): Globs `packages/atomic/src/**/*.ts(x)` and `packages/atomic-sdk/src/**/*.ts(x)`; skips comment lines; reports violations with `{file, line, matched}`.
- **Control flow:** Single test (line 94) collects violations; if any, builds a multi-line error message listing each `file:line: "matched"`. Skips comment lines starting with `//`, `*`, `/*`.

---

#### `tests/fixtures/sdk-compiled-consumer/scripts/smoke.ts`

- **Role:** Six-step end-to-end smoke matrix for SDK distribution scenarios: host-bun mode vs. compiled-binary mode.
- **Key symbols:**
  - Steps 1–6: `bun install` → host-bun run → `bun build --compile` → compiled run → `NoDispatcherError` path → host-bun re-run.
  - Step 2 assertion (line 131): `stdout.includes("workflow:launched")` and `stderr.includes("kind=host-bun")`.
  - Step 4 assertion (line 170): Same `workflow:launched` check and `kind=override-binary` debug line — confirms the SDK auto-defaults `pathToAtomicExecutable` to `process.execPath` for compiled binaries.
  - Step 5 (lines 181–202): `ATOMIC_DISABLE_DEFAULT_EXEC=1` disables `process.execPath` default; expects non-zero exit and `"NoDispatcherError"` in stderr.
  - `killSpawnedSessions()` (lines 97–108): Runs `tmux -L atomic ls -F #{session_name}` and kills any `atomic-wf-` sessions containing `fixture-greet`.
  - `skipSteps` (lines 54–59): CLI-parseable `--skip-steps 4,5` flag for CI environments without tmux.
- **Control flow:** Linear script; each step guarded by `if (!skipSteps.has(N))`. Cleanup removes compiled binary at end (lines 225–227).
- **Dependencies:** Node.js `child_process.spawnSync`, `tmux` binary on PATH.

---

#### `tests/fixtures/sdk-compiled-consumer/src/workflow.ts`

- **Role:** Minimal smoke fixture workflow definition, demonstrating the canonical `defineWorkflow` API.
- **Key symbols:**
  - `greetWorkflow` (line 11): `defineWorkflow({name: "fixture-greet", inputs: [{name: "who", type: "string", default: "fixture"}]}).for("claude").run(async (ctx) => { await ctx.stage({name: "greet"}, {}, {}, async (s) => { await s.session.query(...); s.save(s.sessionId); }); }).compile()`.
- **Data flow:** `ctx.inputs.who` threaded into the query string. `s.save(s.sessionId)` captures session id for downstream retrieval.
- **Dependencies:** `@bastani/atomic-sdk/workflows` (npm package alias for the SDK).

---

#### `tests/sdk/primitives/inputs.test.ts`

- **Role:** Tests for `validateInputs` — input schema validation and default application.
- **Key symbols:**
  - `validateInputs(wf: WorkflowDefinition, inputs: Record<string,string>) => Record<string,string>` (line 3): Applies defaults, throws on missing required, throws on unknown keys, throws on invalid enum/integer values. Returns all values as strings.
  - Fixture workflow (lines 5–21): `topic` (required string), `mode` (required enum `["fast","thorough"]`, default `"fast"`), `limit` (integer, default `10`).
  - Free-form pass-through (lines 53–60): Workflows without `inputs` declaration pass all inputs through as-is.
- **Dependencies:** `packages/atomic-sdk/src/primitives/inputs.ts`, `packages/atomic-sdk/src/define-workflow.ts`.

---

#### `tests/sdk/components/orchestrator-panel-store.test.ts`

- **Role:** Behavioral contract for `PanelStore` — the orchestrator panel's reactive state container.
- **Key symbols:**
  - `PanelStore` (line 2): Class with `version`, `workflowName`, `agent`, `prompt`, `sessions`, `completionInfo`, `fatalError`, `completionReached`, `exitResolve` properties.
  - `subscribe(listener) => unsub` (lines 23–48): Observer pattern; `emit` increments `version` and calls all listeners. `unsub` removes listener.
  - `setWorkflowInfo(name, agent, sessions, prompt)` (lines 50–85): Creates orchestrator session as first entry with `status: "running"`, `parents: []`, `startedAt: Date.now()`; adds remaining sessions with `status: "pending"`, default parent `"orchestrator"` unless explicit parents provided.
- **Control flow:** 11 describe blocks covering full session lifecycle from initialization through completion/fatal-error states.
- **Dependencies:** `packages/atomic-sdk/src/components/orchestrator-panel-store.ts`.

---

#### `tests/sdk/components/workflow-picker-panel.test.tsx`

- **Role:** 1564-line component test for `WorkflowPickerPanel` — the TUI workflow selection and input form UI.
- **Key symbols (from header):**
  - `WorkflowPicker`, `WorkflowPickerPanel`, `buildEntries`, `buildPickerTheme`, `buildPickerRows`, `buildRows`, `fuzzyMatch`, `isFieldValid` (lines 8–17): All exported symbols tested.
  - `createTestRenderer` from `@opentui/core/testing` (line 4).
  - `flushPendingInput(setup)` (lines 39–45): Calls `stdinParser.flushTimeout(+Infinity)` and `drainStdinParser()` on the renderer to force-flush pending escape-sequence disambiguation.
  - `press(setup, action)` (lines 47–57): Wraps input and render in React `act()`, calls `flushPendingInput`, then `setup.renderOnce()`.
- **Dependencies:** `packages/atomic-sdk/src/components/workflow-picker-panel.tsx`, `@opentui/core`, `@opentui/core/testing`, `packages/atomic-sdk/src/registry.ts`.

---

### Cross-Cutting Synthesis

The `tests/` partition (52 files, ~10k LOC) operates as a three-layered specification for the system being rewritten onto `pi-coding-agent`:

**Layer 1 — Pure-function contracts (no I/O):** `graph-inference.test.ts`, `cc-debounce.test.ts`, `version-compat.test.ts`, `inputs.test.ts`, portions of `tmux.test.ts` (pure string normalizers, session-name parsers). These document data transformations that are agent-agnostic and will survive the rewrite unchanged in structure.

**Layer 2 — SDK provider contracts (agent-specific, heavily coupled to external CLIs):** `claude-wait-for-idle.test.ts`, `claude-watch-hil-marker.test.ts`, `copilot.test.ts`. The marker-file mechanism (`~/.atomic/claude-stop/<sessionId>`, `~/.atomic/claude-hil/<sessionId>`) is Claude-specific: driven by Stop/PreToolUse/PostToolUse hooks in `claude-stop-hook.ts`. The `@anthropic-ai/claude-agent-sdk` import is mocked at module level to control `getSessionMessages`. The Copilot provider exposes `NODE_NO_WARNINGS=1` subprocess env and `COPILOT_CLI_PATH` override path — both Copilot-specific. These are the primary components to be removed or replaced in the pi-coding-agent rewrite.

**Layer 3 — System integration contracts (binary, tmux, env wiring):** `executor.test.ts` documents the env-var protocol for the orchestrator subprocess (`ATOMIC_WF_ID`, `ATOMIC_WF_TMUX`, `ATOMIC_WF_AGENT`, `ATOMIC_WF_CWD`); `tmux.test.ts` documents all tmux/psmux abstraction including the `atomic-chat-<agent>-<id>` / `atomic-wf-<agent>-<wfname>-<id>` session name convention; `chat-integration.test.ts` documents three distinct env builders with different security profiles (launcher: secrets-stripped; spawn/tmux: full shell env). The `onboarding.test.ts` documents per-agent `onboarding_files` expectations including the `.mcp.json`/`mcpServers` shape. The smoke matrix in `fixtures/sdk-compiled-consumer/scripts/smoke.ts` documents the two SDK distribution modes (host-bun / compiled-binary self-dispatch) and the `NoDispatcherError` failure path.

**Key invariants relevant to the pi-coding-agent rewrite:**
- The `ATOMIC_WF_AGENT` environment variable must be one of the valid agent identifiers; the tests assert `validateOrchestratorEnv` throws for unknown values.
- Session naming convention `atomic-{chat|wf}-<agent>-...` is deeply embedded and parsed by `parseSessionName`.
- The tmux socket name `SOCKET_NAME` is the shared coordination point for `isInsideAtomicSocket`.
- `GraphFrontierTracker` is entirely agent-agnostic and will not need to change.
- The CI gate `no-import-meta-dir-in-runtime.test.ts` enforces a hard compile-time constraint that any new runtime files must respect.

---

### Out-of-Partition References

- `packages/atomic-sdk/src/runtime/tmux.ts` — production implementation for all tmux symbols.
- `packages/atomic-sdk/src/runtime/executor.ts` — orchestrator launcher; must contain `"orchestrator-entry.ts"`.
- `packages/atomic-sdk/src/runtime/executor-env.ts` — `validateOrchestratorEnv` implementation.
- `packages/atomic-sdk/src/runtime/graph-inference.ts` — `GraphFrontierTracker` implementation.
- `packages/atomic-sdk/src/runtime/cc-debounce.ts` — `shouldForward` and `QUIET_MS`.
- `packages/atomic-sdk/src/runtime/version-compat.ts` — `compareVersions`, `satisfiesMinVersion`.
- `packages/atomic-sdk/src/providers/claude.ts` — `waitForIdle`, `watchHILMarker`, `markerDir`, `markerPath`.
- `packages/atomic-sdk/src/providers/claude-stop-hook.ts` — `claudeHookDirs()`.
- `packages/atomic-sdk/src/providers/copilot.ts` — `resolveCopilotCliPath`, `copilotSubprocessEnv`, `copilotSdkLaunchOptions`, `CommandPathResolver`.
- `packages/atomic-sdk/src/registry.ts` — `createRegistry`.
- `packages/atomic-sdk/src/components/orchestrator-panel-store.ts` — `PanelStore`.
- `packages/atomic-sdk/src/components/workflow-picker-panel.tsx` — `WorkflowPickerPanel` and all exported helpers.
- `packages/atomic-sdk/src/define-workflow.ts` — `defineWorkflow`.
- `packages/atomic-sdk/src/primitives/inputs.ts` — `validateInputs`.
- `packages/atomic-sdk/src/runtime/theme.ts` — `resolveTheme` (used in picker tests).
- `packages/atomic/src/commands/cli/chat/index.ts` — `resolveChatCommand`, `buildLauncherEnv`, `buildSpawnEnv`, `buildTmuxEnv`, `TERMINAL_ENV_KEYS`.
- `packages/atomic/src/commands/cli/init/onboarding.ts` — `resolveDestination`, `AGENT_CONFIG`, `applyManagedOnboardingFiles`.
- `packages/atomic/script/targets.ts` — `TARGETS`, `hostTarget`.
- `packages/atomic/script/build.ts` — binary build entry invoked by `ensureBinary`.
- `@anthropic-ai/claude-agent-sdk` — `getSessionMessages`, `SessionMessage` type (mocked in claude provider tests).

## Patterns
<!-- Source: codebase-pattern-finder sub-agent -->
# Testing Infrastructure Patterns — Atomic CLI Test Suite

**Scope**: `tests/` (52 files, 10,395 LOC)  
**Focus**: Test organization, spawning real processes (tmux, agents, binaries), env isolation, SDK integration, unit vs integration patterns

---

## Pattern 1: Environment Isolation via Save/Restore with beforeEach/afterEach

**Where**: `tests/sdk/runtime/tmux.test.ts:34-46`  
**What**: Shared test helper that saves/restores critical environment variables across test suites to prevent test pollution.

```typescript
function withEnvRestore(vars: string[]) {
  const saved: Record<string, string | undefined> = {};
  for (const v of vars) saved[v] = process.env[v];

  afterEach(() => {
    for (const v of vars) {
      if (saved[v] !== undefined) {
        process.env[v] = saved[v];
      } else {
        delete process.env[v];
      }
    }
  });
}

describe("isInsideTmux", () => {
  withEnvRestore(["TMUX", "PSMUX"]);

  test("returns true when TMUX env var is set", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    delete process.env.PSMUX;
    expect(isInsideTmux()).toBe(true);
  });
});
```

**Variations / call-sites**:
- `tests/services/config/settings.test.ts:19-34` — Environment isolation with `ATOMIC_SETTINGS_HOME`
- `tests/services/config/scm-sync.test.ts:20-35` — Temp directory + env var restore pattern
- `tests/commands/cli/chat/chat-integration.test.ts:35-49` — Full process.env save/restore via `saveEnv()` / `restoreEnv()`

---

## Pattern 2: Temporary Directory Sandboxing for File System Tests

**Where**: `tests/services/config/settings.test.ts:21-34`  
**What**: Uses `mkdtemp()` to create isolated temp dirs, restores env vars after cleanup, prevents filesystem pollution.

```typescript
let tmpDir: string;
let previousSettingsHome: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "settings-test-"));
  previousSettingsHome = process.env.ATOMIC_SETTINGS_HOME;
  process.env.ATOMIC_SETTINGS_HOME = tmpDir;
});

afterEach(async () => {
  if (previousSettingsHome === undefined) {
    delete process.env.ATOMIC_SETTINGS_HOME;
  } else {
    process.env.ATOMIC_SETTINGS_HOME = previousSettingsHome;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

function settingsPath(): string {
  return join(tmpDir, ".atomic", "settings.json");
}
```

**Variations / call-sites**:
- `tests/services/config/scm-sync.test.ts:21-26` — Creates multiple temp directories per test
- `tests/ci/onboarding.test.ts:71-77` — Multi-sandbox pattern with project + settings homes
- `tests/ci/onboarding.test.ts:61-69` — Generous cleanup timeout (120s) for heavy fixtures

---

## Pattern 3: Spawning External Binaries with spawnSync for E2E Tests

**Where**: `tests/ci/onboarding.test.ts:103-126`  
**What**: Spawns compiled `atomic` binary in isolated sandbox with full env injection to test preflight initialization and onboarding file generation.

```typescript
function runPreflight(agent: string, sandbox: Sandbox): PreflightResult {
  const result = spawnSync(
    getBinaryPath(),
    ["chat", "-a", agent, "--preflight-only"],
    {
      cwd: sandbox.projectRoot,
      env: {
        ...process.env,
        ATOMIC_SETTINGS_HOME: sandbox.settingsHome,
        HOME: sandbox.settingsHome,
        USERPROFILE: sandbox.settingsHome,
        XDG_CACHE_HOME: join(sandbox.settingsHome, ".cache"),
        LOCALAPPDATA: join(sandbox.settingsHome, "AppData", "Local"),
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    },
  );
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}
```

**Variations / call-sites**:
- `tests/ci/_helpers/binary.ts:39-59` — Build binary on demand via `ensureBinary()` + memoization
- `tests/ci/_helpers/binary.ts:21-28` — Platform-aware binary path resolution (`.exe` on Windows)
- `tests/ci/onboarding.test.ts:44-45` — Gate test with `RUN_CI_E2E=1` environment variable
- `tests/ci/onboarding.test.ts:176-212` — Parameterized test loop over agents: `for (const [agent, expectedFiles] of Object.entries(EXPECTED))`

---

## Pattern 4: Platform Mocking via Object.defineProperty for Cross-Platform Tests

**Where**: `tests/commands/cli/chat/buildLauncherScript.test.ts:8-23`  
**What**: Patches `process.platform` dynamically to test bash and PowerShell launcher script generation without spawning separate processes.

```typescript
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

afterAll(() => {
  if (ORIGINAL_PLATFORM_DESCRIPTOR) {
    Object.defineProperty(process, "platform", ORIGINAL_PLATFORM_DESCRIPTOR);
  }
});

describe("buildLauncherScript – bash (posix)", () => {
  beforeEach(() => setPlatform("linux"));
  afterEach(() => setPlatform("linux"));

  test("returns ext=sh", () => {
    const { ext } = buildLauncherScript("/usr/bin/agent", [], "/home/user");
    expect(ext).toBe("sh");
  });
});

describe("buildLauncherScript – PowerShell (win32)", () => {
  beforeEach(() => setPlatform("win32"));
  afterEach(() => setPlatform("linux"));
  // PowerShell-specific tests...
});
```

**Variations / call-sites**:
- `tests/sdk/runtime/tmux.test.ts:57-71` — `withMockPlatform()` helper for scoped platform mocking
- `tests/sdk/runtime/tmux.test.ts:113-151` — Fake command creation with `writeFakeCommand()` to simulate PATH resolution

---

## Pattern 5: Memoized Binary Build with Shared Helper

**Where**: `tests/ci/_helpers/binary.ts:30-59`  
**What**: Centralized binary resolution + on-demand build to avoid multiple compilation calls across test suites; holds on exit until cleanup.

```typescript
let binaryReady = false;

export function ensureBinary(): void {
  if (binaryReady) return;

  const binaryPath = getBinaryPath();
  if (existsSync(binaryPath)) {
    binaryReady = true;
    return;
  }

  const buildScript = join(REPO_ROOT, "packages", "atomic", "script", "build.ts");
  const result = spawnSync("bun", [buildScript], {
    stdio: "inherit",
    cwd: REPO_ROOT,
    timeout: 600_000,
  });

  if (result.status !== 0) {
    throw new Error(`build.ts exited with status ${result.status ?? "null"}`);
  }
  binaryReady = true;
}

export function getBinaryPath(): string {
  const target = hostTarget();
  const meta = TARGETS.find((t) => t.name === target);
  if (!meta) {
    throw new Error(`Unknown host target "${target}". Update TARGETS.`);
  }
  return join(REPO_ROOT, "packages", "atomic", "dist", target, "bin", `atomic${meta.ext ?? ""}`);
}
```

**Variations / call-sites**:
- `tests/ci/onboarding.test.ts:40-41` — Invokes `ensureBinary()` at test start, reuses across parameterized loop

---

## Pattern 6: Environment Builders with Three Variants (Launcher/Spawn/Tmux)

**Where**: `tests/commands/cli/chat/chat-integration.test.ts:55-88, 130-217, 226-313`  
**What**: Three distinct env-building functions with different secret-handling and inheritance strategies:
- `buildLauncherEnv()` — minimal, excludes secrets, terminal keys only
- `buildSpawnEnv()` — full inheritance, includes secrets (intentional)
- `buildTmuxEnv()` — full inheritance, strips tmux context vars

```typescript
describe("buildLauncherEnv – launcher script safety", () => {
  test("excludes GH_TOKEN from inherited env", () => {
    const base: NodeJS.ProcessEnv = { GH_TOKEN: "ghp_secret", LANG: "en_US.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor" };
    const env = buildLauncherEnv({}, base);
    expect("GH_TOKEN" in env).toBe(false);
  });

  test("exports normalized LANG, LC_ALL, LC_CTYPE, TERM, COLORTERM", () => {
    const base: NodeJS.ProcessEnv = { LANG: "C", TERM: "dumb" };
    const env = buildLauncherEnv({}, base);
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["COLORTERM"]).toBe("truecolor");
  });
});

describe("buildTmuxEnv – tmux session env", () => {
  test("strips outer-tmux/psmux identifiers so the new pane doesn't reuse the caller's TMUX/TMUX_PANE", () => {
    const env = buildTmuxEnv({}, {
      TMUX: "/tmp/tmux-1000/default,123,0",
      TMUX_PANE: "%5",
      PSMUX: "/tmp/psmux/default,123,0",
    });
    expect("TMUX" in env).toBe(false);
    expect("PSMUX" in env).toBe(false);
  });
});
```

**Variations / call-sites**:
- `tests/commands/cli/chat/chat-integration.test.ts:305-312` — Symmetry test: `buildTmuxEnv` and `buildSpawnEnv` both expose full shell env

---

## Pattern 7: Pure Function Unit Tests with Deterministic Inputs

**Where**: `tests/sdk/runtime/tmux.test.ts:244-276`  
**What**: Focused pure-function tests for parsing/normalization; no env setup, highly readable test names.

```typescript
describe("normalizeTmuxCapture", () => {
  test("collapses whitespace to single spaces", () => {
    expect(normalizeTmuxCapture("hello   world")).toBe("hello world");
  });

  test("strips carriage returns", () => {
    expect(normalizeTmuxCapture("hello\r\nworld")).toBe("hello world");
  });

  test("collapses newlines to spaces", () => {
    expect(normalizeTmuxCapture("line1\nline2\nline3")).toBe("line1 line2 line3");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalizeTmuxCapture("  hello  ")).toBe("hello");
  });
});

describe("parseSessionName", () => {
  test("parses chat session with agent", () => {
    const result = parseSessionName("atomic-chat-claude-a1b2c3d4");
    expect(result).toEqual({ type: "chat", agent: "claude" });
  });

  test("parses workflow session with hyphenated workflow name", () => {
    const result = parseSessionName("atomic-wf-opencode-my-cool-workflow-a1b2c3d4");
    expect(result).toEqual({ type: "workflow", agent: "opencode" });
  });
});
```

**Variations / call-sites**:
- `tests/sdk/runtime/tmux.test.ts:328-375` — 14 parsing variants in a single describe block
- `tests/services/config/scm-sync.test.ts:55-82` — Pure function flags builder: `copilotScmDisableFlags()`

---

## Pattern 8: State Mutation Tests with Tracking via GraphFrontierTracker

**Where**: `tests/sdk/runtime/graph-inference.test.ts:4-92`  
**What**: Tests dag execution order via `onSpawn()` / `onSettle()` calls; verifies parallel fan-out, fan-in, and nested scope isolation.

```typescript
describe("GraphFrontierTracker", () => {
  test("sequential chain: each stage depends on the previous", () => {
    const t = new GraphFrontierTracker("orchestrator");

    // await ctx.stage("a")
    expect(t.onSpawn()).toEqual(["orchestrator"]);
    t.onSettle("a");

    // await ctx.stage("b")
    expect(t.onSpawn()).toEqual(["a"]);
    t.onSettle("b");

    // await ctx.stage("c")
    expect(t.onSpawn()).toEqual(["b"]);
    t.onSettle("c");
  });

  test("parallel fan-out: siblings share the same parent", () => {
    const t = new GraphFrontierTracker("orchestrator");

    // await ctx.stage("a")
    expect(t.onSpawn()).toEqual(["orchestrator"]);
    t.onSettle("a");

    // Promise.all([ctx.stage("b"), ctx.stage("c")])
    expect(t.onSpawn()).toEqual(["a"]); // b
    expect(t.onSpawn()).toEqual(["a"]); // c
  });

  test("ralph loop: sequential chain across iterations", () => {
    const t = new GraphFrontierTracker("orchestrator");

    // Iteration 1
    expect(t.onSpawn()).toEqual(["orchestrator"]); // planner-1
    t.onSettle("planner-1");
    expect(t.onSpawn()).toEqual(["planner-1"]); // orchestrator-1
    t.onSettle("orchestrator-1");
    // Iteration 2
    expect(t.onSpawn()).toEqual(["orchestrator-1"]); // planner-2
  });
});
```

**Variations / call-sites**:
- Tests ralph-loop (planner → orchestrator → reviewer cycles)
- Tests nested scopes with independent trackers
- Tests diamond patterns (sequential → parallel → fan-in)

---

## Pattern 9: Parameterized Agent Testing with describe.skipIf Gate

**Where**: `tests/ci/onboarding.test.ts:176-212`  
**What**: Loop over agent configurations with parameterized test names; skip entire suite if `RUN_CI_E2E !== "1"`.

```typescript
const isE2EEnabled = process.env.RUN_CI_E2E === "1";

const EXPECTED: Record<string, readonly ExpectedFile[]> = {
  claude: [
    { destination: ".mcp.json", hasTopLevelKey: "mcpServers" },
    { destination: ".claude/settings.json" },
    { destination: "~/.claude/settings.json" },
  ],
  copilot: [
    { destination: ".mcp.json", hasTopLevelKey: "mcpServers" },
  ],
  opencode: [{ destination: ".opencode/opencode.json" }],
} as const;

describe.skipIf(!isE2EEnabled)("onboarding preflight (compiled binary)", () => {
  for (const [agent, expectedFiles] of Object.entries(EXPECTED)) {
    test(
      `${agent}: preflight materialises every declared onboarding file`,
      async () => {
        ensureBinary();
        const sandbox = await createSandbox(agent);
        const result = runPreflight(agent, sandbox);
        expect(result.exitCode).toBe(0);
        for (const file of expectedFiles) {
          const path = resolveSandboxPath(file.destination, sandbox);
          expect(existsSync(path)).toBe(true);
        }
      },
      120_000, // 120s timeout for binary startup
    );
  }
});

test.skipIf(isE2EEnabled)(
  "onboarding preflight [skip when RUN_CI_E2E unset]",
  () => {
    expect(true).toBe(true);
  },
);
```

**Variations / call-sites**:
- `tests/ci/onboarding.test.ts:217-222` — Marker test for CI dashboards when E2E disabled

---

## Pattern 10: Async File I/O Tests with Helper Functions

**Where**: `tests/services/config/scm-sync.test.ts:37-49, 119-126`  
**What**: Async helpers to read/write JSON config files; tests use helpers to keep test code readable.

```typescript
async function writeAtomicConfig(
  projectRoot: string,
  config: Record<string, unknown>,
): Promise<void> {
  const dir = join(projectRoot, ".atomic");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "settings.json"), JSON.stringify(config));
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function writeClaudeSettings(
  projectRoot: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const dir = join(projectRoot, ".claude");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "settings.json"), JSON.stringify(settings));
}

describe("syncScmMcpServers — Claude settings", () => {
  test("adds azure-devops to disabledMcpjsonServers when scm is github", async () => {
    const projectRoot = join(tmpDir, "claude-gh");
    await mkdir(projectRoot, { recursive: true });
    await writeAtomicConfig(projectRoot, { scm: "github" });
    await writeClaudeSettings(projectRoot, {});

    await syncScmMcpServers(projectRoot);

    const settings = await readJsonFile(
      join(projectRoot, ".claude", "settings.json"),
    );
    expect(settings.disabledMcpjsonServers).toEqual(["azure-devops"]);
  });
});
```

**Variations / call-sites**:
- `tests/services/config/scm-sync.test.ts:276-284` — OpenCode variant of config writer
- `tests/services/config/settings.test.ts:36-49` — Per-test helper for settings path + read/write

---

## Pattern 11: SDK Host Consumer Fixture

**Where**: `tests/fixtures/sdk-host-consumer/index.ts`  
**What**: Standalone executable fixture that imports SDK directly; used to test that SDK exports work in host mode.

```typescript
#!/usr/bin/env bun
import { defineWorkflow, hostLocalWorkflows, type WorkflowDefinition } from "@bastani/atomic-sdk";

const wf = defineWorkflow({
  name: "demo-wf",
  description: "Demo workflow for SDK host integration test",
  inputs: [],
})
  .for("claude")
  .run(async (_ctx) => {
    // no-op run for fixture purposes
  })
  .compile() as unknown as WorkflowDefinition;

await hostLocalWorkflows([wf]);

// user main() continues here when not invoked under atomic
console.log("user main ran");
```

**Variations / call-sites**:
- `tests/fixtures/sdk-compiled-consumer/` — Compiled TypeScript consumer for build verification

---

## Pattern 12: YAML Workflow Validation Tests

**Where**: `tests/ci/publish-workflow-shape.test.ts:1-33`  
**What**: Validates GitHub Actions workflow structure via YAML parsing; checks for bare `npm publish` anti-patterns.

```typescript
import { test, expect } from "bun:test";
import { parse } from "yaml";
import { join } from "node:path";

const WORKFLOW_PATH = join(import.meta.dir, "../../.github/workflows/publish.yml");

test("publish workflow invokes per-package publish scripts", async () => {
  const wf = parse(await Bun.file(WORKFLOW_PATH).text());
  const steps = wf.jobs.publish.steps as Array<{ run?: string; uses?: string }>;
  const runs = steps.map(s => s.run ?? "").filter(Boolean);
  expect(runs.some(r => r.includes("bun packages/atomic/script/publish.ts"))).toBe(true);
  expect(runs.some(r => r.includes("bun packages/atomic-sdk/script/publish.ts"))).toBe(true);
});

test("no job runs bare 'npm publish' from the repo root", async () => {
  const wf = parse(await Bun.file(WORKFLOW_PATH).text());
  const offenders: string[] = [];
  for (const [jobName, job] of Object.entries(wf.jobs as Record<string, { steps?: Array<{ run?: string }> }>)) {
    for (const step of job.steps ?? []) {
      const cmd = step.run ?? "";
      const lines = cmd.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^npm\s+publish\b/.test(trimmed) && !/\bcd\s+/.test(line)) {
          offenders.push(`${jobName}: ${trimmed}`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});
```

**Variations / call-sites**:
- CI validation tests for asset bundle, MCP server config, import constraints

---

## Summary

The test suite demonstrates these key patterns:

1. **Environment Isolation**: Comprehensive save/restore of env vars + temp dir sandboxing prevents test pollution
2. **Process Spawning**: `spawnSync()` for external binaries with full env injection; binary memoization prevents rebuilds
3. **Platform Mocking**: Dynamic `process.platform` patching for cross-platform code testing without subprocess overhead
4. **Three Env Builders**: Distinct `buildLauncherEnv()` / `buildSpawnEnv()` / `buildTmuxEnv()` with different secret/inheritance strategies
5. **Pure Unit Tests**: Heavy use of pure functions (parsing, normalization, flags) with no setup required
6. **State Mutation via Callbacks**: `GraphFrontierTracker` tests verify DAG execution order with `onSpawn()` / `onSettle()` calls
7. **Parameterized E2E Tests**: Agent loop + gating via environment variable; generous 120s timeouts for binary startup
8. **Async File I/O**: Helper functions for JSON reads/writes keep test code DRY and readable
9. **SDK Fixtures**: Standalone consumer files verify SDK exports in host and compiled modes
10. **Workflow Validation**: YAML parsing + regex checks guard against CI/CD anti-patterns
11. **Integration vs Unit**: Clear separation — unit tests for parsing/logic are fast; E2E tests spawn real binaries (gated)

## External References
<!-- Source: codebase-online-researcher sub-agent -->
# Partition 4 — `tests/` External Library Research

## Decision: Research IS applicable

The test suite (52 files, ~10 k LOC) uses `bun:test` APIs that have important
behavioural nuances not obvious from the import names alone, especially:

- `mock.module()` timing/hoisting semantics (critical for the claude-agent-sdk mock pattern)
- `spyOn` + `mockImplementation` chain used in registry tests
- AI-agent quieter-output env vars (`CLAUDECODE`, `REPL_ID`, `AGENT`) referenced in CLAUDE.md and in the project's test-script commentary
- `mock()` function for stub objects (renderer-background, tui-diagnostics)

Snapshot testing (`toMatchSnapshot`) is **not** used anywhere in `tests/`; that
section can be skipped for the rewrite.

---

#### Bun test runner — `bun:test` module

**Docs:** https://bun.com/docs/test/index.md  
**Docs (mocks):** https://bun.com/docs/test/mocks.md  
**Docs (lifecycle):** https://bun.com/docs/test/lifecycle.md  
**Docs (AI-agent integration / quieter output):** https://bun.com/docs/test/index.md (§ "AI Agent Integration")

**Relevant behaviour:**

1. **`mock(fn)`** — wraps `fn` and decorates it with `.mock.calls`, `.mock.results`, `.mock.lastCall`, and the full `mockImplementation` / `mockReturnValue` / `mockResolvedValue` family.  The result satisfies `toHaveBeenCalled`, `toHaveBeenCalledTimes`, `toHaveBeenCalledWith`.

2. **`mock.module(specifier, factory)`** — overrides the ESM/CJS module cache for `specifier`. The factory callback is evaluated lazily on first import after the call. **Critical timing rule**: when mocking a package that has already been imported (e.g. at top-level `await import()`), the original module's side-effects have already run; only subsequent imports see the mock. The codebase works around this with the pattern of capturing `actualClaudeSdk = await import("@anthropic-ai/claude-agent-sdk")` then spreading it in the factory so only `getSessionMessages` is overridden while all other exports remain authentic — a documented safe pattern.

3. **`spyOn(object, methodName)`** — wraps the named method in-place; the spy keeps the original implementation and also tracks calls. Calling `.mockImplementation(() => {})` silences the original. Restore with `.mockRestore()` or `mock.restore()` (global).

4. **`mock.clearAllMocks()`** — resets call history on all mocks without restoring implementations.

5. **`mock.restore()`** — restores all spied-on methods to originals; does NOT un-mock `mock.module()` overrides.

6. **Lifecycle hooks** — `beforeAll`, `beforeEach`, `afterEach`, `afterAll`; these are scoped to the `describe` block they appear in. `onTestFinished` runs after a single test, after all `afterEach` handlers.

7. **AI-agent quieter output** — `bun test` suppresses passing-test lines and shows only failures + summary when **any** of the following env vars is set:
   - `CLAUDECODE=1` (Claude Code)
   - `REPL_ID=1` (Replit)
   - `AGENT=1` (generic)
   This is noted in CLAUDE.md under "AI Agent Integration". The rewrite must **not** interpret these as general test-filtering logic; they solely affect reporter verbosity.

**Where used in `tests/`:**

| API | Path:line | Note |
|-----|-----------|------|
| `mock.module("@anthropic-ai/claude-agent-sdk", factory)` | `tests/sdk/providers/claude-wait-for-idle.test.ts:37` | Top-level `await mock.module(...)` called before the module under test is imported; factory spreads `actualClaudeSdk` and overrides only `getSessionMessages` with a queue-based stub |
| `mock(() => {})` stub objects | `tests/sdk/components/renderer-background.test.ts:13-15` | Creates `CliRenderer` stub via `Partial<CliRenderer>` cast |
| `mock(() => {})` stub objects | `tests/sdk/components/tui-diagnostics.test.ts:66-67` | `dumpBuffers`, `dumpStdoutBuffer` stubs |
| `spyOn(console, "warn").mockImplementation(...)` | `tests/sdk/registry.test.ts:162,191` | Silences console.warn; inspects `.mock.calls` in assertions |
| `beforeEach` / `afterEach` env save-restore | `tests/sdk/providers/copilot.test.ts`, `tests/sdk/runtime/executor.test.ts`, `tests/sdk/runtime/tmux.test.ts` | Standard env-var isolation pattern |

---

#### `@anthropic-ai/claude-agent-sdk` — test contract only

**Docs (local cache):** `research/web/2026-04-14-claude-agent-sdk-hil-transcript.md`  
**Relevant behaviour (test-surface only):**

The tests mock the SDK at the module boundary. Only two SDK symbols cross the
mock boundary into real test assertions:

- `SessionMessage` (type import only) — used to type the queue arrays in
  `claude-wait-for-idle.test.ts`; no runtime behaviour is exercised
- `getSessionMessages(sessionId: string, opts?) → Promise<SessionMessage[]>` —
  the function that the mock replaces; tests verify the **wrapper logic** in
  `claude.ts` (slice detection, flush-race retry, mid-loop flush) not the SDK
  itself

`listSessions()` is imported directly (un-mocked) in one CI-adjacent test that
simply asserts it returns an array. No mock contract is needed for it.

The HIL marker flow (`watchHILMarker`) does NOT mock the SDK at all; it uses
real `fs.watch` with UUID-namespaced marker files.

**Where used:**

| Symbol | Path:line | Note |
|--------|-----------|------|
| `import type { SessionMessage }` | `tests/sdk/providers/claude-wait-for-idle.test.ts:21` | Type-only; erased at runtime |
| `await import("@anthropic-ai/claude-agent-sdk")` + spread in `mock.module` factory | `tests/sdk/providers/claude-wait-for-idle.test.ts:35-44` | Captures real module before overriding |
| `listSessions` (un-mocked) | one CI helper | Smoke-tests that the export is callable |

---

## Prose Summary

External library research is warranted for this partition, but it is narrowly scoped.

The `tests/` directory's primary test runner is `bun:test` (Jest-compatible API). The key
non-obvious API is `mock.module()`: its ESM live-binding semantics mean mocks declared at
file top-level (before the module under test is imported) suppress original side-effects,
while mocks declared inside test bodies do not. The project exploits this correctly in
`claude-wait-for-idle.test.ts` by capturing the authentic module via a top-level `await
import()` and spreading it in the factory — this is the canonical "partial module mock"
pattern documented in Bun's mocks guide.

The AI-agent env vars (`CLAUDECODE=1`, `REPL_ID=1`, `AGENT=1`) only affect Bun's reporter
verbosity; they do not influence test selection or mocking behaviour and need not be
replicated in test logic during the rewrite.

Snapshot tests (`toMatchSnapshot`) are absent from this test suite, so that API surface
needs no attention.

The `@anthropic-ai/claude-agent-sdk` appears only as a mocked boundary dependency. The
actual SDK type `SessionMessage` is used for TypeScript queue typing but carries no runtime
contract the rewrite needs to preserve independently of the SDK version. All substantive
Claude-provider logic is exercised through internal module imports with the SDK replaced by
queue-based stubs.

`@opentui/core` (specifically `CliRenderer`) appears only as a `Partial<CliRenderer>` cast
target for stub objects constructed with `mock(() => {})`. No real renderer is instantiated
in tests; no OpenTUI test-specific API is required.

## Out-of-Partition References
Look for the **Out-of-Partition References** subsection inside the
"How It Works" section above — that is where the analyzer flagged files
outside this partition that other partitions should examine.
