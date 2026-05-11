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
  - Provider implementations (providers/*.ts)
  - TUI rendering pipeline (tui/*, components/*)

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

| Module | Criticality | Reason | Rewrite Implications |
|--------|------------|--------|----------------------|
| executor.ts | CRITICAL | Workflow execution engine | Core pi-agent integration point; architecture invert required |
| orchestrator-entry.ts | CRITICAL | Workflow definition resolution | May become redundant if pi handles module loading |
| define-workflow.ts | HIGH | DSL surface | Keep as-is, adapt callbacks to pi-agent |
| registry.ts | HIGH | Workflow registration | Reusable with minimal changes |
| providers/claude.ts | CRITICAL | Claude integration | Entirely replaced by pi-agent SDK |
| providers/copilot.ts | CRITICAL | Copilot integration | Entirely replaced by pi-agent SDK |
| providers/opencode.ts | CRITICAL | OpenCode integration | Entirely replaced by pi-agent SDK |
| tmux.ts | CRITICAL | tmux session management | Replaced by pi-agent's native pane spawning |
| offload-manager.ts | HIGH | Session resume state machine | May be replaced by pi's native session persistence |
| panel.tsx + orchestrator-panel.tsx | HIGH | Graph visualization | Can be ported with UI framework upgrade |
| workflow-picker-panel.tsx | MEDIUM | Workflow selection UI | Portable after agent-agnostic refactor |
| runtime/port-discovery.ts | MEDIUM | Port detection | Likely removable with pi architecture |
| lib/atomic-temp.ts | MEDIUM | Temp directory | Reusable as-is |
| lib/spawn.ts | MEDIUM | Subprocess execution | Likely reusable or replaced by pi's spawn interface |

---

## Key Entry Points for Pi-Agent Integration

1. **Workflow Execution Entry**: `src/primitives/run.ts` → `runWorkflow()` currently calls `executeWorkflow()` in executor.ts; must be wired to pi-coding-agent's native workflow execution.

2. **Provider Dispatch**: `src/runtime/executor.ts` lines 1100–1200 (approx.) enumerate agent type and dispatch to provider adapters; becomes pi extension loading point.

3. **Orchestrator Pane**: `src/runtime/panel.tsx` and `src/components/orchestrator-panel.tsx` are TUI entry points; can be adapted as pi panel extension.

4. **Registry Resolution**: `src/registry.ts` and `src/define-workflow.ts` handle workflow lookup; pi-agent may handle this natively or via plugin hooks.

5. **Workflow Definition**: `src/define-workflow.ts` exports `defineWorkflow()` and `WorkflowBuilder` class; core DSL surface that pi-coding-agent can adopt/adapt.

6. **Session Persistence**: `src/runtime/offload-manager.ts` and `src/runtime/status-writer.ts` handle resume metadata; pi-agent can adopt the metadata schema or replace it.

