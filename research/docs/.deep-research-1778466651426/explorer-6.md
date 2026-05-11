# Partition 6 of 12 — Findings

## Scope
`research/` (2 files, 2,307 LOC)

## Files in Scope
<!-- Source: codebase-locator sub-agent -->
# Partition 6: Research Documentation Artifacts

## Summary
This partition contains 198 historical research and design documents (JSON schema examples, markdown research notes, and experimental UI designs) accumulated during the Atomic CLI development. These are not source code but rather snapshots of decisions, investigations, and explorations that provide context for the refactor onto pi-coding-agent.

## Implementation (Design Reference Files)

- `research/designs/workflow-picker-tui.tsx` — Experimental workflow picker TUI component design with selector logic
- `research/designs/session-graph-tui.tsx` — Session graph visualization TUI component design for workflow visualization
- `research/designs/tsconfig.json` — TypeScript configuration for the design exploration files

## Documentation (Research Notes by Category)

### CLI Surface & Commands (19 docs)
- `research/docs/2026-01-18-atomic-cli-implementation.md` — Initial CLI structure overview
- `research/docs/2026-01-19-cli-auto-init-agent.md` — Agent auto-initialization at CLI startup
- `research/docs/2026-01-19-cli-ordering-fix.md` — Command ordering and display sequence
- `research/docs/2026-01-19-slash-commands.md` — Slash command syntax research and implementation
- `research/docs/2026-01-20-cli-agent-rename-research.md` — Agent name and command rename refactoring
- `research/docs/2026-01-20-force-flag-modification-research.md` — --force flag implementation strategy
- `research/docs/2026-01-21-binary-distribution-installers.md` — Binary installers and distribution (Windows, macOS, Linux, ARM64)
- `research/docs/2026-01-21-update-uninstall-commands.md` — Update and uninstall command implementation
- `research/docs/2026-01-25-commander-cli-audit.md` — Commander.js library audit and patterns
- `research/docs/2026-01-25-commander-js-migration.md` — Migration strategy from manual arg parsing to Commander
- `research/docs/2026-01-24-bun-shell-script-conversion.md` — Shell script to Bun conversion for build/install
- `research/docs/2026-01-20-cross-platform-support.md` — Windows/macOS/Linux/ARM64 platform compatibility
- `research/docs/2026-02-03-command-migration-notes.md` — Command-by-command migration checklist
- `research/docs/2026-02-04-agent-subcommand-parity-audit.md` — Agent-specific subcommand feature parity
- `research/docs/2026-02-08-command-required-args-validation.md` — Required argument validation patterns
- `research/docs/2026-02-10-source-control-type-selection.md` — Source control type selection UI
- `research/docs/2026-02-05-model-command-header-update-research.md` — Model command header display logic
- `research/docs/2026-03-20-388-389-windows-arm64-support.md` — Windows ARM64 dual-binary approach
- `research/docs/2026-03-23-dual-binary-windows-approach.md` — Alternative binary distribution for Windows

### TUI Layer & Chat Rendering (28 docs)
- `research/docs/2026-02-01-chat-tui-parity-implementation.md` — Chat TUI feature parity across agents
- `research/docs/2026-02-01-claude-code-ui-patterns-for-atomic.md` — Claude Code UI patterns applied to Atomic
- `research/docs/2026-02-12-tui-layout-streaming-content-ordering.md` — TUI layout and streaming content order
- `research/docs/2026-02-13-emoji-unicode-icon-usage-catalog.md` — Icon and emoji usage catalog for UI elements
- `research/docs/2026-02-16-atomic-chat-architecture-current.md` — Current chat architecture documentation
- `research/docs/2026-02-16-chat-system-design-reference.md` — Chat system design reference patterns
- `research/docs/2026-02-16-chat-system-design-ui-research.md` — Chat UI design research and patterns
- `research/docs/2026-02-16-markdown-rendering-research.md` — Markdown rendering in TUI (terminal capabilities)
- `research/docs/2026-02-09-opentui-markdown-capabilities.md` — OpenTUI markdown support capabilities
- `research/docs/2026-02-09-terminal-markdown-libraries.md` — Terminal markdown rendering library research
- `research/docs/2026-02-09-token-count-thinking-timer-bugs.md` — Token counting and thinking timer display bugs
- `research/docs/2026-02-13-token-counting-system-prompt-tools.md` — Token counting for system prompts and tools
- `research/docs/2026-02-16-opencode-deepwiki-research.md` — OpenCode DeepWiki TUI patterns
- `research/docs/2026-02-16-opencode-message-rendering-patterns.md` — OpenCode message rendering patterns
- `research/docs/2026-02-16-opencode-tui-chat-architecture.md` — OpenCode TUI chat architecture documentation
- `research/docs/2026-02-16-opentui-deepwiki-research.md` — OpenTUI widget deep-dive research
- `research/docs/2026-02-16-opentui-rendering-architecture.md` — OpenTUI rendering architecture and lifecycle
- `research/docs/2026-02-17-command-history-persistence-tui.md` — Command history persistence in TUI
- `research/docs/2026-02-17-message-truncation-dual-view-system.md` — Message truncation and dual-view rendering
- `research/docs/2026-02-15-opentui-opencode-message-truncation-research.md` — Message truncation patterns across agents
- `research/docs/2026-02-15-ui-inline-streaming-vs-pinned-elements.md` — Streaming inline vs. pinned element rendering
- `research/docs/2026-02-12-opencode-tui-empty-file-fix-ui-consistency.md` — OpenCode TUI empty file display consistency
- `research/docs/2026-02-06-at-mention-dropdown-research.md` — @-mention dropdown UI implementation
- `research/docs/2026-02-06-mcp-tool-calling-opentui.md` — MCP tool calling UI patterns in OpenTUI
- `research/docs/2026-03-25-opentui-react-antipattern-audit.md` — OpenTUI React anti-pattern analysis (refs, lifecycle, concurrency)
- `research/docs/2026-04-17-claude-design-product-analysis.md` — Claude Design product analysis for UI reference
- `research/docs/2026-04-17-open-claude-design.md` — OpenUI Design patterns from Claude
- `research/web/2026-04-12-opentui-bun-react19-anti-patterns.md` — OpenTUI and React 19 anti-pattern patterns

### Workflow Orchestrator & Ralph (29 docs)
- `research/docs/2026-01-31-atomic-current-workflow-architecture.md` — Current workflow architecture overview
- `research/docs/2026-02-02-atomic-builtin-workflows-research.md` — Built-in workflows and workflow library
- `research/docs/2026-02-03-custom-workflow-file-format.md` — Custom workflow file format and schema
- `research/docs/2026-02-03-model-params-workflow-nodes-message-queuing.md` — Model parameters, workflow nodes, and message queuing
- `research/docs/2026-02-03-workflow-composition-patterns.md` — Workflow composition and chaining patterns
- `research/docs/2026-02-05-pluggable-workflows-sdk-design.md` — Pluggable workflows SDK design patterns
- `research/docs/2026-02-11-workflow-sdk-implementation.md` — Workflow SDK implementation guide
- `research/docs/2026-02-13-ralph-task-list-ui.md` — Ralph task list UI design and rendering
- `research/docs/2026-02-09-163-ralph-loop-enhancements.md` — Ralph loop improvements and enhancements
- `research/docs/2026-02-15-ralph-loop-manual-worker-dispatch.md` — Manual worker dispatch in Ralph workflow loop
- `research/docs/2026-02-15-ralph-dag-orchestration-implementation.md` — DAG orchestration implementation in Ralph
- `research/docs/2026-02-15-ralph-dag-orchestration-blockedby.md` — DAG blocking dependencies (blockedBy)
- `research/docs/2026-02-15-ralph-orchestrator-ui-cleanup.md` — Ralph orchestrator UI cleanup and rendering
- `research/docs/2026-02-25-ralph-workflow-implementation.md` — Ralph workflow implementation patterns
- `research/docs/2026-02-25-workflow-registration-flow.md` — Workflow registration and discovery flow
- `research/docs/2026-02-25-workflow-sdk-design.md` — Workflow SDK public API design
- `research/docs/2026-02-25-workflow-sdk-patterns.md` — Workflow SDK usage patterns and examples
- `research/docs/2026-02-25-workflow-sdk-refactor-research.md` — Workflow SDK refactor research and planning
- `research/docs/2026-02-25-workflow-sdk-standardization.md` — Workflow SDK standardization across agents
- `research/docs/2026-02-31-workflow-tui-rendering-unification.md` — Workflow TUI rendering unification
- `research/docs/2026-02-28-workflow-gaps-architecture.md` — Workflow architecture gaps and missing features
- `research/docs/2026-02-28-workflow-issues-research.md` — Workflow issue tracking and resolution
- `research/docs/2026-02-28-workflow-tui-rendering-unification-refactor.md` — Workflow TUI refactor and rendering consolidation
- `research/docs/2026-02-21-workflow-sdk-inline-mode-research.md` — Workflow SDK inline mode (headless execution)
- `research/docs/2026-03-18-ralph-eager-dispatch-research.md` — Eager dispatch strategy in Ralph
- `research/docs/2026-03-20-ralph-workflow-redesign-analysis.md` — Ralph workflow redesign analysis
- `research/docs/2026-03-21-workflow-sdk-simplification-z3-verification.md` — Workflow SDK simplification with Z3 verification
- `research/docs/2026-03-22-ralph-review-debug-loop-termination.md` — Ralph review/debug loop termination conditions
- `research/docs/2026-03-23-ask-user-question-dsl-node-type.md` — Ask-user-question DSL node type and implementation
- `research/docs/2026-03-24-workflow-interrupt-stage-advancement-bug.md` — Workflow interrupt and stage advancement bugs
- `research/docs/2026-03-25-workflow-interrupt-resume-bugs.md` — Workflow interrupt/resume implementation bugs

### Agent Adapters & SDK Integration (28 docs)
- `research/docs/2026-01-31-claude-agent-sdk-research.md` — Claude Agent SDK research and capabilities
- `research/docs/2026-01-31-claude-implementation-analysis.md` — Claude SDK implementation analysis
- `research/docs/2026-01-31-github-copilot-sdk-research.md` — GitHub Copilot SDK research and capabilities
- `research/docs/2026-01-31-github-implementation-analysis.md` — Copilot SDK implementation analysis
- `research/docs/2026-01-31-opencode-implementation-analysis.md` — OpenCode SDK implementation analysis
- `research/docs/2026-01-31-opencode-sdk-research.md` — OpenCode SDK research and capabilities
- `research/docs/2026-01-31-opentui-library-research.md` — OpenTUI library research and patterns
- `research/docs/2026-01-31-graph-execution-pattern-design.md` — Graph execution pattern design
- `research/docs/2026-01-31-sdk-migration-and-graph-execution.md` — SDK migration strategy and graph execution
- `research/docs/2026-01-24-copilot-agent-detection-findings.md` — Copilot agent detection implementation findings
- `research/docs/2026-01-24-copilot-agent-detection-refactoring.md` — Copilot agent detection refactoring strategy
- `research/docs/2026-01-24-opencode-telemetry-investigation.md` — OpenCode telemetry implementation investigation
- `research/docs/2026-01-24-opencode-hook-test-results.md` — OpenCode hook test results and integration
- `research/docs/2026-02-03-model-params-workflow-nodes-message-queuing.md` — Model parameters and message queuing across SDKs
- `research/docs/2026-02-12-sub-agent-sdk-integration-analysis.md` — Sub-agent SDK integration patterns
- `research/docs/2026-02-12-sdk-ui-standardization-comprehensive.md` — SDK UI standardization (cross-Claude/Copilot/OpenCode)
- `research/docs/2026-02-12-sdk-ui-standardization-research.md` — SDK UI standardization research
- `research/docs/2026-02-14-opencode-opentui-sdk-research.md` — OpenCode and OpenTUI SDK integration
- `research/docs/2026-03-01-opencode-auto-compaction.md` — OpenCode auto-compaction strategy
- `research/docs/2026-03-01-opencode-delegation-streaming-parity.md` — OpenCode delegation and streaming parity with others
- `research/docs/2026-03-01-opencode-tui-concurrency-bottlenecks.md` — OpenCode TUI concurrency bottlenecks and optimization
- `research/docs/2026-03-02-copilot-sdk-ui-alignment.md` — Copilot SDK UI alignment with standards
- `research/docs/2026-03-06-claude-agent-sdk-event-schema.md` — Claude Agent SDK event schema reference
- `research/docs/2026-03-06-copilot-sdk-session-events-schema-reference.md` — Copilot SDK session events schema reference
- `research/docs/2026-03-06-opencode-sdk-event-schema-reference.md` — OpenCode SDK event schema reference
- `research/docs/2026-03-08-claude-subagent-tree-tool-call-streaming.md` — Claude subagent tree tool call streaming patterns
- `research/docs/2026-03-12-copilot-post-stream-file-warning-rendering-bug.md` — Copilot post-stream file warning rendering bug
- `research/docs/2026-03-13-copilot-foreground-subagent-premature-completion.md` — Copilot foreground subagent completion issues

### Skills & Prompts Loading (10 docs)
- `research/docs/2026-02-08-skill-loading-from-configs-and-ui.md` — Skill discovery and loading from config files and UI
- `research/docs/2026-02-09-165-custom-tools-directory.md` — Custom tools directory structure and loading
- `research/docs/2026-02-25-skills-directory-structure.md` — Skills directory (.agents/skills, .claude/skills symlink) structure
- `research/docs/2026-02-17-legacy-code-removal-skills-migration.md` — Legacy code removal and skills migration strategy
- `research/docs/2026-02-14-frontend-design-builtin-skill-integration.md` — Frontend Design built-in skill integration patterns
- `research/docs/2026-02-25-at-command-duplicate-subagent-tree.md` — @-command duplicate handling in subagent trees
- `research/docs/2026-02-25-ui-workflow-coupling.md` — UI and workflow coupling analysis (skill vs. workflow boundaries)
- `research/docs/2026-02-08-164-mcp-support-discovery.md` — MCP (Model Context Protocol) server discovery and configuration
- `research/docs/2026-02-14-mcp-tool-discovery-startup-bugs.md` — MCP tool discovery startup and initialization bugs
- `research/docs/2026-02-14-failing-tests-mcp-config-discovery.md` — MCP config discovery test failures and root causes

### Sub-agents & Message Rendering (13 docs)
- `research/docs/2026-02-05-subagent-ui-opentui-independent-context.md` — Sub-agent UI rendering with independent OpenTUI context
- `research/docs/2026-02-15-sub-agent-tree-status-lifecycle-sdk-parity.md` — Sub-agent tree status lifecycle and SDK parity
- `research/docs/2026-02-15-subagent-event-flow-diagram.md` — Sub-agent event flow diagram and state machine
- `research/docs/2026-02-15-subagent-premature-completion-investigation.md` — Sub-agent premature completion investigation
- `research/docs/2026-02-15-subagent-premature-completion-quick-ref.md` — Sub-agent premature completion quick reference
- `research/docs/2026-02-15-subagent-premature-completion-SUMMARY.md` — Sub-agent premature completion fix summary
- `research/docs/2026-02-15-subagent-premature-completion-fix-comparison.md` — Sub-agent premature completion fix comparison
- `research/docs/2026-02-16-sub-agent-tree-inline-state-lifecycle-research.md` — Sub-agent tree inline state and lifecycle research
- `research/docs/2026-02-23-gh-issue-258-background-agents-ui.md` — Background agents UI rendering and lifecycle (#258)
- `research/docs/2026-02-23-258-background-agents-sdk-event-pipeline.md` — Background agents SDK event pipeline (#258)
- `research/docs/2026-02-14-subagent-output-propagation-issue.md` — Sub-agent output propagation issues
- `research/docs/2026-02-23-sdk-subagent-api-research.md` — SDK sub-agent API research and patterns
- `research/docs/2026-03-12-background-agent-spinner-premature-completion.md` — Background agent spinner and premature completion

### Telemetry & Configuration (15 docs)
- `research/docs/2026-01-21-anonymous-telemetry-implementation.md` — Anonymous telemetry implementation strategy
- `research/docs/2026-01-22-azure-app-insights-backend-integration.md` — Azure App Insights telemetry backend integration
- `research/docs/2026-01-23-telemetry-hook-investigation.md` — Telemetry hook investigation and implementation
- `research/docs/2026-01-23-hooks-json-history-analysis.md` — Hooks.json history and analysis
- `research/docs/2026-02-25-global-config-sync-mechanism.md` — Global config sync mechanism (Claude/.claude, Copilot/.github, OpenCode/.opencode)
- `research/docs/2026-03-04-claude-sdk-discovery-and-atomic-config-sync.md` — Claude SDK discovery and Atomic config synchronization
- `research/docs/2026-01-19-readme-update-research.md` — README update research and documentation
- `research/docs/2026-02-20-readme-update-research.md` — README update research (secondary)
- `research/docs/2026-02-25-install-postinstall-analysis.md` — Install and postinstall lifecycle analysis
- `research/docs/2026-02-25-unified-workflow-execution-research.md` — Unified workflow execution research
- `research/docs/2026-03-03-bun-migration-startup-optimization.md` — Bun runtime migration and startup optimization
- `research/docs/2026-02-19-sdk-v2-first-unified-layer-research.md` — SDK v2 unified layer architecture research
- `research/docs/2026-01-20-init-config-merge-behavior.md` — Init config merge behavior and conflict resolution
- `research/docs/2026-01-23-update-data-dir-clean-install.md` — Update data directory cleanup on clean install

### Graph Execution & Streaming (10 docs)
- `research/docs/2026-02-25-graph-execution-engine.md` — Graph execution engine design overview
- `research/docs/2026-02-25-graph-execution-engine-technical-documentation.md` — Graph execution engine technical reference
- `research/docs/2026-03-14-event-bus-callback-elimination-sdk-event-types.md` — Event bus callback elimination and SDK event types
- `research/docs/2026-02-26-opencode-event-bus-patterns.md` — OpenCode event bus patterns and architecture
- `research/docs/2026-02-26-streaming-architecture-event-bus-migration.md` — Streaming architecture and event bus migration
- `research/docs/2026-02-26-streaming-event-bus-spec-audit.md` — Streaming event bus specification audit
- `research/docs/2026-03-18-opencode-streaming-order-architecture.md` — OpenCode streaming order architecture
- `research/docs/2026-02-23-thinking-tag-stream-grouping.md` — Thinking tag stream grouping and ordering
- `research/docs/2026-03-05-claude-at-subagent-streaming-done-state-ordering.md` — Claude @-subagent streaming and done state ordering
- `research/docs/2026-02-14-testing-infrastructure-and-dev-setup.md` — Testing infrastructure and dev setup

### CI/CD & Build Infrastructure (14 docs)
- `research/docs/2026-02-12-opentui-distribution-ci-fix.md` — OpenTUI distribution CI fix and npm publishing
- `research/docs/2026-02-12-bun-test-failures-root-cause-analysis.md` — Bun test failures root cause analysis
- `research/docs/2026-03-28-devcontainer-features-publishing-research.md` — Devcontainer features publishing research (GHCR)
- `research/docs/2026-03-28-ghcr-multi-variant-docker-build.md` — GHCR multi-variant Docker build strategy
- `research/docs/2026-03-29-windows-arm64-bun-ci-research.md` — Windows ARM64 Bun CI research
- `research/docs/2026-03-24-test-suite-design.md` — Test suite design and structure
- `research/docs/2026-02-15-test-coverage-audit-and-85-percent-plan.md` — Test coverage audit and 85% coverage goal
- `research/docs/2026-03-13-codebase-architecture-modularity-analysis.md` — Codebase architecture and modularity analysis
- `research/docs/2026-04-02-logging-debugging-traces-rethink.md` — Logging/debugging/traces architecture rethinking
- `research/docs/2026-04-02-logging-debugging-traces-unified-research.md` — Unified logging/debugging/traces research
- `research/web/2026-04-08-opentui-testing.md` — OpenTUI testing patterns and best practices
- `research/web/2026-04-09-bun-global-install-postinstall-lifecycle.md` — Bun global install and postinstall lifecycle
- `research/web/2026-04-10-nodejs-fs-rm-windows-junction-behavior.md` — Node.js fs.rm() Windows junction behavior
- `research/web/2026-04-17-bun-global-install-bin-behavior.md` — Bun global install binary linking behavior

### tmux Integration & UX (11 docs)
- `research/docs/2026-04-10-tmux-ux-implementation-guide.md` — tmux UX implementation guide and patterns
- `research/docs/2026-04-14-hil-detection-implementation-research.md` — Human-in-the-loop (HIL) detection implementation
- `research/docs/2026-04-16-tmux-destructive-actions-prevention.md` — tmux destructive actions prevention strategy
- `research/web/2026-04-10-tmux-ux-for-embedded-cli-tools.md` — tmux UX for embedded CLI tools
- `research/web/2026-04-10-tmux-ux-improvements.md` — tmux UX improvements and session handling
- `research/web/2026-04-11-tmux-copy-mode-ux-scroll-exit.md` — tmux copy mode UX and scroll exit behavior
- `research/web/2026-04-10-psmux-tmux-compatibility.md` — psmux (PowerShell tmux) compatibility research
- `research/web/2026-04-14-claude-agent-sdk-hil-transcript.md` — Claude Agent SDK HIL transcript analysis
- `research/web/2026-04-14-copilot-sdk-hil-events.md` — Copilot SDK HIL events and handling
- `research/web/2026-04-14-opencode-sdk-hil-events.md` — OpenCode SDK HIL events and handling
- `research/web/2026-04-16-tmux-preventing-destructive-actions.md` — tmux preventing destructive actions implementation

### Additional Research & References (15 docs)
- `research/docs/2026-02-25-web-search-fetch-references.md` — Web search and fetch API reference patterns
- `research/docs/2026-02-25-playwright-cli-capabilities.md` — Playwright CLI capabilities research
- `research/docs/2026-02-25-playwright-cli-integration-research.md` — Playwright CLI integration strategy
- `research/web/2026-04-11-opencode-install-script.md` — OpenCode install script analysis
- `research/web/2026-04-14-bun-file-watch-api.md` — Bun file watch API research
- `research/docs/agent-detection-test-results.md` — Agent detection test results summary
- `research/docs/qa-ralph-task-list-ui.md` — QA notes on Ralph task list UI
- `research/docs/sapling-reference.md` — Sapling reference documentation
- `research/web/2026-04-17-claude-design-anthropic-labs.md` — Claude Design (Anthropic Labs) reference

## Notable Clusters

- `research/docs/` — 178 markdown research notes covering architecture decisions, bug investigations, SDK research, UI patterns, and integration strategies
- `research/designs/` — 3 TypeScript files with experimental TUI component designs and configuration
- `research/web/` — 17 markdown research notes capturing external research on Bun, tmux, OpenTUI, and other dependencies

## How It Works
<!-- Source: codebase-analyzer sub-agent -->
## Analysis: Partition 6 — Skills / Prompts / Sub-Agents / MCP Loading

### Files Analysed

- `research/designs/workflow-picker-tui.tsx`
- `research/designs/session-graph-tui.tsx`
- `research/designs/tsconfig.json`
- `research/docs/2026-02-08-skill-loading-from-configs-and-ui.md`
- `research/docs/2026-02-25-skills-directory-structure.md`

---

### Per-File Notes

#### `research/designs/workflow-picker-tui.tsx`

- **Role:** OpenTUI React prototype demonstrating a two-phase, agent-scoped telescope-style workflow picker TUI with fuzzy matching, structured argument forms, and a confirm-before-run modal.
- **Key symbols:**
  - `AgentType` (`workflow-picker-tui.tsx:89`) — union `"claude" | "copilot" | "opencode"`, the three supported agent backends; the picker is pinned to one agent per session via the `-a` CLI flag parsed at `workflow-picker-tui.tsx:255–279`.
  - `Workflow` / `WorkflowInput` (`workflow-picker-tui.tsx:99–115`) — core data shapes; `Workflow.source` is `"local" | "global" | "builtin"` mapping to `.atomic/workflows`, `~/.atomic/workflows`, and built-in respectively; `WorkflowInput.type` is `"text" | "string" | "enum"`.
  - `fuzzyMatch()` (`workflow-picker-tui.tsx:307–326`) — subsequence scoring: 0 for empty query, adjacent-character bonus (score 1), gap penalty (score 4 + gap distance).
  - `buildEntries()` (`workflow-picker-tui.tsx:341–378`) — filters workflows by active agent (`wf.agents.includes(agent)`), scores against name (primary) and description (+2 penalty), returns flat sorted list on non-empty query or source-grouped list on empty query.
  - `buildRows()` (`workflow-picker-tui.tsx:380–395`) — inserts `kind:"section"` separator rows for the source groups when query is empty.
  - `DEFAULT_PROMPT_INPUT` (`workflow-picker-tui.tsx:119–125`) — fallback `WorkflowInput` used for free-form (no `inputs`) workflows; keeps form renderer uniform.
  - `isFieldValid()` (`workflow-picker-tui.tsx:1262–1266`) — required-field guard: optional fields always pass; `enum` requires non-empty; `text`/`string` require non-whitespace-only value.
  - `WorkflowPicker` (`workflow-picker-tui.tsx:1270`) — root React component; manages `phase` (`"pick" | "prompt"`), `query`, `entryIdx`, `fieldValues`, `focusedFieldIdx`, `confirmOpen`, and a 530ms blinking `cursorTick`.
  - `ConfirmModal` (`workflow-picker-tui.tsx:1011`) — absolute-positioned overlay showing the composed shell invocation (`atomic workflow <name> -a <agent> [--field="val" ...]`); `y`/`return` triggers `renderer.destroy()` (prototype) or the real `runWorkflow()` hook (`TODO(prod)` comment at `workflow-picker-tui.tsx:1349`).
  - Source-color and source-dir maps (`workflow-picker-tui.tsx:283–296`) — `SOURCE_DIR` maps `local` → `.atomic/workflows`, `global` → `~/.atomic/workflows`, `builtin` → `built-in`; these strings match the `atomic workflow -l` output.
- **Control flow:**
  1. `parseAgentFromArgv()` (`workflow-picker-tui.tsx:255`) reads `-a`/`--agent` from `process.argv` and sets module-level `CURRENT_AGENT`.
  2. `WorkflowPicker` renders. `useKeyboard` at `workflow-picker-tui.tsx:1337` dispatches into three branches: confirm-modal, pick-phase, or prompt-phase.
  3. Pick-phase: alphanumeric chars append to `query`; `↑`/`↓` move `entryIdx`; `return` seeds `fieldValues` (enum fields get `f.default ?? f.values[0]`, others get `""`) and transitions `phase` to `"prompt"`.
  4. Prompt-phase: `tab`/`shift+tab` cycle `focusedFieldIdx`; text/string fields collect typed chars; enum fields cycle `left`/`right`; `ctrl+s` blocks if `invalidFieldIndices.length > 0` (first invalid field is focused instead), otherwise sets `confirmOpen = true`.
  5. Confirm-modal: `y`/`return` → `renderer.destroy()` (prod: `runWorkflow()`); `n`/`escape` closes modal.
- **Data flow:** `WORKFLOWS` (mock) → `buildEntries(query, CURRENT_AGENT)` → `buildRows(entries, query)` → `WorkflowList` (left sidebar) + `Preview` (right pane). Field values live in `fieldValues: Record<string, string>` React state. On confirm, the full invocation is composed inline inside `ConfirmModal` from `workflow`, `agent`, `fields`, and `values`.
- **Dependencies:** `@opentui/core` (`createCliRenderer`), `@opentui/react` (`createRoot`, `useKeyboard`, `useRenderer`), React (`useState`, `useEffect`, `useMemo`).

---

#### `research/designs/session-graph-tui.tsx`

- **Role:** OpenTUI React prototype of the orchestrator session graph pane, rendering a scrollable DAG of tmux-backed agent sessions with live duration timers, pulsing borders, and spatial keyboard navigation.
- **Key symbols:**
  - `Session` (`session-graph-tui.tsx:95–103`) — data shape: `id`, `name`, `status` (`"running" | "complete" | "pending" | "error"`), `duration`, `tmux` (tmux session handle e.g. `"@0"`), `parent` (nullable session id for tree edges), optional `error`.
  - `SESSIONS` (`session-graph-tui.tsx:114–122`) — 7-node mock DAG with parent-child relationships (orchestrator → planner → frontend-writer / backend-writer / reviewer → test-runner, orchestrator → deploy-agent). Session nodes explicitly carry `tmux` session identifiers — this is load-bearing tmux coupling.
  - `computeLayout()` (`session-graph-tui.tsx:150–215`) — pure function: builds parent→children tree from flat `Session[]`, assigns DFS `depth`, computes `rowH` (max node height per depth level), leaf-first column placement with `cursor` accumulation, centers parents over child midpoints. Returns `{ roots, map, rowH, width, height }`.
  - `buildConnector()` (`session-graph-tui.tsx:235–298`) — computes Unicode box-drawing connector text for an edge: straight `│` drop for single in-line children, or a multi-row stem + horizontal bar with junction characters (`╭ ╰ ├ ┤ ┴ ┬ ┼ ─`) for branching.
  - `NodeCard` (`session-graph-tui.tsx:315–376`) — absolute-positioned node box; running nodes pulse border color via `lerpColor(theme.border, theme.warning, sin(pulsePhase))` at `session-graph-tui.tsx:334`; focused node gets status-tinted background via `lerpColor(theme.background, statusColor, 0.12)` at `session-graph-tui.tsx:347`.
  - `navigate()` (`session-graph-tui.tsx:544–573`) — spatial arrow-key navigation: computes `(dx, dy)` from focused node center to each candidate, applies a 3× cross-axis penalty (`Math.abs(dy) + Math.abs(dx) * 3` for horizontal), picks minimum-distance node.
  - `doAttach()` (`session-graph-tui.tsx:535–541`) — shows a flash message `"→ <name> · <tmux>"` in the statusline for 2400ms; in production this is where tmux attach would fire.
  - `SessionGraph` (`session-graph-tui.tsx:470`) — root component; wraps graph canvas in `<scrollbox scrollX scrollY>` and auto-scrolls to keep focused node visible via `sb.scrollTo()` at `session-graph-tui.tsx:630`.
- **Control flow:**
  1. `computeLayout(SESSIONS)` runs once in `useMemo` at `session-graph-tui.tsx:474`.
  2. Two `useEffect` intervals run: pulse phase at 60ms (`session-graph-tui.tsx:492`), and live duration increment at 1000ms for `"running"` nodes (`session-graph-tui.tsx:509`).
  3. Keyboard: arrows/hjkl call `navigate()`; `return` calls `doAttach(focusedId)`; `G` (shift) jumps to deepest-rightmost leaf; `gg` double-tap within 300ms jumps to root; `q`/`escape` destroys renderer.
  4. Auto-scroll `useEffect` at `session-graph-tui.tsx:625` fires on `focusedId` change, centering the focused node.
- **Data flow:** `Session[]` → `computeLayout()` → `LayoutNode[]` + `ConnectorResult[]` → `NodeCard` + `Edge` components rendered in a `<scrollbox>`. Live duration updates flow from `timerSecsRef` (a stable mutable `useMemo` object) → `setDurations()` → `NodeCard.duration` prop.
- **Dependencies:** `@opentui/core` (`createCliRenderer`, `ScrollBoxRenderable`), `@opentui/react` (`createRoot`, `useKeyboard`, `useTerminalDimensions`, `useRenderer`), React (`useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`).

---

#### `research/designs/tsconfig.json`

- **Role:** TypeScript configuration for the design exploration files in `research/designs/`; extends the root `tsconfig.json` and sets `noEmit: true`, covering all `.tsx` files in the directory.
- **Key symbols:** None exported; `"extends": "../../tsconfig.json"` at line 2; `"include": ["**/*.tsx"]` at line 5.
- **Control flow:** Compile-time only — no runtime behavior.
- **Data flow:** None.
- **Dependencies:** Root `../../tsconfig.json` (repo-level).

---

#### `research/docs/2026-02-08-skill-loading-from-configs-and-ui.md`

- **Role:** Research document mapping how skills are discovered, loaded, and rendered across all three agent SDKs, with a gap analysis of what Atomic currently implements vs. what is missing, and a proposed `SkillStatusIndicator` UI component design.
- **Key symbols (source file references documented):**
  - `BUILTIN_SKILLS` — array at `src/ui/commands/skill-commands.ts:70`, 9 hardcoded skills with embedded prompts; `SkillMetadata` and `BuiltinSkill` types at `skill-commands.ts:27–58`.
  - `expandArguments()` — `skill-commands.ts:1548`; replaces `$ARGUMENTS` placeholder.
  - `createBuiltinSkillCommand()` — `skill-commands.ts:1624`; produces `CommandDefinition` with category `"skill"`, calls `context.sendSilentMessage(expandedPrompt)`.
  - `registerSkillCommands()` — `skill-commands.ts:1699`; registers builtins then legacy `SKILL_DEFINITIONS`.
  - `discoverAgentFiles()` / `parseAgentFile()` / `parseMarkdownFrontmatter()` — `agent-commands.ts:1493 / 1519 / 1188`; the pattern Atomic should replicate for disk-based skill discovery.
  - `CommandRegistry` — `registry.ts:209`; category priority at `registry.ts:383`: `workflow(0) > skill(1) > agent(2) > builtin(3) > custom(4)`.
  - `initializeCommandsAsync()` — `commands/index.ts:132–151`; proposed insertion point for `discoverAndRegisterDiskSkills()`.
  - `executeCommand()` — `chat.tsx:1973–2265`; dispatch site where a `SkillStatusIndicator` render should be injected.
  - `StatusIndicator` / `AnimatedStatusIndicator` / `ToolResult` — `tool-result.tsx:76–108 / 53–74 / 256–353`; UI patterns to reuse for skill loading indicator.
  - `initClaudeOptions()` / `createSession()` (Copilot) / `createSession()` (OpenCode) — `src/sdk/init.ts:24–33` / `copilot-client.ts:585–645` / `opencode-client.ts:608–633`.
- **Control flow:** Documents a proposed flow: `initializeCommandsAsync()` → `registerSkillCommands()` (builtins, priority 1) → `discoverAndRegisterDiskSkills()` (disk SKILL.md, priorities 2–4, override via `unregister()` + `register()`). SDK passthrough: Claude via `settingSources: ["project", "user"]` (already present); OpenCode auto-discovers via server; Copilot via `skillDirectories` in `SessionConfig` (currently missing).
- **Data flow:** Discovery paths table (8 paths across project-local, global, builtin scopes) → YAML frontmatter parsing → `CommandDefinition` registration → command dispatch → `sendSilentMessage()` → active agent session.
- **Dependencies:** References `src/ui/commands/skill-commands.ts`, `agent-commands.ts`, `registry.ts`, `commands/index.ts`, `chat.tsx`, `tool-result.tsx`, `src/sdk/init.ts`, `copilot-client.ts`, `opencode-client.ts`, `config-path.ts`, `settings.ts`.

---

#### `research/docs/2026-02-25-skills-directory-structure.md`

- **Role:** Research document providing a complete catalog of all 11 skills (names, locations, sizes, purposes, key features), the multi-platform deployment strategy, the `install.sh` `sync_global_agent_configs` function, the `package.json` `files` field, and the `~/.atomic` directory structure.
- **Key symbols (source file references documented):**
  - `sync_global_agent_configs()` — `install.sh:144–165`; copies `.claude/` → `~/.atomic/.claude/`, `.opencode/` → `~/.atomic/.opencode/`, `.github/` → `~/.atomic/.copilot/`, `.mcp.json` → `~/.atomic/.mcp.json`; then removes `gh-*` and `sl-*` from all three `skills/` subdirectories and removes `.copilot/workflows` and `.copilot/dependabot.yml`.
  - `package.json:22–31` — `files` field: includes `src`, `assets/settings.schema.json`, `.claude`, `.opencode`, `.mcp.json`, `.github/skills`, `.github/agents`, `.github/mcp-config.json`; excludes `.github/workflows` and `.github/dependabot.yml`.
  - 11 skills across `.github/skills/`, `.claude/skills/`, `.opencode/skills/`: `create-spec`, `explain-code`, `frontend-design`, `gh-commit`, `gh-create-pr`, `init`, `prompt-engineer` (with 3 reference files), `research-codebase`, `sl-commit`, `sl-submit-diff`, `testing-anti-patterns`.
  - `.claude/skills/research-codebase/SKILL.md` — the only file with Claude-specific frontmatter: `aliases: [research]`, `argument-hint: "<research-question>"`, `required-arguments: [research-question]`.
  - `~/.atomic/.tmp/opencode-config-merged/skills/` — temporary merged skills directory created by OpenCode config merging.
  - 9 agent markdown files (identical across all three platforms): `codebase-analyzer.md`, `codebase-locator.md`, `codebase-online-researcher.md`, `codebase-pattern-finder.md`, `codebase-research-analyzer.md`, `codebase-research-locator.md`, `debugger.md`, `reviewer.md`, `worker.md`.
- **Control flow:** Documents `install.sh` 8-step flow ending with `sync_global_agent_configs "$DATA_DIR"` at `install.sh:233–234`.
- **Data flow:** npm package → `atomic-config.tar.gz` → extraction to `$DATA_DIR` → `sync_global_agent_configs` copies 3 platform dirs → removes SCM/GitHub-specific artifacts → `~/.atomic/{.claude,.opencode,.copilot}/` each receive 7 skills and 9 agents.
- **Dependencies:** References `install.sh`, `package.json`, `.github/skills/`, `.claude/skills/`, `.opencode/skills/`, `~/.atomic/`.

---

### Cross-Cutting Synthesis

The three design files (`workflow-picker-tui.tsx`, `session-graph-tui.tsx`, `tsconfig.json`) are prototypes exploring two UI surfaces: a two-phase workflow picker (pick → compose → confirm) and a DAG session graph viewer. Both use OpenTUI + React exclusively and introduce no agent-SDK coupling at the component level. The workflow picker does embed the `AgentType` union (`"claude" | "copilot" | "opencode"`) as a first-class concept, and the session graph's `Session.tmux` field exposes direct tmux dependency (the "attach" interaction at `session-graph-tui.tsx:535–541`).

The two research documents document the load-bearing implementation: 11 skills maintained as SKILL.md files in three parallel directories (`.github/skills/`, `.claude/skills/`, `.opencode/skills/`), deployed globally via `install.sh:144–165` to `~/.atomic/{.claude,.opencode,.copilot}/skills/` minus SCM-specific ones. The TUI command layer presents skills as hardcoded `BUILTIN_SKILLS` at `src/ui/commands/skill-commands.ts:70` — disk-based SKILL.md discovery is described as absent and proposed. Sub-agents (9 agents shared across platforms) are the main orchestration primitive used by complex skills like `research-codebase` and `create-spec`.

For the pi-coding-agent rewrite: the three-platform parallel skill structure collapses to one; the `AgentType` union in the picker becomes a single pi target; the tmux `Session.tmux` field in the graph has no pi equivalent without a tmux replacement; and the `BUILTIN_SKILLS` embedding plus the proposed disk-discovery flow are the seam where pi skill loading (via pi's own skill/prompt mechanism) slots in.

---

### Out-of-Partition References

- `src/ui/commands/skill-commands.ts` — Primary skill registration file: `BUILTIN_SKILLS` array, `expandArguments()`, `createBuiltinSkillCommand()`, `registerSkillCommands()` — core load-bearing skill command implementation.
- `src/ui/commands/agent-commands.ts` — Contains `discoverAgentFiles()`, `parseAgentFile()`, `parseMarkdownFrontmatter()`, `shouldAgentOverride()`, `registerAgentCommands()` — the disk-discovery pattern that skill loading should replicate.
- `src/ui/commands/registry.ts` — `CommandRegistry` class, category sort priority; skill commands register here.
- `src/ui/commands/index.ts` — `initializeCommandsAsync()` registration flow; proposed insertion point for disk skill discovery.
- `src/ui/chat.tsx` — `executeCommand()` at line 1973; message bubble rendering at line 982; `LoadingIndicator`, `StreamingBullet` animation patterns.
- `src/ui/components/tool-result.tsx` — `StatusIndicator`, `AnimatedStatusIndicator`, `ToolResult` — UI component patterns to reuse for `SkillStatusIndicator`.
- `src/sdk/init.ts` — `initClaudeOptions()` at line 24–33; `settingSources: ["project"]` Claude skill passthrough.
- `src/sdk/copilot-client.ts` — `createSession()` at line 585–645; missing `skillDirectories` in `SdkSessionConfig`.
- `src/sdk/opencode-client.ts` — `createSession()` at line 608–633; OpenCode auto-discovers skills via server.
- `src/utils/config-path.ts` — `getConfigRoot()` at line 77; installation-aware path resolution.
- `src/utils/settings.ts` — Two-tier settings paths (local `.atomic/settings.json` overrides global `~/.atomic/settings.json`).
- `install.sh` — `sync_global_agent_configs()` at line 144–165; SCM skill exclusion and three-platform skill deployment.
- `package.json` — `files` field at line 22–31; controls which skill/agent directories are published to npm.
- `.github/skills/` — Canonical skill source directory (9/11 skills, most complete set).
- `.claude/skills/` — Claude-specific skill directory; `research-codebase/SKILL.md` has unique `aliases`/`argument-hint`/`required-arguments` frontmatter.
- `.opencode/skills/` — OpenCode-specific skill directory.
- `.agents/skills/` — Shared symlink target; `.claude/skills` is a symlink to `.agents/skills`.

## Patterns
<!-- Source: codebase-pattern-finder sub-agent -->
# Partition 6: Research Documentation Patterns
## Pattern Mapping for Atomic → Pi-Coding-Agent Rewrite

**Partition**: 6 of 12 (research/)  
**Scope**: `research/docs/` (2,307 LOC of markdown)  
**Research Question**: Map the entire Atomic CLI codebase for a planned full rewrite onto pi-coding-agent. Remove ALL dependencies on tmux, Claude Code/Claude Agent SDK, GitHub Copilot CLI/SDK, and OpenCode/OpenCode SDK.

---

## Patterns Found

#### Pattern 1: Unified SDK Abstraction Architecture
**Where:** `research/docs/2026-01-31-sdk-migration-and-graph-execution.md:544-576`  
**What:** Documents the current three-SDK abstraction pattern and recommends a single unified interface.

```typescript
interface CodingAgentClient {
  // Session management
  createSession(config: SessionConfig): Promise<Session>
  resumeSession(id: string): Promise<Session>
  
  // Messaging
  send(message: string): Promise<void>
  stream(): AsyncGenerator<AgentMessage>
  
  // Events
  on(event: string, handler: EventHandler): Unsubscribe
  
  // Tools
  registerTool(tool: ToolDefinition): void
  
  // Lifecycle
  start(): Promise<void>
  stop(): Promise<void>
}

// Implementations
class OpenCodeClient implements CodingAgentClient { ... }
class ClaudeAgentClient implements CodingAgentClient { ... }
class CopilotClient implements CodingAgentClient { ... }
```

**Variations / call-sites:**  
- `research/docs/2026-01-31-opencode-sdk-research.md:114-145` — OpenCode SDK migration path
- `research/docs/2026-01-31-claude-agent-sdk-research.md:147-196` — Claude Agent SDK v2 API patterns
- `research/docs/2026-01-31-github-copilot-sdk-research.md:198-255` — GitHub Copilot SDK architecture

---

#### Pattern 2: Graph-Based Workflow Execution with Fluent API
**Where:** `research/docs/2026-01-31-sdk-migration-and-graph-execution.md:429-461`  
**What:** Declarative workflow pattern with chaining, conditionals, loops, and parallel execution.

```typescript
const workflow = graph<AtomicWorkflowState>()
  .start("research")
  .then(researchCodebase)
  .then(createSpec)
  .then(reviewSpec)
  .if(ctx => ctx.state.specApproved === true)
    .then(createFeatureList)
    .loop(implementFeature, {
      until: ctx => ctx.state.allFeaturesPassing === true,
      maxIterations: 100
    })
    .then(createPR)
  .else()
    .then(notifyUser)
    .wait("Waiting for spec revision")
  .endif()
  .end("create_pr", "notify")
  .compile({
    checkpointer: new ResearchDirSaver()
  })

const result = await workflow.invoke(initialState, config)

for await (const state of workflow.stream(initialState, config)) {
  console.log(`Iteration: ${state.iteration}`)
}
```

**Variations / call-sites:**
- `research/docs/2026-01-31-graph-execution-pattern-design.md:432-540` — Node factory functions, error handling, state persistence
- `research/docs/2026-01-31-atomic-current-workflow-architecture.md:147-161` — Current graph engine entry point and exports

---

#### Pattern 3: SDK Event Normalization for Multi-Agent Support
**Where:** `research/docs/2026-02-12-tui-layout-streaming-content-ordering.md:202-226`  
**What:** Maps SDK-specific events from three agents (Claude, OpenCode, Copilot) to unified UI events.

```typescript
// Each SDK produces different event structures:

// **Claude Agent SDK** (QueryAsyncIterable)
for await (const message of query(...)) {
  if (message.type === 'tool_use') {
    // Handle tool start
  }
  if (message.type === 'tool_result') {
    // Handle tool complete
  }
}

// **OpenCode SDK** (SSE-based)
for await (const event of events.stream()) {
  if (event.type === 'message.part.updated') {
    const partType = event.data.part.type; // 'text' | 'tool' | 'reasoning'
    // Handle by part type
  }
}

// **Copilot SDK** (31 event types)
session.on((event) => {
  if (event.type === 'assistant.message') { /* ... */ }
  if (event.type === 'tool.execution_start') { /* ... */ }
})

// Unified event pipeline in adapter
interface NormalizedEvent {
  type: 'chunk' | 'tool_start' | 'tool_complete' | 'agent_start' | 'agent_complete'
  timestamp: number
  // ... payload varies by type
}
```

**Variations / call-sites:**
- `research/docs/2026-02-12-tui-layout-streaming-content-ordering.md:258` — SDK UI standardization reference
- `research/docs/2026-02-01-claude-code-ui-patterns-for-atomic.md` — Claude Code CLI patterns for TUI
- `research/docs/2026-02-16-opencode-deepwiki-research.md:103-160` — OpenCode message streaming and sub-agent lifecycle

---

#### Pattern 4: Chat System Architecture with Content Segments
**Where:** `research/docs/2026-02-16-atomic-chat-architecture-current.md:23-100`  
**What:** Offset-based chronological rendering of interleaved message content, tools, agents, and tasks.

```typescript
function buildContentSegments(
  content: string,
  toolCalls: MessageToolCall[],
  agents?: ParallelAgent[] | null,
  agentsOffset?: number,
  taskItems?: TaskItem[] | null,
  tasksOffset?: number,
  tasksExpanded?: boolean,
): ContentSegment[]

// Segment types:
type ContentSegment = 
  | { type: 'text'; content: string }
  | { type: 'tool'; toolCall: MessageToolCall }
  | { type: 'hitl'; question: CompletedQuestion }
  | { type: 'agents'; agents: ParallelAgent[] }
  | { type: 'tasks'; items: TaskItem[] }

// Offset-based insertion: Each segment has a character offset in content
// where it should appear chronologically. Segments sorted by:
// 1. offset (chronological)
// 2. priority (text=0, tool=0, hitl=1, agents=2, tasks=3)
// 3. sequence (insertion order)
```

**Variations / call-sites:**
- `research/docs/2026-02-16-atomic-chat-architecture-current.md:1287-1483` — `buildContentSegments()` full implementation
- `research/docs/2026-02-16-atomic-chat-architecture-current.md:1502-1757` — `MessageBubble` rendering with segments

---

#### Pattern 5: Deferred Completion with Parallel Agent Coordination
**Where:** `research/docs/2026-02-16-atomic-chat-architecture-current.md:319-343`  
**What:** Pattern for handling asynchronous sub-agents while preventing premature message completion.

```typescript
// Handler delays completion if sub-agents or tools still running
if (hasActiveAgents || hasRunningToolRef.current) {
  pendingCompleteRef.current = handleComplete;
  return; // Exit early, defer execution
}

// Effect monitors completion state
useEffect(() => {
  if (!hasActive && !hasRunningToolRef.current && pendingCompleteRef.current) {
    const complete = pendingCompleteRef.current;
    pendingCompleteRef.current = null;
    complete(); // Now finalize
  }
}, [parallelAgents, toolCompletionVersion])

// Stale callback guard with generation counter
const currentGeneration = streamGenerationRef.current;
return () => {
  if (streamGenerationRef.current !== currentGeneration) return;
  // Safe to proceed
};
```

**Variations / call-sites:**
- `research/docs/2026-02-16-atomic-chat-architecture-current.md:3384-3393` — Deferred completion check in `handleComplete`
- `research/docs/2026-02-16-atomic-chat-architecture-current.md:2707-2782` — Agent-only stream finalization
- `research/docs/2026-02-15-subagent-premature-completion-SUMMARY.md` — Comprehensive fix notes

---

#### Pattern 6: tmux-Free Architecture Transition
**Where:** `research/docs/2026-02-06-at-mention-dropdown-research.md:55-85` (Claude Code tmux usage), `2026-02-06-at-mention-dropdown-research.md:175-200` (OpenCode SolidJS native UI)  
**What:** Documents shift from tmux-based Claude Code to native terminal UI (OpenCode/OpenTUI approach).

```typescript
// OLD PATTERN (Claude Code + tmux):
// 1. Claude Code CLI runs in tmux pane
// 2. Sub-agent invocation via `@mention` triggers tmux send-keys
// 3. External process coordination via file I/O and tmux escape sequences

// NEW PATTERN (OpenCode + OpenTUI):
// 1. Single-process TUI using OpenTUI primitives
// 2. Sub-agents managed natively within event loop
// 3. No tmux dependency, no external process coordination

// OpenTUI primitives (SolidJS-based):
import { Textarea, Box, ScrollBox, Text, SelectRenderable } from "@opentui/core"

// All UI components manage state directly
function ChatApp() {
  const [messages, setMessages] = createSignal([])
  const [inputValue, setInputValue] = createSignal("")
  
  return (
    <Box flexDirection="column" flexGrow={1}>
      <ScrollBox flexGrow={1} stickyScroll>
        {messages.map(msg => <MessageComponent msg={msg} />)}
      </ScrollBox>
      <Textarea 
        value={inputValue()}
        onInput={e => setInputValue(e)}
        onSubmit={handleMessage}
      />
    </Box>
  )
}
```

**Variations / call-sites:**
- `research/docs/2026-02-06-at-mention-dropdown-research.md:537-574` — Comparison table (Claude Code vs OpenCode primitives)
- `research/docs/2026-02-01-claude-code-ui-patterns-for-atomic.md` — Claude Code UI patterns study

---

#### Pattern 7: SDK Auto-Compaction and Context Management
**Where:** `research/docs/2026-03-01-opencode-auto-compaction.md:111-167`  
**What:** Unified context overflow handling across three SDKs with different mechanisms.

```typescript
// COPILOT SDK: Native auto-compact with event
session.on('session.compaction', (event) => {
  if (event.data.phase === 'start') {
    showCompactionSpinner();
  }
  if (event.data.phase === 'complete') {
    hideCompactionSpinner();
    showCompactionSummary(event.data.summary);
  }
});

// CLAUDE AGENT SDK: Auto-compact on ContextOverflowError
try {
  for await (const msg of query(...)) {
    // process message
  }
} catch (error) {
  if (error instanceof ContextOverflowError) {
    // SDK handles auto-compaction internally
    // Resume streaming
  }
}

// OPENCODE SDK: Manual trigger via summarize()
if (contextUsage > 0.45) { // 45% threshold
  await session.summarize();
  // UI shows compaction spinner
}

// Unified adapter pattern:
interface CompactionEvent {
  phase: 'start' | 'complete';
  summary?: string;
  timestamp: number;
}
```

**Variations / call-sites:**
- `research/docs/2026-03-01-opencode-auto-compaction.md:185-203` — Feature comparison table
- `research/docs/2026-03-01-opencode-auto-compaction.md:204-428` — Upstream OpenCode native auto-compaction system

---

## Summary

The research partition documents **seven distinct patterns** critical for the Atomic → Pi-Coding-Agent rewrite:

1. **Unified SDK Abstraction** (`CodingAgentClient` interface): Abstracts three SDKs (Claude, OpenCode, Copilot) behind a single interface with `createSession()`, `stream()`, `on()`, `registerTool()` methods.

2. **Graph-Based Workflows**: Fluent API for declarative workflow orchestration with `.then()`, `.if()`/`.else()`, `.loop()`, and `.parallel()` combinators, supporting Ralph-loop patterns.

3. **Event Normalization**: Adapters map SDK-specific events (Claude's `QueryAsyncIterable`, OpenCode's SSE, Copilot's 31+ event types) to unified pipeline.

4. **Content Segment Architecture**: Offset-based chronological rendering interleaves text, tool calls, HITL questions, parallel agents, and task items at their exact character positions.

5. **Deferred Completion Pattern**: Prevents premature message finalization when sub-agents are running by storing callbacks in refs and executing when all operations complete.

6. **tmux Removal**: Shift from external process coordination (Claude Code + tmux) to native single-process TUI (OpenTUI + SolidJS).

7. **Context Management**: Unified auto-compaction handling across Copilot (native events), Claude (exceptions), and OpenCode (manual triggers).

All patterns exist in current codebase as of research documents dated 2026-01-31 through 2026-03-02. Each includes concrete type definitions, implementation strategies, and variation examples across the three current coding agent SDKs.

## Out-of-Partition References
Look for the **Out-of-Partition References** subsection inside the
"How It Works" section above — that is where the analyzer flagged files
outside this partition that other partitions should examine.
