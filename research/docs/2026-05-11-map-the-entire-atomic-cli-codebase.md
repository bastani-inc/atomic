---
date: 2026-05-11 02:57:44 UTC
researcher: deep-research-codebase workflow
git_commit: deaee4748f3bdaa434460343f8a6645514e59fd4
branch: refactor/pi-rewrite
repository: atomic-pi-rewrite
topic: "Map the entire Atomic CLI codebase (packages/atomic + packages/atomic-sdk) for a planned full rewrite onto pi-coding-agent. We will remove ALL dependencies on tmux, Claude Code/Claude Agent SDK, GitHub Copilot CLI/SDK, and OpenCode/OpenCode SDK, and re-platform Atomic as a forked/rebranded pi-coding-agent."
tags: [research, codebase, deep-research]
status: complete
last_updated: 2026-05-11
---

# Research: Atomic → pi-coding-agent Rewrite — Whole-Codebase Inventory

## Research Question

Map the entire Atomic CLI codebase (packages/atomic + packages/atomic-sdk) for a planned full rewrite onto pi-coding-agent. We will remove ALL dependencies on tmux, Claude Code/Claude Agent SDK, GitHub Copilot CLI/SDK, and OpenCode/OpenCode SDK, and re-platform Atomic as a forked/rebranded pi-coding-agent. Deliver a comprehensive, partitioned audit covering: (1) CLI surface, (2) TUI layer, (3) Workflow orchestrator, (4) Agent adapters, (5) tmux integration, (6) Skills / prompts / sub-agents / MCP loading, (7) SDK packages, (8) Configuration layer, (9) Infra, (10) Testing. For each section, list (a) directories/files involved, (b) public types/exports, (c) dependencies pinning Atomic to claude/copilot/opencode/tmux vs. agent-agnostic ones, and (d) load-bearing vs. removable. Identify seams where pi-coding-agent extensions, skills, prompts, or themes replace Atomic-specific code, and call out where architecture must invert (e.g., workflow orchestrator → pi extension exposing a dynamically-spawned pane in chat TUI). Produce a per-partition inventory deep enough to drive a hierarchical refactor spec.

## Executive Summary

Atomic is a **Bun-first TypeScript monorepo** organised into two production packages: `@bastani/atomic` (`packages/atomic/`, ~21k LOC, the CLI shell), and `@bastani/atomic-sdk` (`packages/atomic-sdk/`, ~44k LOC, the workflow + TUI engine). The CLI shell is a Commander.js program (`packages/atomic/src/cli.ts:46-625`) that lazy-imports command modules and exposes 13 top-level subcommands plus 7 hidden internal hooks (`_orchestrator-entry`, `_cc-debounce`, `_claude-stop-hook`, `_claude-session-start-hook`, `_claude-ask-hook`, `_claude-inflight-hook`, `_runtime-assets-smoke`). The SDK provides the agent-agnostic DSL surface (`defineWorkflow().for(agent).run(fn).compile()`) layered on top of a deeply tmux-coupled execution engine and per-agent provider adapters.

Agent-specific coupling concentrates in three SDK files: `packages/atomic-sdk/src/providers/claude.ts` (61 KB, Claude Agent SDK + Stop/SubagentStart/SubagentStop/TeammateIdle hook marker protocol), `packages/atomic-sdk/src/providers/copilot.ts` (CopilotClient + `cliUrl` SDK wiring), and `packages/atomic-sdk/src/providers/opencode.ts` (OpenCode `OPENCODE_CLIENT=sdk` env scoping). The `AgentType = "claude" | "copilot" | "opencode"` union (`packages/atomic-sdk/src/types.ts:33`) drives a discriminated `ClientMap`/`SessionMap`/`StageClientOptions`/`StageSessionOptions` type system that pins three SDK packages directly into the type surface.

tmux coupling concentrates in four files: `packages/atomic-sdk/src/runtime/tmux.ts` (28 KB, `SOCKET_NAME="atomic"`, `createSession`, `createWindow`, `respawnPane`, `sendLiteralText`, `sendViaPasteBuffer`, `capturePane`, `killWindow`, `killSession`, `killSessionOnPaneExit`, `getPanePid`, `getSessionEnv`), `packages/atomic-sdk/src/runtime/executor.ts` (94 KB, `executeWorkflow`, `runOrchestrator`, `createSessionRunner`, `initProviderClientAndSession` switch over agents, `AGENT_CLI` config record), `packages/atomic-sdk/src/runtime/offload-manager.ts` (22 KB, resume metadata persistence, secret-filtering allowlist), and `packages/atomic-sdk/src/runtime/port-discovery.ts` (15 KB, `/proc/<pid>/fd` polling on Linux + lsof fallback to discover the agent CLI's TCP port). The chat command (`packages/atomic/src/commands/cli/chat/index.ts`) consumes nine functions from `runtime/tmux.ts` plus `runtime/attached-footer.ts` to spawn `claude`/`copilot`/`opencode` CLIs inside dedicated tmux sessions on the `atomic` socket.

The DSL stratum is largely **agent-agnostic and portable**: `define-workflow.ts`, `registry.ts`, `primitives/run.ts`, `primitives/inputs.ts`, `worker-shared.ts`, `errors.ts`, all of `lib/atomic-temp.ts` / `lib/spawn.ts` / `lib/terminal-env.ts` / `lib/common-ignore.ts`, the entire `theme/colors.ts` (Catppuccin), and most of `components/` (graph layout, connectors, node-card, workflow-picker-panel, color-utils, status-helpers) carry no agent or tmux dependency. The `OrchestratorPanel` class in `components/orchestrator-panel.tsx` and `WorkflowPickerPanel` in `components/workflow-picker-panel.tsx` are OpenTUI/React TUI surfaces that can transfer with minimal changes. Skills (43 SKILL.md files under `.agents/skills/`, distributed via the `skills` tar bundle in `embedded-assets.ts` and `installGlobalSkills()`) are pure markdown + YAML frontmatter and fully portable. The `_emit-workflow-meta` / `_atomic-run` subprocess protocol for custom workflows (`packages/atomic/src/commands/custom-workflows.ts:73-150`, `packages/atomic-sdk/src/lib/host-local-workflows.ts:182`) is agent-agnostic, token-gated via `ATOMIC_DISPATCH_TOKEN`, and reusable as-is.

The primary **architectural inversion** for pi-coding-agent is the agent-pane model. Currently `executeWorkflow()` spawns a top-level tmux session containing an orchestrator pane (running `_orchestrator-entry`) plus one window per stage (each running the agent CLI), then `runOrchestrator()` renders the workflow graph in the orchestrator pane and dispatches stages via `ctx.stage()` → `tmux.createWindow()` → agent CLI server on a discovered port. The pi rewrite must invert this: pi's chat TUI becomes the host and the workflow orchestrator becomes a pi extension that spawns a dynamically-attached pane within the chat. The single switch point is `initProviderClientAndSession` at `packages/atomic-sdk/src/runtime/executor.ts:1589` — replacing the three agent cases with one pi-agent call collapses the entire provider stratum.

## Detailed Findings

### 1. CLI Surface (`packages/atomic/`)

**Entry & Subcommands** (`packages/atomic/src/cli.ts:46-625`):

- `createProgram()` at `cli.ts:46` builds the Commander tree; `program` exported at line 540; `main()` at line 579 is the async bootstrap.
- Top-level commands registered in `cli.ts`: `chat` (default, `cli.ts:73-132`), `workflow` (`cli.ts:149-281`, mounted via `workflowCommand` from `commands/cli/workflow.ts`), `workflow session` and top-level `session` (built via `management-commands.ts:addSessionSubcommand`), `config set` (`cli.ts:287-301`), `install` (`cli.ts:472`), `uninstall` (`cli.ts:484-492`), `update` (`cli.ts:494-506`), `init`, `completions`, `upload-telemetry` (hidden in current source; specs/2026-05-03 lists it as the 6th command).
- Internal hidden hooks at `cli.ts:325-464`: `_orchestrator-entry` (`cli.ts:324-384`, the SDK orchestrator launch point), `_cc-debounce` (Claude Code C-c debounce), `_claude-stop-hook` (`cli.ts:399-415`, `claudeStopHookCommand` from `@bastani/atomic-sdk/providers/claude-stop-hook`), `_claude-session-start-hook` (`cli.ts:417-426`, writes `~/.atomic/claude-ready/<sessionId>`), `_claude-ask-hook` (`cli.ts:428-444`, AskUserQuestion lifecycle, writes/unlinks `~/.atomic/claude-hil/<sessionId>`), `_claude-inflight-hook` (`cli.ts:446-464`, SubagentStart/Stop/TeammateIdle marker dirs), `_runtime-assets-smoke` (assets materialisation CI check).
- `main()` flow at `cli.ts:579-622`: `ensureGlobalAtomicSettings()` → `autoSyncIfStale()` (gated by `isInfoCommandArgv` from `info-command-skip.ts`) → `bootstrapCustomWorkflowsAndRebuild()` → `program.parseAsync()`.

**Chat Command** (`packages/atomic/src/commands/cli/chat/index.ts`, 446 lines):

- `chatCommand(options)` at `chat/index.ts:260` orchestrates preflight, arg-building, launcher creation, tmux session, attach.
- `buildAgentArgs(agentType, passthroughArgs, projectRoot)` at `chat/index.ts:102` merges `AGENT_CONFIG[agent].chat_flags`, `getProviderOverrides()`, Copilot SCM disable flags, Claude `--append-system-prompt-file`, and passthrough args.
- `buildLauncherScript(cmd, args, projectRoot, envVars)` at `chat/index.ts:198` generates POSIX bash or PowerShell launcher with `cd`, env exports, agent invocation, and exit-code capture; platform-aware via `process.platform`.
- `resolveChatCommand(agentType, resolveCommandPath)` at `chat/index.ts:146` calls `resolveCopilotCliPath` for copilot (handles Node shim detection) or `getCommandPath(config.cmd)` for others.
- `spawnDirect(cmd, projectRoot, env)` at `chat/index.ts:433` is the fallback when no TTY or tmux unavailable.
- Tmux SDK consumption: `createSession`, `spawnAttachedFooter`, `killSessionOnPaneExit`, `spawnMuxAttach`, `switchClient`, `detachAndAttachAtomic`, `killSession`, `isInsideAtomicSocket`, `isInsideTmux`, `isTmuxInstalled`, `resetMuxBinaryCache`, `ensureTmuxInstalled` (all from `@bastani/atomic-sdk/runtime/tmux` and `runtime/attached-footer`).

**Workflow Commands**:

- `commands/cli/workflow.ts` — module-level mutable `activeRegistry` swapped via `rebuildWorkflowCommand()`; `buildWorkflowCommand(registry, liveRegistry)` at `workflow.ts:313`; `dispatch(workflow, cliInputs, detach)` at `workflow.ts:261` routes external workflows to `dispatchExternal()` (spawns `[w.source.command, ...args, "_atomic-run", "--dispatch-token=<token>"]`) and builtin workflows to `runWorkflow` from `@bastani/atomic-sdk`; `runPicker(registry, agent, detach)` opens `WorkflowPickerPanel`; `blockIfBroken(name, agent)` exits 2 on known-broken workflows.
- `commands/cli/workflow-list.ts` — filters by agent; renders builtin + custom registries.
- `commands/cli/workflow-inputs.ts` — prints input schema JSON.
- `commands/cli/workflow-read.ts` — resolves on-disk path under `~/.atomic/sessions/<runId>/<stageDir>/`; flags `--sessionId`, `--stageId`, `--format`.
- `commands/cli/workflow-status.ts` — queries workflow status; flag `--format json|text`.
- `commands/cli/workflow-refresh.ts` — reloads custom workflows; emits JSON when `ATOMIC_AGENT` is set.

**Session Management**:

- `commands/cli/management-commands.ts:addSessionSubcommand()` — shared list/connect/kill subcommands for `atomic session`, `atomic chat session`, `atomic workflow session`.
- `commands/cli/session.ts` — implementation: tmux session introspection via `listSessions`, `getSessionStatus`, `attachSession`, `stopSession` from the SDK.

**Install/Uninstall/Update** (`packages/atomic/src/commands/cli/install.ts`, 826 LOC):

- `installCommand(opts)` at `install.ts:751` — `copyBinary` → `persistPathEntry` → `detectMuxBinary` → `installCompletions` → `cleanupOldArtifacts` (microtask).
- `getInstallPaths()` at `install.ts:58` — Windows `%LOCALAPPDATA%\atomic\bin\atomic.exe`, Unix `~/.local/bin/atomic`.
- `copyBinary(paths, sourcePath)` at `install.ts:96` — atomic-move pattern: copy to `.tmp.<pid>.<ts>`, `chmodSync(0o755)`, `renameSync` to final. Windows archives existing `.exe` to `.old.<ts>`.
- `persistPathEntry(dir)` at `install.ts:223` — Unix appends shell rc snippet with `PATH_RC_MARKER`; Windows writes `HKCU\Environment\Path` via PowerShell `[Environment]::SetEnvironmentVariable`.
- `detectMuxBinary()` at `install.ts:411` — searches PATH then `wellKnownMuxInstallDirs()` (`install.ts:435`) for `tmux` (Unix) or `psmux`/`pmux` (Windows); covers Homebrew, Scoop, WinGet, Chocolatey paths.
- `installCompletions(paths)` at `install.ts:472` — writes `~/.atomic/completions/atomic.<ext>` from `COMPLETION_SCRIPTS[shell]`, sources from rc file.
- `cleanupOldArtifacts(binDir, now)` at `install.ts:160` — reaps `.old.<ts>` and `.tmp.<pid>.<ts>` older than 1 hour.
- `install-method.ts` — `InstallMethod = "binary"|"bun"|"npm"|"pnpm"|"yarn"|"source"|"unknown"` (`install-method.ts:4`); `PKG_PATH_RE = /\/node_modules\/@bastani\/atomic(?:-[a-z0-9-]+)?\//` (`install-method.ts:22`); memoised via `cached` module-level variable.
- `update.ts` — uses `release-fetch.ts:downloadAssetFromUrl()` and GitHub Releases API at `DEFAULT_GITHUB_API_BASE = "https://api.github.com/repos/bastani/atomic"` (`release-fetch.ts:30`).

**Banner & Logo**:

- `theme/logo.ts:14-123` — `ATOMIC_BLOCK_LOGO`, `displayBlockBanner()`, Catppuccin gradient with truecolor/256-color/no-color branches.

**Auto-sync** (`services/system/auto-sync.ts`):

- `autoSyncIfStale()` at `auto-sync.ts:82` — compares `VERSION` vs `~/.atomic/.synced-version`; on mismatch runs `seedGlobalAdditionalInstructions`, `seedGlobalProviderEnvVars`, `ensureTmuxInstalled({quiet:true})`, `installGlobalAgents()`, `upgradeGlobalToolPackages()` (bun install -g playwright/liteparse/ast-grep), `installGlobalSkills()`. Skipped for info commands. Skipped when not installed package.

**Embedded Assets** (`packages/atomic/src/lib/embedded-assets.ts`):

- `BUNDLES: Record<EmbeddedAssetKind, string>` at `embedded-assets.ts:15` — maps `claude`, `opencode`, `github`, `skills` to `.tar` files imported via Bun's `with { type: "file" }` static file imports.
- `getEmbeddedAsset(kind)` at `embedded-assets.ts:41` — extracts tar to versioned cache dir `~/.cache/atomic/<VERSION>/<kind>/` with SHA-256 fingerprint and `.extracted` marker; uses `isCompiledBinaryRuntime` to handle `/$bunfs/` path.
- `cacheRoot()` at `embedded-assets.ts:22` — `%LOCALAPPDATA%\atomic\Cache` (win32), `~/Library/Caches/atomic` (darwin), `~/.cache/atomic` (linux).

**Global Config Sync** (`services/config/atomic-global-config.ts`, 349 LOC):

- `AGENT_KIND_BY_KEY: Record<AgentKey, ProviderConfigKind>` at `atomic-global-config.ts:13` — `claude→"claude"`, `opencode→"opencode"`, `copilot→"github"`.
- `syncAtomicGlobalAgentConfigs(resolveKind, baseDir)` at line 240 — extracts each kind's tar, copies `agents/` subdir to `~/.<agentFolder>/agents/`, sync JSON files (Copilot `lsp.json` → `lsp-config.json`).
- `removeAtomicManagedGlobalAgentConfigs()` at line 182 — inverse for uninstall.
- `ensureAtomicGlobalAgentConfigs()` at line 342 — verify-and-repair entry.

**Telemetry** (`lib/telemetry/`):

- `offload-events.ts` — event constants: `WORKFLOW_OFFLOAD_SCHEDULED`, `WORKFLOW_OFFLOAD_COMPLETED`, `WORKFLOW_OFFLOAD_RESUME_ATTEMPTED`, `WORKFLOW_OFFLOAD_RESUME_SUCCEEDED`, `WORKFLOW_OFFLOAD_RESUME_FAILED`. Payload interfaces (`WorkflowOffloadScheduledPayload`, etc.).
- `lib/telemetry/index.ts` — re-exports `getProductionTelemetrySink()` and `TelemetrySink` from SDK.
- `services/system/release-fetch.ts` — `buildApiHeaders()` reads `GITHUB_TOKEN`, `downloadAssetFromUrl()` with progress callback.

**Custom Workflow Loader** (`commands/custom-workflows.ts`, 413 LOC):

- `loadCustomWorkflows(workflows, origin, settingsPath)` at line 73 — fans out `loadOne` calls in parallel.
- `loadOne(alias, entry, origin, settingsPath)` at line 94 — spawns `[entry.command, ...args, "_emit-workflow-meta", "--dispatch-token=<token>"]` with env `ATOMIC_HOST=1, ATOMIC_DISPATCH_TOKEN=<token>`, 5s default timeout via `ATOMIC_WORKFLOWS_META_TIMEOUT_MS`.
- `META_PREFIX = "ATOMIC_WORKFLOW_META: "` at line 52 — line prefix the spawned child emits.
- `mergeIntoRegistry(builtin, global, local)` at line 282 — local overrides global overrides builtin; shadow-subtraction of broken entries.
- `bootstrapCustomWorkflows(projectDir)` at line 391 — reads global + local `settings.json`, calls `loadCustomWorkflows` in parallel, returns `BootstrapResult`.

**Builtin Registry** (`commands/builtin-registry.ts`):

- `createBuiltinRegistry()` at line 26 — registers 9 builtin workflows (ralph × 3 agents, deep-research-codebase × 3, open-claude-design × 3) via `createRegistry().register()` chain.

**Binary Wrapper** (`packages/atomic/bin/atomic`):

- Node.js shim that detects platform/arch, resolves `@bastani/atomic-{platform}-{arch}` package, spawns native binary with inherited stdio.
- Linux musl detection via `/lib/ld-musl-<arch>.so.1` existence check.

**Build/Release Scripts** (`packages/atomic/script/`):

- `build.ts` — bundles embedded assets via `bundleEmbeddedAssets`, then `bun build --compile --target=bun-<os>-<arch>` per target.
- `build-assets.ts` — packs `.claude`, `.opencode`, `.github`, `.agents/skills` into `.tar` modules (enforces MAX_TARRED_PATH_CHARS=150 for Windows).
- `bump-version.ts` — `parseVersionFromBranch()` extracts version from `release/v<x.y.z>` or `prerelease/v<x.y.z>-<n>` branch names.
- `release-assets.ts` — builds 6 OS/arch variants (darwin x64/arm64, linux x64/arm64 glibc/musl, windows x64).
- `publish.ts` — uploads via GitHub release API.
- `targets.ts` — `TARGETS` array, `hostTarget()`.

### 2. TUI Layer

**OrchestratorPanel** (`packages/atomic-sdk/src/components/`):

- `orchestrator-panel.tsx` — `OrchestratorPanel` class, OpenTUI React-based root, manages session graph, pane/window state. `OrchestratorPanel.create({tmuxSession})` (line referenced in executor.ts:2287).
- `orchestrator-panel-store.ts` — `PanelStore` class: `version`, `workflowName`, `agent`, `prompt`, `sessions`, `completionInfo`, `fatalError`, `exitResolve`. `subscribe(listener) → unsub` observer pattern; `setWorkflowInfo(name, agent, sessions, prompt)` creates orchestrator session entry with `status:"running"`.
- `orchestrator-panel-types.ts` — `SessionStatus = "pending"|"running"|"complete"|"error"|"awaiting_input"|"offloaded"|"resuming"`; `ViewMode = "graph"|"attached"|"resuming"`; `PanelSession`, `PanelOptions`, `SessionData`.
- `orchestrator-panel-contexts.ts` — React contexts: `useStore()`, `useGraphTheme()`, `useStoreVersion()`, `useOffloadManager()`.

**SessionGraphPanel** (`components/session-graph-panel.tsx`):

- Renders DAG of workflow stages in graph view; consumes layout from `layout.ts` and connectors from `connectors.ts`.
- The 500 ms focus-poll referenced in spec history lives here.

**Workflow Picker** (`components/workflow-picker-panel.tsx`, 1700+ lines):

- `WorkflowPicker`, `WorkflowPickerPanel` class, `buildEntries`, `buildPickerTheme`, `buildPickerRows`, `buildRows`, `fuzzyMatch`, `isFieldValid`.
- Two-phase telescope-style picker: pick → prompt → confirm; agent-scoped, fuzzy match on workflow name + description; required-field validation; renders inputs as `--<name>` flag editor.

**Graph Layout & Edges**:

- `components/layout.ts` — `computeLayout()` builds parent→children tree, assigns DFS depth, leaf-first column placement.
- `components/connectors.ts` — `buildConnector()`, `buildMergeConnector()` produce Unicode box-drawing connector text (`╭ ╰ ├ ┤ ┴ ┬ ┼ ─`) for DAG edges.
- `components/edge.tsx` — Edge React component.
- `components/node-card.tsx` — Absolute-positioned node box; running nodes pulse border via `lerpColor(theme.border, theme.warning, sin(pulsePhase))`.

**Header / Footer / Toast / Compact Switcher / Errors**:

- `components/header.tsx` — workflow name, model, version display.
- `components/compact-switcher.tsx` — mode selector for graph/attached/resuming views.
- `components/toast.tsx` — `ToastStack` for notifications in orchestrator panel.
- `components/error-boundary.tsx` — `ErrorBoundary` React component for TUI error handling.
- `components/renderer-background.ts` — `setRendererBackground`, `resetRendererTerminalBackground`, `wrapForTmuxIfNeeded`.

**Theme & Status Helpers**:

- `components/graph-theme.ts` — `GraphTheme` interface, `deriveGraphTheme()` from terminal theme.
- `components/color-utils.ts` — `hexToRgb`, `rgbToHex`, `lerpColor`.
- `components/status-helpers.ts` — `statusColor`, `statusLabel`, `statusIcon`, `fmtDuration`.
- `components/tui-diagnostics.ts` — `isTuiDiagnosticsEnabled`, `createTuiDiagnostics`, `BufferDiagnostic`, `WorkflowDiagnosticSnapshot`.

**TUI Compiler & Renderer** (`packages/atomic-sdk/src/tui/`):

- `tui/index.ts` — barrel re-exports.
- `tui/components.tsx` — `Box`, `Text`, `Footer` stub components.
- `tui/types.ts` — `StyleProps`, `ElementProps`, `StatusPosition`, `FooterConfig`.
- `tui/renderer.ts` — `renderFooter()`, `clearFooter()` for OpenTUI footer rendering.
- `tui/mux.ts` — `setOption`, `setWindowOption`, `setGlobalWindowOption`, `setStatuslineState` (tmux multiplexer control).
- `tui/attached-statusline.tsx` — `attachedStatusline()` renders status in tmux status-line for attached session.
- `tui/globals.ts` — `TmuxGlobals` type exposing tmux/psmux global state.
- `tui/compiler/parser.ts` — `compile()` parses React nodes into OpenTUI-compatible command strings.
- `tui/compiler/styles.ts` — `styleAttributes`, `inlineStyle` for style compilation.

**Attached Footer** (`runtime/attached-footer.ts`):

- `spawnAttachedFooter(paneId, ?, tmuxSessionName)` — spawns footer pane via OpenTUI, displays workflow status/duration; renders to tmux status-line.

**SyntaxStyle Lifecycle Pattern**:

- Codebase memory documents: `SyntaxStyle` from OpenTUI is a native resource that must be `.destroy()`ed in `useEffect` cleanup, NOT in `useMemo`. Fixed in `text-part-display.tsx`, `reasoning-part-display.tsx`, `use-shell-state.ts` (per memory note).

**Research Designs** (TUI prototypes in `research/designs/`):

- `workflow-picker-tui.tsx` — two-phase agent-scoped picker prototype.
- `session-graph-tui.tsx` — DAG session graph prototype with `Session.tmux` field encoding tmux session handles (load-bearing tmux coupling at component level).

### 3. Workflow Orchestrator

**DSL Surface** (`packages/atomic-sdk/src/define-workflow.ts`):

- `defineWorkflow<I>(options)` at `define-workflow.ts:376` — factory; calls `_captureCallerPath()` (line 48) to walk V8 stack and extract caller's absolute path into `options.source`.
- `WorkflowBuilder<A, I>` at line 217 — chainable: `.for(agent)`, `.run(fn)`, `.compile()`.
- `RESERVED_INPUT_NAMES` at line 140 — `name`, `agent`, `detach`, `list`, `help`, `version`, `session`, `status` (collide with CLI flags).
- `validateWorkflowInput(input, workflowName)` at line 156 — throws on empty/invalid name, reserved names, enum without values, non-integer defaults.
- `WorkflowBuilder.compile()` at line 284 — freezes inputs, throws if `source` empty (compiled-binary bunfs path); pushes into `_compiledWorkflowRegistry`.
- `getCompiledWorkflows()` at line 121 — returns snapshot used by `_emit-workflow-meta`.

**Registry** (`packages/atomic-sdk/src/registry.ts`):

- `createRegistry()` at line 151 — factory returning empty `RegistryImpl`.
- `RegistryImpl<T>` at line 65 — immutable; `.register(wf)` returns new instance with updated key `${agent}/${name}`; throws on duplicate; `.upsert(wf, onOverride?)` for silent replacement; `.list()` returns `Object.freeze(Array.from(...))`; `.resolve(name, agent)` returns `this.map.get(${agent}/${name})`.
- `providerValidators` at lines 21-28 — `Record<AgentType, (source) => ValidationWarning[]>` dispatch table to `validateClaudeWorkflow`, `validateOpenCodeWorkflow`, `validateCopilotWorkflow`.

**Runtime Executor** (`packages/atomic-sdk/src/runtime/executor.ts`, 94 KB / ~2400 LOC):

- `AGENT_CLI: Record<AgentType, {cmd, chatFlags, envVars}>` at lines 86-111 — hardcodes `copilot --ui-server --port 0`, `opencode --port 0`, `claude` (lazy spawn); sets `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`.
- `TelemetrySink` interface at line 137; `setExecutorTelemetrySinks()` at line 152 (test injection).
- `buildPaneCommand(agent, overrides, extraChatFlags)` at line 464 — composes per-agent shell command.
- `waitForServer(agent, paneId)` at line 533 — for copilot/opencode polls `capturePane` for 3+ lines, calls `getListeningPortForPid(panePid)` from `port-discovery.ts`; probes copilot SDK via `CopilotClient.start()` + `listSessions()`.
- `executeWorkflow(options)` at line 659 — top-level: resolves dispatcher via `resolveDispatcher`, reconciles opencode instructions, generates `workflowRunId`, writes launcher shell to `~/.atomic/sessions/<runId>/orchestrator.<ext>`, encodes inputs as base64, builds orchestrator command via `buildSelfExecCommand`, calls `tmux.createSession(name, cmd, "orchestrator", ...)`, calls `spawnAttachedFooter`, optionally attaches or detaches.
- `runOrchestrator(definition, inputs)` at ~line 2290 — entry inside tmux pane: validates env (`validateOrchestratorEnv` from `executor-env.ts`), sets telemetry sinks, creates `OrchestratorPanel.create({tmuxSession})`, subscribes to panel for snapshot persistence, builds `OffloadManager` via `createOffloadManager`, builds `WorkflowContext` with `stage()` delegating to `offloadManager.spawnSession`, invokes `definition.run(ctx)`.
- `createSessionRunner(shared, parentName)` at line 1861 — returns `ctx.stage()` implementation; per call: uniqueness check → `GraphFrontierTracker.onSpawn()` for DAG parents → `tmux.createWindow(...)` or headless path → `waitForServer` → `initProviderClientAndSession` → callback → cleanup → write `inbox.md` + `messages.json`.
- `initProviderClientAndSession<A>(agent, serverUrl, paneId, ...)` at line 1589 — **load-bearing switch**: copilot uses `new CopilotClient({cliUrl: serverUrl})` + `client.createSession()` + `client.setForegroundSessionId()`; opencode uses `createOpencodeClient({baseUrl})` or `createOpencode({port:0})` headless; claude uses `new ClaudeClientWrapper(paneId, opts)` + `client.start()` or `HeadlessClaudeClientWrapper`.
- `cleanupProvider(agent, client, session, paneId)` at line 1750 — per-agent teardown.
- `wrapCopilotSend()` at line 1238 — wraps `session.send()` to block until `session.idle` fires.
- `watchOpencodeStreamForHIL(stream, sessionId, onHIL)` at line 1303 — SSE consumer for `question.asked`/`replied`/`rejected`.
- `watchCopilotSessionForHIL(session, onHIL)` at line 1355 — tracks `ask_user` via `tool.execution_start/complete`.
- `renderClaudeTranscript`, `renderCopilotTranscript`, `renderOpencodeTranscript`, `renderMessagesToText` at lines 978-1201.
- `discoverCopilotBinary()`, `shouldOverrideCopilotCliPath()`, `applyContainerEnvDefaults()` at lines 375-442 — Bun-without-node detection.

**Orchestrator Entry** (`packages/atomic-sdk/src/runtime/orchestrator-entry.ts`):

- `resolveWorkflowDefinition(sourcePath, workflowName, agent)` at line 57 — checks `lookupLocalWorkflow` (from `host-local-workflows`), falls back to `mod.default` via dynamic `import(sourcePath)`; throws `InvalidWorkflowError`.
- `runOrchestratorWithDefinition(def, inputsB64)` at line 88 — compiled-binary path.
- `runOrchestratorEntry(sourcePath, workflowName, agentRaw, inputsB64)` at line 130 — dev path.
- `decodeInputs(b64)` at line 97 — base64 → JSON.

**OffloadManager** (`packages/atomic-sdk/src/runtime/offload-manager.ts`, 22 KB):

- `filterSpawnEnv(env)` at line 49 — secret-stripping allowlist; deny exact: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`; deny suffix regex `/_(API_KEY|AUTH_TOKEN|SECRET|TOKEN|PASSWORD)$/i`; allow exact: `CLAUDECODE`, `PATH`, `HOME`, `LANG`, `SHELL`; allow prefix: `ATOMIC_`, `LC_`, `OPENCODE_`, `COPILOT_`.
- `persistResume(stageDir, patch)` at line 122 — per-stageDir mutex; writes `metadata.json` atomically via `.tmp` rename at mode `0o600`.
- `_doPersist(metaPath, patch)` at line 149 — defaults → existing → patch merge; `schemaVersion: 1` always.
- `OffloadResumeMetadata` (`offload-types.ts`) — `{schemaVersion:1, agentSessionId, tmuxSessionName, tmuxWindowName, spawnEnv, spawnCwd, chatFlags, lastPrompt, lastSeenAt, offloadedAt}`.
- `OffloadManager` / `createOffloadManager` / `doResume` (deeper body not fully read but referenced as `index.ts:119-121` exports).

**Graph Inference** (`packages/atomic-sdk/src/runtime/graph-inference.ts`):

- `GraphFrontierTracker` class: constructor takes `scopeParent: string`; `onSpawn() → string[]` returns parent list; `onSettle(name)` marks completed. Handles sequential chain, parallel fan-out (multiple `onSpawn` before settle return same parents via `parallelAncestors`), fan-in, ralph-loop iterations, diamonds, nested scopes.

**Other Runtime**:

- `runtime/port-discovery.ts` — `getListeningPortForPid(pid)` polls `/proc/<pid>/fd` on Linux, lsof fallback; `PORT_DISCOVERY_TIMEOUT_MS` timeout.
- `runtime/cc-debounce.ts` — `shouldForward(now, last, quietMs?)`; `QUIET_MS` constant.
- `runtime/version-compat.ts` — `compareVersions`, `satisfiesMinVersion` (SemVer; prerelease ranks below stable).
- `runtime/status-writer.ts` — `writeSnapshot()` persists workflow state to `metadata.json` for resume/external observation.
- `runtime/executor-env.ts` — `validateOrchestratorEnv()` requires `ATOMIC_WF_ID`, `ATOMIC_WF_TMUX`, `ATOMIC_WF_AGENT`, `ATOMIC_WF_CWD`; throws on `gpt`, `not-an-agent`.
- `runtime/theme.ts` — `resolveTheme()` for graph theme passing.
- `runtime/shell-quote.ts` — minimal shell escaping helper.
- `runtime/panel.tsx` — re-exports `OrchestratorPanel` from components.

**Builtin Workflows** (`packages/atomic-sdk/src/workflows/builtin/`):

- `ralph/{claude,copilot,opencode}/index.ts` — plan → orchestrate → review loop; headless reviewer stages with JSON schema validation.
- `ralph/helpers/prompts.ts` — `buildPlannerPrompt`, `buildOrchestratorPrompt`, `buildReviewPrompt`, `REVIEW_RESULT_JSON_SCHEMA`.
- `ralph/helpers/review.ts` — `hasActionableFindings`, `mergeReviewResults`.
- `ralph/helpers/git.ts` — `captureBranchChangeset`.
- `ralph/helpers/{claude,copilot}-reviewer.ts` — per-agent review tools and persona injection.
- `deep-research-codebase/{claude,copilot,opencode}/index.ts` + helpers (`prompts`, `scout`, `heuristic`, `batching`, `scratch`).
- `open-claude-design/{claude,copilot,opencode}/index.ts` + helpers (`design-system`, `scan`, `import`, `export`, `validation`, `constants`).

### 4. Agent Adapters

**Claude** (`packages/atomic-sdk/src/providers/claude.ts`, 61 KB):

- `WORKFLOW_HOOK_SETTINGS` at line 250 — JSON for `SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `TeammateIdle` hooks pointing to `atomic _claude-*-hook` subcommands; `Stop` timeout `2_147_483` seconds.
- `createClaudeSession(options)` at line 393 — generates UUID via `randomUUID()`, stores in `initializedPanes` map, writes PID file, returns session UUID; lazy spawn.
- `spawnClaudeWithPrompt(paneId, promptFile, chatFlags, sessionId)` at line 431 — `ensureWorkflowHookSettings()` writes settings.json, builds `claude [flags] --settings <path> --session-id <uuid> "Read <file>"`, calls `respawnPane(paneId, cmd)`, then `waitForReadyMarker(sessionId)` watching `~/.atomic/claude-ready/<uuid>` via `fs.watch`.
- `ensureWorkflowHookSettings()` at line 472 — writes settings to content-addressed temp at `atomicContentTempPath` mode `0o600`.
- `clearClaudeSession(paneId)` at line 88 — releases Stop hook marker, waits for in-flight subagents via `waitForInflightDrained`, clears PID file, ready marker, inflight tracking.
- `ClaudeClientWrapper` class (~line 550) — wraps a pane's Claude state.
- `ClaudeSessionWrapper` — `sessionId` is Claude UUID; `query()` for sending prompts.
- `HeadlessClaudeClientWrapper` / `HeadlessClaudeSessionWrapper` — headless via `sdkQuery()` from `@anthropic-ai/claude-agent-sdk`.
- `buildClaudeResumeArgs(meta)` — `claude [chatFlags] --resume <sessionId> --settings <path>`.
- `validateClaudeWorkflow(source)` — `createProviderValidator` checking for forbidden direct SDK API usage.
- `waitForIdle(claudeSessionId, transcriptBeforeCount)` — watches `~/.atomic/claude-stop/<sessionId>`; reads transcript slice via `getSessionMessages`; polls until `stop_reason !== "tool_use"`.
- `watchHILMarker(sessionId, onHIL, signal)` — watches `~/.atomic/claude-hil/<sessionId>`; `onHIL(true)` on create, `onHIL(false)` on unlink.
- Imports `getSessionMessages`, `query as sdkQuery`, `SessionMessage`, `SDKUserMessage`, `Options as SDKOptions` from `@anthropic-ai/claude-agent-sdk` at line 26.

**Claude Stop Hook** (`providers/claude-stop-hook.ts`, 18 KB):

- `claudeStopHookCommand()` — receives `{session_id, transcript_path?, cwd?, stop_hook_active?, last_assistant_message?, hook_event_name:"Stop"}` via stdin.
- Returns `{decision:"block", reason}` to inject next prompt without tmux send-keys.
- `claudeHookDirs()` returns `{ready, hil, inflight, stop}` directories under `~/.atomic/`.

**Claude Inflight Hook** (`providers/claude-inflight-hook.ts`, 12 KB):

- `claudeInflightHookCommand(mode)` — `start` (SubagentStart), `stop` (SubagentStop), `wait` (TeammateIdle).
- Marker files at `~/.atomic/claude-inflight/<root_session_id>/<agent_id>`.
- `waitForInflightDrained()` blocks until all subagent markers removed.

**Copilot** (`packages/atomic-sdk/src/providers/copilot.ts`, 7.4 KB):

- `isCopilotShim(candidate)` at line 61 — detects `.js`/`.mjs`/`.cjs` Node shims via extension, `node_modules/.bin` symlink, or shebang/npm-loader-marker in first 256 bytes.
- `resolveCopilotCliPath(resolveCommandPath?)` at line 100 — checks `COPILOT_CLI_PATH` env, then `getCommandPath("copilot")`, falls through PATH if shim detected.
- `copilotSdkLaunchOptions()` at line 127 — returns `CopilotClientOptions` with UTF-8 env + optional `cliPath`.
- `copilotSubprocessEnv()` — normalises `LANG`/`LC_ALL`/`LC_CTYPE` to `en_US.UTF-8`; sets `NODE_NO_WARNINGS=1`.
- `mergeCopilotSystemMessage(existing, extra)` at line 154 — merges additional instructions into `systemMessage`.
- `buildCopilotResumeArgs(meta)` at line 187 — `["--ui-server", "--port", "0", "--resume=<sessionId>", ...chatFlags]`.
- `validateCopilotWorkflow` at line 199 — checks for forbidden `new CopilotClient`, `client.createSession`.

**OpenCode** (`packages/atomic-sdk/src/providers/opencode.ts`, 4.4 KB):

- `HEADLESS_OPENCODE_CLIENT_ID = "sdk"` at line 25 — suppresses interactive `question` tool.
- `withHeadlessOpencodeEnv<T>(fn)` at line 48 — ref-counted env-mutation wrapper around `process.env.OPENCODE_CLIENT = "sdk"`.
- `buildOpencodeResumeArgs(meta)` at line 88 — `["--port", "0", "--session", agentSessionId, ...chatFlags]`.
- `validateOpenCodeWorkflow` at line 100 — checks for `createOpencodeClient()`, `client.session.create()`.

**Agent Definitions** (`services/config/definitions.ts`):

- `AgentKey = "claude" | "copilot" | "opencode"` at line 61, aliased as `AgentType` in `types.ts`.
- `AGENT_CONFIG: Record<AgentKey, AgentConfig>` at line 63 — per agent: `name`, `cmd`, `chat_flags`, `env_vars`, `folder` (`.claude`/`.opencode`/`.github`), `install_url`, `exclude`, `onboarding_files`.
- `onboarding_files` for claude: copies `.mcp.json` (merge), `settings.json` to project `.claude/settings.json` (merge), to `~/.claude/settings.json` (merge, excluding `disabledMcpjsonServers`).
- OpenCode `onboarding_files`: copies `opencode.json` to `.opencode/opencode.json` (merge).
- Copilot `onboarding_files`: copies `.mcp.json` sourced from `claude` bundle.
- `ProviderConfigKind = "claude" | "opencode" | "github"` at line 10.
- `EmbeddedAssetKind = ProviderConfigKind | "skills"` at line 16.
- `ProviderOverrides` at line 149 — `{chatFlags?, envVars?}` per-provider user overrides from `settings.json`.

**Type-Level Pinning** (`packages/atomic-sdk/src/types.ts:7-30`):

- `import type { SessionEvent } from "@github/copilot-sdk"` (line 7).
- `import type { SessionPromptResponse } from "@opencode-ai/sdk/v2"` (line 8).
- `import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk"` (line 9).
- `import type { CopilotClient, CopilotClientOptions, CopilotSession, SessionConfig as CopilotSessionConfig } from "@github/copilot-sdk"`.
- `import type { OpencodeClient, Session as OpencodeSession } from "@opencode-ai/sdk/v2"`.
- `ClientOptionsMap`, `SessionOptionsMap`, `ClientMap`, `SessionMap` (lines 41-76) — the union maps that pin all three SDKs into the type system.
- `SavedMessage` discriminated union (line 237) — `{provider:"copilot"; data: SessionEvent} | {provider:"opencode"; data: SessionPromptResponse} | {provider:"claude"; data: SessionMessage}`.

### 5. tmux Integration

**Core tmux Module** (`packages/atomic-sdk/src/runtime/tmux.ts`, 28 KB):

- `SOCKET_NAME = "atomic"` at line 22 — dedicated socket isolating Atomic from user's default tmux server.
- `getMuxBinary()` at line 54 — resolves `tmux` (Unix) or `psmux`/`pmux` (Windows) via `Bun.which`; caches.
- `tmuxRun(args)` at line 116 — runs `<binary> -f <config> -L atomic <args>` via `Bun.spawnSync`; returns `{ok, stdout|stderr}`.
- `createSession(sessionName, initialCommand, windowName?, cwd?, envVars?, pathToAtomicExecutable?)` at line 185 — `tmux new-session -d -s <name> -P -F #{pane_id} -e KEY=VALUE ... <cmd>`; calls `tmux source-file <config>` and `tmux set-option -g @atomic-cc-debounce <cmd>`.
- `createWindow(sessionName, windowName, command, cwd?, envVars?)` at line 286 — `tmux new-window -d -t <session> -n <window> ...`.
- `respawnPane(paneId, command)` at line 331 — `tmux respawn-pane -k -t <paneId> <cmd>`; used by claude.ts to exec claude in a bare shell pane (avoids shell race).
- `sendLiteralText(paneId, text)` at line 346 — `tmux send-keys -t <pane> -l -- <text>` with newline normalisation.
- `sendViaPasteBuffer(paneId, text)` at line 363 — temp file + `tmux load-buffer` + `tmux paste-buffer -t <pane> -d` for large payloads.
- `sendSpecialKey(paneId, key)` at line 387.
- `capturePane(paneId, start?)` at line 401 — `tmux capture-pane -t <pane> -p [-S <start>]`.
- `killWindow(sessionName, windowName)` at line 470 — async; refuses names in `RESERVED_WINDOW_NAMES = {"0","orchestrator"}` (line 459).
- `killSession(sessionName)` at line 445 — swallows errors.
- `getPanePid(paneId)` at line 517 — `tmux display-message -t <pane> -p #{pane_pid}` → number|null.
- `getSessionEnv(sessionName, key)` at line 528 — `tmux show-environment -t <session> <key>`.
- `killSessionOnPaneExit(sessionName, paneId)` at line 262 — installs `pane-exited` + `after-kill-pane` hooks.
- `spawnMuxAttach`, `attachSession`, `detachAndAttachAtomic`, `switchClient`, `isInsideAtomicSocket`, `isInsideTmux`, `isTmuxInstalled`, `resetMuxBinaryCache` — exported attach/detect helpers.
- Session-name parsing: `parseSessionName` recognises `atomic-chat-<agent>-<id>` and `atomic-wf-<agent>-<wfname>-<id>` patterns.

**Tmux Consumers** (out-of-partition references):

- `packages/atomic/src/commands/cli/chat/index.ts` — nine tmux functions consumed.
- `packages/atomic/src/commands/cli/install.ts:411-462` — `detectMuxBinary`, `wellKnownMuxInstallDirs`.
- `packages/atomic/src/services/system/auto-sync.ts` — `ensureTmuxInstalled`, `hasRequiredMuxBinary`.
- `packages/atomic-sdk/src/runtime/executor.ts` — session/window/pane lifecycle.
- `packages/atomic-sdk/src/runtime/offload-manager.ts` — offload cleanup.
- `packages/atomic-sdk/src/lib/spawn.ts` — `ensureTmuxInstalled`, `hasRequiredMuxBinary`, `requiredMuxBinaryCandidatesForPlatform`, `upgradeGlobalToolPackages`.
- `packages/atomic-sdk/src/lib/runtime-assets.ts` — `tmuxConfPath()` returns bundled config path.
- `packages/atomic-sdk/src/runtime/attached-footer.ts` — `spawnAttachedFooter`.
- `packages/atomic-sdk/src/components/session-graph-panel.tsx` — 500 ms focus poll (per spec history).
- `packages/atomic-sdk/src/tui/mux.ts` — tmux statusline state.

**Linter for tmux Guards** (`scripts/lint-offload-await.ts`):

- Rule B checks for `tmuxRun(["switch-client", ...)` patterns; requires `// offload-exempt:` or preceding `offloadManager.getStatus(`/`requestResume(` within 20-line lookback.
- Rules A/A2 enforce `await`/`void`/`.catch` discipline on `offloadManager.registerSession(` and `offloadManager.requestResume(`.

### 6. Skills / Prompts / Sub-Agents / MCP Loading

**Skills Directory** (`.agents/skills/`, 43 skills, 397 files, 30k LOC):

- Each `SKILL.md` carries YAML frontmatter (`name`, `description`, `metadata.provider`, optional `internal:true`, `version`).
- `.claude/skills` is a symlink to `../.agents/skills` for Claude Code consumption.
- Categories: Git/VCS (6), Code Analysis (5), Context Engineering (4), Document Processing (4 — docx/pdf/pptx/xlsx, 186 files), Agent Orchestration (5), Testing/Eval (3), Code Gen/Design (5), UI Libraries (2 — opentui/typescript-react-reviewer), TypeScript (3), Dev Tools (3), Misc (4).
- Notable: `atomic` skill (the Atomic guide), `workflow-creator` (806 lines, with 12 reference files, deepest dependency on tmux + 3 agent SDKs), `research-codebase`, `init`, `find-skills`, `skill-creator` (488 lines with eval framework).

**Skills Installation** (`packages/atomic/src/services/system/skills.ts`):

- `SKILL_DEST_DIRS = [".agents/skills", ".claude/skills"]` at line 27.
- `installGlobalSkills()` at line 35 — `getEmbeddedAsset("skills")` → `copyDir(src, join(home, rel))` for each dest dir.

**Skills Bundling** (`packages/atomic/script/build-assets.ts`):

- Bundles `.agents/skills/` into `skills.tar` (with MAX_TARRED_PATH_CHARS=150 limit for Windows MAX_PATH compatibility).

**Skills-Lock Manifest** (`skills-lock.json`):

- Version 1 manifest tracking 18 curated skills (`ast-grep`, `bun`, `dev`, `docx`, `find-skills`, `impeccable`, `liteparse`, `opentui`, `pdf`, `playwright-cli`, `pptx`, `ripgrep`, `skill-creator`, `tdd`, `typescript-advanced-types`, `typescript-expert`, `typescript-react-reviewer`, `xlsx`) with `source`, `sourceType` (`github`/`well-known`), `skillPath`, `computedHash` (SHA256).

**Agent Definition Files** (`.claude/agents/`, `.opencode/agents/`, `.github/agents/`):

- 9-12 markdown files per agent: `orchestrator.md`, `planner.md`, `worker.md`, `reviewer.md`, `codebase-analyzer.md`, `codebase-locator.md`, `codebase-pattern-finder.md`, `codebase-research-locator.md`, `codebase-research-analyzer.md`, `debugger.md`, `codebase-online-researcher.md`.
- YAML frontmatter: `name`, `description`, `tools`, `model`.

**Agent Config Sync** (`packages/atomic/src/services/system/agents.ts`):

- `AGENT_DIR_PAIRS: AgentSyncPair[]` at line 44 — `[{kind:"claude", dest:".claude/agents"}, {kind:"opencode", dest:".opencode/agents"}, {kind:"github", dest:".copilot/agents"}]`.
- `installGlobalAgents()` at line 55 — extracts tar, `copyDir(src, join(home, dest))`; renames Copilot's `lsp.json` to `~/.copilot/lsp-config.json`.

**MCP Configuration**:

- `.claude/.mcp.json` — declares HTTP server `github-mcp-server` (`https://api.githubcopilot.com/mcp`, auth `Authorization: Bearer ${GH_TOKEN}`) and stdio server `azure-devops` (`bunx -y @azure-devops/mcp <your-org>`).
- `.opencode/opencode.json` — `"mcp"` map with `type:"local"`/`"remote"`, per-server `enabled:bool`, env syntax `{env:GH_TOKEN}`; top-level `permission: "allow"`, `instructions: ["~/.atomic/AGENTS.md"]`.
- `.claude/settings.json` — `disabledMcpjsonServers`, `enabledPlugins`, `permissions.defaultMode`, `env`.

**SCM Sync** (`packages/atomic-sdk/src/services/config/scm-sync.ts`):

- `SCM_MCP_SERVERS = ["github-mcp-server", "azure-devops"]` at line 22.
- `enabledServersFor(scm)` — github→github-mcp-server only, azure-devops→azure-devops only, sapling→none.
- `COPILOT_DISABLE_BY_SCM` — per-provider disable flags.
- `syncScmMcpServers(projectRoot)` updates `.claude/settings.json:disabledMcpjsonServers`, flips `.opencode/opencode.json:mcp.<server>.enabled`, generates `--disable-mcp-server <name>` CLI flags for Copilot.
- `getCopilotScmDisableFlags(projectRoot)` returns CLI flag array.

### 7. SDK Packages

**Public API Surface** (`packages/atomic-sdk/src/index.ts`):

- `defineWorkflow`, `WorkflowBuilder`, `getCompiledWorkflows` (re-exported from `define-workflow.ts`).
- `createRegistry`, `Registry`, `listWorkflows`, `getWorkflow` (re-exported from `registry.ts` + utility helpers).
- `hostLocalWorkflows` (re-exported from `lib/host-local-workflows.ts`).
- `runWorkflow` (re-exported from `primitives/run.ts`).
- `setExecutorTelemetrySinks`, `TelemetrySink`, `getProductionTelemetrySink` (re-exported from runtime/executor + telemetry).
- `listSessions`, `getSession`, `stopSession`, `attachSession`, `detachSession`, `nextWindow`, `previousWindow`, `gotoOrchestrator`, `getSessionStatus`, `getSessionTranscript` (re-exported from `primitives/sessions.ts`).
- `filterSpawnEnv`, `persistResume`, `OffloadManager`, `OffloadManagerDeps` (re-exported from `runtime/offload-manager.ts`).
- All core types (`AgentType`, `WorkflowDefinition`, `WorkflowContext`, `SessionContext`, `SessionHandle`, `WorkflowInput`, `SavedMessage`, `Transcript`, `ExternalWorkflow`, `BrokenWorkflow`, `RegistrableWorkflow`, `ValidationWarning`, `ValidationRule`, etc.) from `types.ts`.
- Error classes (`errors.ts`): `MissingDependencyError`, `WorkflowNotCompiledError`, `InvalidWorkflowError`, `SessionNotFoundError`, `IncompatibleSDKError`, `NoDispatcherError`, `errorMessage()`.
- 60+ package.json subpath exports — `./workflows`, `./workflows/components`, `./runtime/tmux`, `./runtime/orchestrator-entry`, `./runtime/attached-footer`, `./runtime/cc-debounce`, `./providers/claude-stop-hook`, `./providers/claude-inflight-hook`, `./providers/copilot`, `./services/config/atomic-config`, `./services/config/scm-sync`, `./services/config/additional-instructions`, `./services/config/definitions`, `./services/system/copy`, `./services/system/detect`, `./lib/spawn`, `./lib/atomic-temp`, `./lib/common-ignore`, `./lib/runtime-env`, `./lib/terminal-env`, `./lib/runtime-assets`, `./lib/workspace-paths`, `./lib/self-exec`, `./lib/host-local-workflows`, `./theme/colors`, `./errors`, `./worker-shared`, `./primitives/inputs`, `./primitives/sessions`, `./primitives/metadata`, `./primitives/run`, etc.

**Primitives**:

- `primitives/run.ts` — `runWorkflow(options)` at line 82: validates inputs via `validateInputs`, casts to `WorkflowDefinition`, calls `executeWorkflow`. Imports `../lib/auto-dispatch.ts` as side-effect (line 16) — installs synchronous argv intercept for `_orchestrator-entry`/`_cc-debounce` before user code runs.
- `primitives/sessions.ts` — Session state tracking and lifecycle wrappers.
- `primitives/inputs.ts` — `validateInputs(wf, inputs)`: applies defaults, throws on missing required, unknown keys, invalid enum/integer.
- `primitives/metadata.ts` — `getName`, `getDescription`, `getAgent`, `getInputSchema`, `getSource`, `getMinSDKVersion`.

**Auto-Dispatch** (`packages/atomic-sdk/src/lib/auto-dispatch.ts`):

- Side-effect import that scans `process.argv` for `_orchestrator-entry` or `_cc-debounce`; if matched and dispatch token valid, runs the handler and exits — no async cost for non-matching argv.

**Host-Local Workflows** (`packages/atomic-sdk/src/lib/host-local-workflows.ts`):

- `localWorkflowRegistry: Map<string, HostableLocalWorkflow>` at line 73 (module-scope).
- `lookupLocalWorkflow(name, agent)` at line 87.
- `hostLocalWorkflows(workflows, options?)` at line 182 — registers all workflows; scans argv for `_emit-workflow-meta` (emits `ATOMIC_WORKFLOW_META: <json>\n` + `process.exit(0)`) or `_atomic-run` (parses flags, calls `runWorkflow`, exits); both token-gated via `validateDispatchToken`.
- `HOST_SUBS = new Set(["_emit-workflow-meta", "_atomic-run"])` at line 59.

**Dispatch Utils** (`lib/dispatch-utils.ts`):

- `validateDispatchToken`, `findSub`, `parseAtomicRunArgv`, `AtomicRunArgs`.

**Self-Exec** (`lib/self-exec.ts`):

- `buildSelfExecCommand({dispatcher, subcommand, args})`, `resolveDispatcher({override})` — composes re-invocation command for orchestrator launch.

**Runtime-Env** (`lib/runtime-env.ts`):

- `isInstalledPackage()`, `isCompiledBinaryRuntime(path)` — detection helpers for compiled binary vs dev/installed package mode.

**Spawn** (`lib/spawn.ts`):

- `spawnSync`, `spawn`, `ensureTmuxInstalled`, `hasRequiredMuxBinary`, `requiredMuxBinaryCandidatesForPlatform`, `upgradeGlobalToolPackages`.

**Terminal-Env** (`lib/terminal-env.ts`):

- `TERMINAL_ENV_KEYS`, `buildLauncherEnv`, `buildSpawnEnv`, `buildTmuxEnv`, `normalizedTerminalEnv`. Three env builders with distinct security profiles: launcher (secrets stripped), spawn (full + secrets), tmux (full but strips `TMUX`/`PSMUX`/`TMUX_PANE`/`TMUX_TMPDIR`/`PSMUX_PANE`/`WINDOWID` to prevent nested-mux reuse).

**Atomic-Temp** (`lib/atomic-temp.ts`):

- `atomicTempDir()`, `ensureAtomicTempDir()`, `atomicTempEnv()`, `atomicTempPath()`, `atomicContentTempPath()`, `withAtomicTempEnv()` — `~/.atomic/` temp directory management.

**Runtime-Assets** (`lib/runtime-assets.ts`):

- `tmuxConfPath()`, `confPath()` — bundled asset paths (tmux config).

**Workspace-Paths** (`lib/workspace-paths.ts`):

- `getDevCliPkgRoot()`, `getWorkspaceRoot()`, `findRepoRoot(start)` — walks up for `bun.lock` marker.

**Common-Ignore** (`lib/common-ignore.ts`):

- `createCommonIgnoreFilter()` — `.gitignore`-style patterns.

**Telemetry Sink** (`lib/telemetry/index.ts`):

- `getProductionTelemetrySink(runId)` — returns anonymous event emitter.

**SDK Distribution Modes**:

- Host-bun: `runWorkflow` auto-defaults `pathToAtomicExecutable` via `isCompiledBinaryRuntime(import.meta.dir)`.
- Compiled binary: SDK barrel installs synchronous argv side-effect (per spec §11.7 in `specs/2026-05-06-sdk-self-contained-runworkflow.md`).
- Smoke matrix at `tests/fixtures/sdk-compiled-consumer/scripts/smoke.ts` validates both paths in a 6-step sequence (bun install → host-bun → `bun build --compile` → compiled run → `NoDispatcherError` path via `ATOMIC_DISABLE_DEFAULT_EXEC=1` → host-bun re-run).

### 8. Configuration Layer

**Settings Schema** (`packages/atomic-sdk/src/services/config/settings-schema.ts`):

- Zod schema for `~/.atomic/settings.json` and `.atomic/settings.json`.
- Keys: `version`, `scm` (`"github"|"azure-devops"|"sapling"`), `providers.<agent>.{chatFlags, envVars}`, `workflows` (custom workflow registrations).

**Atomic Config** (`packages/atomic-sdk/src/services/config/atomic-config.ts`):

- `AtomicConfig` class loads/merges `~/.atomic/config.json` and project `.atomic/config.json`.
- `getProviderOverrides(agent, projectRoot)`, `readAtomicConfigSplit(projectRoot)`, `getGlobalSettingsPath()`, `getLocalSettingsPath(projectRoot)`, `CustomWorkflowEntry`.

**Custom Workflows in settings.json**:

- `workflows` key map: `{[alias]: {command, args?, agents}}`.
- Per `specs/2026-05-07-custom-workflows-settings-json.md`: spawn each command with `_emit-workflow-meta` subcommand and `ATOMIC_DISPATCH_TOKEN` for token-gated metadata emission.

**Additional Instructions** (`packages/atomic-sdk/src/services/config/additional-instructions.ts`):

- `resolveAdditionalInstructionsContent(projectRoot)`, `resolveAdditionalInstructionsPath(projectRoot)`, `reconcileOpencodeInstructions(projectRoot)`, `seedGlobalAdditionalInstructions()`, `seedGlobalProviderEnvVars()`.

**Init/Onboarding**:

- `commands/cli/init/index.ts:ensureProjectSetup(agentKey, projectRoot)` — `applyManagedOnboardingFiles` + `syncScmMcpServers` + opencode-specific `reconcileOpencodeInstructions`.
- `commands/cli/init/onboarding.ts:applyManagedOnboardingFiles(agentKey, projectRoot, resolveKind)` — iterates `AGENT_CONFIG[agentKey].onboarding_files`, calls `syncJsonFile(source, dest, merge, excludeKeys, overwriteKeys)`.
- `KindResolver` type at `onboarding.ts:9` — `(kind: EmbeddedAssetKind) => Promise<string>`; test seam.

**lib/merge.ts** (`packages/atomic/src/lib/merge.ts`):

- `syncJsonFile(source, destination, merge, excludeKeys?, overwriteKeys?)` — JSON deep-merge with key exclusion/overwrite semantics.

**Documentation Files**:

- `CLAUDE.md` (project root) — Atomic project instructions.
- `AGENTS.md` (generated by `init` skill) — agent-agnostic version of CLAUDE.md.
- `.impeccable.md` — design context (referenced from CLAUDE.md; used by `impeccable` skill).
- `DESIGN.json` / `DESIGN.md` — design system data (per `open-claude-design` workflow).
- `PRODUCT.md` — product context for the `impeccable` skill.

### 9. Infra

**Build System**:

- `package.json` (root) — `@bastani/atomic-monorepo`, workspaces `packages/*`, `examples/*`, `tests/fixtures/*`. Lint script chains `oxlint → lint-custom-workflows.ts → lint-offload-await.ts`.
- `bunfig.toml` — Bun runtime config, coverage paths via `coveragePathIgnorePatterns` (validated by `tests/ci/coverage-paths.test.ts`).
- `packages/atomic-sdk/package.json` — 60+ named exports; depends on `@anthropic-ai/claude-agent-sdk ^0.2.132`, `@github/copilot-sdk ^0.3.0`, `@opencode-ai/sdk ^1.14.40`, `@opentui/core ^0.2.3`, `@opentui/react ^0.2.3`, `commander`, `zod ^4.4.3`, `ignore ^7.0.5`, `yaml ^2.8.4`. peerDependency on `react@19.2.6`.
- `packages/atomic/package.json` — `private` workspace package; bin entry `atomic → src/cli.ts`; deps `@anthropic-ai/claude-agent-sdk ^0.2.132`, `@github/copilot-sdk ^0.3.0`, `@bastani/atomic-sdk` (workspace), `@clack/prompts`, `@commander-js/extra-typings ^14.0.3`, `@opentui/core`, `@opentui/react`, `react ^19.2.6`, `@catppuccin/palette`.

**CI Workflows** (`.github/workflows/`):

- `publish.yml` — npm publish for `@bastani/atomic` and `@bastani/atomic-sdk` (uses `bun packages/atomic/script/publish.ts` and `bun packages/atomic-sdk/script/publish.ts` per `tests/ci/publish-workflow-shape.test.ts`).
- `publish-features.yml` — GHCR feature publish on PR merge to main touching `.devcontainer/features/**` (uses `devcontainers/action@v1` with `publish-features:"true"`, `GITHUB_TOKEN`, `packages: write`).
- `validate-features.yml` — Schema validation on PRs touching `.devcontainer/features/**` (uses `devcontainers/action@v1` with `validate-only:"true"`).
- npm publishing uses **provenance** (no NPM_TOKEN required per project notes in CLAUDE.md).

**Devcontainer Features** (`.devcontainer/`):

- Root `.devcontainer/devcontainer.json` — all three agents, base `mcr.microsoft.com/devcontainers/base:ubuntu`, env passthrough `GH_TOKEN`/`COPILOT_GITHUB_TOKEN`/`ANTHROPIC_API_KEY`, `postCreateCommand: bun install`, mounts `~/.ssh` + `~/.gitconfig`.
- Per-agent manifests: `.devcontainer/{claude,copilot,opencode}/devcontainer.json` each referencing `ghcr.io/bastani/atomic/<agent>:1`.
- Feature manifests (`.devcontainer/features/<agent>/devcontainer-feature.json`, version `1.0.15`) declare `dependsOn`: tmux-apt-get, bun, agent-specific CLI feature (Anthropics `claude-code:1`, devcontainers `copilot-cli:1`, devcontainers-extra `opencode:1`).
- `install.sh` scripts in each feature dir are **byte-for-byte identical** (line 8 comment explicitly notes this requires manual sync). Each installs `@bastani/atomic` globally via `bun add -g`, configures PATH across bash/zsh/fish/login shells, generates `en_US.UTF-8` locale (apt-get or apk branches), installs `@playwright/cli` + `@llamaindex/liteparse` as global tools.

**Windows ARM64 CI**:

- Targets in `script/targets.ts`: 6 OS/arch combos including `linux-x64-musl`, `linux-arm64`, `linux-arm64-musl`, `windows-x64` (and Windows ARM64 per spec history).

**Telemetry Upload Backend** (`rest-api/`):

- Bun.serve REST API (1168 LOC); zero external SDK deps; no tmux; in-memory `ItemStore` (no persistence).
- Routes: `GET/POST /items`, `GET/PUT/DELETE /items/:id`; `errorResponse()` envelope `{error:{status, message}}`.
- Hardcoded port 3000 default (no env var config).

**Anonymous Telemetry**:

- `lib/telemetry/offload-events.ts` (CLI) — event constants.
- `getProductionTelemetrySink(workflowRunId)` — emitted from `runOrchestrator()` and `executeWorkflow()`.

**Binary Distribution Installers**:

- `install.sh` (173 LOC) — POSIX bash; curl/wget; `RELEASES_BASE = "https://github.com/bastani/atomic/releases"`; downloads manifest, validates SHA256 via `shasum -a 256`/`sha256sum`, handoff to `<binary> install`. musl detection via `ldd --version` + `/lib/ld-musl-*` fallback. Rosetta 2 detection via `sysctl -n sysctl.proc_translated`.
- `install.cmd` (169 LOC) — Windows cmd.exe; delegates input validation regex to inline PowerShell; SHA256 via `certutil`; rejects 32-bit; supports `windows-x64` + `windows-arm64`.
- `install.ps1` (128 LOC) — PowerShell 5.1+; `Invoke-RestMethod` for manifest, retry loop (3 attempts, exp backoff capped 5s); `Get-FileHash` for SHA256; `finally` block deletes temp.
- All three use **manifest-then-pinned-version** pattern: `latest` resolves manifest, then binary URL is always `download/v$version/` to prevent races.

**Maintenance Scripts** (`scripts/`):

- `scripts/lint-custom-workflows.ts` — guards against `registry.resolve(<expr>.alias, ...)` anti-pattern. Pure Node-builtin script.
- `scripts/lint-offload-await.ts` — enforces async-discipline on `offloadManager.registerSession(`, `offloadManager.requestResume(`, and `tmuxRun(["switch-client"`. Uses `Bun.file`, `Bun.Glob`. Exports `checkAwaitOrCatch` and `checkSwitchClientGate` for unit testing.

**Build Scripts**:

- `packages/atomic/script/build.ts:bundleEmbeddedAssets` + `bun build --compile --target=bun-<os>-<arch>` per target.
- `packages/atomic/script/build-assets.ts` — bundles via `tar` + `spawnSync({stdio:"inherit"})`.
- `packages/atomic/script/bump-version.ts` — semver validation; `--from-branch` extracts via `git rev-parse --abbrev-ref HEAD` and `parseVersionFromBranch` regex.

### 10. Testing

**Test Organisation** (`tests/`, 52 files, 10395 LOC):

- `tests/sdk/runtime/` (5 files) — `tmux.test.ts` (664 LOC, 15 describe blocks), `executor.test.ts`, `graph-inference.test.ts`, `cc-debounce.test.ts`, `version-compat.test.ts`.
- `tests/sdk/providers/` (3 files) — `copilot.test.ts`, `claude-wait-for-idle.test.ts` (349 LOC; mocks `@anthropic-ai/claude-agent-sdk`), `claude-watch-hil-marker.test.ts`.
- `tests/sdk/primitives/` — `inputs.test.ts`, `metadata.test.ts`, `sessions.test.ts`.
- `tests/sdk/registry.test.ts` — 8 describe blocks; immutability + provider validator dispatch.
- `tests/sdk/components/` (9 .tsx + several .ts) — `node-card.test.tsx`, `edge.test.tsx`, `session-graph-panel.test.tsx`, `header.test.tsx`, `orchestrator-panel.test.tsx`, `error-boundary.test.tsx`, `orchestrator-panel-contexts.test.tsx`, `workflow-picker-panel.test.tsx` (1564 LOC, snapshot file), `layout.test.ts`, `orchestrator-panel-store.test.ts` (343 LOC), `color-utils.test.ts`, `connectors.test.ts`, `renderer-background.test.ts`, `status-helpers.test.ts`, `graph-theme.test.ts`, `tui-diagnostics.test.ts`.
- `tests/commands/cli/chat/` (2 files) — `chat-integration.test.ts` (5 describes, tests `resolveChatCommand`, `buildLauncherEnv`, `buildSpawnEnv`, `buildTmuxEnv`, `TERMINAL_ENV_KEYS`), `buildLauncherScript.test.ts` (platform-shimmed bash/pwsh).
- `tests/lib/` — `merge.test.ts`, `common-ignore.test.ts`, `path-root-guard.test.ts`.
- `tests/services/config/` — `settings.test.ts`, `scm-sync.test.ts`, `settings-seed-envvars.test.ts`.
- `tests/services/system/` — `detect.test.ts`, `copy.test.ts`.
- `tests/ci/` (7 files + `_helpers/binary.ts`) — `onboarding.test.ts` (`RUN_CI_E2E=1` gated, spawns compiled binary), `coverage-paths.test.ts`, `mcp-bundle-source.test.ts`, `no-import-meta-dir-in-runtime.test.ts` (forbids `import.meta.dir` arithmetic in runtime — allowlisted to `workspace-paths.ts`), `no-ts-file-asset-import.test.ts`, `publish-workflow-shape.test.ts`, `skill-description-length.test.ts`.

**Fixtures**:

- `tests/fixtures/sdk-compiled-consumer/` — full end-to-end fixture with `src/workflow.ts` (`greetWorkflow` calling `ctx.stage.query()`), `src/cli.ts`, `scripts/smoke.ts` (6-step matrix), `tsconfig.json`, `package.json`, `README.md`.
- `tests/fixtures/sdk-host-consumer/index.ts` — minimal host-bun fixture using `hostLocalWorkflows([wf])`.

**Co-located Tests** (`packages/atomic-sdk/src/` and `packages/atomic/src/`):

- ~57 test files inside atomic-sdk: `executor.test.ts` (49 KB), `executor.buildPaneCommand.test.ts`, `executor.waitForClaudeReady.test.ts`, `executor.offload-wiring.test.ts`, `executor.loggedKillWindow.test.ts`, `offload-manager.test.ts`, `offload-manager.persistResume.test.ts`, `offload-manager.doResume-rollback.test.ts`, `offload-manager.eligibility.test.ts`, `offload-manager.skeleton.test.ts`, `offload-manager.bodies.test.ts` (27 KB), `offload-manager.claudeMarkerCleanup.test.ts`, `offload-manager.deps.types.test.ts`, `offload-types.test.ts`, `port-discovery.test.ts` (21 KB), `status-writer.test.ts`, `attached-footer.test.ts`, `tmux.killWindow.test.ts`, `orchestrator-entry.resolve.test.ts`, `shell-quote.test.ts`, plus 11 provider tests (`claude.buildResume.test.ts`, `claude.buildResumeArgs.test.ts`, `claude.claudeOffloadCleanup.test.ts`, `claude.waitForIdleDrain.test.ts`, `copilot.buildResume.test.ts`, `copilot.buildResumeArgs.test.ts`, `copilot.test.ts` (14 KB), `opencode.buildResume.test.ts`, `opencode.buildResumeArgs.test.ts`, `headless-hil-policy.test.ts`), 9 component tests, 9 lib tests, 2 service tests, 4 TUI tests, 1 SDK-build test.
- ~39 test files in `packages/atomic`: CLI tests, command tests, install-method tests (POSIX + win32), session tests, custom-workflows tests (unit + integration), service tests, lib tests, build script tests.

**Test Patterns**:

- `withEnvRestore(vars)` — save/restore env vars via `afterEach`.
- `mkdtemp(join(tmpdir(), "settings-test-"))` + `ATOMIC_SETTINGS_HOME` env redirection.
- `spawnSync()` for E2E binaries with full sandbox env (`HOME`, `USERPROFILE`, `XDG_CACHE_HOME`, `LOCALAPPDATA`).
- `Object.defineProperty(process, "platform", {value, configurable:true})` for platform mocking.
- `mock.module("@anthropic-ai/claude-agent-sdk", factory)` with spread of authentic module — partial mock pattern.
- `describe.skipIf(!isE2EEnabled)` for `RUN_CI_E2E=1` gating.
- `bun:test` runner; quieter output triggered by `CLAUDECODE=1`/`REPL_ID=1`/`AGENT=1` env vars.

**Examples** (`examples/`, 14 subdirs, 80+ files, 3435 LOC):

- 7 examples with full claude/copilot/opencode coverage: `hello-world`, `parallel-hello-world`, `hil-favorite-color`, `hil-favorite-color-headless`, `headless-test`, `structured-output-demo`, `pane-navigation`.
- 4 single-agent: `sequential-describe-summarize` (Claude), `review-fix-loop` (Claude), `claude-background-subagents` (Claude), `reviewer-tool-test` (Copilot).
- 3 framework integration: `commander-embed`, `multi-workflow`, `custom-workflow-bunx`.
- Per-agent session APIs documented: Claude `s.session.query(prompt)` + `s.save(s.sessionId)`; Copilot `s.session.send({prompt})` + `s.save(await s.session.getMessages())`; OpenCode `s.client.session.prompt({sessionID, parts})` + `s.save(result.data!)`.
- Each example has `<agent>-worker.ts` Commander driver using `getInputSchema(workflow)` to declare `--<name>` options and call `runWorkflow({workflow, inputs})`.

## Architecture & Patterns

**Layered Strata**:

1. **DSL stratum** — `define-workflow.ts`, `types.ts`, `registry.ts`, `worker-shared.ts`, `errors.ts`. Agent-agnostic except `types.ts`'s `ClientMap`/`SessionMap`/`SavedMessage` union (the only files that `import type` from the three SDKs).
2. **Dispatch stratum** — `primitives/run.ts`, `lib/auto-dispatch.ts`, `lib/host-local-workflows.ts`, `lib/dispatch-utils.ts`, `lib/self-exec.ts`. Routes between `runWorkflow()` callers and Atomic CLI's `_orchestrator-entry`/`_atomic-run`/`_emit-workflow-meta` subcommands. Token-gated, argv-side-effect-driven.
3. **Execution stratum** — `runtime/executor.ts`, `runtime/orchestrator-entry.ts`, `runtime/tmux.ts`, `runtime/offload-manager.ts`, `runtime/port-discovery.ts`, `runtime/attached-footer.ts`, `runtime/graph-inference.ts`, `runtime/status-writer.ts`. 100% tmux-coupled. `executeWorkflow` writes launcher script → tmux session → orchestrator pane runs `runOrchestrator(definition)` → `ctx.stage()` calls create tmux windows → per-stage agent CLI servers discovered via TCP port.
4. **Provider stratum** — `providers/claude.ts`, `providers/copilot.ts`, `providers/opencode.ts`, `providers/claude-stop-hook.ts`, `providers/claude-inflight-hook.ts`. 100% pinned to the three agent SDKs. The single switch in `initProviderClientAndSession` at `executor.ts:1589`.
5. **TUI stratum** — `components/*.tsx`, `tui/*.ts(x)`. OpenTUI/React-based. Agent-agnostic apart from `Session.tmux` field exposure in research-design prototypes and tmux mux options in `tui/mux.ts`.

**Custom Workflow Subprocess Protocol** (agent-agnostic, reusable):

- Atomic CLI spawns external workflow process with `_emit-workflow-meta` + `--dispatch-token=<hex>` + env `ATOMIC_HOST=1`, `ATOMIC_DISPATCH_TOKEN=<hex>`.
- External process reads `process.argv`, validates token via `validateDispatchToken` (`lib/dispatch-utils.ts`).
- Emits `ATOMIC_WORKFLOW_META: <json>\n` to stdout + `process.exit(0)`.
- For dispatch: spawns with `_atomic-run --dispatch-token=<token> --name=<name> --agent=<agent> --detach? --<input>=<value>...`.
- 5s default timeout via `ATOMIC_WORKFLOWS_META_TIMEOUT_MS`.

**Inversion Points for pi-coding-agent**:

1. **Orchestrator pane** — currently top-level tmux session spawning `_orchestrator-entry`. Rewrite: pi extension dynamically spawning a pane within pi's chat TUI.
2. **Agent provider layer** — currently `initProviderClientAndSession` switch over three SDKs. Rewrite: single pi-agent interface; provider files deleted.
3. **Auto-dispatch subcommands** — currently SDK-side argv intercept. Rewrite: native pi-coding-agent commands.
4. **Resume persistence** — currently `offload-manager.ts` with `metadata.json` + tmux window/session names. Rewrite: pi's native session persistence; metadata format is JSON, format-free.
5. **Marker-file IPC** — Claude Stop/HIL/Inflight hooks use `~/.atomic/claude-*/` marker dirs watched via `fs.watch`. Rewrite: pi's native event/hook system replaces marker-file protocol.
6. **AGENT_CONFIG record + `AgentKey` union** — `services/config/definitions.ts`. Rewrite: single `pi` entry, drop the union.

**Reusable Components** (carry-forward without rewrite):

- `define-workflow.ts` DSL (only callbacks need pi wiring).
- `registry.ts` immutable accumulation.
- `primitives/inputs.ts`, `primitives/metadata.ts`.
- Graph layout/connectors/node-card/workflow-picker (`components/layout.ts`, `connectors.ts`, etc.).
- `theme/colors.ts` Catppuccin palette.
- `lib/atomic-temp.ts`, `lib/spawn.ts`, `lib/common-ignore.ts`, `lib/workspace-paths.ts`.
- 43 SKILL.md files + skills-lock.json + `installGlobalSkills()` (with dest dirs adjusted).
- Custom workflow subprocess protocol (`_emit-workflow-meta`, `_atomic-run`, `ATOMIC_DISPATCH_TOKEN`).
- Telemetry event constants in `lib/telemetry/offload-events.ts`.
- Install scripts' platform-detection logic (Rosetta 2, musl, Windows ARM64) — agent-agnostic.
- Commander-based CLI structure (cli.ts, command modules).
- `rest-api/` (zero coupling; optional carry-forward or delete).

**Removable / Replace Entirely**:

- All of `packages/atomic-sdk/src/providers/*.ts`.
- All of `packages/atomic-sdk/src/runtime/tmux.ts` plus tmux consumers in `executor.ts`, `offload-manager.ts`, `chat/index.ts`, `install.ts:detectMuxBinary`, `auto-sync.ts:ensureTmuxInstalled`.
- All of `packages/atomic-sdk/src/workflows/builtin/*/claude|copilot|opencode/index.ts` (replaced with pi-targeted variants).
- Internal subcommands `_cc-debounce`, `_claude-*-hook` registered in `cli.ts:399-464`.
- `AGENT_KIND_BY_KEY`, `AGENT_DIR_PAIRS`, `AGENT_CONFIG` hardcoded triplets.
- `.devcontainer/{claude,copilot,opencode}/` per-agent manifests and the three GHCR feature subdirs (collapse to one `pi` feature).
- `auth.ts` Copilot/Claude auth probe.
- Three claude-\* hidden hook handlers in `packages/atomic/src/commands/cli/`.

## Code References

- `packages/atomic-sdk/src/runtime/executor.ts:86-111` — `AGENT_CLI` hardcoded record (the three agent CLIs).
- `packages/atomic-sdk/src/runtime/executor.ts:464-531` — `buildPaneCommand` and `waitForServer` (TCP port discovery for copilot/opencode).
- `packages/atomic-sdk/src/runtime/executor.ts:659-800` — `executeWorkflow` top-level orchestrator launcher.
- `packages/atomic-sdk/src/runtime/executor.ts:1589-1750` — `initProviderClientAndSession` agent switch + `cleanupProvider`.
- `packages/atomic-sdk/src/runtime/executor.ts:1861-end` — `createSessionRunner` per-stage spawn loop.
- `packages/atomic-sdk/src/runtime/tmux.ts:22` — `SOCKET_NAME = "atomic"`.
- `packages/atomic-sdk/src/runtime/tmux.ts:185-335` — `createSession`, `createWindow`, `respawnPane`.
- `packages/atomic-sdk/src/runtime/tmux.ts:459` — `RESERVED_WINDOW_NAMES = {"0", "orchestrator"}`.
- `packages/atomic-sdk/src/runtime/offload-manager.ts:49-122` — `filterSpawnEnv` + `persistResume`.
- `packages/atomic-sdk/src/providers/claude.ts:250` — `WORKFLOW_HOOK_SETTINGS`.
- `packages/atomic-sdk/src/providers/claude.ts:393` — `createClaudeSession`.
- `packages/atomic-sdk/src/providers/claude.ts:431` — `spawnClaudeWithPrompt`.
- `packages/atomic-sdk/src/providers/copilot.ts:61-180` — Copilot CLI path resolution, shim detection, resume args.
- `packages/atomic-sdk/src/providers/opencode.ts:25-95` — `HEADLESS_OPENCODE_CLIENT_ID`, `withHeadlessOpencodeEnv`, resume args.
- `packages/atomic-sdk/src/types.ts:7-30` — agent SDK type imports.
- `packages/atomic-sdk/src/types.ts:41-76` — `ClientOptionsMap`, `SessionOptionsMap`, `ClientMap`, `SessionMap`.
- `packages/atomic-sdk/src/types.ts:237` — `SavedMessage` discriminated union.
- `packages/atomic-sdk/src/define-workflow.ts:48-65` — `_captureCallerPath` stack-trace introspection.
- `packages/atomic-sdk/src/define-workflow.ts:140-156` — `RESERVED_INPUT_NAMES`, `validateWorkflowInput`.
- `packages/atomic-sdk/src/registry.ts:21-48` — `providerValidators`, `validateAtRegistration`.
- `packages/atomic-sdk/src/lib/auto-dispatch.ts` — argv side-effect for `_orchestrator-entry`/`_cc-debounce`.
- `packages/atomic-sdk/src/lib/host-local-workflows.ts:59-189` — `HOST_SUBS`, `lookupLocalWorkflow`, `hostLocalWorkflows`.
- `packages/atomic-sdk/src/services/config/definitions.ts:61-149` — `AgentKey`, `AGENT_CONFIG`, `ProviderOverrides`.
- `packages/atomic-sdk/src/services/config/scm-sync.ts:22-187` — `SCM_MCP_SERVERS`, `enabledServersFor`, `syncScmMcpServers`.
- `packages/atomic-sdk/src/components/orchestrator-panel-types.ts` — `SessionStatus`, `ViewMode`, `PanelSession`.
- `packages/atomic-sdk/src/components/workflow-picker-panel.tsx` — `WorkflowPicker`, `buildEntries`, `fuzzyMatch`.
- `packages/atomic/src/cli.ts:46-625` — full CLI tree.
- `packages/atomic/src/cli.ts:324-464` — internal hidden subcommands.
- `packages/atomic/src/commands/cli/chat/index.ts:91-446` — chat command implementation.
- `packages/atomic/src/commands/cli/workflow.ts:159-434` — workflow command, registry hot-swap.
- `packages/atomic/src/commands/custom-workflows.ts:52-391` — custom workflow loader.
- `packages/atomic/src/commands/builtin-registry.ts:9-36` — `createBuiltinRegistry`.
- `packages/atomic/src/commands/cli/install.ts:96-825` — install/uninstall full surface including `detectMuxBinary` at line 411.
- `packages/atomic/src/lib/embedded-assets.ts:15-100` — `BUNDLES`, `getEmbeddedAsset`.
- `packages/atomic/src/services/config/atomic-global-config.ts:13-342` — agent config sync.
- `packages/atomic/src/services/system/agents.ts:44-87` — `AGENT_DIR_PAIRS`, `installGlobalAgents`.
- `packages/atomic/src/services/system/skills.ts:27-50` — `SKILL_DEST_DIRS`, `installGlobalSkills`.
- `packages/atomic/src/services/system/auto-sync.ts:82-108` — `autoSyncIfStale` step list.
- `packages/atomic/bin/atomic:1-83` — Node.js binary wrapper.
- `packages/atomic/script/build.ts:50-100` — `bundleEmbeddedAssets`.
- `packages/atomic/script/build-assets.ts:46-100` — skills tar packing (MAX_TARRED_PATH_CHARS=150).
- `packages/atomic/script/bump-version.ts:54-92` — version parsing.
- `install.sh:24` — `RELEASES_BASE` GitHub URL.
- `install.sh:104-113` — musl libc detection.
- `install.sh:94-98` — Rosetta 2 detection.
- `install.ps1:77-98` — retry loop.
- `install.cmd:54-58` — Windows ARM64/x64 detection.
- `.devcontainer/features/claude/install.sh:7-9` — duplicate-script warning.
- `scripts/lint-offload-await.ts:48-88` — `checkAwaitOrCatch`, `checkSwitchClientGate`.
- `scripts/lint-custom-workflows.ts:25-62` — registry-alias-pattern guard.
- `tests/ci/onboarding.test.ts:159-172` — `EXPECTED` per-agent onboarding file invariants.
- `tests/fixtures/sdk-compiled-consumer/scripts/smoke.ts:54-227` — 6-step matrix.
- `tests/sdk/runtime/tmux.test.ts:6-664` — full tmux abstraction contract.
- `tests/sdk/providers/claude-wait-for-idle.test.ts:31-317` — Claude marker-file watcher tests.

## Historical Context (from research/)

The research/ directory contains 198 historical research and design documents accumulated during development. Relevant to the rewrite:

- `specs/2026-05-03-atomic-package-split.md` — Documents the current single-package state and the planned 3-way split (CLI shim + SDK library + platform-specific compiled binaries) modelled on OpenCode; Windows MAX_PATH root cause documented.
- `specs/2026-05-08-workflow-pane-offload-and-resume.md` — Catalogues every tmux spawn point, per-provider resume flags (`claude --resume <UUID>`, `opencode --session <sessionId>`, `copilot --resume=<session-id>`), and the load-bearing executor.ts lines. Proposes new `OffloadManager` + `tmux.killWindow()` (deepens tmux surface further).
- `specs/2026-05-07-custom-workflows-settings-json.md` — Settings schema, builtin registry location, SDK auto-dispatch interceptor, `_emit-workflow-meta` and `_atomic-run` subprocess protocol.
- `specs/2026-05-06-sdk-self-contained-runworkflow.md` (§11.7 authoritative) — Final dispatcher design eliminating earlier boilerplate. `runWorkflow` auto-defaults `pathToAtomicExecutable` via `isCompiledBinaryRuntime`; SDK barrel installs synchronous argv side-effect via `lib/auto-dispatch.ts`. Deleted in this change: `packages/atomic-sdk/src/cli.ts`, `packages/atomic-sdk/src/dispatcher.ts`, `./dispatcher` export, `packages/atomic/src/lib/run-workflow-with-self.ts`.
- `research/docs/2026-03-13-codebase-architecture-modularity-analysis.md` — Authoritative 576-file module map (older pre-split numbering), full dependency matrix, circular-dep pairs. Notes: load-bearing finding that `WorkflowSDK` class is bypassed at runtime (Ralph uses hardcoded `if (metadata.name === "ralph")`); non-Ralph workflows get no-op handlers. Fan-in hotspot: `services/agents/types.ts` (109 imports). Nine circular dependency pairs documented.
- `research/docs/2026-01-31-sdk-migration-and-graph-execution.md` — Proposed `CodingAgentClient` unified interface (`createSession`, `resumeSession`, `send`, `stream`, `on`, `registerTool`, `start`, `stop`) plus declarative graph workflow API (`.then().if().else().loop()`).
- `research/docs/2026-02-12-tui-layout-streaming-content-ordering.md` — Documents SDK event normalisation for the three agents (Claude `QueryAsyncIterable`, OpenCode SSE, Copilot 31 event types).
- `research/docs/2026-02-16-atomic-chat-architecture-current.md` — `buildContentSegments` offset-based chronological renderer; deferred completion pattern for parallel sub-agents.
- `research/docs/2026-03-01-opencode-auto-compaction.md` — Auto-compaction triple comparison: Copilot native events, Claude exceptions, OpenCode manual `session.summarize()`.
- `research/designs/workflow-picker-tui.tsx`, `session-graph-tui.tsx` — Component prototypes showing `AgentType` union and `Session.tmux` field as design-time coupling points.

## Open Questions

- Whether the `@anthropic-ai/claude-agent-sdk` optional-dep inline behaviour inside `bun build --compile` binaries has been empirically verified across all distribution targets (flagged as still-open per `specs/2026-05-03`).
- macOS/Windows code signing for the compiled binaries (deferred per `specs/2026-05-03`).
- Final post-split `tests/` location (TBD per `specs/2026-05-03`).
- Whether the `OffloadManager` full body (resume, rollback, eligibility — only `persistResume`/`filterSpawnEnv` were read in the analyzer's first 200 lines) carries additional tmux coupling beyond what's documented.
- Whether `WorkflowPickerPanel`'s OpenTUI `SyntaxStyle` resources have been audited for the `useEffect` cleanup pattern (per codebase memory).
- Whether pi-coding-agent requires equivalents to the three Claude marker-file directories (`claude-ready/`, `claude-hil/`, `claude-inflight/`, `claude-stop/`) or if pi's native event system supersedes the entire marker protocol.

## Methodology

Generated by the deep-research-codebase workflow with 12 partitions covering 498 source files (114,799 LOC). Each partition was investigated by four specialist sub-agents dispatched directly via the provider SDK's native agent parameter: codebase-locator, codebase-pattern-finder, codebase-analyzer, and codebase-online-researcher. A separate research-history pipeline ran codebase-research-locator → codebase-research-analyzer over the project's prior research documents.
