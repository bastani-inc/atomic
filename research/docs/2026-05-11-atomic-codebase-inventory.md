Now I have a comprehensive understanding of the entire codebase. Let me compile the full inventory.

---

## Atomic CLI Codebase Inventory

---

## Partition 1: CLI Entry & Commands

### Entry Point

1. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/bin/atomic` — Node.js shim, detects platform/arch/libc suffix, resolves `@bastani/atomic-<platform>-<arch>[-musl]` optional dep and `spawnSync` the real binary — DEPS: [fs, node:child_process, node:os] [REUSABLE]

2. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/cli.ts:46–624` — `createProgram()`, `program`, `main()` — mounts all Commander subcommands, runs `bootstrapCustomWorkflowsAndRebuild()`, calls `autoSyncIfStale()` and `ensureGlobalAtomicSettings()` on startup — DEPS: [@commander-js/extra-typings, @bastani/atomic-sdk, fs] [PORTABLE-TO-EXTENSION]

### Subcommand files

3. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/chat/index.ts:1–446` — `chatCommand()`, `buildAgentArgs()`, `buildLauncherScript()`, `resolveChatCommand()` — spawns the agent CLI in a new tmux session with an attached footer, writes a launcher .sh/.ps1 script for safe arg quoting — DEPS: [tmux, claude, copilot, opencode, @bastani/atomic-sdk] [REMOVE-CANDIDATE for tmux; PORTABLE-TO-EXTENSION for agent dispatch]

4. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/workflow.ts:1–434` — `buildWorkflowCommand()`, `workflowCommand`, `rebuildWorkflowCommand()`, `dispatch()`, `blockIfBroken()`, `buildExternalDispatchArgv()` — Commander workflow command with dynamic `--<input>` flags, interactive picker integration, hot-swappable registry — DEPS: [@bastani/atomic-sdk, opentui] [PORTABLE-TO-EXTENSION]

5. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/workflow-list.ts` — `workflowListCommand()` — prints builtin+custom registry filtered by agent — DEPS: [@bastani/atomic-sdk] [REUSABLE]

6. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/workflow-inputs.ts` — `workflowInputsCommand()`, `buildInputsPayload()` — prints workflow input schema as JSON/text — DEPS: [@bastani/atomic-sdk] [REUSABLE]

7. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/workflow-status.ts` — `workflowStatusCommand()`, `WorkflowStatusReport` — reads `status.json` + tmux session liveness — DEPS: [tmux, @bastani/atomic-sdk, fs] [REMOVE-CANDIDATE tmux half; PORTABLE-TO-EXTENSION status-file half]

8. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/workflow-read.ts` — `workflowReadCommand()` — resolves on-disk path to a workflow run or stage dir under `~/.atomic/sessions/` — DEPS: [fs, @bastani/atomic-sdk] [REUSABLE]

9. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/workflow-refresh.ts` — `workflowRefreshCommand()` — re-spawns metadata loaders, reports loaded/broken — DEPS: [@bastani/atomic-sdk] [REUSABLE]

10. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/session.ts` — `sessionListCommand()`, `sessionConnectCommand()`, `sessionPickerCommand()`, `sessionKillCommand()` — wraps tmux listing/attach behind @clack/prompts picker — DEPS: [tmux, @clack/prompts, @bastani/atomic-sdk] [REMOVE-CANDIDATE]

11. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/management-commands.ts` — `addSessionSubcommand()` — attaches `session list/connect/kill` to any Commander parent — DEPS: [@commander-js/extra-typings] [PORTABLE-TO-EXTENSION]

12. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/config.ts` — `configCommand()` — handles `atomic config set telemetry|scm` — DEPS: [@clack/prompts, @bastani/atomic-sdk] [REUSABLE]

13. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/init.ts` — Commander `init` shim that delegates to `init/index.ts` — DEPS: [other]

14. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/init/index.ts` — `ensureProjectSetup()` — runs onboarding files, scm-sync, opencode instruction reconcile — DEPS: [claude, copilot, opencode, fs] [REMOVE-CANDIDATE for agent-specific sync; PORTABLE-TO-EXTENSION for generic file-merge]

15. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/init/onboarding.ts` — `applyManagedOnboardingFiles()`, `hasProjectOnboardingFiles()` — merge-copies bundled JSON templates into project — DEPS: [claude, copilot, opencode, fs] [PORTABLE-TO-EXTENSION]

16. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/install.ts` — `installCommand()`, `uninstallCommand()`, `getInstallPaths()`, `copyBinary()` — self-installs the binary, PATH, completions — DEPS: [fs] [REUSABLE]

17. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/update.ts` — `updateCommand()` — self-update from GitHub Releases with sha256 verify — DEPS: [fs, @clack/prompts] [REUSABLE]

18. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/install-method.ts` — `detectInstallMethod()` — detects standalone vs bun/npm/pnpm/yarn package manager install — DEPS: [fs] [REUSABLE]

19. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/completions.ts` — `completionsCommand()` — outputs shell completion script for bash/zsh/fish/powershell — DEPS: [other] [REUSABLE]

20. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/claude-ask-hook.ts` — `claudeAskHookCommand()` — writes/removes HIL marker for `AskUserQuestion` pre/post tool hooks — DEPS: [claude, fs] [REMOVE-CANDIDATE]

21. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/claude-session-start-hook.ts` — `claudeSessionStartHookCommand()` — writes readiness marker when Claude fires SessionStart hook — DEPS: [claude, fs] [REMOVE-CANDIDATE]

22. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/runtime-assets-smoke.ts` — `runtimeAssetsSmokeCommand()` — verifies bundled tmux.conf materialises for CI smoke tests — DEPS: [tmux, fs] [REMOVE-CANDIDATE]

23. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/builtin-registry.ts` — `createBuiltinRegistry()` — assembles atomic CLI's builtin registry (ralph, deep-research-codebase, open-claude-design × 3 agents each) — DEPS: [claude, copilot, opencode, @bastani/atomic-sdk] [REMOVE-CANDIDATE for per-agent variants; structure PORTABLE-TO-EXTENSION]

24. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/custom-workflows.ts` — `loadCustomWorkflows()`, `bootstrapCustomWorkflows()` — spawns external commands with `_emit-workflow-meta`, parses metadata JSON — DEPS: [fs, @bastani/atomic-sdk] [REUSABLE]

25. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/completions/bash.ts`, `zsh.ts`, `fish.ts`, `powershell.ts` — completion script generators — DEPS: [other] [REUSABLE]

26. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/version.ts` — `VERSION` constant — DEPS: [other] [REUSABLE]

27. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/info-command-skip.ts` — `isInfoCommandArgv()` — recognizes `--version`/`--help` so auto-sync is skipped — DEPS: [other] [REUSABLE]

28. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/theme/logo.ts` — `displayBlockBanner()`, `ATOMIC_BLOCK_LOGO`, gradient colorizers — DEPS: [@catppuccin/palette] [REUSABLE]

### Build / bump scripts

29. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/script/bump-version.ts` — reads/writes version in `package.json`; supports `--from-branch` — DEPS: [fs] [REUSABLE]

30. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/script/build.ts` — drives `bun build --compile` for each platform target — DEPS: [fs] [REUSABLE]

31. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/script/build-assets.ts` — bundles `.claude.tar`, `.opencode.tar`, `.github.tar`, `skills.tar` embedded assets — DEPS: [claude, copilot, opencode, fs] [REMOVE-CANDIDATE per-agent tarballs; tarball mechanism PORTABLE-TO-EXTENSION]

32. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/script/bundle-configs.ts` — generates the agent config tarballs pre-compile — DEPS: [claude, copilot, opencode, fs] [REMOVE-CANDIDATE]

33. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/script/publish.ts`, `release-assets.ts`, `targets.ts`, `clean-dist.ts` — npm publish + GitHub Release asset management — DEPS: [fs] [REUSABLE]

---

## Partition 2: TUI Layer

All TUI components live in `packages/atomic-sdk/src/components/` and use `@opentui/react` JSX.

34. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/orchestrator-panel.tsx:30–` — `OrchestratorPanel` class — imperative bridge for executor → React tree; owns `CliRenderer`, `PanelStore`, `createRoot`, offload-manager context, `TuiDiagnostics`; exposes `addSession()`, `updateSession()`, `showCompletion()`, `showFatalError()`, `waitForExit()` — DEPS: [opentui, tmux] [REMOVE-CANDIDATE for tmux context; opentui coupling heavy]

35. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/session-graph-panel.tsx:69–` — `SessionGraphPanel` — main graph component; keyboard nav (↑↓/j/k/Enter/gg/"/" switcher/q), `computeLayout`, pulse animation at 60ms, `decideAttachAction()` determines resume vs switch-client — DEPS: [opentui, tmux] [REMOVE-CANDIDATE]

36. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/node-card.tsx:9–` — `NodeCard` — renders a single session graph node with animated border pulse, status color, duration — DEPS: [opentui] [REMOVE-CANDIDATE]

37. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/header.tsx:32–` — `Header` — shows workflow name, status count badges, elapsed duration, fatal-error band — DEPS: [opentui] [REMOVE-CANDIDATE]

38. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/compact-switcher.tsx:15–` — `CompactSwitcher` — "/" popup list of all stages for direct jump — DEPS: [opentui] [REMOVE-CANDIDATE]

39. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/toast.tsx` — `ToastStack` — top-right nvim-style notification cards, auto-dismissed via PanelStore timers — DEPS: [opentui] [REMOVE-CANDIDATE]

40. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/edge.tsx` — `Edge` — renders connector lines between graph nodes (SVG-style box-drawing chars) — DEPS: [opentui] [REMOVE-CANDIDATE]

41. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/error-boundary.tsx` — `ErrorBoundary` — React class error boundary with fallback render prop — DEPS: [opentui] [REUSABLE pattern, but opentui-JSX specific]

42. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/workflow-picker-panel.tsx:29–` — `WorkflowPickerPanel` — telescope-style fuzzy picker, two-phase PICK → PROMPT → CONFIRM flow; owns its own `CliRenderer` and `createRoot`; exposes `waitForSelection()` — DEPS: [opentui] [REMOVE-CANDIDATE]

43. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/orchestrator-panel-store.ts:21–` — `PanelStore` — Zustand-lite pub/sub store owning all session state, toasts, viewMode, completion/fatalError state; `subscribe(fn)` pattern — DEPS: [other] [PORTABLE-TO-EXTENSION store interface]

44. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/orchestrator-panel-types.ts` — `SessionData`, `SessionStatus`, `ViewMode`, `PanelSession`, `PanelOptions`, `SYNTHETIC_ORCHESTRATOR_NAME` — DEPS: [other] [REUSABLE type definitions]

45. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/orchestrator-panel-contexts.ts` — `StoreContext`, `ThemeContext`, `TmuxSessionContext`, `OffloadManagerContext`, hooks `useStore()`, `useGraphTheme()`, `useStoreVersion()`, `useOffloadManager()` — DEPS: [opentui, tmux] [REMOVE-CANDIDATE for TmuxSessionContext]

46. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/layout.ts` — `computeLayout()`, `NODE_W`, `NODE_H`, `LayoutNode` — converts flat `SessionData[]` to a 2D grid DAG layout — DEPS: [other] [REUSABLE]

47. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/connectors.ts` — `buildConnector()`, `buildMergeConnector()`, `ConnectorResult` — calculates box-drawing character paths for graph edges — DEPS: [other] [REUSABLE]

48. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/graph-theme.ts` — `deriveGraphTheme()`, `GraphTheme` — maps `TerminalTheme` to component-level color tokens — DEPS: [other] [REUSABLE]

49. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/status-helpers.ts` — `statusColor()`, `statusIcon()`, `fmtDuration()` — pure status-to-color/icon helpers — DEPS: [other] [REUSABLE]

50. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/color-utils.ts` — `lerpColor()` — hex color interpolation — DEPS: [other] [REUSABLE]

51. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/renderer-background.ts` — `setRendererBackground()`, `resetRendererTerminalBackground()`, `requestRendererBackgroundRepaint()` — manages opentui renderer background color sync — DEPS: [opentui] [REMOVE-CANDIDATE]

52. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/tui-diagnostics.ts` — `TuiDiagnostics`, `createTuiDiagnostics()` — records renderer timing snapshots for debug — DEPS: [opentui] [REMOVE-CANDIDATE]

53. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/hooks.ts` — `useLatest()` — stable ref-to-latest-value hook — DEPS: [other] [REUSABLE]

### Footer / statusline TUI sub-package

54. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/tui/attached-statusline.tsx` — `attachedStatusline()`, `backgroundTasksValue()`, `BACKGROUND_TASKS_OPTION`, `ORCHESTRATOR_WINDOW_NAME` — JSX tree compiled to tmux format-string status-line — DEPS: [tmux] [REMOVE-CANDIDATE]

55. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/tui/compiler/parser.ts` — `compile()` — walks React element tree to emit tmux `#[…]` format strings — DEPS: [other] [REMOVE-CANDIDATE if tmux removed; the pattern is PORTABLE]

56. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/tui/compiler/styles.ts` — `inlineStyle()`, `styleAttributes()` — converts CSS-like style props to tmux attribute strings — DEPS: [tmux] [REMOVE-CANDIDATE]

57. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/tui/components.tsx` — `Box`, `Footer`, `FooterLeft`, `FooterRight`, `Text` — JSX intrinsics for the status-line compiler — DEPS: [other] [REMOVE-CANDIDATE if compiler removed]

58. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/tui/mux.ts` — `setOption()`, `setOptionRaw()`, `setWindowOption()`, `setGlobalWindowOption()`, `setStatuslineState()` — thin wrappers around `tmuxRun` for status-line option writes — DEPS: [tmux] [REMOVE-CANDIDATE]

59. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/tui/renderer.ts` — `renderFooter()`, `clearFooter()` — calls `compile()` and invokes `setOption` to apply the result — DEPS: [tmux] [REMOVE-CANDIDATE]

60. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/tui/globals.ts`, `types.ts` — tmux status-line type definitions and tmux global defaults — DEPS: [tmux] [REMOVE-CANDIDATE]

61. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/tui/index.ts` — re-exports all tui sub-package public symbols — DEPS: [tmux] [REMOVE-CANDIDATE]

---

## Partition 3: Workflow Orchestrator

62. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/executor.ts` (large) — `executeWorkflow()`, `runOrchestrator()` — creates the workflow tmux session with an orchestrator pane, spawns `_orchestrator-entry` hidden command, attaches client; contains the per-stage lifecycle: `createAgentSession()`, `claudeQuery()`, `waitForIdle()`, the HIL loop, DAG execution via `GraphFrontierTracker`, transcript save, cleanup — DEPS: [tmux, claude, copilot, opencode, opentui, fs] [REMOVE-CANDIDATE heavily; core DAG logic PORTABLE-TO-EXTENSION]

63. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/orchestrator-entry.ts` — `runOrchestratorEntry()`, `runOrchestratorWithDefinition()`, `resolveWorkflowDefinition()` — entry point spawned in the orchestrator pane; resolves workflow via `hostLocalWorkflows` registry or `mod.default`, then calls `runOrchestrator()` — DEPS: [opentui, tmux, fs] [PORTABLE-TO-EXTENSION resolution logic]

64. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/graph-inference.ts` — `GraphFrontierTracker` — frontier-based automatic parent/child edge inference for sequential/parallel/fan-in stage patterns — DEPS: [other] [REUSABLE]

65. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/status-writer.ts` — `buildSnapshot()`, `writeSnapshot()`, `readSnapshot()`, `workflowRunIdFromTmuxName()`, `WorkflowStatusSnapshot` — writes/reads `~/.atomic/sessions/<runId>/status.json` — DEPS: [fs] [REUSABLE schema; PORTABLE-TO-EXTENSION for output format]

66. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/panel.tsx` — `OrchestratorPanel` re-export barrel from `components/` — DEPS: [opentui] [REMOVE-CANDIDATE]

67. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/offload-manager.ts` — `createOffloadManager()`, `OffloadManager`, `filterSpawnEnv()`, `persistResume()` — implements the "offload pane + resume" state machine: registers sessions, kills tmux windows on offload, re-spawns agents on resume — DEPS: [tmux, claude, fs] [REMOVE-CANDIDATE offload/resume is tmux-specific]

68. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/offload-types.ts` — `OffloadResumeMetadata`, `MetadataJsonWithResume`, `AgentKind` — disk-persisted schema for offload/resume state (schemaVersion=1) — DEPS: [other] [PORTABLE-TO-EXTENSION the on-disk metadata concept]

69. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/primitives/run.ts` — `runWorkflow()`, `RunWorkflowOptions`, `RunWorkflowResult` — public entry point; validates inputs then calls `executeWorkflow()`; imports `auto-dispatch.ts` as a side effect — DEPS: [tmux, claude, copilot, opencode, fs] [PORTABLE-TO-EXTENSION interface]

70. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/primitives/sessions.ts` — `listSessions()`, `getSession()`, `stopSession()`, `attachSession()`, `getSessionStatus()`, `gotoOrchestrator()`, `getSessionTranscript()`, `SessionInfo`, `SessionPrimitiveDeps` — session-management primitives over tmux + status-writer — DEPS: [tmux, fs] [REMOVE-CANDIDATE for tmux wrappers; transcript/status PORTABLE-TO-EXTENSION]

71. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/primitives/inputs.ts` — `validateInputs()`, `ResolvedInputs` — validates workflow input map against declared schema, applies defaults — DEPS: [other] [REUSABLE]

72. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/primitives/metadata.ts` — `getName()`, `getDescription()`, `getAgent()`, `getInputSchema()`, `getSource()`, `getMinSDKVersion()` — accessor helpers for `WorkflowDefinition` fields — DEPS: [other] [REUSABLE]

73. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/lib/auto-dispatch.ts` — `findSub()`, `validateDispatchToken()` re-exports; argv side-effect that intercepts `_orchestrator-entry` and `_cc-debounce` at module load — DEPS: [tmux, fs] [PORTABLE-TO-EXTENSION dispatch pattern]

74. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/lib/host-local-workflows.ts` — `hostLocalWorkflows()`, `lookupLocalWorkflow()` — handles `_emit-workflow-meta` and `_atomic-run` internal argv sub-commands for third-party hosts — DEPS: [fs] [PORTABLE-TO-EXTENSION]

75. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/lib/dispatch-utils.ts` — `validateDispatchToken()`, `parseAtomicRunArgv()`, `findSub()`, `AtomicRunArgs` — pure argv parsing helpers for dispatch protocol — DEPS: [other] [REUSABLE]

76. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/cc-debounce.ts` — `runCcDebounce()`, `shouldForward()`, `QUIET_MS` — Ctrl+C debounce for tmux panes, writes state file to `~/.atomic/tmp/` — DEPS: [tmux, fs] [REMOVE-CANDIDATE]

77. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/port-discovery.ts` — `getListeningPortForPid()`, `PORT_DISCOVERY_TIMEOUT_MS` — polls `/proc/<pid>/net/tcp` (Linux), `lsof` (macOS), PowerShell (Windows) to find listening TCP port for opencode server process — DEPS: [opencode, fs] [REMOVE-CANDIDATE for opencode]

78. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/shell-quote.ts` — `shellQuote()` — cross-platform shell argument quoting — DEPS: [other] [REUSABLE]

79. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/version-compat.ts` — version compatibility check helpers — DEPS: [other] [REUSABLE]

80. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/executor-env.ts` — `buildPaneCommand()` and env construction helpers for pane spawn — DEPS: [tmux] [REMOVE-CANDIDATE]

81. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/theme.ts` — `resolveTheme()`, `TerminalTheme` — detects dark/light terminal background, returns color theme — DEPS: [other] [REUSABLE]

### Workflow status/read CLI commands

82. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/workflow-status.ts` — (listed above, entry 7)

83. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/workflow-read.ts` — (listed above, entry 8)

84. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/workflow-refresh.ts` — (listed above, entry 9)

---

## Partition 4: Agent Adapters

### Claude adapter [REMOVE-CANDIDATE]

85. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/providers/claude.ts` — `ClaudeClientWrapper`, `ClaudeSessionWrapper`, `createClaudeSession()`, `claudeQuery()`, `clearClaudeSession()`, `extractAssistantText()`, `validateClaudeWorkflow()`, `ensureWorkflowHookSettings()`, `buildClaudeResumeArgs()`, `claudeOffloadCleanup()`, `HeadlessClaudeClientWrapper`, `HeadlessClaudeSessionWrapper` — tmux-send-keys delivery + fs.watch JSONL idle detection; hooks into `@anthropic-ai/claude-agent-sdk` for headless reviewer stages; registers Claude Code Stop/SessionStart/Inflight/AskUserQuestion hooks — DEPS: [tmux, claude/claude-agent-sdk, fs] [REMOVE-CANDIDATE]

86. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/providers/claude-stop-hook.ts` — `claudeStopHookCommand()`, `claudeHookDirs()`, `ClaudeStopHookPayload` — reads stdin JSON from Claude's Stop hook, writes marker file, block-polls queue dir for follow-up prompts, emits `{"decision":"block","reason":…}` to continue the agent loop — DEPS: [claude, fs] [REMOVE-CANDIDATE]

87. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/providers/claude-inflight-hook.ts` — `claudeInflightHookCommand()`, `waitForInflightDrained()`, `clearInflightTracking()`, `inflightDirIsEmpty()`, `sweepStaleInflight()`, `ClaudeInflightHookPayload` — SubagentStart/Stop/TeammateIdle hook handler; per-session in-flight marker dir — DEPS: [claude, fs] [REMOVE-CANDIDATE]

88. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/claude-ask-hook.ts` — `claudeAskHookCommand()` — writes/removes HIL marker at `~/.atomic/claude-ask/<session_id>` — DEPS: [claude, fs] [REMOVE-CANDIDATE]

89. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/claude-session-start-hook.ts` — `claudeSessionStartHookCommand()` — (entry 21 above) [REMOVE-CANDIDATE]

90. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/claude-inflight-hook.test.ts`, `claude-ask-hook.test.ts`, `claude-stop-hook.test.ts` — tests for the three Claude hook commands [REMOVE-CANDIDATE]

### Copilot adapter [REMOVE-CANDIDATE]

91. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/providers/copilot.ts` — `isCopilotShim()`, `enumeratePathCandidates()`, `resolveCopilotCliPath()`, `copilotSubprocessEnv()`, `buildCopilotResumeArgs()`, `validateCopilotWorkflow()`, `CopilotClientOptions`, `copilotSdkLaunchOptions()` — resolves non-shim copilot binary, validates workflow source, builds resume args — DEPS: [copilot, fs] [REMOVE-CANDIDATE]

92. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/services/config/scm-sync.ts` — `copilotScmDisableFlags()`, `getCopilotScmDisableFlags()`, `syncClaudeDisabledMcpServers()`, `syncOpencodeMcpServers()` — reads `.atomic/settings.json` scm field, updates `.claude/settings.json` disabledMcpjsonServers and `.opencode/opencode.json` mcp.enabled flags — DEPS: [claude, copilot, opencode, fs] [REMOVE-CANDIDATE most; generic JSON-edit PORTABLE-TO-EXTENSION]

### OpenCode adapter [REMOVE-CANDIDATE]

93. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/providers/opencode.ts` — `withHeadlessOpencodeEnv()`, `HEADLESS_OPENCODE_CLIENT_ID`, `buildOpencodeResumeArgs()`, `validateOpenCodeWorkflow()` — sets `OPENCODE_CLIENT=sdk` env for headless stages, builds resume args for opencode session — DEPS: [opencode, fs] [REMOVE-CANDIDATE]

### Auth probes (per-agent, all REMOVE-CANDIDATE)

94. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/services/system/auth.ts` — `checkAgentAuth()`, `checkCopilotAuth()`, `checkClaudeAuth()`, `printAuthError()` — pre-flight auth probes using copilot SDK `getAuthStatus()` and claude SDK `query().initializationResult()` — DEPS: [claude, copilot] [REMOVE-CANDIDATE]

### Streaming event model

The current "event bus" is not an explicit event emitter. Claude uses `fs.watch` on a JSONL transcript file plus a Stop hook marker file (`~/.atomic/claude-stop/<session_id>`). Idle is detected by watching for the marker file and polling `session_state_changed` events in the JSONL. Copilot uses `@github/copilot-sdk`'s `session.prompt()` which returns an async iterator of `SessionEvent`. OpenCode uses `@opencode-ai/sdk/v2`'s `session.prompt().data` (the full `{ info, parts }` response).

---

## Partition 5: tmux Integration

Every file in this partition is [REMOVE-CANDIDATE].

95. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/tmux.ts:1–836` — `getMuxBinary()`, `resetMuxBinaryCache()`, `isTmuxInstalled()`, `isInsideTmux()`, `isInsideAtomicSocket()`, `tmuxRun()`, `createSession()`, `createWindow()`, `createPane()`, `respawnPane()`, `sendLiteralText()`, `sendViaPasteBuffer()`, `sendSpecialKey()`, `capturePane()`, `capturePaneVisible()`, `capturePaneScrollback()`, `killSession()`, `killWindow()`, `RESERVED_WINDOW_NAMES`, `sessionExists()`, `setSessionEnv()`, `getSessionEnv()`, `listSessions()`, `parseListSessionsOutput()`, `parseSessionName()`, `attachSession()`, `spawnMuxAttach()`, `switchClient()`, `getCurrentSession()`, `attachOrSwitch()`, `detachClients()`, `detachAndAttachAtomic()`, `selectWindow()`, `nextWindow()`, `previousWindow()`, `normalizeTmuxCapture()`, `normalizeTmuxLines()` — complete tmux/psmux session management, pane management, keystroke delivery, pane capture, session lifecycle — DEPS: [tmux, fs] [REMOVE-CANDIDATE]

96. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/attached-footer.ts` — `spawnAttachedFooter()` — calls `attachedStatusline()` → `renderFooter()` → tmux `set-option` to render the status-line footer — DEPS: [tmux] [REMOVE-CANDIDATE]

97. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/tui/mux.ts` — (entry 58) [REMOVE-CANDIDATE]

98. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/cc-debounce.ts` — (entry 76) [REMOVE-CANDIDATE]

99. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/lib/runtime-assets.ts` — `tmuxConfPath`, `materializeRuntimeAsset()`, `runtimeAssetsCacheDir()` — materializes `tmux.conf` from Bun virtual FS to `~/.atomic/runtime/<sdk-version>/tmux.conf` — DEPS: [tmux, fs] [REMOVE-CANDIDATE]

100.    `packages/atomic-sdk/src/runtime/tmux.conf` (binary asset) — bundled tmux config defining `C-c` debounce binding via `@atomic-cc-debounce` user option — DEPS: [tmux] [REMOVE-CANDIDATE]

101.    `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/lib/spawn.ts:1–` — `ensureTmuxInstalled()`, `upgradeGlobalToolPackages()`, `hasRequiredMuxBinary()`, `requiredMuxBinaryCandidatesForPlatform()`, `runCommand()` — installs tmux/psmux from GitHub releases, wraps `Bun.spawn` — DEPS: [tmux, fs] [REMOVE-CANDIDATE tmux install; generic spawn REUSABLE]

102.    `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/lib/self-exec.ts` — `resolveDispatcher()`, `buildSelfExecCommand()`, `Dispatcher` — resolves the binary/bun+cli for spawning `_orchestrator-entry` / `_cc-debounce` subprocesses in tmux; used by `createSession()` — DEPS: [tmux] [REMOVE-CANDIDATE tmux-spawn usage; generic self-exec concept PORTABLE-TO-EXTENSION]

103.    `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/session.ts` — (entry 10) [REMOVE-CANDIDATE]

104.    `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/management-commands.ts` — (entry 11) — but session commands reference tmux [REMOVE-CANDIDATE session subcommands; Commander builder pattern REUSABLE]

---

## Partition 6: Skills / Prompts / Sub-agents / MCP Loading

105. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/services/system/skills.ts` — `installGlobalSkills()` — copies bundled `.agents/skills.tar` to `~/.agents/skills` and `~/.claude/skills` — DEPS: [claude, fs] [PORTABLE-TO-EXTENSION for generic skill-dir copy]

106. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/services/system/agents.ts` — `installGlobalAgents()` — copies bundled `.claude/agents`, `.opencode/agents`, `.github/agents` → `~/.claude/agents`, `~/.opencode/agents`, `~/.copilot/agents` — DEPS: [claude, copilot, opencode, fs] [REMOVE-CANDIDATE agent-specific paths; copy helper PORTABLE-TO-EXTENSION]

107. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/services/config/atomic-global-config.ts` — `ensureAtomicGlobalAgentConfigs()`, `syncGlobalAgentConfig()` — syncs bundled template dirs into provider home roots (`.claude`, `.opencode`, `.copilot`) using `syncJsonFile()` — DEPS: [claude, copilot, opencode, fs] [REMOVE-CANDIDATE]

108. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/services/config/additional-instructions.ts` — `ADDITIONAL_INSTRUCTIONS`, `seedGlobalAdditionalInstructions()`, `resolveAdditionalInstructionsPath()`, `resolveAdditionalInstructionsContent()`, `reconcileOpencodeInstructions()` — manages `~/.atomic/AGENTS.md` seed file, resolves project-local vs global path, reconciles into `.opencode/opencode.json` — DEPS: [claude, copilot, opencode, fs] [PORTABLE-TO-EXTENSION seed concept; provider-specific reconcile REMOVE-CANDIDATE]

109. `.agents/skills/` (directory, ~170 SKILL.md files) — bundled agent skills (impeccable, tdd, opentui, bun, workflow-creator, etc.) — DEPS: [other] [REUSABLE as content]

110. `.claude/agents/` — Claude Code sub-agent definitions (orchestrator, worker, planner, reviewer, debugger, etc.) — DEPS: [claude] [REMOVE-CANDIDATE]

111. `.claude/.mcp.json` — Claude Code project-level MCP server configuration — DEPS: [claude] [REMOVE-CANDIDATE]

112. `.claude/settings.json` — Claude Code project-level hooks config (Stop, SessionStart, PreToolUse/PostToolUse AskUserQuestion, SubagentStart/Stop, TeammateIdle hooks all pointing to `atomic _claude-*`) — DEPS: [claude] [REMOVE-CANDIDATE]

113. `.opencode/opencode.json` (template in embedded .opencode.tar) — OpenCode project config with MCP servers, instructions, experimental LSP — DEPS: [opencode] [REMOVE-CANDIDATE]

114. `.github/` (template in embedded .github.tar) — Copilot CLI config (lsp.json, MCP, agents) — DEPS: [copilot] [REMOVE-CANDIDATE]

115. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/lib/common-ignore.ts` — `createCommonIgnoreFilter()` — ignores `.git`, `node_modules`, `.DS_Store` during dir copies — DEPS: [fs] [REUSABLE]

MCP discovery: `scm-sync.ts` reads `.claude/settings.json` and `.opencode/opencode.json` to toggle MCP server `enabled` flags. The project-level `.mcp.json` is synced from the embedded `claude` bundle via `applyManagedOnboardingFiles`. No dedicated "MCP discovery" service — discovery is handled by each agent CLI natively given the merged config files on disk.

At-command parsing for workflow picker: `workflow.ts`:`workflowCommand` wires the interactive picker directly from Commander's `action` handler when `--name` is absent but `--agent` is present in a TTY.

---

## Partition 7: Atomic SDK (`@bastani/atomic-sdk`)

### Public barrel exports (`src/index.ts:1–122`)

116. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/index.ts` — re-exports: `MissingDependencyError`, `WorkflowNotCompiledError`, `InvalidWorkflowError`, `SessionNotFoundError`, `NoDispatcherError`, `defineWorkflow`, `WorkflowBuilder`, `getCompiledWorkflows`, `createRegistry`, `Registry`, `hostLocalWorkflows`, `HostLocalWorkflowsOptions`, all types from `types.ts`, metadata accessors, `listWorkflows`, `getWorkflow`, `validateInputs`, `ResolvedInputs`, `runWorkflow`, `RunWorkflowOptions`, `RunWorkflowResult`, `TelemetrySink`, `setExecutorTelemetrySinks`, `getProductionTelemetrySink`, all session primitives, `filterSpawnEnv`, `persistResume`, `OffloadManager` — DEPS: [tmux, claude, copilot, opencode, opentui, fs]

117. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/define-workflow.ts:1–` — `defineWorkflow()`, `WorkflowBuilder`, `getCompiledWorkflows()`, `RESERVED_INPUT_NAMES`, `_captureCallerPath()` — fluent builder pattern: `.for(agent)` → `.run(fn)` → `.compile()` → `WorkflowDefinition`; auto-captures caller source path from V8 stack — DEPS: [other] [REUSABLE core authoring API]

118. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/types.ts:1–628` — all public types: `AgentType`, `WorkflowInput`, `WorkflowInputType`, `WorkflowDefinition`, `WorkflowContext`, `SessionContext`, `SessionHandle`, `SessionRunOptions`, `ExternalWorkflow`, `BrokenWorkflow`, `RegistrableWorkflow`, `Registry`, `StageClientOptions`, `StageSessionOptions`, `ProviderClient`, `ProviderSession`, `SavedMessage`, `SaveTranscript`, `Transcript`; re-exports all three native SDK types from claude/copilot/opencode — DEPS: [claude, copilot, opencode] [REMOVE-CANDIDATE type imports; structural types REUSABLE]

119. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/registry.ts:1–` — `createRegistry()` — immutable chainable registry, runs provider validation on `.register()`, supports `.upsert()` with `onOverride` callback — DEPS: [claude, copilot, opencode] [PORTABLE-TO-EXTENSION registry mechanics; validator dispatch REMOVE-CANDIDATE]

120. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/worker-shared.ts` — `toCamelCase()`, `validateAndResolve()`, `buildInputUnion()` — input schema helpers shared between CLI command and executor — DEPS: [other] [REUSABLE]

121. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/errors.ts` — `MissingDependencyError`, `WorkflowNotCompiledError`, `InvalidWorkflowError`, `SessionNotFoundError`, `NoDispatcherError`, `errorMessage()` — typed error classes — DEPS: [other] [REUSABLE]

122. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/workflows/index.ts` — `/workflows` import-path barrel; re-exports defineWorkflow + provider helpers + session primitives — DEPS: [claude, copilot, opencode, tmux] [REMOVE-CANDIDATE re-exports; structure PORTABLE-TO-EXTENSION]

### v2 / pluggable layer

123. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/lib/host-local-workflows.ts` — (entry 74) — `hostLocalWorkflows()` handles `_emit-workflow-meta` and `_atomic-run` argv sub-commands for external workflow hosting; the local registry is the "pluggable workflow SDK" for third-party CLIs — DEPS: [fs] [REUSABLE/PORTABLE-TO-EXTENSION]

### Components sub-export

124. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/workflow-picker-panel.tsx` — (entry 42) — exported as `@bastani/atomic-sdk/workflows/components` → `WorkflowPickerPanel.create()` — DEPS: [opentui] [REMOVE-CANDIDATE]

---

## Partition 8: Configuration Layer

125. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/services/config/atomic-config.ts:1–` — `readAtomicConfig()`, `readAtomicConfigSplit()`, `getProviderOverrides()`, `getGlobalSettingsPath()`, `getLocalSettingsPath()`, `AtomicConfig`, `CustomWorkflowEntry`, `SCM_PROVIDERS` — reads project `.atomic/settings.json` and global `~/.atomic/settings.json`; resolution order: local > global — DEPS: [fs] [REUSABLE]

126. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/services/config/settings.ts` — `ensureGlobalAtomicSettings()`, `setTelemetryEnabled()`, `setScmProvider()`, `seedGlobalProviderEnvVars()`, `AtomicSettings` — manages `~/.atomic/settings.json` lifecycle, writes `$schema` URL on creation — DEPS: [fs] [REUSABLE]

127. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/services/config/definitions.ts` — `AGENT_CONFIG`, `AgentKey`, `AgentConfig`, `ProviderConfigKind`, `EmbeddedAssetKind`, `isValidAgent()`, `getAgentConfig()`, `getAgentKeys()`, `ProviderOverrides` — the central source of truth for all three agent identities, their CLI flags, env vars, onboarding file lists — DEPS: [other] [REMOVE-CANDIDATE current values; the schema PORTABLE-TO-EXTENSION]

128. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/services/config/settings-schema.ts` — `SETTINGS_SCHEMA_URL` constant pointing to the published JSON Schema — DEPS: [other] [REUSABLE]

129. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/services/config/scm-sync.ts` — (entry 92) [REMOVE-CANDIDATE]

130. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/services/config/additional-instructions.ts` — (entry 108) [PORTABLE-TO-EXTENSION seed/resolve pattern; provider sync REMOVE-CANDIDATE]

131. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/services/config/atomic-global-config.ts` — (entry 107) [REMOVE-CANDIDATE]

132. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/lib/merge.ts` — `syncJsonFile()`, `deepMergeUserPrecedence()` — deep-merge with user-precedence semantics and configurable `overwriteKeys`; idempotent writes — DEPS: [fs] [REUSABLE]

133. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/assets/settings.schema.json` — published JSON Schema for `.atomic/settings.json` — DEPS: [other] [PORTABLE-TO-EXTENSION schema]

134. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/DESIGN.md`, `DESIGN.json` — Catppuccin color tokens and component design tokens; consumed by impeccable skill — DEPS: [other] [REUSABLE]

135. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/AGENTS.md` — project-level instructions for all agents; served to Copilot via `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` — DEPS: [copilot, claude, opencode] [PORTABLE-TO-EXTENSION content]

136. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/.impeccable.md` — design system reference consumed by the impeccable skill — DEPS: [other] [REUSABLE content]

137. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/skills-lock.json` — (found referenced in CLAUDE.md) — tracks skill versions/locks — DEPS: [other] [REUSABLE]

138. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/.atomic/settings.json` — project-level atomic settings for the repo itself — DEPS: [other] [REUSABLE]

---

## Partition 9: Infra/CI

### Bootstrap installers

139. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/install.sh` — downloads verified binary from GitHub Releases, runs `atomic install` — DEPS: [tmux bootstrap] [PORTABLE-TO-EXTENSION pattern; tmux install step REMOVE-CANDIDATE]

140. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/install.ps1`, `install.cmd` — Windows equivalents — DEPS: [tmux bootstrap] [same tags]

### CI workflows

141. `.github/workflows/ci.yml` — runs tests, lint, typecheck on PRs — DEPS: [other] [REUSABLE structure]

142. `.github/workflows/publish.yml` — multi-platform `bun build --compile` matrix (8 targets), assembles per-platform npm packages, publishes npm with provenance (no NPM_TOKEN needed), creates GitHub Release — DEPS: [opentui native bindings, fs] [REUSABLE structure; opentui native install step REMOVE-CANDIDATE if opentui removed]

143. `.github/workflows/bump-version.yml` — calls `bump-version.ts --from-branch` on release branches — DEPS: [other] [REUSABLE]

144. `.github/workflows/sdk-fixture-smoke.yml` — runs the `tests/fixtures/sdk-compiled-consumer/` smoke against a compiled binary — DEPS: [tmux, claude, copilot, opencode] [REMOVE-CANDIDATE]

145. `.github/workflows/publish-features.yml`, `validate-features.yml` — publish/validate devcontainer features — DEPS: [claude, copilot, opencode] [REMOVE-CANDIDATE]

146. `.github/workflows/claude.yml`, `code-review.yml`, `pr-description.yml` — Claude Code and Copilot CI integrations — DEPS: [claude, copilot] [REMOVE-CANDIDATE]

### devcontainer features

147. `.devcontainer/features/claude/`, `copilot/`, `opencode/` — `devcontainer-feature.json` + `install.sh` for each agent CLI — DEPS: [claude, copilot, opencode] [REMOVE-CANDIDATE]

148. `.devcontainer/devcontainer.json`, `claude/`, `copilot/`, `opencode/` — per-agent devcontainer configurations — DEPS: [claude, copilot, opencode] [REMOVE-CANDIDATE]

### Release / publish infrastructure

149. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/script/publish.ts` — uploads compiled binaries as GitHub Release assets — DEPS: [fs] [REUSABLE]

150. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/services/system/release-fetch.ts` — `getLatestRelease()`, `getReleaseByTag()`, `downloadAssetFromUrl()`, `verifyChecksum()`, `isNewer()` — GitHub Releases download + sha256 verify for self-update — DEPS: [fs] [REUSABLE]

151. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/script/build.ts`, `pack.ts`, `publish.ts`, `verify-bundled-cli.ts` — SDK build, pack, publish scripts — DEPS: [other] [REUSABLE]

---

## Partition 10: Tests

152. `tests/sdk/runtime/tmux.test.ts` — unit tests for `tmux.ts` utilities (parseSessionName, parseListSessionsOutput, buildKillSessionOnPaneExitHooks, etc.) — DEPS: [tmux] [REMOVE-CANDIDATE]

153. `tests/sdk/runtime/executor.test.ts`, `packages/atomic-sdk/src/runtime/executor.test.ts` (multiple focused test files for `buildPaneCommand`, `loggedKillWindow`, `offload-wiring`, `waitForClaudeReady`) — DEPS: [tmux, claude, copilot, opencode] [REMOVE-CANDIDATE]

154. `tests/sdk/providers/claude-wait-for-idle.test.ts`, `claude-watch-hil-marker.test.ts` — tests for Claude-specific idle/HIL detection — DEPS: [claude] [REMOVE-CANDIDATE]

155. `tests/sdk/providers/copilot.test.ts`, `packages/atomic-sdk/src/providers/copilot.test.ts` — tests for `isCopilotShim`, `resolveCopilotCliPath` — DEPS: [copilot] [REMOVE-CANDIDATE]

156. `packages/atomic-sdk/src/providers/claude.buildResumeArgs.test.ts`, `claude.buildResume.test.ts`, `claude.claudeOffloadCleanup.test.ts`, `claude.waitForIdleDrain.test.ts` — focused Claude provider tests — DEPS: [claude, tmux] [REMOVE-CANDIDATE]

157. `packages/atomic-sdk/src/providers/copilot.buildResumeArgs.test.ts`, `copilot.buildResume.test.ts`, `copilot.test.ts` — DEPS: [copilot] [REMOVE-CANDIDATE]

158. `packages/atomic-sdk/src/providers/opencode.buildResumeArgs.test.ts`, `opencode.buildResume.test.ts` — DEPS: [opencode] [REMOVE-CANDIDATE]

159. `packages/atomic-sdk/src/runtime/offload-manager.*.test.ts` (8 files) — DEPS: [tmux, claude] [REMOVE-CANDIDATE]

160. `packages/atomic-sdk/src/runtime/tmux.killWindow.test.ts` — DEPS: [tmux] [REMOVE-CANDIDATE]

161. `packages/atomic-sdk/src/runtime/executor.waitForClaudeReady.test.ts`, `executor.loggedKillWindow.test.ts`, `executor.buildPaneCommand.test.ts`, `executor.offload-wiring.test.ts` — DEPS: [tmux, claude] [REMOVE-CANDIDATE]

162. `tests/sdk/components/*.test.ts[x]` — tests for layout, connectors, node-card, header, session-graph-panel, orchestrator-panel, workflow-picker-panel, etc. — DEPS: [opentui] [REMOVE-CANDIDATE]

163. `packages/atomic-sdk/src/components/orchestrator-panel-contexts.test.tsx`, `orchestrator-panel-store.test.ts`, `orchestrator-panel.test.tsx`, `session-graph-panel.test.tsx`, `workflow-picker-panel.test.tsx` etc. — DEPS: [opentui] [REMOVE-CANDIDATE]

164. `tests/sdk/runtime/cc-debounce.test.ts`, `packages/atomic-sdk/src/runtime/status-writer.test.ts` — DEPS: [tmux, fs] [REMOVE-CANDIDATE cc-debounce; status-writer test REUSABLE structure]

165. `tests/commands/cli/chat/buildLauncherScript.test.ts`, `chat-integration.test.ts` — DEPS: [tmux, claude, copilot, opencode] [REMOVE-CANDIDATE]

166. `packages/atomic/src/commands/cli/workflow-command.test.ts`, `workflow-list.test.ts`, `workflow-list.shadow.test.ts`, `workflow-inputs.test.ts`, `workflow-read.test.ts`, `workflow-refresh.test.ts`, `workflow-status.test.ts` — DEPS: [tmux, claude, copilot, opencode] [PORTABLE-TO-EXTENSION test shapes]

167. `tests/lib/merge.test.ts`, `tests/lib/common-ignore.test.ts`, `tests/lib/path-root-guard.test.ts` — pure utility tests — DEPS: [other] [REUSABLE]

168. `tests/services/config/settings.test.ts`, `scm-sync.test.ts`, `settings-seed-envvars.test.ts` — DEPS: [claude, copilot, opencode] [REMOVE-CANDIDATE scm-sync; settings test REUSABLE structure]

169. `tests/ci/onboarding.test.ts`, `coverage-paths.test.ts`, `no-import-meta-dir-in-runtime.test.ts`, etc. — CI lint tests for code conventions — DEPS: [other] [REUSABLE]

170. `tests/fixtures/sdk-compiled-consumer/`, `sdk-host-consumer/` — fixture CLIs for compiled-binary and host-local-workflows smoke tests — DEPS: [tmux, claude] [REMOVE-CANDIDATE]

171. `packages/atomic-sdk/src/runtime/port-discovery.test.ts` — DEPS: [opencode] [REMOVE-CANDIDATE]

172. `packages/atomic-sdk/src/lib/runtime-assets.test.ts`, `runtime-env.test.ts` — DEPS: [tmux, fs] [REMOVE-CANDIDATE runtime-assets; runtime-env REUSABLE]

173. `packages/atomic-sdk/src/lib/telemetry/index.test.ts` — DEPS: [fs] [REUSABLE]

### Coverage / test config

174. `packages/atomic/src/lib/embedded-assets.test.ts` — tests tarball extraction and cache fingerprinting — DEPS: [claude, copilot, opencode, fs] [REMOVE-CANDIDATE agent bundles]

175. `packages/atomic-sdk/src/sdk-build-emits-js.test.ts` — verifies SDK builds emit `.js` not `.ts` — DEPS: [other] [REUSABLE]

176. `tests/setup/ensure-embedded-tarballs.ts` — preload hook to guarantee tarballs exist before tests run — DEPS: [claude, copilot, opencode, fs] [REMOVE-CANDIDATE]

---

### Rest API

177. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/rest-api/src/server.ts` — `createServer()` — generic CRUD REST API (items endpoint), Bun.serve routes, no agent coupling — DEPS: [other] [REUSABLE — appears to be a standalone scaffolding API, not wired into atomic's main paths]

178. `/home/alilavaee/Documents/projects/atomic-pi-rewrite/rest-api/src/store.ts`, `types.ts`, `errors.ts` — ItemStore in-memory store, request body parsers, typed error responses — DEPS: [other] [REUSABLE]

---

## Load-Bearing Concepts

The following 18 named abstractions are the central concepts the rewrite must either preserve or consciously replace:

1. **WorkflowDefinition / defineWorkflow builder** — the fluent `.for(agent).run(fn).compile()` DSL that produces a sealed, source-path-stamped `WorkflowDefinition` object; the single authoring primitive everything else routes through.

2. **ctx.stage() DAG execution model** — `WorkflowContext.stage()` / `SessionContext.stage()` as the recursive unit of work; the executor uses `GraphFrontierTracker` to infer sequential/parallel/fan-in topology automatically from JavaScript execution order.

3. **WorkflowRegistry / createRegistry()** — immutable chainable registry keyed by `${agent}/${name}`; supports `register()` (throws on dup) and `upsert()` (replaces with callback); drives both builtin and custom workflow dispatch.

4. **EventBus stream model (per-agent)** — three distinct idle-detection and message-delivery mechanisms: Claude uses fs.watch on JSONL + Stop hook marker files; Copilot uses a native SDK async-iterator `SessionEvent` stream; OpenCode uses a synchronous `session.prompt()` response body. No shared bus.

5. **AskUserQuestion (HIL) DSL node** — Claude's `_claude-ask-hook` CLI command wired into Claude's PreToolUse/PostToolUse hooks writes a `~/.atomic/claude-ask/<session_id>` marker; the executor polls it and surfaces a blocking prompt to the user; the Stop hook's `{"decision":"block","reason":…}` mechanism delivers follow-up prompts without tmux send-keys.

6. **Workflow pane offload/resume** — `OffloadManager` kills the agent process and tmux window when a background stage is deprioritized; `persistResume()` writes `metadata.json` with `OffloadResumeMetadata` (schemaVersion=1, agentSessionId, chatFlags, spawnEnv); `doResume()` re-spawns the agent CLI with `--resume`/`--session` flags and polls readiness.

7. **Tmux socket isolation (atomic socket)** — all sessions are created on a dedicated `-L atomic` tmux socket, isolating them from the user's default server; `isInsideAtomicSocket()` discriminates re-entry.

8. **Launcher script pattern** — instead of passing args through shell, `chatCommand` writes a temp `.sh`/`.ps1` file with properly escaped args and runs it in the tmux pane; avoids all shell-injection risks from passthrough args.

9. **Embedded asset tarballs** — `.claude.tar`, `.opencode.tar`, `.github.tar`, `skills.tar` bundled with `with { type: "file" }` in the compiled binary; `getEmbeddedAsset(kind)` extracts to a content-addressed cache under `~/.cache/atomic/`; `materializeRuntimeAsset()` does the same for `tmux.conf`.

10. **Auto-dispatch side-effect** — `lib/auto-dispatch.ts` imported as a module-level side-effect from `primitives/run.ts`; intercepts `_orchestrator-entry` and `_cc-debounce` in `process.argv` before any host CLI parser sees them, enabling compiled third-party hosts with zero boilerplate.

11. **hostLocalWorkflows() / ExternalWorkflow dispatch protocol** — `_emit-workflow-meta` sub-command emits `ATOMIC_WORKFLOW_META: <json>` to stdout; `_atomic-run` sub-command executes a workflow; dispatch token prevents unauthorized invocation; enables npm-publishable third-party workflow packages.

12. **PanelStore pub/sub model** — `PanelStore` is a Zustand-lite mutable class with `subscribe(fn)` → version counter increment; React components call `useStoreVersion(store)` to re-render on change; bridges imperative executor state into the React tree without a global store.

13. **Status snapshot file** — `~/.atomic/sessions/<runId>/status.json` with `WorkflowStatusSnapshot` (schemaVersion=1); the orchestrator writes it on every `PanelStore` mutation; `atomic workflow status` reads it; this is the entire IPC channel between the orchestrator pane and the CLI.

14. **Settings JSON merge with user precedence** — `syncJsonFile()` implements deep-merge where destination (user) values always win except for `overwriteConfigKeys`; applied to onboarding files (`.mcp.json`, `settings.json`, `opencode.json`) on every `atomic chat` preflight.

15. **CustomWorkflowEntry / Bootstrap** — `settings.json` `workflows` map entries; `bootstrapCustomWorkflows()` spawns each entry's command with `_emit-workflow-meta`, parses emitted JSON, builds `ExternalWorkflow` records; `rebuildWorkflowCommand()` hot-swaps the Commander option set at runtime.

16. **Ctrl+C debounce via tmux.conf hook** — `@atomic-cc-debounce` user option set on the tmux server points to the full self-exec command; `tmux.conf` binds `C-c` to `run-shell -b '#{@atomic-cc-debounce} "#{pane_id}"'`; prevents agent CLI's double-tap exit from firing on accidental presses.

17. **Attached footer status-line** — JSX compiled to tmux format strings via `tui/compiler/parser.ts`; applied via `set-option` session-scope so concurrent sessions don't clobber each other; uses `#{@atomic-<id>}` user-option indirection for reactive bg-tasks counter without nested conditionals.

18. **GraphFrontierTracker topology inference** — `onSpawn()` returns inferred parents by checking whether any stage completed since the last spawn (frontier); `onSettle()` populates the frontier; this is the single mechanism that makes `Promise.all` parallel stages and `await` sequential chains automatically produce the correct DAG without any explicit `dependsOn` declaration.

---

## Deletion Blast Radius

**Removing tmux** takes out roughly **45–50% of source files by count** and an even higher percentage by line count (executor.ts alone is the largest file in the codebase at ~1800 lines). Specifically eliminated: `runtime/tmux.ts`, `runtime/attached-footer.ts`, `runtime/cc-debounce.ts`, `runtime/executor-env.ts`, `runtime/offload-manager.ts`, `runtime/port-discovery.ts` (partially), `runtime/runtime-assets.ts`, `tui/mux.ts`, `tui/renderer.ts`, `tui/compiler/*`, `tui/globals.ts`, `tui/types.ts`, `tui/attached-statusline.tsx`, `lib/self-exec.ts` (tmux usage), `lib/spawn.ts` (tmux install), the chat command's session creation path, all session subcommands, `cc-debounce` CLI command, `_runtime-assets-smoke` CLI command, the tmux.conf asset, the entire install.sh tmux-detection section.

**Removing Claude/Copilot/OpenCode adapters** takes out roughly **35–40% of remaining files**. Specifically eliminated: `providers/claude.ts`, `providers/claude-stop-hook.ts`, `providers/claude-inflight-hook.ts`, `providers/copilot.ts`, `providers/opencode.ts`, `services/config/scm-sync.ts`, `services/config/definitions.ts` (the three-agent enum), `services/config/additional-instructions.ts` (provider-sync parts), `commands/cli/claude-ask-hook.ts`, `commands/cli/claude-session-start-hook.ts`, `commands/cli/init/index.ts` (provider-specific onboarding), `commands/builtin-registry.ts` (all three-agent builtin variants), `services/system/agents.ts`, `services/system/auth.ts`, `types.ts` (native SDK type imports), all three builtin workflow directories (`ralph/*`, `deep-research-codebase/*`, `open-claude-design/*` per-agent variants), all devcontainer features, `build-assets.ts`/`bundle-configs.ts` for the three provider tarballs, and all provider-specific test files.

**What survives (and maps to pi-coding-agent extension seams)**: `define-workflow.ts`, `registry.ts`, `worker-shared.ts`, `errors.ts`, `primitives/inputs.ts`, `primitives/metadata.ts`, `primitives/run.ts` (interface), `lib/host-local-workflows.ts`, `lib/dispatch-utils.ts`, `lib/auto-dispatch.ts` (pattern), `lib/runtime-env.ts`, `lib/atomic-temp.ts`, `lib/common-ignore.ts`, `lib/telemetry/index.ts`, `runtime/graph-inference.ts`, `runtime/shell-quote.ts`, `runtime/status-writer.ts` (schema), `components/orchestrator-panel-store.ts`, `components/orchestrator-panel-types.ts`, `components/layout.ts`, `components/connectors.ts`, `components/graph-theme.ts`, `components/status-helpers.ts`, `components/color-utils.ts`, `services/config/atomic-config.ts`, `services/config/settings-schema.ts`, `services/system/copy.ts`, `services/system/detect.ts`, `lib/merge.ts`, `lib/workspace-paths.ts`, `theme/colors.ts`, `version.ts`, `completions/*`, `commands/custom-workflows.ts`, `commands/cli/workflow.ts` (dispatch logic), `commands/cli/workflow-list.ts`, `commands/cli/workflow-inputs.ts`, `commands/cli/workflow-read.ts`, `commands/cli/workflow-refresh.ts`, `commands/cli/install.ts`, `commands/cli/update.ts`, and the rest-api.

In total, removing all four dependencies (tmux + three agent adapters) eliminates approximately **65–70% of the total source lines**, leaving a foundation of workflow authoring primitives, registry, input validation, status-file I/O, graph layout, config management, CLI scaffolding, and install/update infrastructure that maps cleanly to the pi-coding-agent extension API.
