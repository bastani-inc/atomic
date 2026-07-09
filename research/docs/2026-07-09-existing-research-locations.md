I found the relevant existing research documents, but this read-only toolset does not include a file write/edit tool, so I could not update `progress.md` or create `research/docs/2026-07-09-existing-research-locations.md` directly. Below is the content to place in that output file.

## Research Documents about Atomic startup / MCP lazy loading / extension loading / workflows / subagents / Claude Code comparisons / startup performance

### Related Tickets

No `research/tickets/` directory was present in this checkout.

### Related Documents

- 🟢 `research/docs/2026-07-08-existing-research-locator.md` - Recent locator-style research document; likely useful for finding adjacent prior context and potentially supersedes older broad locator docs.
- 🟢 `research/docs/2026-07-08-overflow-fallback-patterns.md` - Recent workflow/subagent orchestration patterns around fallback behavior; adjacent to startup-safe initialization and agent workflow robustness.
- 🟢 `research/web/2026-07-08-bun-tui-first-input-responsiveness.md` - Research cache on terminal/TUI first keyboard input responsiveness; directly relevant to deferring nonessential startup probes and measuring first input latency.
- 🟡 `research/docs/2026-05-14-pi-subagents-api-parity-for-atomic-workflows.md` - Documents `pi-subagents` API, extension registration, management/discovery behavior, runtime/control semantics, and mapping to Atomic workflows.
- 🟡 `research/docs/2026-05-14-local-atomic-workflows-api-analysis.md` - Local `@bastani/atomic-workflows` SDK and workflow tool analysis, including pi extension entrypoints, runtime wiring, lifecycle hooks, and discovery-backed dispatch.
- 🟡 `research/docs/2026-05-14-local-workflow-patterns.md` - Pattern examples for local workflow and pi-subagents-adjacent API shapes, including skills, prompts, workflow invocation, and packaged assets.
- 🟡 `research/docs/2026-05-14-existing-workflows-research-locator.md` - Locator for existing workflow-related research; useful as an index for workflow startup/registration context.
- 🟡 `research/docs/2026-05-14-local-atomic-workflows-locator.md` - Locator for local Atomic workflows implementation docs and related references.
- 🟡 `research/docs/2026-05-12-extension-intercom-pi-integration-surfaces.md` - Highly relevant to extension initialization: describes `src/extension/index.ts` composition root, synchronous bundled registry seeding, async config/discovery upgrade, MCP scope events, subagent env/event helpers, and intercom wiring.
- 🟡 `research/docs/2026-05-12-extension-runs-workflows-test-surfaces.md` - Covers `src/extension`, `src/runs`, and `src/workflows` runtime surfaces; relevant for extension loading, background workflow runs, MCP scoping, HIL UI, CLI flag startup dispatch, and tests.
- 🟡 `research/docs/2026-05-12-pi-extension-integrations-ui.md` - Relevant for pi extension integration/UI surfaces and workflow extension behavior.
- 🟡 `research/docs/2026-05-12-workflow-authoring-registry-core.md` - Documents workflow authoring and registry core, relevant to workflow registration/discovery and avoiding expensive eager loading.
- 🟡 `research/docs/2026-05-11-pi-mcp-adapter-and-subagents.md` - Directly relevant to MCP lazy loading: documents pi-mcp-adapter lazy/eager/keep-alive lifecycle modes, on-demand MCP proxy, direct tool promotion, session_start initialization, and pi-subagents/intercom integration.
- 🟡 `research/docs/2026-05-11-atomic-codebase-inventory.md` - Broad codebase inventory; useful for locating startup and extension-related implementation surfaces.
- 🟡 `research/docs/2026-05-11-map-the-entire-atomic-cli-codebase.md` - Broad map of Atomic CLI codebase; useful background for startup path and module layout.
- 🔴 `research/docs/2026-04-17-claude-design-product-analysis.md` - Claude Design / Claude Code product analysis; relevant for Claude Code comparison context, though likely UI/product-focused and aged.
- 🔴 `research/docs/2026-04-17-open-claude-design.md` - Open Claude design patterns; related comparison context for Claude-like product/UX behavior.
- 🔴 `research/web/2026-04-14-claude-agent-sdk-hil-transcript.md` - Claude Agent SDK transcript/HIL research; relevant for subagent messages, MCP tool blocks, AskUserQuestion, and session initialization semantics.
- 🔴 `research/web/2026-04-14-copilot-sdk-hil-events.md` - Copilot SDK event research; includes events for `session.skills_loaded`, `session.custom_agents_updated`, `session.mcp_servers_loaded`, `session.extensions_loaded`, and subagent events; useful for extension/loading comparisons.
- 🔴 `research/web/2026-04-14-opencode-sdk-hil-events.md` - OpenCode SDK event research; includes MCP tool change events and HIL-related behavior for provider comparison.
- 🔴 `research/docs/2026-04-02-logging-debugging-traces-unified-research.md` - Potentially relevant to startup performance instrumentation/tracing.
- 🔴 `research/docs/2026-04-02-logging-debugging-traces-rethink.md` - Potentially relevant to measuring startup initialization and lazy-loading behavior.
- 🔴 `research/docs/2026-03-04-claude-sdk-discovery-and-atomic-config-sync.md` - Directly relevant to Claude SDK discovery and Atomic config sync; documents skills/sub-agents discovery across `.opencode`, `.claude`, `.github`, and `~/.atomic` mirrors.
- 🔴 `research/docs/2026-03-03-bun-migration-startup-optimization.md` - Most directly relevant prior startup performance work; documents Atomic CLI startup path, lazy loading status, eager modules, Node/Bun API migration opportunities, and startup-time optimization. Potentially superseded by the matching spec.
- 🔴 `research/docs/2026-03-01-opencode-tui-concurrency-bottlenecks.md` - Relevant for TUI concurrency/performance bottlenecks and startup responsiveness.
- 🔴 `research/docs/2026-02-25-workflow-registration-flow.md` - Relevant to workflow registration and discovery, including custom workflow loading.
- 🔴 `research/docs/2026-02-25-workflow-sdk-design.md` - Workflow SDK design context; useful for initialization and public API preservation.
- 🔴 `research/docs/2026-02-25-workflow-sdk-patterns.md` - Workflow SDK patterns; relevant to workflows and registry design.
- 🔴 `research/docs/2026-02-23-sdk-subagent-api-research.md` - SDK subagent API research; relevant to subagent/workflow initialization and public API compatibility.
- 🔴 `research/docs/2026-02-21-workflow-sdk-inline-mode-research.md` - Relevant to workflow SDK inline mode and execution initialization.
- 🔴 `research/docs/2026-02-14-mcp-tool-discovery-startup-bugs.md` - Directly relevant to MCP startup: traces MCP config loading → server connection → tool discovery → state storage → UI rendering and documents first-message/runtime snapshot issues.
- 🔴 `research/docs/2026-02-14-failing-tests-mcp-config-discovery.md` - Relevant to MCP project-level config discovery and regression tests.
- 🔴 `research/docs/2026-02-08-164-mcp-support-discovery.md` - Foundational MCP support/discovery research for config files, provider mappings, `/mcp`, and MCP tool rendering.
- 🔴 `research/docs/2026-02-06-mcp-tool-calling-opentui.md` - MCP tool-calling UI patterns in OpenTUI; relevant to MCP display after lazy discovery.
- 🔴 `research/docs/2026-02-05-pluggable-workflows-sdk-design.md` - Relevant to pluggable workflow SDK and extension-like workflow registration.
- 🔴 `research/docs/2026-02-05-subagent-ui-opentui-independent-context.md` - Relevant to subagent UI and independent context behavior.
- 🔴 `research/docs/2026-02-02-atomic-builtin-workflows-research.md` - Built-in workflows research; useful for startup workflow registration/load decisions.
- 🔴 `research/docs/2026-02-01-claude-code-ui-patterns-for-atomic.md` - Claude Code UI pattern comparison for Atomic; includes message queuing, collapsible outputs, autocomplete, timing display, and spinner behavior.
- 🔴 `research/docs/2026-01-31-atomic-current-workflow-architecture.md` - Baseline current workflow architecture overview; useful historical context, likely superseded by May workflow/pi docs.
- 🔴 `research/docs/2026-01-31-claude-agent-sdk-research.md` - Broad Claude Agent SDK research; relevant to Claude Code comparison, subagents, MCP integration, hooks, permissions, and sessions.
- 🔴 `research/docs/2026-01-31-claude-implementation-analysis.md` - Atomic Claude Code integration analysis, including `.claude` settings and configuration; useful for Claude Code comparison and config initialization.
- 🔴 `research/docs/2026-01-19-cli-auto-init-agent.md` - Older CLI auto-initialization research; directly related to startup/init behavior but likely superseded by March startup optimization and May pi extension docs.
- 🔴 `research/docs/2026-01-18-atomic-cli-implementation.md` - Initial Atomic CLI implementation overview; baseline startup/command structure context.

### Related Specs

- 🟢 `specs/2026-06-20-first-run-onboarding-workflow-routing.md` - Recent spec likely relevant to startup/onboarding routing and avoiding blocking first-run behavior.
- 🟡 `specs/2026-05-14-workflow-sdk-pi-subagents-api-parity.md` - Formal RFC for workflow SDK parity with pi-subagents; relevant to workflows, subagents, intercom routing, public API surface, and extension registration.
- 🟡 `specs/2026-05-14-workflow-sdk-fallback-models.md` - Workflow SDK fallback models; adjacent workflow/subagent orchestration behavior.
- 🟡 `specs/2026-05-11-pi-workflows-extension.md` - Formal pi-workflows extension design; highly relevant for extension loading, workflow registration, dependency on pi-subagents and pi-mcp-adapter, and public extension surfaces.
- 🟡 `specs/2026-05-08-workflow-pane-offload-and-resume.md` - Workflow pane offload/resume spec; relevant to workflow initialization and runtime startup.
- 🟡 `specs/2026-05-07-custom-workflows-settings-json.md` - Custom workflows settings spec; relevant to workflow discovery and lazy loading.
- 🟡 `specs/2026-05-06-sdk-self-contained-runworkflow.md` - SDK self-contained `runWorkflow` spec; relevant to public workflow APIs and preserving compatibility.
- 🔴 `specs/2026-03-25-workflow-interrupt-resume-session-preservation.md` - Workflow interrupt/resume session preservation; relevant to workflow lifecycle but aged.
- 🔴 `specs/2026-03-23-workflow-sdk-simplification-z3-verification.md` - Workflow SDK simplification spec; older workflow API design context.
- 🔴 `specs/2026-03-23-ralph-workflow-redesign.md` - Workflow redesign spec for Ralph; relevant to workflows/subagents but aged.
- 🔴 `specs/2026-03-02-bun-migration-startup-optimization.md` - Formal startup performance spec; directly tied to prior startup optimization research and likely the key implementation guide for Bun-native startup improvements.
- 🔴 `specs/2026-03-02-unified-workflow-execution.md` - Unified workflow execution spec; relevant to workflow startup/initialization.
- 🔴 `specs/2026-03-02-workflow-sdk-refactor.md` - Workflow SDK refactor spec; older API/design context.
- 🔴 `specs/2026-03-02-workflow-sdk-standardization.md` - Workflow SDK standardization spec; relevant to public API preservation.
- 🔴 `specs/2026-03-02-workflow-tui-rendering-unification.md` - Workflow TUI rendering unification; relevant to workflow UI initialization.
- 🔴 `specs/2026-02-21-workflow-sdk-inline-mode.md` - Workflow SDK inline mode spec; relevant to execution initialization.
- 🔴 `specs/2026-02-14-mcp-project-level-config-discovery-fix.md` - Formal MCP project-level config discovery fix; relevant to MCP startup discovery.
- 🔴 `specs/2026-02-09-mcp-support-and-discovery.md` - Foundational MCP support and discovery spec; potentially supersedes or formalizes `research/docs/2026-02-08-164-mcp-support-discovery.md`.
- 🔴 `specs/2026-02-07-mcp-tool-calling-opentui.md` - MCP tool calling OpenTUI spec; relevant to rendering lazy-discovered MCP tools.
- 🔴 `specs/2026-02-05-pluggable-workflows-sdk.md` - Pluggable workflows SDK spec; relevant to extension-style workflow loading.
- 🔴 `specs/2026-02-02-atomic-builtin-workflows-commands.md` - Built-in workflows commands spec; relevant to startup workflow registration.

### Related Discussions / Notes

No `research/notes/` directory was present in this checkout.

### Potentially Superseded Older Documents

- 🔴 `research/docs/2026-03-03-bun-migration-startup-optimization.md` is likely formalized/superseded by 🔴 `specs/2026-03-02-bun-migration-startup-optimization.md`, though both remain directly relevant.
- 🔴 `research/docs/2026-02-08-164-mcp-support-discovery.md` is likely formalized/superseded by 🔴 `specs/2026-02-09-mcp-support-and-discovery.md` and 🔴 `specs/2026-02-14-mcp-project-level-config-discovery-fix.md`.
- 🔴 `research/docs/2026-01-31-atomic-current-workflow-architecture.md` is likely superseded by 🟡 May 2026 pi-workflows / atomic-workflows documents.
- 🔴 `research/docs/2026-01-19-cli-auto-init-agent.md` and 🔴 `research/docs/2026-01-18-atomic-cli-implementation.md` are baseline historical references; newer startup/extension docs should be prioritized.

Total: 58 relevant documents found  
- 3 🟢 Recent  
- 18 🟡 Moderate  
- 37 🔴 Aged