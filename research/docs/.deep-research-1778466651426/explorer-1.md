# Partition 1 of 12 — Findings

## Scope

`packages/atomic-sdk/` (175 files, 43,878 LOC)

## Files in Scope

<!-- Source: codebase-locator sub-agent -->

# Partition 1: packages/atomic-sdk — Complete File Inventory (43.8k LOC, 175 TS/TSX files)

## Implementation

### Core Entry Points & SDK Barrel

- `src/index.ts` — Public SDK barrel exporting defineWorkflow, Registry, hosting primitives, types, error classes, metadata accessors
- `src/cli.ts` — Entry point for SDK's internal CLI dispatcher (`_orchestrator-entry`, `_cc-debounce` sub-commands)
- `src/define-workflow.ts` — WorkflowBuilder DSL, caller-path capture for auto-populating `source`, defineWorkflow() factory, getCompiledWorkflows()
- `src/registry.ts` — Registry<T> type and implementation; immutable chainable registry keyed by `${agent}/${name}`, validator dispatch
- `src/types.ts` — All TypeScript type definitions: AgentType, WorkflowDefinition, SessionContext, WorkflowContext, SessionHandle, StageClientOptions/SessionOptions type maps per agent, ValidationRule/ValidationWarning
- `src/worker-shared.ts` — Utilities shared between workers: toCamelCase(), validateAndResolve(), stringifyDefaults(), buildInputUnion() for workflow input/output handling
- `src/errors.ts` — Custom error classes: MissingDependencyError, WorkflowNotCompiledError, InvalidWorkflowError, SessionNotFoundError, IncompatibleSDKError, NoDispatcherError; errorMessage() helper

### Workflow Runtime Executor

- `src/runtime/executor.ts` — (94 KB) Core workflow execution engine. Spawns tmux session with orchestrator pane, runs `_orchestrator-entry` sub-command, orchestrates stage execution, manages agent sessions (claude/copilot/opencode), handles offload/resume state machine, tmux window management, telemetry injection
- `src/runtime/orchestrator-entry.ts` — Resolves WorkflowDefinition by source path or from host registry; runOrchestratorWithDefinition() for compiled-binary mode, runOrchestratorEntry() for dev/installed-package mode
- `src/runtime/offload-manager.ts` — (22 KB) State machine for workflow pane offload & resume: persistResume(), doResume(), cleanup; manages JSON metadata on disk, environment filtering, session resumption
- `src/runtime/tmux.ts` — (28 KB) Low-level tmux operations: session creation, pane spawning, send-keys, capture-pane, kill-window; abstracts over tmux/psmux multiplexers; SOCKET_NAME="atomic"
- `src/runtime/port-discovery.ts` — (15 KB) Discovers listening port for agent CLI process by PID; polls /proc/[pid]/fd on Linux, lsof fallback; times out after PORT_DISCOVERY_TIMEOUT_MS
- `src/runtime/attached-footer.ts` — Spawns footer pane showing workflow status/duration; renders via OpenTUI + tmux status-line
- `src/runtime/status-writer.ts` — Writes workflow snapshot to metadata.json during execution; used for resume/persistence
- `src/runtime/executor-env.ts` — Builds environment variables for executor (unused in public API, internal only)
- `src/runtime/cc-debounce.ts` — Debounces "C-c" keypresses in Claude pane to prevent accidental abort
- `src/runtime/theme.ts` — Exports theme configuration passed to rendering layer
- `src/runtime/graph-inference.ts` — GraphFrontierTracker class for computing which stages are "frontier" (next executable) in DAG
- `src/runtime/version-compat.ts` — SDK version compatibility checks
- `src/runtime/shell-quote.ts` — Shell escaping utility (minimal; mostly delegated to Bun's escBash)

### Agent Adapters — Provider Implementations

- `src/providers/claude.ts` — (61 KB) Claude Code query abstraction. Sends prompts via tmux send-keys, verifies delivery by polling capture-pane, manages session JSONL idle detection, session initialization via Stop hooks, inflight subagent tracking, respawn logic
- `src/providers/claude-stop-hook.ts` — (18 KB) Stop hook registration + marker file logic for Claude sessions; hooks emit markers to signal stage completion and idle detection
- `src/providers/claude-inflight-hook.ts` — (12 KB) Inflight task/subagent tracking via marker directories; wait for backgrounded subagents to drain before advancing stages
- `src/providers/copilot.ts` — (7.4 KB) Copilot SDK client wrapper; manages session creation, resume args building, headless HIL policy
- `src/providers/opencode.ts` — (4.4 KB) OpenCode SDK client wrapper; environment setup with headless wiring, resume args building

### Workflow Definitions — Builtin Workflows

- `src/workflows/index.ts` — Exports builtin workflow registry and helper utilities
- `src/workflows/builtin/ralph/claude/index.ts` — Ralph workflow for Claude: plan → orchestrate → review loop; headless reviewer stages with JSON schema validation
- `src/workflows/builtin/ralph/copilot/index.ts` — Ralph workflow for Copilot
- `src/workflows/builtin/ralph/opencode/index.ts` — Ralph workflow for OpenCode
- `src/workflows/builtin/ralph/helpers/prompts.ts` — Prompt templates: buildPlannerPrompt(), buildOrchestratorPrompt(), buildReviewPrompt(), REVIEW_RESULT_JSON_SCHEMA
- `src/workflows/builtin/ralph/helpers/review.ts` — Review merge logic: hasActionableFindings(), mergeReviewResults()
- `src/workflows/builtin/ralph/helpers/git.ts` — Git operations: captureBranchChangeset()
- `src/workflows/builtin/ralph/helpers/claude-reviewer.ts` — Claude-specific review tools and persona injection
- `src/workflows/builtin/ralph/helpers/copilot-reviewer.ts` — Copilot-specific review logic
- `src/workflows/builtin/deep-research-codebase/claude/index.ts` — Deep research workflow for Claude
- `src/workflows/builtin/deep-research-codebase/copilot/index.ts` — Deep research workflow for Copilot
- `src/workflows/builtin/deep-research-codebase/opencode/index.ts` — Deep research workflow for OpenCode
- `src/workflows/builtin/deep-research-codebase/helpers/prompts.ts` — Research prompt templates
- `src/workflows/builtin/deep-research-codebase/helpers/scout.ts` — Scout logic for code exploration
- `src/workflows/builtin/deep-research-codebase/helpers/heuristic.ts` — Heuristic analysis
- `src/workflows/builtin/deep-research-codebase/helpers/batching.ts` — Batching strategies for research
- `src/workflows/builtin/deep-research-codebase/helpers/scratch.ts` — Scratch files for research state
- `src/workflows/builtin/open-claude-design/claude/index.ts` — Open Claude Design workflow for Claude
- `src/workflows/builtin/open-claude-design/copilot/index.ts` — Open Claude Design workflow for Copilot
- `src/workflows/builtin/open-claude-design/opencode/index.ts` — Open Claude Design workflow for OpenCode
- `src/workflows/builtin/open-claude-design/helpers/design-system.ts` — Design system management
- `src/workflows/builtin/open-claude-design/helpers/scan.ts` — Scan design files
- `src/workflows/builtin/open-claude-design/helpers/import.ts` — Import design system
- `src/workflows/builtin/open-claude-design/helpers/export.ts` — Export design system
- `src/workflows/builtin/open-claude-design/helpers/validation.ts` — Validate design system
- `src/workflows/builtin/open-claude-design/helpers/constants.ts` — Design constants

### TUI Components & Rendering

- `src/runtime/panel.tsx` — Re-exports OrchestratorPanel from components/
- `src/components/orchestrator-panel.tsx` — OrchestratorPanel class; OpenTUI React-based orchestrator with session graph, pane/window state management
- `src/components/session-graph-panel.tsx` — SessionGraphPanel component; renders DAG of workflow stages in graph view
- `src/components/workflow-picker-panel.tsx` — (1,700+ lines) WorkflowPicker modal; fuzzy search, field validation, pickerTheme, WorkflowPickerPanel class for workflow selection UI
- `src/components/orchestrator-panel-types.ts` — Type definitions: SessionStatus, ViewMode, PanelSession, PanelOptions, SessionData
- `src/components/orchestrator-panel-store.ts` — PanelStore class; manages panel state, toast messages, version tracking
- `src/components/orchestrator-panel-contexts.ts` — React context hooks: useStore(), useGraphTheme(), useStoreVersion(), useOffloadManager()
- `src/components/header.tsx` — Header component showing workflow name, model, version, etc.
- `src/components/layout.ts` — computeLayout() function; pane positioning/sizing logic for graph view
- `src/components/connectors.ts` — buildConnector(), buildMergeConnector() for DAG edge rendering
- `src/components/edge.tsx` — Edge component; renders connector lines between DAG nodes
- `src/components/node-card.tsx` — Node card component for individual DAG nodes
- `src/components/compact-switcher.tsx` — CompactSwitcher component; mode selector for graph/attached/resuming views
- `src/components/graph-theme.ts` — GraphTheme interface; deriveGraphTheme() for computing colors from terminal theme
- `src/components/color-utils.ts` — Color manipulation: hexToRgb(), rgbToHex(), lerpColor()
- `src/components/toast.tsx` — ToastStack component; displays notifications in orchestrator panel
- `src/components/status-helpers.ts` — statusColor(), statusLabel(), statusIcon(), fmtDuration() for session status rendering
- `src/components/error-boundary.tsx` — ErrorBoundary React component for TUI error handling
- `src/components/renderer-background.ts` — setRendererBackground(), resetRendererTerminalBackground(), wrapForTmuxIfNeeded() for terminal background color management
- `src/components/tui-diagnostics.ts` — TUI diagnostics/metrics: isTuiDiagnosticsEnabled(), createTuiDiagnostics(), BufferDiagnostic, WorkflowDiagnosticSnapshot
- `src/tui/index.ts` — TUI barrel exports; re-exports renderer, footer, attachment utilities
- `src/tui/components.tsx` — Box, Text, Footer stub components for OpenTUI
- `src/tui/types.ts` — StyleProps, ElementProps, StatusPosition, FooterConfig types
- `src/tui/renderer.ts` — renderFooter(), clearFooter() for OpenTUI footer rendering
- `src/tui/mux.ts` — setOption(), setWindowOption(), setGlobalWindowOption(), setStatuslineState() for tmux multiplexer control
- `src/tui/attached-statusline.tsx` — attachedStatusline() function; renders status in tmux status-line for attached session
- `src/tui/globals.ts` — TmuxGlobals type; exposes tmux/psmux global state to TUI layer
- `src/tui/compiler/parser.ts` — compile() function; parses React nodes into OpenTUI-compatible command strings
- `src/tui/compiler/styles.ts` — styleAttributes(), inlineStyle() for TUI style compilation

### Primitives & Composition Utilities

- `src/primitives/run.ts` — runWorkflow() function; SDK consumer entry point for executing workflows
- `src/primitives/sessions.ts` — Session state tracking and lifecycle
- `src/primitives/inputs.ts` — Input validation and resolution for workflow parameters
- `src/primitives/metadata.ts` — Metadata accessors: getName(), getDescription(), getAgent(), getInputSchema(), getSource(), getMinSDKVersion()

### Library — Utilities & Infrastructure

- `src/lib/auto-dispatch.ts` — Argv side-effect dispatcher for `_orchestrator-entry` and `_cc-debounce` sub-commands; no async cost for non-matching argv
- `src/lib/dispatch-utils.ts` — validateDispatchToken(), findSub(), parseAtomicRunArgv(), AtomicRunArgs for argv parsing
- `src/lib/host-local-workflows.ts` — hostLocalWorkflows() function; registers workflows with host registry and handles `_emit-workflow-meta`, `_atomic-run` dispatch
- `src/lib/runtime-assets.ts` — tmuxConfPath(), confPath() for accessing bundled assets (tmux config)
- `src/lib/self-exec.ts` — buildSelfExecCommand(), resolveDispatcher() for re-invoking the SDK CLI as a subprocess
- `src/lib/spawn.ts` — spawnSync(), spawn() for subprocess execution; wraps Bun.spawn() with error handling
- `src/lib/terminal-env.ts` — buildLauncherEnv(), buildTmuxEnv(), normalizedTerminalEnv() for environment variable management
- `src/lib/runtime-env.ts` — isInstalledPackage() for detecting dev vs published installation mode
- `src/lib/atomic-temp.ts` — atomicTempDir(), ensureAtomicTempDir(), atomicTempEnv(), atomicTempPath(), atomicContentTempPath(), withAtomicTempEnv() for ~/.atomic/ temp directory management
- `src/lib/workspace-paths.ts` — getDevCliPkgRoot(), getWorkspaceRoot() for monorepo path resolution
- `src/lib/common-ignore.ts` — Common ignore patterns for code traversal
- `src/lib/path-root-guard.ts` — Guards against traversing above filesystem root
- `src/lib/telemetry/index.ts` — Telemetry infrastructure: getProductionTelemetrySink() for anonymous event emission

### Services — Configuration & System

- `src/services/config/atomic-config.ts` — AtomicConfig class; loads/merges ~/.atomic/config.json and project-level .atomic/config.json; provides settings.json schema
- `src/services/config/definitions.ts` — AgentKey type ("claude" | "copilot" | "opencode"), isValidAgent(), getProviderOverrides() for per-agent config overrides
- `src/services/config/settings-schema.ts` — Zod schema for ~/.atomic/settings.json and .atomic/workflows config
- `src/services/config/scm-sync.ts` — getCopilotScmDisableFlags() for disabling SCM warnings in Copilot
- `src/services/config/additional-instructions.ts` — resolveAdditionalInstructionsContent() for loading system prompt extensions
- `src/services/system/copy.ts` — ensureDir() filesystem utility
- `src/services/system/detect.ts` — System detection utilities

### Theme & Styling

- `src/theme/colors.ts` — PaletteKey type, Catppuccin palette integration, createPainter() for terminal color injection

### Configuration & Build

- `tsconfig.json` — TypeScript configuration for SDK
- `tsconfig.build.json` — Build-specific TypeScript config
- `package.json` — SDK package metadata; exports 60+ public entry points; depends on @anthropic-ai/claude-agent-sdk, @github/copilot-sdk, @opencode-ai/sdk, @opentui/core, @opentui/react, commander, zod, ignore, yaml

## Tests

### Unit Tests (57 total test files)

- `src/index.test.ts` — SDK barrel export tests
- `src/define-workflow.test.ts` — WorkflowBuilder and caller-path capture tests
- `src/registry.test.ts` — Registry registration and validation tests
- `src/errors.test.ts` — Error class tests
- `src/worker-shared.test.ts` — Utility function tests

### Workflow Tests

- `src/workflows/builtin/ralph/claude/index.test.ts` — (if exists) Ralph Claude workflow tests
- Similar test files under copilot and opencode subdirectories

### Runtime Tests (26 test files)

- `src/runtime/executor.test.ts` — (49 KB) Large test suite covering workflow execution, stage lifecycle, offload/resume, tmux interactions
- `src/runtime/executor.buildPaneCommand.test.ts` — Tests for pane command building
- `src/runtime/executor.waitForClaudeReady.test.ts` — Tests for Claude readiness polling
- `src/runtime/executor.offload-wiring.test.ts` — Tests for offload/resume wiring
- `src/runtime/executor.loggedKillWindow.test.ts` — Tests for kill window logging
- `src/runtime/offload-manager.test.ts` — Tests for offload state machine
- `src/runtime/offload-manager.persistResume.test.ts` — Tests for persist/resume metadata writing
- `src/runtime/offload-manager.doResume-rollback.test.ts` — Tests for resume failure rollback
- `src/runtime/offload-manager.eligibility.test.ts` — Tests for offload eligibility checks
- `src/runtime/offload-manager.skeleton.test.ts` — Tests for skeleton workflow setup
- `src/runtime/offload-manager.bodies.test.ts` — (27 KB) Tests for resume body building
- `src/runtime/offload-manager.claudeMarkerCleanup.test.ts` — Tests for Claude marker cleanup
- `src/runtime/offload-manager.deps.types.test.ts` — Dependency type checks
- `src/runtime/offload-types.test.ts` — OffloadResumeMetadata type tests
- `src/runtime/port-discovery.test.ts` — (21 KB) Tests for port discovery by PID polling
- `src/runtime/status-writer.test.ts` — Tests for workflow status JSON writing
- `src/runtime/attached-footer.test.ts` — Tests for footer pane rendering
- `src/runtime/tmux.killWindow.test.ts` — Tests for tmux window kill logic
- `src/runtime/orchestrator-entry.resolve.test.ts` — Tests for workflow definition resolution
- `src/runtime/shell-quote.test.ts` — Shell quoting tests

### Provider Tests (11 test files)

- `src/providers/claude.buildResume.test.ts` — Claude resume args building
- `src/providers/claude.buildResumeArgs.test.ts` — Claude resume arguments tests
- `src/providers/claude.claudeOffloadCleanup.test.ts` — Claude offload cleanup tests
- `src/providers/claude.waitForIdleDrain.test.ts` — Claude idle detection tests
- `src/providers/copilot.buildResume.test.ts` — Copilot resume tests
- `src/providers/copilot.buildResumeArgs.test.ts` — Copilot resume arguments
- `src/providers/copilot.test.ts` — (14 KB) General Copilot provider tests
- `src/providers/opencode.buildResume.test.ts` — OpenCode resume tests
- `src/providers/opencode.buildResumeArgs.test.ts` — OpenCode resume arguments
- `src/providers/headless-hil-policy.test.ts` — Headless HIL policy tests

### Component Tests (7 test files)

- `src/components/orchestrator-panel.test.tsx` — (if exists) OrchestratorPanel React tests
- `src/components/session-graph-panel.test.tsx` — SessionGraphPanel component tests
- `src/components/orchestrator-panel-store.test.ts` — PanelStore state management tests
- `src/components/orchestrator-panel-contexts.test.tsx` — Context hooks tests
- `src/components/orchestrator-panel-context.test.tsx` — Single context tests
- `src/components/layout.test.ts` — Layout computation tests
- `src/components/connectors.test.ts` — DAG connector tests
- `src/components/status-helpers.test.ts` — Status rendering utility tests

### Lib Tests (9 test files)

- `src/lib/atomic-temp.test.ts` — Atomic temp directory tests
- `src/lib/auto-dispatch.test.ts` — argv dispatcher tests
- `src/lib/host-local-workflows.test.ts` — Workflow registry tests
- `src/lib/runtime-assets.test.ts` — Asset path resolution tests
- `src/lib/runtime-env.test.ts` — Runtime environment detection tests
- `src/lib/self-exec.test.ts` — Self-execution tests
- `src/lib/spawn.test.ts` — Subprocess spawning tests
- `src/lib/terminal-env.test.ts` — Terminal environment tests
- `src/lib/telemetry/index.test.ts` — Telemetry sink tests

### Service Tests (2 test files)

- `src/services/config/atomic-config.test.ts` — Config loading and merging tests
- `src/services/config/settings.schema.test.ts` — Settings schema validation tests

### Primitive Tests (1 test file)

- `src/primitives/sessions.test.ts` — Session state tests

### TUI Tests (4 test files)

- `src/tui/compiler/parser.test.tsx` — React-to-string compiler tests
- `src/tui/compiler/styles.test.ts` — Style compilation tests

### Build & SDK Tests (1 test file)

- `src/sdk-build-emits-js.test.ts` — SDK build output verification

## Types / Interfaces

### Core Type Definitions (src/types.ts)

- `AgentType` — Union of "claude" | "copilot" | "opencode"
- `WorkflowDefinition<I extends WorkflowInput[] = WorkflowInput[]>` — Compiled workflow with run callback, metadata
- `WorkflowBuilder<A extends AgentType, I extends WorkflowInput[]>` — DSL builder for fluent workflow construction
- `WorkflowOptions<I extends WorkflowInput[]>` — Workflow initialization options (name, description, inputs, source, agent, minSdkVersion)
- `WorkflowContext<A extends AgentType, I extends WorkflowInput[]>` — Callback context with stage(), getInputs(), getRawInputs()
- `SessionContext<A extends AgentType>` — Per-stage context with client, session, request/response types
- `SessionHandle<T>` — Opaque reference to a persisted session for polling
- `SessionRunOptions` — Options for running a session (inputs, expectedOutput)
- `Transcript` — Message list from agent session
- `SavedMessage` — Discriminated union of user/assistant/system message types
- `SaveTranscript` — Serialization format for session transcript
- `WorkflowInput` — Input field definition (name, type, description, choices, default, optional)
- `WorkflowInputType` — "string" | "text" | "enum" | "integer"
- `ProviderClient<A extends AgentType>` — Resolved client type per agent (OpencodeClient | CopilotClient | ClaudeClientWrapper)
- `ProviderSession<A extends AgentType>` — Resolved session type per agent
- `StageClientOptions<A extends AgentType>` — Client init options per agent
- `StageSessionOptions<A extends AgentType>` — Session creation options per agent
- `Registry<T extends Record<string, WorkflowDefinition | ExternalWorkflow>>` — Immutable workflow registry keyed by agent/name
- `ExternalWorkflow` — Workflow loaded from external source (not builtin)
- `BrokenWorkflow` — Workflow that failed to load/compile
- `RegistrableWorkflow` — Union of WorkflowDefinition | ExternalWorkflow
- `ValidationWarning` — Validation error with rule name and message
- `ValidationRule` — Named validation rule

### Component Types (src/components/orchestrator-panel-types.ts)

- `SessionStatus` — "pending" | "running" | "complete" | "error" | "awaiting_input" | "offloaded" | "resuming"
- `ViewMode` — "graph" | "attached" | "resuming"
- `PanelSession` — Session state in panel
- `PanelOptions` — Orchestrator panel initialization options
- `SessionData` — Session data for layout computation

### Runtime Types

- `OffloadResumeMetadata` (src/runtime/offload-types.ts) — Resume persistence block with agent session ID, tmux window name, spawn environment, chat flags, idle tracking
- `TelemetrySink` (src/runtime/executor.ts) — Interface for telemetry event emission

### TUI Types (src/tui/types.ts)

- `StyleProps` — TUI styling (color, backgroundColor, bold, etc.)
- `ElementProps` — Element properties with style + children
- `StatusPosition` — "top" | "bottom" for status placement
- `FooterConfig` — Footer rendering configuration

### Provider Wrapper Types

- `ClaudeClientWrapper`, `ClaudeSessionWrapper` (src/providers/claude.ts) — Wrappers around Claude Agent SDK types
- `CopilotClient`, `CopilotSession` — Re-exported from @github/copilot-sdk
- `OpencodeClient`, `OpencodeSession` — Re-exported from @opencode-ai/sdk

## Configuration

### Package Configuration

- `package.json` — SDK package metadata with 60+ named exports pointing to internal modules; direct imports of provider SDKs (claude-agent-sdk, copilot-sdk, opencode-sdk); peerDependency on react@19.2.6
- `tsconfig.json`, `tsconfig.build.json` — TypeScript compilation config for SDK

### Runtime Configuration (Services)

- Config loading via `src/services/config/atomic-config.ts` — merges ~/.atomic/config.json and .atomic/config.json (project-level)
- Settings schema in `src/services/config/settings-schema.ts` — Zod schema for both global and project configs
- Agent-specific config overrides via `src/services/config/definitions.ts` — AgentKey type, provider override mappings
- Additional instructions (system prompt extensions) loaded via `src/services/config/additional-instructions.ts`
- SCM sync flags for Copilot via `src/services/config/scm-sync.ts`

### Built-in Workflow Registration

- Builtin workflows registered in `src/workflows/index.ts` and individual agent variant files (claude/, copilot/, opencode/)
- Custom workflows loaded from `.atomic/workflows/` directory at runtime

## Examples / Fixtures

### Workflow Fixtures

- `src/runtime/__fixtures__/default-only.ts` — Minimal workflow fixture
- `src/runtime/__fixtures__/empty-module.ts` — Empty module for testing import errors
- `src/runtime/__fixtures__/host-only.ts` — Workflow registered via hostLocalWorkflows()

## Documentation

- `README.md` — SDK package documentation
- Inline JSDoc comments throughout source files documenting:
    - Workflow DSL usage (define-workflow.ts)
    - Runtime architecture (executor.ts, orchestrator-entry.ts)
    - Offload/resume state machine (offload-manager.ts)
    - tmux integration (tmux.ts)
    - Provider implementations (providers/\*.ts)
    - TUI rendering pipeline (tui/_, components/_)

## Notable Clusters

### Runtime Orchestration (src/runtime/)

- 35 files total; concentrates tmux integration, offload/resume state machine, executor, port discovery, session lifecycle
- Key dependencies: tmux, offload-manager, provider adapters
- Load-bearing for workflow execution; architecture must invert for pi-coding-agent (spawn pane dynamically rather than orchestrating from top-level)

### Provider Adapters (src/providers/)

- 15 files; three agent-specific implementations (Claude, Copilot, OpenCode) plus tests
- 100% pinned to claude-agent-sdk, copilot-sdk, opencode-sdk imports
- Load-bearing architectural seams; must be replaced entirely with pi-coding-agent integration layer

### TUI Components (src/components/ + src/tui/)

- 28 components + TUI utilities; OpenTUI-based React orchestrator panel, picker, graph rendering
- Dependencies: @opentui/core, @opentui/react, tmux mux operations
- Agent-agnostic after provider adapter replacement; layout/graph rendering can transfer with minimal changes

### Workflow Definitions (src/workflows/builtin/)

- 26 files; three builtin workflows (ralph, deep-research-codebase, open-claude-design) × 3 agents
- 100% agent-specific; must be rewritten for pi-coding-agent or replaced with plugin system
- Helpers (prompts, git, review logic) are mostly agent-agnostic; can be extracted

### Library Utilities (src/lib/)

- 18 files; subprocess spawning, environment setup, terminal detection, path resolution, telemetry
- Mix of agent-agnostic (spawn, atomicTempDir, workspace-paths) and agent-specific (auto-dispatch)
- auto-dispatch and CLI binding are removable; spawn/env/paths are reusable

### Configuration Services (src/services/)

- 7 files; config loading, agent detection, additional instructions, SCM sync
- Mostly removable; settings schema can be converted to pi-coding-agent config format
- Agent-specific overrides (definitions.ts) are tied to claude/copilot/opencode enums

### Primitives & DSL (src/define-workflow.ts, src/primitives/)

- 6 files; defineWorkflow() builder, input validation, metadata accessors, run() invocation
- Core DSL is agent-agnostic; re-platforming may keep AST/DSL shape with pi-agent callbacks
- SessionHandle and transcript persistence are reusable

### Type Definitions (src/types.ts)

- Single large file defining all SDK types
- 100% agent-agnostic except provider type maps (ClientMap, SessionMap, OptionsMap)
- Type structure itself is transferable; provider unions need replacement

---

## Dependencies Analysis

### Direct Agent SDK Imports (Pinning to Rewrite)

Files importing `@anthropic-ai/claude-agent-sdk`:

- `src/types.ts` (SessionMessage type import)
- `src/providers/claude.ts` (60 KB, core implementation)
- `src/runtime/executor.ts` (94 KB, orchestration)

Files importing `@github/copilot-sdk`:

- `src/types.ts` (SessionEvent, CopilotClient types)
- `src/providers/copilot.ts` (7.4 KB)
- `src/runtime/executor.ts`

Files importing `@opencode-ai/sdk`:

- `src/types.ts` (SessionPromptResponse types)
- `src/providers/opencode.ts` (4.4 KB)
- `src/runtime/executor.ts`

Files importing `tmux` (via `execSync`):

- `src/runtime/executor.ts` (session spawn, pane management)
- `src/runtime/offload-manager.ts` (offload cleanup)
- `src/runtime/tmux.ts` (28 KB, core tmux primitives)
- `src/lib/spawn.ts` (subprocess wrapper)

### OpenTUI Integration

Files using `@opentui/core`, `@opentui/react`:

- `src/components/orchestrator-panel.tsx` (React orchestrator)
- `src/components/session-graph-panel.tsx` (graph view)
- `src/components/workflow-picker-panel.tsx` (1.7 KB picker modal)
- `src/tui/renderer.ts` (footer rendering)
- `src/tui/mux.ts` (tmux option setting)
- `src/tui/compiler/` (React-to-CLI compiler)

### Agent-Agnostic Core (Portable)

- `src/define-workflow.ts` — DSL builder, not agent-specific
- `src/registry.ts` — Registry implementation
- `src/primitives/` — Input validation, metadata, session tracking
- `src/lib/atomic-temp.ts` — Temp directory management
- `src/lib/spawn.ts` — Subprocess execution
- `src/lib/terminal-env.ts` — Environment variable setup
- `src/lib/runtime-assets.ts` — Asset bundling
- `src/theme/colors.ts` — Color palette (Catppuccin)
- Most of `src/components/` (except provider-aware pieces)

---

## Architectural Seams for Pi-Coding-Agent Rewrite

### Inversion Point 1: Orchestrator Pane

**Current**: Atomic spawns tmux session with orchestrator pane running `_orchestrator-entry` CLI command; workflow engine runs inside pane and renders graph via React/OpenTUI.
**Rewrite**: Orchestrator becomes a pi extension that dynamically spawns a pane on demand during workflow execution; workflow runtime stays in host process, pane is just a view attachment.

### Inversion Point 2: Agent Provider Layer

**Current**: Executor directly invokes provider adapters (claude.ts, copilot.ts, opencode.ts) which wrap agent SDK calls.
**Rewrite**: Provider layer becomes pi extension hooks/skills that satisfy a unified agent interface; executor calls through that interface, not SDK-specific code.

### Inversion Point 3: Auto-Dispatch Sub-Commands

**Current**: `_orchestrator-entry` and `_cc-debounce` are private CLI sub-commands in the SDK.
**Rewrite**: These become pi-coding-agent commands or part of agent's native command dispatch; no SDK CLI wrapper needed.

### Inversion Point 4: Resume Persistence

**Current**: Metadata.json in stage directory; offload-manager handles read-write-resume cycle.
**Rewrite**: May be absorbed into pi's native session persistence; metadata format can be pi-agnostic (JSON serialization is format-free).

### Reusable Components After Rewrite

- `src/define-workflow.ts` — DSL syntax is portable; only callbacks need pi-agent wiring
- `src/types.ts` — Type structure is mostly portable; agent unions become extensible registries
- Graph layout/rendering (src/components/layout.ts, connectors.ts, etc.) — UI is agent-agnostic
- Picker modal (workflow-picker-panel.tsx) — Can be styled for pi
- Color/theme utilities (src/theme/colors.ts) — Catppuccin palette is portable

### Removable Code

- `src/runtime/tmux.ts` — Entirely tmux-specific; pi will have native pane spawning
- `src/runtime/executor.ts` — Executor-specific; pi-agent has native execution model
- `src/providers/*.ts` — Agent SDK wrappers; replaced by pi extensions
- `src/lib/auto-dispatch.ts`, `src/lib/dispatch-utils.ts` — CLI dispatch logic
- All `*Resume*.ts` in providers — Agent SDK-specific resume mechanisms
- `src/workflows/builtin/*.ts` — Agent-specific workflow definitions
- `src/services/config/definitions.ts` — AgentKey enum (pi will have native agent detection)

---

## Load-Bearing Dependencies Summary

| Module                             | Criticality | Reason                         | Rewrite Implications                                          |
| ---------------------------------- | ----------- | ------------------------------ | ------------------------------------------------------------- |
| executor.ts                        | CRITICAL    | Workflow execution engine      | Core pi-agent integration point; architecture invert required |
| orchestrator-entry.ts              | CRITICAL    | Workflow definition resolution | May become redundant if pi handles module loading             |
| define-workflow.ts                 | HIGH        | DSL surface                    | Keep as-is, adapt callbacks to pi-agent                       |
| registry.ts                        | HIGH        | Workflow registration          | Reusable with minimal changes                                 |
| providers/claude.ts                | CRITICAL    | Claude integration             | Entirely replaced by pi-agent SDK                             |
| providers/copilot.ts               | CRITICAL    | Copilot integration            | Entirely replaced by pi-agent SDK                             |
| providers/opencode.ts              | CRITICAL    | OpenCode integration           | Entirely replaced by pi-agent SDK                             |
| tmux.ts                            | CRITICAL    | tmux session management        | Replaced by pi-agent's native pane spawning                   |
| offload-manager.ts                 | HIGH        | Session resume state machine   | May be replaced by pi's native session persistence            |
| panel.tsx + orchestrator-panel.tsx | HIGH        | Graph visualization            | Can be ported with UI framework upgrade                       |
| workflow-picker-panel.tsx          | MEDIUM      | Workflow selection UI          | Portable after agent-agnostic refactor                        |
| runtime/port-discovery.ts          | MEDIUM      | Port detection                 | Likely removable with pi architecture                         |
| lib/atomic-temp.ts                 | MEDIUM      | Temp directory                 | Reusable as-is                                                |
| lib/spawn.ts                       | MEDIUM      | Subprocess execution           | Likely reusable or replaced by pi's spawn interface           |

---

## Key Entry Points for Pi-Agent Integration

1. **Workflow Execution Entry**: `src/primitives/run.ts` → `runWorkflow()` currently calls `executeWorkflow()` in executor.ts; must be wired to pi-coding-agent's native workflow execution.

2. **Provider Dispatch**: `src/runtime/executor.ts` lines 1100–1200 (approx.) enumerate agent type and dispatch to provider adapters; becomes pi extension loading point.

3. **Orchestrator Pane**: `src/runtime/panel.tsx` and `src/components/orchestrator-panel.tsx` are TUI entry points; can be adapted as pi panel extension.

4. **Registry Resolution**: `src/registry.ts` and `src/define-workflow.ts` handle workflow lookup; pi-agent may handle this natively or via plugin hooks.

5. **Workflow Definition**: `src/define-workflow.ts` exports `defineWorkflow()` and `WorkflowBuilder` class; core DSL surface that pi-coding-agent can adopt/adapt.

6. **Session Persistence**: `src/runtime/offload-manager.ts` and `src/runtime/status-writer.ts` handle resume metadata; pi-agent can adopt the metadata schema or replace it.

## How It Works

<!-- Source: codebase-analyzer sub-agent -->

# Partition 1 — `packages/atomic-sdk/` Deep Implementation Audit

## Files Analysed

- `packages/atomic-sdk/src/index.ts`
- `packages/atomic-sdk/src/define-workflow.ts`
- `packages/atomic-sdk/src/types.ts`
- `packages/atomic-sdk/src/registry.ts`
- `packages/atomic-sdk/src/primitives/run.ts`
- `packages/atomic-sdk/src/runtime/orchestrator-entry.ts`
- `packages/atomic-sdk/src/runtime/executor.ts` (read in four slices: 1–600, 600–1000, 1000–1500, 1500–2000)
- `packages/atomic-sdk/src/runtime/tmux.ts` (read in two slices: 1–200, 200–550)
- `packages/atomic-sdk/src/runtime/offload-manager.ts` (first 200 lines)
- `packages/atomic-sdk/src/providers/claude.ts` (two slices: 1–200, 200–500)
- `packages/atomic-sdk/src/providers/copilot.ts`
- `packages/atomic-sdk/src/providers/opencode.ts`
- `packages/atomic-sdk/src/lib/host-local-workflows.ts`
- `packages/atomic-sdk/src/services/config/definitions.ts`

---

## Per-File Notes

### `packages/atomic-sdk/src/index.ts`

- **Role:** Public SDK barrel that re-exports every consumer-facing symbol from the internal submodules.
- **Key symbols:**
    - `defineWorkflow` (`index.ts:20`) — re-exported from `define-workflow.ts`
    - `WorkflowBuilder`, `getCompiledWorkflows` (`index.ts:20`) — same source
    - `createRegistry` (`index.ts:21`) — re-exported from `registry.ts`
    - `hostLocalWorkflows` (`index.ts:25`) — re-exported from `lib/host-local-workflows.ts`
    - `runWorkflow` (`index.ts:84`) — re-exported from `primitives/run.ts`
    - `setExecutorTelemetrySinks`, `TelemetrySink` (`index.ts:92–93`) — re-exported from `runtime/executor.ts`
    - `listSessions`, `getSession`, `stopSession`, `attachSession`, `detachSession`, `nextWindow`, `previousWindow`, `gotoOrchestrator`, `getSessionStatus`, `getSessionTranscript` (`index.ts:96–107`) — session management from `primitives/sessions.ts`
    - `filterSpawnEnv`, `persistResume`, `OffloadManager`, `OffloadManagerDeps` (`index.ts:117–121`) — offload state machine surface from `runtime/offload-manager.ts`
    - All core types (`AgentType`, `WorkflowDefinition`, `WorkflowContext`, `SessionContext`, `SessionHandle`, `WorkflowInput`, etc.) — from `types.ts`
- **Control flow:** Pure re-exports plus two small utility functions `listWorkflows` (`index.ts:66`) and `getWorkflow` (`index.ts:71`) that delegate to `registry.list()` and `registry.resolve()`.
- **Data flow:** No transformation; just surface expansion.
- **Dependencies:** All internal siblings; no external libraries imported directly.

---

### `packages/atomic-sdk/src/define-workflow.ts`

- **Role:** Implements the `defineWorkflow()` factory and `WorkflowBuilder` DSL that workflow authors call at module-load time to register and compile a `WorkflowDefinition`.
- **Key symbols:**
    - `_captureCallerPath(stack?)` (`define-workflow.ts:48`) — walks V8 stack trace to extract the calling file's absolute path; exported with `_` prefix for unit testing only
    - `RESERVED_INPUT_NAMES` (`define-workflow.ts:140`) — `const` array of names (`name`, `agent`, `detach`, `list`, `help`, `version`, `session`, `status`) that collide with the Atomic CLI's `workflow` subcommand flags; validated in `validateWorkflowInput`
    - `validateWorkflowInput(input, workflowName)` (`define-workflow.ts:156`) — throws on empty/invalid name, reserved names, enum without values, and non-integer defaults
    - `WorkflowBuilder<A, I>` (`define-workflow.ts:217`) — generic class; holds `options`, `runFn`, and `agentValue`; exposes `.for(agent)`, `.run(fn)`, `.compile()` chain
    - `WorkflowBuilder.compile()` (`define-workflow.ts:284`) — seals the definition; freezes inputs; throws if `source` is empty (compiled-binary bunfs path); pushes into module-private `_compiledWorkflowRegistry`
    - `getCompiledWorkflows()` (`define-workflow.ts:121`) — returns snapshot of `_compiledWorkflowRegistry`; called by `_emit-workflow-meta` auto-dispatch
    - `defineWorkflow<I>(options)` (`define-workflow.ts:376`) — factory; calls `_captureCallerPath()` to auto-populate `source` if not explicitly supplied; returns `new WorkflowBuilder`
- **Control flow:** `defineWorkflow()` → `new WorkflowBuilder` → `.for(agent)` returns new builder with `agentValue` set → `.run(fn)` sets `runFn` on same builder → `.compile()` validates, freezes inputs, checks `agentValue !== null` and `source` non-empty, constructs `WorkflowDefinition` literal, pushes into `_compiledWorkflowRegistry`, returns sealed object.
- **Data flow:** Input: `WorkflowOptions<I>` (author-supplied at call site). Output: `WorkflowDefinition<A, I>` pushed into module-private registry and returned to caller. `source` is the auto-captured absolute path of the caller's file, used by `orchestrator-entry.ts` to `import()` the module inside the child process.
- **Dependencies:** `./types.ts` (type imports only); no external libraries.

---

### `packages/atomic-sdk/src/types.ts`

- **Role:** Single file declaring every public TypeScript type in the SDK, including agent-specific type maps that pin the SDK to Claude/Copilot/OpenCode SDKs.
- **Key symbols (agent-pinning imports):**
    - `import type { SessionEvent } from "@github/copilot-sdk"` (`types.ts:7`) — Copilot message type in `SavedMessage`
    - `import type { SessionPromptResponse } from "@opencode-ai/sdk/v2"` (`types.ts:8`) — OpenCode response type in `SavedMessage`
    - `import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk"` (`types.ts:9`) — Claude message type in `SavedMessage`
    - `import type { ClaudeClientWrapper, ClaudeSessionWrapper } from "./providers/claude.ts"` (`types.ts:25–26`)
    - `import type { CopilotClient, CopilotClientOptions, CopilotSession, SessionConfig as CopilotSessionConfig } from "@github/copilot-sdk"` (`types.ts:13–17`)
    - `import type { OpencodeClient, Session as OpencodeSession } from "@opencode-ai/sdk/v2"` (`types.ts:19–21`)
- **Key public types:**
    - `AgentType = AgentKey` (`types.ts:33`) — `"claude" | "copilot" | "opencode"` — the union controlling all agent dispatch
    - `ClientOptionsMap` (`types.ts:41–45`) — internal map of agent → client init options; `opencode: { directory?, experimental_workspaceID? }`, `copilot: Omit<CopilotClientOptions, "cliUrl">`, `claude: { chatFlags?: string[] }`
    - `SessionOptionsMap` (`types.ts:53–62`) — internal map of agent → session create options
    - `ClientMap` / `SessionMap` (`types.ts:65–76`) — internal maps of agent → resolved client/session types
    - `StageClientOptions<A>`, `StageSessionOptions<A>`, `ProviderClient<A>`, `ProviderSession<A>` (`types.ts:79–88`) — distributed type lookups over the maps above
    - `WorkflowInputType` (`types.ts:157`) — `"string" | "text" | "enum" | "integer"`
    - `WorkflowInput` (`types.ts:169`) — per-field schema: `name`, `type`, `required?`, `description?`, `placeholder?`, `default?`, `values?`
    - `InputsOf<I>` (`types.ts:206`) — conditional mapped type producing typed `ctx.inputs` from the literal input schema
    - `SessionContext<A, I>` (`types.ts:296`) — per-stage callback context: `client`, `session`, `inputs`, `agent`, `transcript(ref)`, `getMessages(ref)`, `save`, `sessionDir`, `paneId`, `sessionId`, `stage()` (nested)
    - `WorkflowContext<A, I>` (`types.ts:355`) — top-level callback context: `inputs`, `agent`, `stage()`, `transcript()`, `getMessages()`
    - `WorkflowDefinition<A, I>` (`types.ts:584`) — sealed output of `.compile()`: `__brand`, `name`, `agent`, `description`, `source`, `inputs`, `minSDKVersion`, `run(ctx)`
    - `SavedMessage` (`types.ts:237`) — discriminated union `{ provider: "copilot"; data: SessionEvent } | { provider: "opencode"; data: SessionPromptResponse } | { provider: "claude"; data: SessionMessage }`
    - `ExternalWorkflow` (`types.ts:485`) — workflow from `settings.json` with `source: { command, args }` instead of a file path
    - `BrokenWorkflow` (`types.ts:466`) — workflow that failed to load; carries `alias`, `origin`, `agents`, `reason`, `fix`
    - `RegistrableWorkflow` (`types.ts:506`) — discriminated union of builtin (`__brand: "WorkflowDefinition"`) and external shapes
    - `Registry<T>` (`types.ts:527`) — interface with `register()`, `upsert()`, `get()`, `has()`, `list()`, `resolve()` — immutable/chainable
    - `validateWorkflowSource(source, rules)` (`types.ts:121`) — regex-based source validation helper
    - `createProviderValidator(rules)` (`types.ts:141`) — curried factory returning a `(source: string) => ValidationWarning[]`
- **Data flow:** Pure type declarations and two pure functions (`validateWorkflowSource`, `createProviderValidator`). The agent-specific type imports are the load-bearing coupling point — replacing agent SDKs requires replacing these import lines and the `ClientMap`/`SessionMap`/options maps.
- **Dependencies:** `@github/copilot-sdk`, `@opencode-ai/sdk/v2`, `@anthropic-ai/claude-agent-sdk` (type-only imports); `./providers/claude.ts`, `./services/config/definitions.ts` (type-only).

---

### `packages/atomic-sdk/src/registry.ts`

- **Role:** Implements the `Registry<T>` interface as an immutable chainable `RegistryImpl` class keyed by `${agent}/${name}`, with provider-specific validation on registration.
- **Key symbols:**
    - `providerValidators` (`registry.ts:21–28`) — `Record<AgentType, (source: string) => ValidationWarning[]>` mapping to `validateClaudeWorkflow`, `validateOpenCodeWorkflow`, `validateCopilotWorkflow`
    - `runProviderValidation(wf)` (`registry.ts:37`) — calls `.run.toString()` on the workflow function body as source text, passes to the agent's validator
    - `validateAtRegistration(wf)` (`registry.ts:48`) — skips external workflows; calls `runProviderValidation` and `console.warn`s each warning
    - `RegistryImpl<T>` (`registry.ts:65`) — private `ReadonlyMap<string, WorkflowDefinition | ExternalWorkflow>`; `register()` throws on duplicates; `upsert()` allows silent replacement; `list()` returns `Object.freeze(Array.from(this.map.values()))`; `resolve(name, agent)` returns `this.map.get(`${agent}/${name}`)`
    - `createRegistry()` (`registry.ts:151`) — factory returning `new RegistryImpl(new Map())`
- **Control flow:** `createRegistry()` → `.register(wf)` clones map, validates, sets key, returns new `RegistryImpl`. `resolve(name, agent)` is the primary lookup path used by the picker and executor.
- **Data flow:** In: `RegistrableWorkflow` objects; out: typed `Registry<T>` accumulating registered entries as a type-level intersection. Validation is a side-effect (console.warn) — not a throw.
- **Dependencies:** `./types.ts`, `./providers/copilot.ts` (for `validateCopilotWorkflow`), `./providers/opencode.ts` (for `validateOpenCodeWorkflow`), `./providers/claude.ts` (for `validateClaudeWorkflow`).

---

### `packages/atomic-sdk/src/primitives/run.ts`

- **Role:** Public entry point for spawning a workflow; validates inputs then delegates to `executeWorkflow` in `runtime/executor.ts`.
- **Key symbols:**
    - `RunWorkflowOptions` (`run.ts:26`) — `workflow: RegistrableWorkflow`, `inputs?`, `cwd?`, `detach?`, `pathToAtomicExecutable?`
    - `RunWorkflowResult` (`run.ts:58`) — `{ id: string; tmuxSessionName: string }`
    - `runWorkflow(options)` (`run.ts:82`) — validates inputs via `validateInputs()`, casts `workflow as unknown as WorkflowDefinition`, calls `executeWorkflow({ definition, agent, inputs, projectRoot, detach, pathToAtomicExecutable })`
- **Control flow:** Module import triggers `../lib/auto-dispatch.ts` as a side-effect (`run.ts:16`) — this intercepts `_orchestrator-entry` and `_cc-debounce` argv before any user code runs. `runWorkflow()` calls `validateInputs(workflow, inputs)` then `executeWorkflow(...)`.
- **Data flow:** Raw `inputs: Record<string, string>` → validated/resolved via `validateInputs` → passed to executor as clean record. Returns `{ id, tmuxSessionName }` which the caller can use to attach or monitor.
- **Dependencies:** `../lib/auto-dispatch.ts` (side-effect import), `../runtime/executor.ts` (`executeWorkflow`), `../types.ts`, `./inputs.ts` (`validateInputs`).

---

### `packages/atomic-sdk/src/runtime/orchestrator-entry.ts`

- **Role:** SDK-owned entry point for the `_orchestrator-entry` CLI sub-command; resolves a `WorkflowDefinition` from a source path (dynamic import) or from the host registry, then runs the orchestrator.
- **Key symbols:**
    - `resolveWorkflowDefinition(sourcePath, workflowName, agent)` (`orchestrator-entry.ts:57`) — `import(sourcePath)` to load the module; checks `lookupLocalWorkflow(workflowName, agent)` first (host registry populated by `hostLocalWorkflows`); falls back to `mod.default` if it has `__brand: "WorkflowDefinition"`; throws `InvalidWorkflowError` if neither resolves
    - `runOrchestratorWithDefinition(def, inputsB64)` (`orchestrator-entry.ts:88`) — compiled-binary path; skips dynamic import, decodes inputs, calls `runOrchestrator(def, inputs)`
    - `runOrchestratorEntry(sourcePath, workflowName, agentRaw, inputsB64)` (`orchestrator-entry.ts:130`) — dev/installed-package path; validates agent via `isValidAgent`, resolves definition via `resolveWorkflowDefinition`, validates `def.agent === agent`, decodes inputs, calls `runOrchestrator(def, inputs)`
    - `decodeInputs(b64)` (`orchestrator-entry.ts:97`) — base64-decodes the inputs JSON payload; returns `{}` on any parse failure
- **Control flow:** The CLI's `_orchestrator-entry` sub-command calls `runOrchestratorEntry(sourcePath, workflowName, agentRaw, inputsB64)` in dev mode, or `runOrchestratorWithDefinition(def, inputsB64)` in compiled-binary mode (CLI has already done the registry lookup). Both paths end in `runOrchestrator(def, inputs)` from `executor.ts`.
- **Data flow:** Inputs arrive as base64-encoded JSON (set by `executeWorkflow` in `executor.ts:750`). Source path is the auto-captured `import.meta.path` of the workflow file. Output: side-effect of running the orchestrator panel (no return value to caller).
- **Dependencies:** `./executor.ts` (`runOrchestrator`), `../types.ts`, `../services/config/definitions.ts` (`isValidAgent`), `../errors.ts` (`InvalidWorkflowError`), `../lib/host-local-workflows.ts` (`lookupLocalWorkflow`).

---

### `packages/atomic-sdk/src/runtime/executor.ts`

- **Role:** Core workflow execution engine; implements `executeWorkflow()` (spawns the orchestrator tmux session), `runOrchestrator()` (runs inside that session), and `createSessionRunner()` (implements `ctx.stage()` lifecycle).
- **Key symbols:**
    - `AGENT_CLI` (`executor.ts:86–111`) — `Record<AgentType, { cmd, chatFlags, envVars }>` hard-coding `copilot` / `opencode` / `claude` CLI spawn settings including `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` for Claude
    - `TelemetrySink` (`executor.ts:137`) — interface `{ emit(event, payload) }`; `setExecutorTelemetrySinks()` (`executor.ts:152`) injects custom sinks for testing
    - `buildPaneCommand(agent, overrides, extraChatFlags)` (`executor.ts:464`) — builds the shell command string for each agent's tmux window: copilot uses `--ui-server --port 0`, opencode uses `--port 0`, claude spawns `$SHELL` (CLI launched lazily by `createClaudeSession`)
    - `waitForServer(agent, paneId)` (`executor.ts:533`) — for copilot/opencode: polls `capturePane` until 3+ lines render, discovers port via `getListeningPortForPid(panePid)`, probes copilot SDK via `CopilotClient.start()` + `listSessions()`, returns `"localhost:<port>"`; for claude returns `""`
    - `executeWorkflow(options)` (`executor.ts:659`) — spawns the tmux session: resolves dispatcher, reconciles opencode instructions, generates `workflowRunId`, writes launcher shell script embedding the `_orchestrator-entry` command with base64 inputs, calls `tmux.createSession(sessionName, shellCmd, "orchestrator", ...)`, calls `spawnAttachedFooter`, optionally attaches or detaches
    - `initProviderClientAndSession<A>(agent, serverUrl, paneId, ...)` (`executor.ts:1589`) — switch over `agent`: copilot uses `new CopilotClient({ cliUrl: serverUrl })` + `client.createSession()` + `client.setForegroundSessionId()`; opencode uses `createOpencodeClient({ baseUrl: serverUrl })` or `createOpencode({ port: 0 })` for headless; claude uses `new ClaudeClientWrapper(paneId, opts)` + `client.start()` or headless `HeadlessClaudeClientWrapper`
    - `cleanupProvider<A>(agent, client, session, paneId)` (`executor.ts:1750`) — copilot: `session.disconnect()` + `client.stop()`; opencode: no-op; claude: `clearClaudeSession(paneId)` unless headless
    - `createSessionRunner(shared, parentName)` (`executor.ts:1861`) — returns the `ctx.stage()` function; manages: name uniqueness check → graph frontier inference → tmux window creation or headless path → `waitForServer` → `initProviderClientAndSession` → runs callback → cleanup → transcript/messages persistence
    - `wrapCopilotSend()` (`executor.ts:1238`) — wraps Copilot `session.send()` to block until `session.idle` fires
    - `watchOpencodeStreamForHIL(stream, sessionId, onHIL)` (`executor.ts:1303`) — consumes OpenCode SSE stream, calls `onHIL(true/false)` on `question.asked/replied/rejected`
    - `watchCopilotSessionForHIL(session, onHIL)` (`executor.ts:1355`) — tracks `ask_user` via `tool.execution_start/complete` events
    - `renderClaudeTranscript`, `renderCopilotTranscript`, `renderOpencodeTranscript`, `renderMessagesToText` (`executor.ts:978–1201`) — per-agent Markdown rendering of session messages
    - `discoverCopilotBinary()`, `shouldOverrideCopilotCliPath()`, `applyContainerEnvDefaults()` (`executor.ts:375–442`) — Bun-without-node detection for Copilot CLI path override
- **Control flow:**
    1. `executeWorkflow()` → writes launcher.sh → `tmux.createSession(...)` → optionally attaches
    2. Inside tmux pane: launcher.sh runs `atomic _orchestrator-entry <name> <agent> <inputsB64> <source>`
    3. `runOrchestratorEntry()` → `resolveWorkflowDefinition()` → `runOrchestrator(def, inputs)`
    4. `runOrchestrator()` initialises `OrchestratorPanel`, creates `SharedRunnerState`, builds `WorkflowContext` with `stage()` pointing to `createSessionRunner(shared, "orchestrator")`
    5. `definition.run(ctx)` is called — user workflow code runs; each `ctx.stage(opts, clientOpts, sessionOpts, fn)` invocation goes through `createSessionRunner`
    6. Inside `createSessionRunner`: name uniqueness → graph inference → `tmux.createWindow(...)` or headless → `waitForServer` → `initProviderClientAndSession` → callback `fn(sessionCtx)` → cleanup → writes `inbox.md` / `messages.json`
- **Data flow:** `executeWorkflow` takes `WorkflowRunOptions` → spawns tmux session → inside pane `runOrchestrator` takes `WorkflowDefinition` + `Record<string, string>` inputs → `ctx.stage()` takes `SessionRunOptions` + per-agent client/session opts → returns `SessionHandle<T>`. Transcripts written to `~/.atomic/sessions/<runId>/<name-sessionId>/inbox.md` and `messages.json`.
- **Dependencies:** `node:path`, `node:os`, `node:fs/promises`, `node:fs`, `bun` (Bun.sleep, Bun.which, Bun.write), `@github/copilot-sdk` (dynamic `import()` in `initProviderClientAndSession` and `waitForServer`), `@opencode-ai/sdk/v2` (dynamic import), `@anthropic-ai/claude-agent-sdk` (dynamic import in `wrapMessages`), `./tmux.ts`, `./port-discovery.ts`, `./attached-footer.ts`, `./offload-manager.ts`, `./graph-inference.ts`, `./status-writer.ts`, `./panel.tsx`, `../providers/claude.ts`, `../providers/opencode.ts`, `../providers/copilot.ts`, `../services/config/atomic-config.ts`, `../services/config/scm-sync.ts`, `../services/config/additional-instructions.ts`, `../services/system/copy.ts`, `../lib/self-exec.ts`, `../lib/terminal-env.ts`, `../lib/atomic-temp.ts`, `../lib/telemetry/index.ts`, `../theme/colors.ts`, `../errors.ts`.

---

### `packages/atomic-sdk/src/runtime/tmux.ts`

- **Role:** Low-level tmux (and psmux for Windows) abstraction; every tmux CLI invocation in the SDK passes through this file.
- **Key symbols:**
    - `SOCKET_NAME = "atomic"` (`tmux.ts:22`) — dedicated socket name isolating Atomic from the user's default tmux server
    - `getMuxBinary()` (`tmux.ts:54`) — resolves `tmux` (Unix) or `psmux`/`pmux` (Windows) via `Bun.which`; caches result
    - `tmuxRun(args)` → `TmuxResult` (`tmux.ts:116`) — runs `<binary> -f <config> -L atomic <args>` via `Bun.spawnSync`; returns `{ ok, stdout|stderr }`
    - `createSession(sessionName, initialCommand, windowName?, cwd?, envVars?, pathToAtomicExecutable?)` (`tmux.ts:185`) — `tmux new-session -d -s <name> -P -F #{pane_id} -e KEY=VALUE ... <cmd>`; also calls `tmux source-file <config>` to reload keybindings and `tmux set-option -g @atomic-cc-debounce <cmd>` to expose the cc-debounce command server-wide
    - `createWindow(sessionName, windowName, command, cwd?, envVars?)` (`tmux.ts:286`) — `tmux new-window -d -t <session> -n <window> -P -F #{pane_id} -e ... <cmd>`
    - `respawnPane(paneId, command)` (`tmux.ts:331`) — `tmux respawn-pane -k -t <paneId> <cmd>`; used by claude.ts to exec `claude ...` in a bare shell pane
    - `sendLiteralText(paneId, text)` (`tmux.ts:346`) — `tmux send-keys -t <pane> -l -- <text>`; normalises newlines to spaces
    - `sendViaPasteBuffer(paneId, text)` (`tmux.ts:363`) — writes text to a temp file, `tmux load-buffer <tmp>` then `tmux paste-buffer -t <pane> -d`; for large payloads
    - `sendSpecialKey(paneId, key)` (`tmux.ts:387`) — `tmux send-keys -t <pane> <key>`
    - `capturePane(paneId, start?)` (`tmux.ts:401`) — `tmux capture-pane -t <pane> -p [-S <start>]`
    - `killWindow(sessionName, windowName)` (`tmux.ts:470`) — async; refuses names in `RESERVED_WINDOW_NAMES` (`{"0", "orchestrator"}`); calls `tmux kill-window -t <session>:<window>`
    - `killSession(sessionName)` (`tmux.ts:445`) — `tmux kill-session -t <name>`; swallows errors
    - `getPanePid(paneId)` (`tmux.ts:517`) — `tmux display-message -t <pane> -p #{pane_pid}` → `number | null`
    - `getSessionEnv(sessionName, key)` (`tmux.ts:528`) — `tmux show-environment -t <session> <key>` → `string | null`
    - `killSessionOnPaneExit(sessionName, paneId)` (`tmux.ts:262`) — installs `pane-exited` and `after-kill-pane` hooks to kill the entire session when the agent pane exits; used for chat sessions
    - `RESERVED_WINDOW_NAMES` (`tmux.ts:459`) — `ReadonlySet<string>` containing `"0"` and `"orchestrator"` — prevents `killWindow` from destroying the orchestrator pane
- **Control flow:** All tmux operations pass through `tmuxRun()` which calls `Bun.spawnSync` with the full `[binary, "-f", configPath, "-L", "atomic", ...args]` argv. No shell interpolation — arguments are passed as an array. `createSession` additionally calls `tmuxRun(["source-file", CONFIG_PATH])` and sets the `@atomic-cc-debounce` user option.
- **Data flow:** Input: discrete args arrays. Output: pane IDs (strings like `"%12"`), stdout text, or void. Side effects: tmux server state mutations (sessions, windows, panes, hooks, options).
- **Dependencies:** `../lib/spawn.ts` (`requiredMuxBinaryCandidatesForPlatform`), `../lib/runtime-assets.ts` (`tmuxConfPath`), `../lib/self-exec.ts` (`buildSelfExecCommand`, `resolveDispatcher`), `node:fs` (`writeFileSync`, `unlinkSync`), `../lib/atomic-temp.ts` (`atomicTempPath`), `../lib/terminal-env.ts` (`normalizedTerminalEnv`).

---

### `packages/atomic-sdk/src/runtime/offload-manager.ts`

- **Role:** State machine for workflow pane offload and resume; persists resume metadata to `metadata.json` with a per-stage in-process mutex.
- **Key symbols:**
    - `filterSpawnEnv(env)` (`offload-manager.ts:49`) — allowlist filter over `process.env`; exact-deny set includes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`; suffix-deny pattern `/_(API_KEY|AUTH_TOKEN|SECRET|TOKEN|PASSWORD)$/i`; exact-allow set: `CLAUDECODE`, `PATH`, `HOME`, `LANG`, `SHELL`; prefix-allow: `ATOMIC_`, `LC_`, `OPENCODE_`, `COPILOT_`
    - `persistResume(stageDir, patch)` (`offload-manager.ts:122`) — queues writes via `_stageMutex` (per-stageDir promise chain); calls `_doPersist(metaPath, patch)`
    - `_doPersist(metaPath, patch)` (`offload-manager.ts:149`) — reads `metadata.json`, merges `patch` over existing `resume` sub-object (defaults → existing → patch; `schemaVersion` always `1`), writes atomically via `.tmp` rename at mode `0o600`
    - `OffloadResumeMetadata` schema (`offload-types.ts`) — `{ schemaVersion: 1, agentSessionId, tmuxSessionName, tmuxWindowName, spawnEnv, spawnCwd, chatFlags, lastPrompt, lastSeenAt, offloadedAt }`
- **Control flow:** `persistResume` is called by the executor when a session starts to record its resume-relevant state (tmux window name, agent session ID, chat flags, spawn environment). The mutex prevents concurrent writes for the same stage from corrupting the file. `doResume` (not read in this slice) reads the persisted metadata to respawn a killed/detached session.
- **Data flow:** In: `stageDir` path + `Partial<OffloadResumeMetadata>`. Out: updated `metadata.json` in that directory. The allowlist filter strips secrets from the `spawnEnv` field before persisting to disk (tokens are re-injected from the live `process.env` at resume time).
- **Dependencies:** `node:fs` (`promises as fs`), `node:path`, `./offload-types.ts`, `../components/orchestrator-panel-types.ts`, `../providers/claude.ts` (`claudeOffloadCleanup`).

---

### `packages/atomic-sdk/src/providers/claude.ts`

- **Role:** Claude Code provider — manages interactive Claude TUI sessions inside tmux panes via send-keys, the Claude Agent SDK (for headless mode and transcript reads), and a hook-based idle/ready/HIL detection mechanism.
- **Key symbols:**
    - `WORKFLOW_HOOK_SETTINGS` (`claude.ts:250`) — JSON object with `SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `TeammateIdle` hooks all pointing to `atomic _claude-<hook>-hook` sub-commands; `Stop` timeout set to `2_147_483` seconds (~24 days)
    - `createClaudeSession(options)` (`claude.ts:393`) — generates `randomUUID()` session ID, stores in `initializedPanes` map, writes PID file, returns session UUID; does NOT spawn `claude` yet (lazy spawn on first query)
    - `spawnClaudeWithPrompt(paneId, promptFile, chatFlags, sessionId)` (`claude.ts:431`) — calls `ensureWorkflowHookSettings()` to write JSON settings file, builds `claude [chatFlags] --settings <path> --session-id <uuid> "Read <file>"` command, calls `respawnPane(paneId, cmd)` to exec directly in the tmux pane (no shell race), then `waitForReadyMarker(sessionId)` to poll for `~/.atomic/claude-ready/<uuid>` file
    - `ensureWorkflowHookSettings()` (`claude.ts:472`) — writes `WORKFLOW_HOOK_SETTINGS` to a content-addressed temp file at `atomicContentTempPath("claude-settings-atomic", ".json", ...)` with mode `0o600`, returns path
    - `waitForReadyMarker(sessionId)` (`claude.ts:496`) — watches `~/.atomic/claude-ready/<uuid>` via `fs.watch`; resolves when file appears; `READY_HOOK_TIMEOUT_MS = 2_147_483_000`
    - `clearClaudeSession(paneId)` (`claude.ts:88`) — releases the Stop hook marker, waits for in-flight subagents via `waitForInflightDrained`, clears PID file, ready marker, and inflight tracking; called by executor during cleanup
    - `ClaudeClientWrapper` (class, `claude.ts` ~line 550+) — wraps a pane's Claude state; `start()` calls `createClaudeSession` and returns session UUID; exposes `paneId`, `sessionDir`, session-level state
    - `ClaudeSessionWrapper` (class) — session wrapper used by `initProviderClientAndSession`; `sessionId` is the Claude UUID; exposes `query()` for sending prompts
    - `HeadlessClaudeClientWrapper` / `HeadlessClaudeSessionWrapper` — headless path using `sdkQuery()` from `@anthropic-ai/claude-agent-sdk`; `query()` calls the Agent SDK directly
    - `buildClaudeResumeArgs(meta)` — builds `claude [chatFlags] --resume <sessionId> --settings <path>` argv for offload resume
    - `validateClaudeWorkflow(source)` — `createProviderValidator([...])` checking for forbidden direct SDK API usage
- **Control flow (interactive path):** `createClaudeSession(paneId)` → `claudeQuery(paneId, prompt)` (first call) → `spawnClaudeWithPrompt(paneId, promptFile, chatFlags, sessionId)` → `waitForReadyMarker(sessionId)` → prompt delivery → `waitForIdle(sessionId)` watching JSONL. Subsequent queries: `sendViaPasteBuffer` or `sendLiteralText` + `sendSpecialKey("C-m")` into the already-running Claude pane.
- **Control flow (headless path):** `new HeadlessClaudeClientWrapper()` → `client.start()` → `new HeadlessClaudeSessionWrapper(projectRoot)` → `session.query(prompt, opts)` calls `sdkQuery(...)` from `@anthropic-ai/claude-agent-sdk` directly.
- **Data flow:** Prompts written to temp files at `atomicContentTempPath`, delivered via tmux paste buffer or send-keys. Responses read from JSONL transcript at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (discovered via `getSessionMessages` from the Agent SDK). Hook markers written to `~/.atomic/claude-ready/`, `~/.atomic/claude-inflight/`, `~/.atomic/claude-hil/`.
- **Dependencies:** `@anthropic-ai/claude-agent-sdk` (`getSessionMessages`, `query as sdkQuery`, `SessionMessage`, `SDKUserMessage`, `Options as SDKOptions`), `../runtime/tmux.ts` (`respawnPane`), `./claude-stop-hook.ts`, `./claude-inflight-hook.ts`, `../lib/workspace-paths.ts`, `../lib/runtime-env.ts`, `node:crypto`, `node:fs/promises`, `node:fs`, `node:path`.

---

### `packages/atomic-sdk/src/providers/copilot.ts`

- **Role:** Copilot provider utilities — CLI path resolution, subprocess env setup, session system message merging, resume arg building, and source validation.
- **Key symbols:**
    - `isCopilotShim(candidate)` (`copilot.ts:61`) — detects `.js`/`.mjs`/`.cjs` Node shims (the npm-installed wrappers that need `node` to run); checks file extension, `node_modules/.bin` symlink target, and shebang/npm-loader-marker in first 256 bytes
    - `resolveCopilotCliPath(resolveCommandPath?)` (`copilot.ts:100`) — checks `COPILOT_CLI_PATH` env first; then `getCommandPath("copilot")`; if it's a shim, enumerates `PATH` candidates to find a non-shim binary
    - `copilotSdkLaunchOptions()` (`copilot.ts:127`) — returns `CopilotClientOptions` with `env: copilotSubprocessEnv()` (UTF-8 locale + `NODE_NO_WARNINGS=1`) and optional `cliPath`
    - `mergeCopilotSystemMessage(existing, extra)` (`copilot.ts:154`) — merges additional instructions into copilot session `systemMessage`; respects `replace` mode
    - `buildCopilotResumeArgs(meta)` (`copilot.ts:187`) — returns `["--ui-server", "--port", "0", "--resume=<sessionId>", ...meta.chatFlags]`
    - `validateCopilotWorkflow` (`copilot.ts:199`) — `createProviderValidator` checking for `new CopilotClient` and `client.createSession` patterns
- **Data flow:** Pure utility functions; no persistent state. `resolveCopilotCliPath` reads filesystem and `process.env`.
- **Dependencies:** `node:fs` (`closeSync`, `existsSync`, `openSync`, `readSync`, `realpathSync`), `node:path`, `@github/copilot-sdk` (type imports), `../lib/terminal-env.ts`, `../runtime/offload-types.ts`, `../services/system/detect.ts`, `../types.ts`.

---

### `packages/atomic-sdk/src/providers/opencode.ts`

- **Role:** OpenCode provider utilities — headless env wrapper, resume arg building, and source validation.
- **Key symbols:**
    - `HEADLESS_OPENCODE_CLIENT_ID = "sdk"` (`opencode.ts:25`) — set as `OPENCODE_CLIENT` env var to suppress the interactive `question` tool in headless stages
    - `withHeadlessOpencodeEnv<T>(fn)` (`opencode.ts:48`) — reference-counted wrapper that sets `process.env.OPENCODE_CLIENT = "sdk"` around a `Bun.spawn`-time call and restores the prior value on exit
    - `buildOpencodeResumeArgs(meta)` (`opencode.ts:88`) — returns `["--port", "0", "--session", meta.agentSessionId, ...meta.chatFlags]`
    - `validateOpenCodeWorkflow` (`opencode.ts:100`) — `createProviderValidator` checking for `createOpencodeClient()` and `client.session.create()`
- **Data flow:** Pure functions; `withHeadlessOpencodeEnv` mutates and restores `process.env.OPENCODE_CLIENT` around the supplied async function.
- **Dependencies:** `../runtime/offload-types.ts`, `../types.ts`.

---

### `packages/atomic-sdk/src/lib/host-local-workflows.ts`

- **Role:** Allows SDK consumers (third-party CLIs) to register their workflows with the Atomic host and respond to Atomic's `_emit-workflow-meta` and `_atomic-run` dispatch sub-commands.
- **Key symbols:**
    - `localWorkflowRegistry` (`host-local-workflows.ts:73`) — `Map<string, HostableLocalWorkflow>` keyed by `${agent}:${name}`; module-scoped; populated by every `hostLocalWorkflows()` call
    - `lookupLocalWorkflow(name, agent)` (`host-local-workflows.ts:87`) — read-only accessor used by `runOrchestratorEntry` to resolve definitions without requiring `export default`
    - `hostLocalWorkflows(workflows, options?)` (`host-local-workflows.ts:182`) — registers all `workflows` into `localWorkflowRegistry`; scans `argv` for `_emit-workflow-meta` (emits JSON meta line + `process.exit(0)`) or `_atomic-run` (calls `runWorkflow()` + `process.exit(0)`); both sub-commands are token-gated via `validateDispatchToken`
    - `HOST_SUBS = new Set(["_emit-workflow-meta", "_atomic-run"])` (`host-local-workflows.ts:59`) — the two sub-commands this module handles
- **Control flow:** `hostLocalWorkflows([wf1, wf2])` → registers all into map → scans argv → if `_emit-workflow-meta` found and token valid: writes `ATOMIC_WORKFLOW_META: <json>\n` to stdout and exits. If `_atomic-run` found and token valid: parses `--name`, `--agent`, `--detach`, input flags from argv tail, finds workflow, calls `runWorkflow({workflow, inputs, detach})`, exits.
- **Data flow:** `workflows` array → `localWorkflowRegistry` map. `_emit-workflow-meta` output: JSON array of `{ name, description, agent, inputs, source, minSDKVersion }`. `_atomic-run` triggers `runWorkflow()` which delegates to `executeWorkflow()`.
- **Dependencies:** `../types.ts`, `../primitives/run.ts` (type-only; loaded dynamically via `await import(...)` at `_atomic-run` dispatch time), `./dispatch-utils.ts` (`validateDispatchToken`, `parseAtomicRunArgv`).

---

### `packages/atomic-sdk/src/services/config/definitions.ts`

- **Role:** Defines the `AgentKey` type and the `AGENT_CONFIG` record with per-agent configuration (CLI command, flags, env vars, config folder, install URL, onboarding files).
- **Key symbols:**
    - `AgentKey = "claude" | "copilot" | "opencode"` (`definitions.ts:61`) — the fundamental agent union; aliased as `AgentType` in `types.ts`
    - `AGENT_CONFIG: Record<AgentKey, AgentConfig>` (`definitions.ts:63`) — contains for each agent: `name`, `cmd`, `chat_flags`, `env_vars`, `folder` (`.claude`/`.opencode`/`.github`), `install_url`, `exclude`, `onboarding_files` (what to copy/merge into project and global agent config)
    - `isValidAgent(key)` (`definitions.ts:154`) — `key in AGENT_CONFIG` type guard
    - `getAgentConfig(key)`, `getAgentKeys()` — accessors
    - `ProviderConfigKind = "claude" | "opencode" | "github"` (`definitions.ts:10`) — identifies which embedded asset bundle to extract for onboarding
    - `EmbeddedAssetKind = ProviderConfigKind | "skills"` (`definitions.ts:16`)
    - `ProviderOverrides` (`definitions.ts:149`) — `{ chatFlags?: string[]; envVars?: Record<string, string> }` — per-provider user overrides from `settings.json`
    - Claude `onboarding_files` (`definitions.ts:76–98`): copies `.mcp.json` (merge), `settings.json` to `.claude/settings.json` (merge), and `settings.json` to `~/.claude/settings.json` (merge, excluding `disabledMcpjsonServers`)
    - OpenCode `onboarding_files` (`definitions.ts:108–115`): copies `opencode.json` to `.opencode/opencode.json` (merge)
    - Copilot `onboarding_files` (`definitions.ts:125–136`): copies `.mcp.json` sourced from `claude` bundle (shared config)
- **Data flow:** Static data record consumed by: executor (`AGENT_CLI` mirrors `chat_flags`/`env_vars`), config service (`getProviderOverrides`), onboarding commands in `packages/atomic`.
- **Dependencies:** None (pure type/data declarations).

---

## Cross-Cutting Synthesis

The SDK engine layers cleanly into four strata:

1. **DSL stratum** (`define-workflow.ts`, `types.ts`, `registry.ts`): Agent-agnostic. `defineWorkflow().for(agent).run(fn).compile()` produces a sealed `WorkflowDefinition` stored in a module-private registry and stamped with the caller's source path. The only agent coupling is in `types.ts`'s `ClientMap`/`SessionMap`/`SavedMessage` union which imports from the three external SDKs.

2. **Dispatch stratum** (`primitives/run.ts`, `lib/host-local-workflows.ts`, `lib/auto-dispatch.ts`): Routes between "user invokes `runWorkflow()`" and "Atomic CLI dispatches `_orchestrator-entry` / `_atomic-run` / `_emit-workflow-meta`". The `auto-dispatch.ts` side-effect fires on module import; `host-local-workflows.ts` handles third-party CLI consumers. Both paths ultimately call `executeWorkflow()`.

3. **Execution stratum** (`runtime/executor.ts`, `runtime/orchestrator-entry.ts`, `runtime/tmux.ts`): 100% tmux-coupled. `executeWorkflow()` writes a launcher shell script, calls `tmux.createSession(...)`, then attaches. Inside the tmux pane, `runOrchestratorEntry()` resolves the definition and calls `runOrchestrator()`, which builds `WorkflowContext` and calls `definition.run(ctx)`. Each `ctx.stage()` call creates a tmux window via `createWindow()`, waits for the agent server, inits provider client/session via the agent-specific `initProviderClientAndSession` switch, and runs the user callback. Transcripts and messages are persisted under `~/.atomic/sessions/`.

4. **Provider stratum** (`providers/claude.ts`, `providers/copilot.ts`, `providers/opencode.ts`): One file per agent SDK. Claude uses send-keys + SessionStart/Stop hooks + the Agent SDK for headless and transcript reads. Copilot uses `@github/copilot-sdk` CopilotClient with `cliUrl` pointing at the tmux-pane CLI server. OpenCode uses `@opencode-ai/sdk/v2` createOpencodeClient or createOpencode for headless. This stratum is 100% removable and replaceable with a pi-coding-agent provider adapter.

The architectural seam is `initProviderClientAndSession`'s `switch (agent)` at `executor.ts:1610` — this is the single function where all three agent SDKs are invoked. Replacing the three cases with a single pi-agent call is the primary inversion point for the rewrite.

---

## Out-of-Partition References

- `packages/atomic/src/cli.ts` — CLI entry point that registers the `_orchestrator-entry`, `_cc-debounce`, `_claude-stop-hook`, `_claude-session-start-hook`, `_claude-ask-hook`, `_claude-inflight-hook` sub-commands dispatched by the SDK's internal mechanisms
- `packages/atomic/src/commands/` — Command files implementing `atomic workflow`, `atomic chat`, `atomic workflow session connect/kill/list`, `atomic workflow status` — these are the external callers of `runWorkflow()` and `executeWorkflow()`
- `packages/atomic/src/lib/telemetry/offload-events.ts` — Telemetry event-name constants mirrored (not imported) in `offload-manager.ts:13–22` to avoid cross-package dependency
- `packages/atomic-sdk/src/components/orchestrator-panel.tsx` — `OrchestratorPanel` class used by `executor.ts`'s `runOrchestrator()` as the TUI root for the workflow graph view
- `packages/atomic-sdk/src/runtime/offload-manager.ts` (full body) — `doResume()`, `createOffloadManager()`, `OffloadManager` interface — only the `persistResume` / `filterSpawnEnv` surface was read; the full state machine (resume, rollback, eligibility) was not
- `packages/atomic-sdk/src/runtime/graph-inference.ts` — `GraphFrontierTracker` class used inside `createSessionRunner` for DAG parent inference
- `packages/atomic-sdk/src/runtime/port-discovery.ts` — `getListeningPortForPid()` used by `waitForServer()` to discover the agent CLI's listening TCP port from `/proc/<pid>/fd` on Linux
- `packages/atomic-sdk/src/runtime/attached-footer.ts` — `spawnAttachedFooter()` called by `executeWorkflow()` and `createSessionRunner()` for each stage pane
- `packages/atomic-sdk/src/providers/claude-stop-hook.ts` — `claudeHookDirs()` and Stop hook registration used by `claude.ts`
- `packages/atomic-sdk/src/providers/claude-inflight-hook.ts` — `clearInflightTracking()`, `waitForInflightDrained()` used by `clearClaudeSession()`
- `packages/atomic-sdk/src/lib/auto-dispatch.ts` — side-effect module imported by `primitives/run.ts`; handles `_orchestrator-entry` and `_cc-debounce` argv at process start
- `packages/atomic-sdk/src/lib/self-exec.ts` — `buildSelfExecCommand()`, `resolveDispatcher()` — builds the re-exec command line for orchestrator launch
- `packages/atomic-sdk/src/services/config/atomic-config.ts` — `getProviderOverrides(agent, projectRoot)` called by `executeWorkflow()` to merge user settings
- `packages/atomic-sdk/src/services/config/additional-instructions.ts` — `resolveAdditionalInstructionsContent(projectRoot)` used by both `initProviderClientAndSession` (Copilot) and OpenCode instructions reconciliation
- `packages/atomic-sdk/src/workflows/builtin/` — builtin workflow definitions (ralph, deep-research-codebase, open-claude-design) × 3 agents; these use `ctx.stage()` and reference provider-specific APIs

## Patterns

<!-- Source: codebase-pattern-finder sub-agent -->

# Partition 1: `packages/atomic-sdk/` Core Patterns

## Overview

The atomic-sdk (44k LOC) is the workflow execution engine and TUI layer. It concentrates all tmux, Claude/Copilot/OpenCode SDK coupling, and orchestrator logic. Entry point is `src/index.ts` (public barrel), with internal layering: `define-workflow.ts` → `runtime/executor.ts` → `runtime/panel.tsx` (OpenTUI), plus provider adapters under `src/providers/`.

---

## Pattern 1: Workflow Definition and Compilation

**Where:** `packages/atomic-sdk/src/define-workflow.ts:217-348`

**What:** Chainable WorkflowBuilder pattern with `.for()` agent narrowing, `.run()` entry point registration, and `.compile()` sealing into immutable WorkflowDefinition.

```typescript
export class WorkflowBuilder<
    A extends AgentType = AgentType,
    I extends AnyInputs = AnyInputs,
> {
    /** @internal Brand for detection across package boundaries */
    readonly __brand = "WorkflowBuilder" as const;
    private readonly options: WorkflowOptions<I>;
    private runFn: ((ctx: WorkflowContext<A, I>) => Promise<void>) | null =
        null;
    private agentValue: AgentType | null = null;

    for<B extends AgentType>(agent: B): WorkflowBuilder<B, I> {
        const next = new WorkflowBuilder<B, I>(
            this.options as WorkflowOptions<I>,
        );
        next.agentValue = agent;
        next.runFn = this.runFn as
            | ((ctx: WorkflowContext<B, I>) => Promise<void>)
            | null;
        return next;
    }

    run(fn: (ctx: WorkflowContext<A, I>) => Promise<void>): this {
        if (this.runFn) {
            throw new Error("run() can only be called once per workflow.");
        }
        this.runFn = fn;
        return this;
    }

    compile(): WorkflowDefinition<A, I> {
        // ... validation ...
        const definition: WorkflowDefinition<A, I> = {
            __brand: "WorkflowDefinition" as const,
            name: this.options.name,
            agent: this.agentValue as A,
            description: this.options.description ?? "",
            inputs,
            minSDKVersion: this.options.minSDKVersion ?? null,
            source: this.options.source,
            run: runFn,
        };
        _compiledWorkflowRegistry.push(
            definition as unknown as WorkflowDefinition,
        );
        return definition;
    }
}
```

**Variations / call-sites:**

- `src/define-workflow.ts:376-391` — `defineWorkflow()` factory entry point with auto-captured stack-based source path
- `src/define-workflow.ts:48-65` — `_captureCallerPath()` stack frame extraction for source path auto-population

---

## Pattern 2: Agent Type and Provider Abstraction

**Where:** `packages/atomic-sdk/src/types.ts:1-101`

**What:** Discriminated union type system mapping each agent (claude/copilot/opencode) to its SDK client/session types and stage options. All provider SDKs' native types are imported directly (no re-definitions).

```typescript
import type { SessionEvent } from "@github/copilot-sdk";
import type { SessionPromptResponse } from "@opencode-ai/sdk/v2";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
    CopilotClient,
    CopilotClientOptions,
    CopilotSession,
} from "@github/copilot-sdk";
import type {
    OpencodeClient,
    Session as OpencodeSession,
} from "@opencode-ai/sdk/v2";
import type {
    ClaudeClientWrapper,
    ClaudeSessionWrapper,
} from "./providers/claude.ts";

type ClientOptionsMap = {
    opencode: { directory?: string; experimental_workspaceID?: string };
    copilot: Omit<CopilotClientOptions, "cliUrl">;
    claude: { chatFlags?: string[] };
};

type SessionOptionsMap = {
    opencode: {
        parentID?: string;
        title?: string;
        workspaceID?: string;
        permission?: import("@opencode-ai/sdk/v2").PermissionRuleset;
    };
    copilot: Partial<CopilotSessionConfig>;
    claude: Record<string, never>;
};

type ClientMap = {
    opencode: OpencodeClient;
    copilot: CopilotClient;
    claude: ClaudeClientWrapper;
};

type SessionMap = {
    opencode: OpencodeSession;
    copilot: CopilotSession;
    claude: ClaudeSessionWrapper;
};

export type StageClientOptions<A extends AgentType> = ClientOptionsMap[A];
export type StageSessionOptions<A extends AgentType> = SessionOptionsMap[A];
export type ProviderClient<A extends AgentType> = ClientMap[A];
export type ProviderSession<A extends AgentType> = SessionMap[A];
```

**Variations / call-sites:**

- `src/types.ts:29-50` — public barrel exports of all type interfaces
- `src/runtime/executor.ts:26-50` — imports these discriminated types for executor's stage dispatch

---

## Pattern 3: Workflow Context and Stage Spawning

**Where:** `packages/atomic-sdk/src/types.ts:296-394`

**What:** Two-tier context model: WorkflowContext (top-level, no session fields) and SessionContext (nested, with paneId/save/sessionId). Both expose `.stage()` to spawn sub-sessions with typed inputs, client options, and callback.

```typescript
export interface SessionContext<
    A extends AgentType = AgentType,
    I extends readonly WorkflowInput[] = readonly WorkflowInput[],
> {
    client: ProviderClient<A>;
    session: ProviderSession<A>;
    inputs: InputsOf<I>;
    agent: A;
    transcript(ref: SessionRef): Promise<Transcript>;
    getMessages(ref: SessionRef): Promise<SavedMessage[]>;
    save: SaveTranscript;
    sessionDir: string;
    paneId: string;
    sessionId: string;
    stage<T = void>(
        options: SessionRunOptions,
        clientOpts: StageClientOptions<A>,
        sessionOpts: StageSessionOptions<A>,
        run: (ctx: SessionContext<A, I>) => Promise<T>,
    ): Promise<SessionHandle<T>>;
}

export interface WorkflowContext<
    A extends AgentType = AgentType,
    I extends readonly WorkflowInput[] = readonly WorkflowInput[],
> {
    inputs: InputsOf<I>;
    agent: A;
    stage<T = void>(
        options: SessionRunOptions,
        clientOpts: StageClientOptions<A>,
        sessionOpts: StageSessionOptions<A>,
        run: (ctx: SessionContext<A, I>) => Promise<T>,
    ): Promise<SessionHandle<T>>;
    transcript(ref: SessionRef): Promise<Transcript>;
    getMessages(ref: SessionRef): Promise<SavedMessage[]>;
}
```

**Variations / call-sites:**

- `src/types.ts:275-289` — `SessionRunOptions` with `headless?: boolean` flag for background spawn
- `src/types.ts:265-272` — `SessionHandle<T>` return type with `.id`, `.name`, `.result`

---

## Pattern 4: Tmux Session and Pane Lifecycle

**Where:** `packages/atomic-sdk/src/runtime/executor.ts:659-800`

**What:** Top-level `executeWorkflow()` creates a tmux session in the atomic socket, spawns an orchestrator pane via self-exec, and optionally attaches or detaches. All tmux operations routed through `tmux.*` module.

```typescript
export async function executeWorkflow(
    options: WorkflowRunOptions,
): Promise<{ id: string; tmuxSessionName: string }> {
    const {
        definition,
        agent,
        inputs = {},
        projectRoot = process.cwd(),
        detach = false,
        pathToAtomicExecutable,
    } = options;

    const dispatcher = resolveDispatcher({ override: pathToAtomicExecutable });
    const workflowRunId = generateId();
    const tmuxSessionName = `atomic-wf-${agent}-${definition.name}-${workflowRunId}`;
    const sessionsBaseDir = join(getSessionsBaseDir(), workflowRunId);
    await ensureDir(sessionsBaseDir);

    const agentEnv: Record<string, string> = {
        ...AGENT_CLI[agent].envVars,
        ...claudeTempEnv,
        ...providerOverrides.envVars,
        ATOMIC_AGENT: agent,
    };
    const sessionEnv = buildTmuxEnv(agentEnv);

    const launcherPath = join(sessionsBaseDir, `orchestrator.${launcherExt}`);
    const inputsB64 = Buffer.from(JSON.stringify(inputs)).toString("base64");
    const workflowSource = definition.source;

    const orchestratorCmd = buildSelfExecCommand({
        dispatcher,
        subcommand: "_orchestrator-entry",
        args: [definition.name, agent, inputsB64, workflowSource],
    });

    const orchPaneId = tmux.createSession(
        tmuxSessionName,
        orchestratorCmd,
        sessionsBaseDir,
        sessionEnv,
    );

    spawnAttachedFooter(orchPaneId, undefined, tmuxSessionName);

    if (detach) {
        return { id: workflowRunId, tmuxSessionName };
    }

    return spawnMuxAttach(tmuxSessionName);
}
```

**Variations / call-sites:**

- `src/runtime/executor.ts:51-52` — `import * as tmux from "./tmux.ts"` and `spawnMuxAttach` from tmux module
- `src/runtime/executor.ts:785-800` — env/launcher setup and orchestrator pane creation
- `src/runtime/executor.ts:318-340` — WorkflowRunOptions interface with `detach` flag

---

## Pattern 5: Tmux Module Primitives

**Where:** `packages/atomic-sdk/src/runtime/tmux.ts:17-100`

**What:** Low-level tmux operations: session/pane creation, window management, binary resolution. Atomic socket isolation via `SOCKET_NAME = "atomic"`. Multiplexer detection (tmux on Unix, psmux/pmux on Windows).

```typescript
export const SOCKET_NAME = "atomic";
const CONFIG_PATH = tmuxConfPath;

export type TmuxResult =
    | { ok: true; stdout: string }
    | { ok: false; stderr: string };

let resolvedMuxBinary: string | null | undefined;

export function getMuxBinary(): string | null {
    if (resolvedMuxBinary !== undefined) return resolvedMuxBinary;

    const pathOpt = { PATH: process.env.PATH ?? "" };
    for (const candidate of requiredMuxBinaryCandidatesForPlatform()) {
        if (Bun.which(candidate, pathOpt)) {
            resolvedMuxBinary = candidate;
            return resolvedMuxBinary;
        }
    }

    resolvedMuxBinary = null;
    return resolvedMuxBinary;
}

export function resetMuxBinaryCache(): void {
    resolvedMuxBinary = undefined;
}

export function isTmuxInstalled(): boolean {
    return getMuxBinary() !== null;
}

export function isInsideTmux(): boolean {
    return process.env.TMUX !== undefined || process.env.PSMUX !== undefined;
}
```

**Variations / call-sites:**

- `src/runtime/tmux.ts:140-310` — `createSession()`, `createWindow()`, `selectWindow()`, `killWindow()`, `killSession()`
- `src/runtime/tmux.ts:341-400` — pane-level ops: `capturePane()`, `getPanePid()`, `sendKeys()`, `respawnPane()`

---

## Pattern 6: Provider Adapter: Claude

**Where:** `packages/atomic-sdk/src/providers/claude.ts:1-100`

**What:** Claude SDK query abstraction. Wraps `@anthropic-ai/claude-agent-sdk` with tmux-based interactive session delivery (send-keys polling + pane capture verification), session tracking map, and CLI flag marshalling.

```typescript
import {
  getSessionMessages,
  query as sdkQuery,
  type SessionMessage,
  type SDKUserMessage,
  type Options as SDKOptions,
} from "@anthropic-ai/claude-agent-sdk";

interface PaneState {
  claudeSessionId: string;
  claudeStarted: boolean;
  chatFlags: string[];
}

const initializedPanes = new Map<string, PaneState>();

export async function createClaudeSession(
  paneId: string,
  chatFlags: string[],
  ...
): Promise<string> {
  const claudeSessionId = randomUUID();
  initializedPanes.set(paneId, {
    claudeSessionId,
    claudeStarted: false,
    chatFlags,
  });
  return claudeSessionId;
}

export async function clearClaudeSession(paneId: string): Promise<void> {
  // Release marker, signal Stop hook, wait for in-flight marker dir drain
  const state = initializedPanes.get(paneId);
  if (!state) return;

  // ... release logic ...

  initializedPanes.delete(paneId);
}
```

**Variations / call-sites:**

- `src/providers/claude.ts:200-300` — `claudeQuery()` with tmux send-keys + capture-pane polling loops
- `src/providers/claude.ts:300-400` — `buildClaudeResumeArgs()` for offload/resume
- `src/providers/claude-stop-hook.ts` — 18k LOC for Hook workflow setup, session tracking, subagent tree marshalling

---

## Pattern 7: Provider Adapter: Copilot

**Where:** `packages/atomic-sdk/src/providers/copilot.ts:75-180`

**What:** Copilot SDK initialization and validation. Detects non-native shims (Node shebangs, npm-loader wrappers) in PATH to avoid passing them to the SDK. Merges system messages and builds resume args.

```typescript
export function isCopilotShim(candidate: string): boolean {
    if (JS_EXT_RE.test(candidate)) return true;
    if (
        candidate.includes(`node_modules${sep}.bin`) ||
        candidate.includes("node_modules/.bin")
    ) {
        const real = safeRealpath(candidate);
        if (JS_EXT_RE.test(real)) return true;
    }
    const header = readCandidateHeader(candidate);
    if (header === null) return false;
    return NODE_SHEBANG_RE.test(header) || header.includes(NPM_LOADER_MARKER);
}

export function resolveCopilotCliPath(
    resolveCommandPath: CommandPathResolver = getCommandPath,
): string | undefined {
    const envPath = process.env["COPILOT_CLI_PATH"];
    if (envPath) return envPath;
    const primary = resolveCommandPath("copilot");
    if (primary === null) return undefined;
    if (!isCopilotShim(primary)) return primary;
    // ... fallback search ...
}

export function buildCopilotResumeArgs(
    meta: Pick<OffloadResumeMetadata, "agentSessionId" | "chatFlags">,
): string[] {
    return [
        "--ui-server",
        "--port",
        "0",
        `--resume=${meta.agentSessionId}`,
        ...meta.chatFlags,
    ];
}
```

**Variations / call-sites:**

- `src/providers/copilot.ts:127-138` — `copilotSdkLaunchOptions()` builds CopilotClientOptions with env + cliPath
- `src/providers/copilot.ts:199-214` — `validateCopilotWorkflow` regex-based source validator

---

## Pattern 8: Provider Adapter: OpenCode

**Where:** `packages/atomic-sdk/src/providers/opencode.ts:43-95`

**What:** OpenCode headless environment scoping and resume arg builder. Headless stages set `OPENCODE_CLIENT=sdk` to exclude the interactive `question` tool; ref-counted nesting to handle parallel stages.

```typescript
export const HEADLESS_OPENCODE_CLIENT_ID = "sdk";

let headlessEnvDepth = 0;
let headlessEnvHadPrior = false;
let headlessEnvPrior: string | undefined;

export async function withHeadlessOpencodeEnv<T>(
    fn: () => Promise<T>,
): Promise<T> {
    if (headlessEnvDepth === 0) {
        headlessEnvHadPrior = Object.prototype.hasOwnProperty.call(
            process.env,
            "OPENCODE_CLIENT",
        );
        headlessEnvPrior = process.env.OPENCODE_CLIENT;
    }
    headlessEnvDepth++;
    try {
        process.env.OPENCODE_CLIENT = HEADLESS_OPENCODE_CLIENT_ID;
        return await fn();
    } finally {
        headlessEnvDepth--;
        if (headlessEnvDepth === 0) {
            if (headlessEnvHadPrior)
                process.env.OPENCODE_CLIENT = headlessEnvPrior;
            else delete process.env.OPENCODE_CLIENT;
        }
    }
}

export function buildOpencodeResumeArgs(
    meta: Pick<OffloadResumeMetadata, "agentSessionId" | "chatFlags">,
): string[] {
    return ["--port", "0", "--session", meta.agentSessionId, ...meta.chatFlags];
}
```

**Variations / call-sites:**

- `src/providers/opencode.ts:100-115` — `validateOpenCodeWorkflow` source validator

---

## Pattern 9: Offload Manager State Machine

**Where:** `packages/atomic-sdk/src/runtime/offload-manager.ts:1-58`

**What:** Resume metadata persistence and cleanup. Filters spawn environment (allowlist secrets, denies token keys), manages per-stage mutexes for concurrent writes, and tracks offload/resume lifecycle events for telemetry.

```typescript
const SPAWN_ENV_EXACT_ALLOW: ReadonlySet<string> = new Set([
    "CLAUDECODE",
    "PATH",
    "HOME",
    "LANG",
    "SHELL",
]);
const SPAWN_ENV_PREFIX_ALLOW: readonly string[] = [
    "ATOMIC_",
    "LC_",
    "OPENCODE_",
    "COPILOT_",
];
const SPAWN_ENV_EXACT_DENY: ReadonlySet<string> = new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
]);
const SPAWN_ENV_SUFFIX_DENY = /_(API_KEY|AUTH_TOKEN|SECRET|TOKEN|PASSWORD)$/i;

export function filterSpawnEnv(
    env: Record<string, string>,
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (SPAWN_ENV_EXACT_DENY.has(key) || SPAWN_ENV_SUFFIX_DENY.test(key))
            continue;
        if (
            SPAWN_ENV_EXACT_ALLOW.has(key) ||
            SPAWN_ENV_PREFIX_ALLOW.some((p) => key.startsWith(p))
        ) {
            result[key] = value;
        }
    }
    return result;
}

const _stageMutex = new Map<string, Promise<void>>();

const _resumeDefaults: Omit<OffloadResumeMetadata, "schemaVersion"> = {
    agentSessionId: "",
    tmuxSessionName: "",
    tmuxWindowName: "",
    spawnEnv: {},
    spawnCwd: "",
    chatFlags: [],
    lastPrompt: "",
    lastSeenAt: 0,
    offloadedAt: null,
};
```

**Variations / call-sites:**

- `src/runtime/offload-manager.ts:80-200` — `persistResume()` async, serializes metadata.json
- `src/runtime/offload-manager.ts:200-400` — `OffloadManager` class constructor and resume orchestration

---

## Pattern 10: Orchestrator Entry Point

**Where:** `packages/atomic-sdk/src/runtime/orchestrator-entry.ts:57-75`

**What:** Dual-mode workflow resolution: compiled-binary (registry lookup by name+agent) vs. dev/installed-package (dynamic import by source). Validates `WorkflowDefinition` brand before invoking `runOrchestrator()`.

```typescript
export async function resolveWorkflowDefinition(
    sourcePath: string,
    workflowName: string,
    agent: AgentType,
): Promise<WorkflowDefinition> {
    const mod: unknown = await import(sourcePath);

    if (workflowName !== "") {
        const fromHost = lookupLocalWorkflow(workflowName, agent);
        if (fromHost && isWorkflowDefinition(fromHost)) {
            return fromHost;
        }
    }

    const def = (mod as { default?: unknown }).default;
    if (isWorkflowDefinition(def)) return def;

    throw new InvalidWorkflowError(sourcePath);
}

export async function runOrchestratorWithDefinition(
    def: WorkflowDefinition,
    inputsB64: string,
): Promise<void> {
    const inputs = decodeInputs(inputsB64);
    await runOrchestrator(def, inputs);
}
```

**Variations / call-sites:**

- `src/runtime/orchestrator-entry.ts:130-180` — `runOrchestratorEntry()` full entry point with error boundary

---

## Pattern 11: Orchestrator Execution and Panel

**Where:** `packages/atomic-sdk/src/runtime/executor.ts:2290-2390`

**What:** Main orchestrator loop: creates OrchestratorPanel (OpenTUI), wires panel store mutations to `status.json`, builds OffloadManager with tmux+provider deps, and invokes the user's workflow callback with WorkflowContext.

```typescript
export async function runOrchestrator(
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<void> {
  const { workflowRunId, tmuxSessionName, agent, cwd } = validateOrchestratorEnv();

  setExecutorTelemetrySinks({
    telemetry: getProductionTelemetrySink(workflowRunId),
  });

  const sessionsBaseDir = join(getSessionsBaseDir(), workflowRunId);
  await ensureDir(sessionsBaseDir);

  const panel = await OrchestratorPanel.create({
    tmuxSession: tmuxSessionName,
  });

  let snapshotPending = false;
  const persistSnapshot = (): void => {
    if (snapshotPending) return;
    snapshotPending = true;
    queueMicrotask(() => {
      snapshotPending = false;
      const snap = panel.getSnapshot();
      void writeSnapshot(
        sessionsBaseDir,
        buildSnapshot({
          workflowRunId,
          tmuxSession: tmuxSessionName,
          ...snap,
        }),
      );
    });
  };
  const unsubscribePanel = panel.subscribe(persistSnapshot);
  persistSnapshot();

  let shutdownCalled = false;
  const shutdown = (exitCode = 0) => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    unsubscribePanel();
    void writeSnapshot(sessionsBaseDir, buildSnapshot({ ... }));
    panel.destroy();
    try {
      tmux.killSession(tmuxSessionName);
    } catch {}
    process.exitCode = exitCode;
  };

  const offloadManager = createOffloadManager({
    panelStore: panel.getPanelStore(),
    tmux: {
      killWindow: tmux.killWindow,
      createWindow: async (session, window, command, cwd, envVars) => {
        tmux.createWindow(session, window, command, cwd, envVars);
      },
      selectWindow: async (session, window) => {
        tmux.selectWindow(`${session}:${window}`);
      },
    },
    providers: { ... },
  });

  const ctx: WorkflowContext<AgentType> = {
    inputs: parsedInputs,
    agent,
    stage: async (opts, clientOpts, sessionOpts, run) => {
      // Delegate to offloadManager.spawnSession
    },
    transcript: ...,
    getMessages: ...,
  };

  await definition.run(ctx);
  shutdown(0);
}
```

**Variations / call-sites:**

- `src/runtime/executor.ts:2500-2600` — provider-specific session creation wiring
- `src/runtime/panel.tsx` — OpenTUI orchestrator pane component (re-export from components/)

---

## Pattern 12: Registry Immutable Accumulation

**Where:** `packages/atomic-sdk/src/registry.ts:58-115`

**What:** Type-safe registry with immutable accumulation. Each `register(wf)` returns a new Registry with updated generic type. Validates workflows at registration time (provider-specific source warnings).

```typescript
class RegistryImpl<
    T extends Record<string, WorkflowDefinition | ExternalWorkflow>,
> {
    private readonly map: ReadonlyMap<
        string,
        WorkflowDefinition | ExternalWorkflow
    >;

    constructor(
        map: ReadonlyMap<string, WorkflowDefinition | ExternalWorkflow>,
    ) {
        this.map = map;
    }

    register<W extends RegistrableWorkflow>(
        wf: W,
    ): Registry<T & Record<`${W["agent"]}/${W["name"]}`, W>> {
        const key = `${wf.agent}/${wf.name}` as `${W["agent"]}/${W["name"]}`;

        if (this.map.has(key)) {
            throw new Error(
                `[atomic] Duplicate workflow registration: "${key}" is already registered.`,
            );
        }

        validateAtRegistration(wf);

        const next = new Map(this.map);
        next.set(key, wf);
        return new RegistryImpl<T & Record<`${W["agent"]}/${W["name"]}`, W>>(
            next,
        ) as Registry<T & Record<`${W["agent"]}/${W["name"]}`, W>>;
    }

    upsert(
        wf: RegistrableWorkflow,
        onOverride?: (prior: WorkflowDefinition | ExternalWorkflow) => void,
    ): Registry<T> {
        const key = `${wf.agent}/${wf.name}`;
        const prior = this.map.get(key);
        if (prior !== undefined && onOverride) {
            onOverride(prior);
        }
        validateAtRegistration(wf);
        const next = new Map(this.map);
        next.set(key, wf);
        return new RegistryImpl<T>(next) as Registry<T>;
    }

    list(): readonly (WorkflowDefinition | ExternalWorkflow)[] {
        return Object.freeze(Array.from(this.map.values()));
    }

    resolve(
        name: string,
        agent: AgentType,
    ): WorkflowDefinition | ExternalWorkflow | undefined {
        return this.map.get(`${agent}/${name}`);
    }
}

export function createRegistry(): Registry<Record<string, never>> {
    return new RegistryImpl<Record<string, never>>(new Map()) as Registry<
        Record<string, never>
    >;
}
```

**Variations / call-sites:**

- `src/registry.ts:18-40` — validator dispatch table mapping agent → validator function
- `src/registry.ts:150-153` — factory entry point

---

## Agent SDK Dependencies

All agent SDK imports are **load-bearing** and concentrated in these files:

- **Claude**: `src/providers/claude.ts` (61k LOC including hooks), `src/providers/claude-stop-hook.ts` (18k), `src/providers/claude-inflight-hook.ts` (12k)
    - Imports: `@anthropic-ai/claude-agent-sdk` for `SessionMessage`, `getSessionMessages()`, tmux-based query
- **Copilot**: `src/providers/copilot.ts` (14k)
    - Imports: `@github/copilot-sdk` for `CopilotClient`, `CopilotSession`, `SessionEvent` types
- **OpenCode**: `src/providers/opencode.ts` (4k)
    - Imports: `@opencode-ai/sdk/v2` for `OpencodeClient`, `createOpencodeClient`, `SessionPromptResponse`

**Tmux dependencies** (core execution path):

- `src/runtime/executor.ts` — ALL session/window/pane lifecycle
- `src/runtime/tmux.ts` — raw tmux primitives + binary detection
- `src/runtime/offload-manager.ts` — offload/resume state and metadata persistence
- `src/runtime/port-discovery.ts` — TCP port polling for agent readiness probes

**Removable for pi-coding-agent rewrite:**

- All provider/\*.ts adapters (claude/copilot/opencode) — replace with pi-specific integration
- All tmux.ts primitives — replace with pi's pane/session API
- Stop hooks, inflight hooks — replace with pi's hook system
- Offload/resume serialization — adapt to pi's session persistence model

---

## Summary

This partition reveals the load-bearing seams for the rewrite:

1. **defineWorkflow + WorkflowBuilder** — The DSL is **agent-agnostic** (can be ported verbatim)
2. **WorkflowContext/SessionContext types** — **Agent-agnostic**, but `.stage()` dispatch must invert to use pi's session/pane APIs
3. **Registry pattern** — **Agent-agnostic** accumulation (keep as-is)
4. **Orchestrator entry + executor** — **Tmux-coupled**, must be rewritten to spawn pi panes instead
5. **Provider adapters (claude/copilot/opencode)** — **Agent-specific**, completely removed in pi rewrite
6. **Offload/resume** — **Tmux-coupled**, must be adapted to pi's session model

The rewrite inverts the architecture: instead of a separate orchestrator pane coordinating separate agent CLI panes in tmux, pi-coding-agent's chat TUI becomes the orchestrator, with workflow stages spawned as dynamically-loaded extensions or subagents in pi's native pane system.

## External References

<!-- Source: codebase-online-researcher sub-agent -->

# Online Research — Partition 1: packages/atomic-sdk External Library Documentation

## Libraries Researched

All research was drawn from local `docs/` copies already checked into the repository, plus cached entries under `research/web/` from prior sessions. No external HTTP fetches were required.

---

#### @anthropic-ai/claude-agent-sdk (^0.2.132)

**Docs:** `docs/claude-code/agent-sdk/sdk-references/typescript.md`, `docs/claude-code/agent-sdk/guides/hooks.md`, `docs/claude-code/agent-sdk/guides/streaming-output.md`, `docs/claude-code/agent-sdk/guides/structured-output.md`, `docs/claude-code/agent-sdk/guides/user-input.md`, `docs/claude-code/agent-sdk/guides/subagents.md`, `docs/claude-code/agent-sdk/guides/permissions.md`, `research/web/2026-04-14-claude-agent-sdk-hil-transcript.md`

**Relevant behaviour:**

**`query()` function signature:**

```typescript
function query({
  prompt: string | AsyncIterable<SDKUserMessage>,
  options?: Options
}): Query; // extends AsyncGenerator<SDKMessage, void>
```

The `Query` object is an async iterable and also exposes `.setPermissionMode()` for dynamic permission mode switching mid-stream. Used in the SDK as the primary entry point for all Claude Agent SDK stages.

**Hook system — all hooks registered via `options.hooks`:**

- `PreToolUse` — fires before tool execution; can `allow`, `deny`, or inject `systemMessage`. Matcher regex filters by tool name. `hookSpecificOutput.permissionDecision` = `"allow" | "deny" | "ask"`. `updatedInput` modifies tool args (requires `permissionDecision: "allow"`).
- `PostToolUse` — fires after tool result; can inject `additionalContext`.
- `Stop` — fires when agent execution stops. Used by the Atomic stop-hook to deliver follow-up prompts and signal session completion.
- `SubagentStart` / `SubagentStop` — fire when subagents spawn/finish. Input includes `agent_id`, `agent_transcript_path`, `stop_hook_active`.
- `SessionStart` / `SessionEnd` — TypeScript-only; fires on session init/teardown.
- `TeammateIdle` — TypeScript-only; fires when a teammate becomes idle.
- `TaskCompleted` — TypeScript-only; fires when a background task completes.
- Async hook output (`{ async: true, asyncTimeout: ms }`) lets the agent proceed without waiting.

**Stop hook integration (Atomic-specific pattern):**
The stop-hook binary (`atomic _claude-stop-hook`) receives a JSON payload via stdin:

```typescript
interface ClaudeStopHookPayload {
    session_id: string;
    transcript_path?: string;
    cwd?: string;
    stop_hook_active?: boolean;
}
```

It returns `{ "decision": "block", "reason": "<next-prompt>" }` to inject the next turn's prompt without tmux send-keys. This is the mechanism documented in `docs/claude-code/agent-sdk/guides/hooks.md` where a `Stop` hook's JSON output `reason` is treated as the next user message.

**In-flight subagent tracking (`claude-inflight-hook`):**
`SubagentStart` / `SubagentStop` hook payloads carry `agent_id` and `session_id`. The inflight hook writes marker files under `~/.atomic/claude-inflight/<root_session_id>/<agent_id>`. `waitForInflightDrained()` blocks until all subagent markers are removed. This prevents the executor from advancing while backgrounded subagents still hold PTY resources on the tmux server.

**Streaming output:**
With `options.includePartialMessages: true`, the query emits `SDKPartialAssistantMessage` (`type: "stream_event"`) containing raw `RawMessageStreamEvent` objects from the Anthropic API. Key event types: `message_start`, `content_block_start`, `content_block_delta` (text: `text_delta`; tool input: `input_json_delta`), `content_block_stop`, `message_delta`, `message_stop`. Without partial messages: stream emits `SDKAssistantMessage`, `SDKResultMessage`, `SDKSystemMessage`, `SDKCompactBoundaryMessage`. Extended thinking disables partial messages.

**Structured output via `outputFormat`:**

```typescript
options: {
  outputFormat: {
    type: "json_schema",
    schema: <JSONSchema> // or z.toJSONSchema(ZodSchema)
  }
}
```

Result appears in `message.structured_output` on the `ResultMessage` when `message.subtype === "success"`. On retry exhaustion: `subtype === "error_max_structured_output_retries"`. Structured output is incompatible with streaming (no deltas; result only in final `ResultMessage`).

**AskUserQuestion HIL via `canUseTool`:**

```typescript
options: {
    canUseTool: async (toolName, input) => {
        if (toolName === "AskUserQuestion") {
            // input.questions: Array<{ question, header, options: Array<{ label, description, preview? }>, multiSelect }>
            return {
                behavior: "allow",
                updatedInput: {
                    questions: input.questions,
                    answers: { [question]: label },
                },
            };
        }
        return { behavior: "allow", updatedInput: input };
        // or: return { behavior: "deny", message: "reason" };
    };
}
```

`AskUserQuestion` must be listed in `tools` if a restricted tool list is used. Not available in subagents. The `toolConfig.askUserQuestion.previewFormat` option enables HTML/markdown option previews. Live detection: check `toolName === "AskUserQuestion"` in `canUseTool`. Transcript-based detection: find `tool_use` blocks with `name === "AskUserQuestion"` that have no matching `tool_result` in subsequent user messages. The `SDKResultSuccess.deferred_tool_use` field signals that the session ended with a pending (unresolved) tool use.

**Permission modes:**
`options.permissionMode`: `"default"` | `"dontAsk"` | `"acceptEdits"` | `"bypassPermissions"` | `"plan"` | `"auto"`. Dynamic switch via `query.setPermissionMode(mode)`. `bypassPermissions` is inherited by all subagents and cannot be overridden. `dontAsk` converts any unmatched tool to a hard deny without calling `canUseTool`.

**Subagents via `agents` parameter:**

```typescript
options: {
  allowedTools: ["Read", "Grep", "Glob", "Agent"],
  agents: {
    "code-reviewer": {
      description: string,     // used by Claude to decide when to delegate
      prompt: string,          // subagent system prompt
      tools?: string[],        // restricted tool set; inherits all if omitted
      model?: "sonnet" | "opus" | "haiku" | "inherit",
      skills?: string[],
      mcpServers?: (string | object)[]
    }
  }
}
```

Subagents get fresh context windows; only the Agent tool prompt string crosses the boundary. Subagent transcripts stored at `~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`. Resume a subagent by passing `options.resume: sessionId` and including the agent ID in the prompt. Tool was renamed `"Task"` → `"Agent"` in CC v2.1.63; SDK emits `"Agent"` in `tool_use` blocks but `"Task"` in `system:init` tools list.

**Session read functions:**

- `listSessions({ dir?, limit?, includeWorktrees? })` → `SDKSessionInfo[]` sorted by `lastModified` desc
- `getSessionMessages(sessionId, { dir?, limit?, offset?, includeSystemMessages? })` → `SessionMessage[]` in chronological order via `parentUuid` chain
- `getSubagentMessages(sessionId, agentId, options?)` → `SessionMessage[]`
- Session JSONL stored at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`; encoded-cwd replaces all non-alphanumeric chars with `-`

**`getSessionMessages` and `getSessionInfo` imports:**

```typescript
import {
    getSessionMessages,
    query as sdkQuery,
    type SessionMessage,
    type SDKUserMessage,
    type Options as SDKOptions,
} from "@anthropic-ai/claude-agent-sdk";
```

**Where used in partition:**

- `packages/atomic-sdk/src/providers/claude.ts:26` — imports `getSessionMessages`, `query as sdkQuery`, `SessionMessage`, `SDKUserMessage`, `Options as SDKOptions`
- `packages/atomic-sdk/src/providers/claude-stop-hook.ts` — implements the Stop hook JSON protocol (`ClaudeStopHookPayload`, block/release/queue polling)
- `packages/atomic-sdk/src/providers/claude-inflight-hook.ts` — implements SubagentStart/Stop/TeammateIdle hook handlers; `ClaudeInflightHookPayload` carries `session_id`, `agent_id`, `agent_type`

**Dependencies pinning Atomic to Claude Agent SDK:**

- The entire `providers/claude.ts` abstraction (session lifecycle, tmux send-keys automation, JSONL watching for idle detection, stop-hook protocol)
- `providers/claude-stop-hook.ts` — stop hook binary and queue/release marker directory protocol
- `providers/claude-inflight-hook.ts` — inflight subagent tracking directory protocol
- All built-in workflow variants under `workflows/builtin/*/claude/` (ralph/claude, deep-research-codebase/claude, open-claude-design/claude)
- The `runtime/tmux.ts` export used by `claude.ts` for pane spawning

**Agent-agnostic seam:** The `createProviderValidator` factory from `types.ts` and the `OffloadResumeMetadata` interface from `runtime/offload-types.ts` are provider-neutral abstractions shared by claude/copilot/opencode adapters.

---

#### @github/copilot-sdk (^0.3.0)

**Docs:** `docs/copilot-cli/sdk.md`, `research/web/2026-04-14-copilot-sdk-hil-events.md`

**Relevant behaviour:**

**Client lifecycle:**

```typescript
const client = new CopilotClient({
  cliPath?: string,         // default: COPILOT_CLI_PATH env var or bundled instance
  cliArgs?: string[],
  cliUrl?: string,          // connect to existing server (skips spawn)
  port?: number,
  useStdio?: boolean,       // default: true
  gitHubToken?: string,
  useLoggedInUser?: boolean
});
await client.start();
// ...
await client.stop();
```

**Session creation (onPermissionRequest required):**

```typescript
const session = await client.createSession({
  model?: string,           // required when using custom provider
  onPermissionRequest: PermissionHandler,  // REQUIRED
  onUserInputRequest?: UserInputHandler,   // enables ask_user tool
  onElicitationRequest?: ElicitationHandler,
  tools?: Tool[],           // custom tools via defineTool()
  systemMessage?: SystemMessageConfig,
  infiniteSessions?: InfiniteSessionConfig,
  provider?: ProviderConfig,
  hooks?: SessionHooks
});
```

**`session.send()` / `session.sendAndWait()`:**

```typescript
await session.send({ prompt: string, attachments?, mode?: "enqueue"|"immediate" });
// sendAndWait blocks until session.idle event fires:
await session.sendAndWait({ prompt }, timeout?);
```

**`defineTool()` with Zod (the custom tool API):**

```typescript
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
defineTool("tool_name", {
  description: string,
  parameters: z.object({ ... }),
  skipPermission?: boolean,
  overridesBuiltInTool?: boolean,
  handler: async (args) => returnValue  // JSON-serializable or ToolResultObject
})
```

**HIL: `onUserInputRequest` (primary mechanism — RPC handler):**

```typescript
onUserInputRequest: async (request, invocation) => {
    // request.question: string
    // request.choices?: string[]
    // request.allowFreeform?: boolean (default true)
    return { answer: string, wasFreeform: boolean };
};
```

When provided, sends `requestUserInput: true` in `session.create` RPC, enabling the `ask_user` tool on the CLI. The CLI makes a direct `userInput.request` RPC call that must return the user's answer.

**HIL: passive event observation:**

```typescript
session.on("user_input.requested", (event) => {
    // event.data: { requestId, question, choices?, allowFreeform?, toolCallId? }
    // ephemeral: true — not persisted to disk
});
session.on("user_input.completed", (event) => {
    // event.data: { requestId }
    // ephemeral: true
});
session.on("session.idle", (event) => {
    // event.data: { backgroundTasks?: { agents, shells }, aborted? }
    // ephemeral: true — signals turn completion
});
```

`session.idle` is the canonical "turn done" signal; `sendAndWait` uses it internally.

**Permission handling:**
`onPermissionRequest(request, invocation)` receives `request.kind: "shell" | "write" | "read" | "mcp" | "custom-tool" | "url" | "memory" | "hook"`. Returns one of: `"approved"`, `"denied-interactively-by-user"`, `"denied-by-rules"`, `"denied-by-content-exclusion-policy"`, `"denied-no-approval-rule-and-could-not-request-from-user"`, `"no-result"`.

**COPILOT_CLI_PATH env detection:**
`CopilotClientOptions.cliPath` falls back to `COPILOT_CLI_PATH` env var, then bundled instance. The `isCopilotShim()` function in `providers/copilot.ts` detects Node.js/npm-loader shim files that should not be passed as the CLI executable (checks `.js` extension, `node_modules/.bin/` path, and `#!/usr/bin/env node` shebang in first 256 bytes).

**Session hooks (`SessionHooks`):**

```typescript
hooks: {
  onPreToolUse: async (input, invocation) => ({ permissionDecision, modifiedArgs?, additionalContext? }),
  onPostToolUse: async (input, invocation) => ({ additionalContext? }),
  onUserPromptSubmitted: async (input, invocation) => ({ modifiedPrompt? }),
  onSessionStart: async (input, invocation) => ({ additionalContext? }),
  onSessionEnd: async (input, invocation) => void,
  onErrorOccurred: async (input, invocation) => ({ errorHandling: "retry"|"skip"|"abort" })
}
```

**Infinite sessions (default on):**
Background compaction at configurable context thresholds. Events: `session.compaction_start`, `session.compaction_complete`. Workspace path: `~/.copilot/session-state/{sessionId}/` with `checkpoints/`, `plan.md`, `files/` subdirs.

**System message customisation:**
Three modes: append-only (default), `mode: "customize"` (section-level overrides: `replace | remove | append | prepend`), `mode: "replace"` (full override, removes guardrails). Section IDs: `identity`, `tone`, `tool_efficiency`, `environment_context`, `code_change_rules`, `guidelines`, `safety`, `tool_instructions`, `custom_instructions`, `last_instructions`.

**Where used in partition:**

- `packages/atomic-sdk/src/providers/copilot.ts:13` — imports `CopilotClientOptions`, `SessionConfig as CopilotSessionConfig` from `@github/copilot-sdk`; implements `isCopilotShim()`, `copilotSubprocessEnv()`, and resume adapter
- All built-in workflow variants under `workflows/builtin/*/copilot/`

**Dependencies pinning Atomic to Copilot SDK:**

- `providers/copilot.ts` — CLI path resolution, shim detection, subprocess env construction, session resume metadata
- `workflows/builtin/ralph/copilot/`, `workflows/builtin/deep-research-codebase/copilot/`, `workflows/builtin/open-claude-design/copilot/` — provider-specific workflow entry points

---

#### @opencode-ai/sdk (^1.14.40)

**Docs:** `docs/opencode/sdk.md`, `research/web/2026-04-14-opencode-sdk-hil-events.md`

**Relevant behaviour:**

**Client creation:**

```typescript
import { createOpencode } from "@opencode-ai/sdk"
const { client } = await createOpencode({
  hostname?: string,  // default: "127.0.0.1"
  port?: number,      // default: 4096
  signal?: AbortSignal,
  timeout?: number,
  config?: Config
})
// Or connect to existing server:
import { createOpencodeClient } from "@opencode-ai/sdk"
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" })
```

**`session.prompt()` with `format` parameter (structured output):**

```typescript
const result = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: "prompt text" }],
    model: { providerID: string, modelID: string },
    format?: {
      type: "json_schema",   // or "text" (default)
      schema: JSONSchema,
      retryCount?: number    // default: 2
    },
    noReply?: boolean        // true = inject context only, no AI response
  }
})
// result.data.info.structured_output — validated JSON
// result.data.info.error?.name === "StructuredOutputError" on failure
```

**Permission records:**

```typescript
client.postSessionByIdPermissionsByPermissionId({
    path: { id: sessionId, permissionId: string },
    body: {
        /* permission decision */
    },
});
```

**Event subscription (SSE stream):**

```typescript
const events = await client.event.subscribe();
for await (const event of events.stream) {
    // event is a member of the Event discriminated union
    console.log(event.type, event.properties);
}
```

**Session CRUD:**
`session.list()`, `session.get()`, `session.create()`, `session.delete()`, `session.abort()`, `session.messages()`, `session.message()`, `session.revert()`, `session.unrevert()`, `session.summarize()`, `session.init()` (creates AGENTS.md).

**OPENCODE_CLIENT env for headless HIL suppression:**
OpenCode only registers its interactive `question` tool when `OPENCODE_CLIENT` is one of `"app" | "cli" | "desktop"`. Setting `OPENCODE_CLIENT=sdk` (the `HEADLESS_OPENCODE_CLIENT_ID` constant) suppresses the question tool entirely for headless workflow stages. The `withHeadlessOpencodeEnv()` function in `providers/opencode.ts` wraps `createOpencode(...)` calls with reference counting to handle concurrent parallel stages safely.

**Where used in partition:**

- `packages/atomic-sdk/src/providers/opencode.ts:25` — `HEADLESS_OPENCODE_CLIENT_ID = "sdk"`, `withHeadlessOpencodeEnv()`, resume adapter
- All built-in workflow variants under `workflows/builtin/*/opencode/`

**Dependencies pinning Atomic to OpenCode SDK:**

- `providers/opencode.ts` — `OPENCODE_CLIENT` env management, headless question-tool suppression, session resume metadata
- `workflows/builtin/ralph/opencode/`, `workflows/builtin/deep-research-codebase/opencode/`, `workflows/builtin/open-claude-design/opencode/`

---

#### @opentui/core + @opentui/react (^0.2.3 each)

**Docs:** Referenced in `CLAUDE.md` as opentui skill; `docs/` has no dedicated OpenTUI doc page. The `components/workflow-picker-panel.tsx` and all TUI-layer files in `packages/atomic-sdk/src/tui/` and `packages/atomic-sdk/src/runtime/attached-footer.ts` depend on these.

**Relevant behaviour:**
OpenTUI provides a React-compatible reconciler for terminal UIs. The partition exports `./tui` (`src/tui/index.ts`), `./runtime/attached-footer` (`src/runtime/attached-footer.ts`), and `./workflows/components` (`src/components/workflow-picker-panel.tsx`), all of which render TUI panes/layouts via `@opentui/react`. The `SyntaxStyle` resource pattern (from codebase memory) requires `useEffect` cleanup calling `.destroy()` — not cleanup inside `useMemo`. This pattern is load-bearing in any OpenTUI component using syntax highlighting. No external fetch required for this library; behavior is documented via the `opentui` agent skill.

**Where used in partition:**

- `packages/atomic-sdk/src/components/workflow-picker-panel.tsx` — workflow picker UI panel
- `packages/atomic-sdk/src/runtime/attached-footer.ts` — footer rendering in the orchestrator runtime
- `packages/atomic-sdk/src/tui/index.ts` and related TUI helpers

---

#### zod (^4.4.3)

**Docs:** Referenced via `z.toJSONSchema()` in structured-output doc above.

**Relevant behaviour:**
Used for `WorkflowInput` schema definitions within `defineWorkflow` and for type-safe tool parameter definitions in workflow stages. The `z.toJSONSchema()` function (Zod 4) converts Zod schemas to JSON Schema for use with `outputFormat: { type: "json_schema", schema }` in both Claude Agent SDK and OpenCode SDK structured-output calls. Also used by `@bastani/atomic-sdk` for `WorkflowInput` validation. Agent-agnostic — not pinned to any specific coding agent.

---

#### commander / @commander-js/extra-typings (^14.0.3 / ^14.0.0)

**Relevant behaviour:**
Used for the `./cli` export (`src/cli.ts`). Provides typed command/subcommand parsing for any CLI entry points surfaced by the SDK package itself (e.g., the `atomic _claude-stop-hook` and `atomic _claude-inflight-hook` internal subcommands). Agent-agnostic.

---

#### ignore (^7.0.5)

**Relevant behaviour:**
Used in `src/lib/common-ignore.ts` (exported as `./lib/common-ignore`). Provides `.gitignore`-style pattern matching for file filtering in workflow file discovery and skill loading. Agent-agnostic.

---

#### yaml (^2.8.4)

**Relevant behaviour:**
Used for parsing/serialising YAML-format configuration files (e.g., skills, workflow definitions, settings). Agent-agnostic.

---

## Summary

The research above covers all external libraries that are central to the `packages/atomic-sdk/` partition's research question. The three agent-SDK dependencies (`@anthropic-ai/claude-agent-sdk`, `@github/copilot-sdk`, `@opencode-ai/sdk`) are the primary removal targets in the rewrite: each has a dedicated provider file (`providers/claude.ts`, `providers/copilot.ts`, `providers/opencode.ts`) plus three sets of built-in workflow entry points. The Claude Agent SDK's Stop/SubagentStart/SubagentStop/TeammateIdle hook protocol and the inflight-marker-directory synchronisation mechanism (`providers/claude-inflight-hook.ts`) are load-bearing for tmux-free session lifecycle management and must be re-platformed entirely. The Copilot SDK's `onPermissionRequest` + `onUserInputRequest` + `session.on("session.idle")` pattern and the OpenCode SDK's `OPENCODE_CLIENT` env suppression pattern are similarly provider-specific. All other dependencies (`zod`, `commander`, `ignore`, `yaml`, `@opentui/core/react`) are agent-agnostic and can be carried forward into the pi-coding-agent rewrite unchanged.

## Out-of-Partition References

Look for the **Out-of-Partition References** subsection inside the
"How It Works" section above — that is where the analyzer flagged files
outside this partition that other partitions should examine.
