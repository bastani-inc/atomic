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

