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
