I’m unable to write `/workspaces/atomic/progress.md` or `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-existing-research-locator.md` with the available read-only tools in this session. Below is the content intended for the requested output file.

```md
# Existing Research Locator: Transitive Usage/Cost, Subagents, Workflows, AgentSession Persistence, Footer/Status Bar, Slash Commands, Issue #1636

Current date: 2026-07-10

Search scope checked:
- `research/docs/`
- `research/subagents/`
- `research/designs/`
- `specs/`

Not present:
- `research/tickets/`
- `research/notes/`

## Related Tickets

No `research/tickets/` directory found.

## Related Research Documents

- 🟢 **Recent** `research/docs/2026-07-08-existing-research-locator.md` - Prior locator for context overflow/fallback research; includes workflow stage runner, lazy `AgentSession`, subagent parity, workflow SDK fallback model references.
- 🟡 **Moderate** `research/docs/2026-05-14-pi-subagents-api-parity-for-atomic-workflows.md` - Directly relevant to subagents/workflows; maps `pi-subagents` API, slash commands, session lifecycle hooks, and Atomic workflow tool parity.
- 🟡 **Moderate** `research/docs/2026-05-14-existing-workflows-research-locator.md` - Broad locator for Atomic workflows, Pi extensions, workflow tools, SDK API design, and subagent-inspired APIs.
- 🟡 **Moderate** `research/docs/2026-05-14-local-atomic-workflows-api-analysis.md` - Local workflow SDK/API analysis; relevant to `StageContext`, `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, stage runner behavior, and lazy `AgentSession` creation.
- 🟡 **Moderate** `research/docs/2026-05-14-local-atomic-workflows-locator.md` - Locator for workflow SDK/tool files including `stage-runner.ts`, foreground executor, extension wiring, and task/chain/parallel paths.
- 🟡 **Moderate** `research/docs/2026-05-14-local-workflow-patterns.md` - Local workflow patterns; relevant to workflow execution and subagent/workflow usage surfaces.
- 🟡 **Moderate** `research/docs/2026-05-12-extension-runs-workflows-test-surfaces.md` - Summarizes executable workflow runtime surfaces; mentions `createStageContext()` and lazy `AgentSession` creation in `stage-runner.ts`.
- 🟡 **Moderate** `research/docs/2026-05-12-workflow-authoring-registry-core.md` - Workflow authoring and registry core; relevant to workflow definitions, run context, and StageContext-like surfaces.
- 🟡 **Moderate** `research/docs/2026-05-11-pi-mcp-adapter-and-subagents.md` - Pi MCP adapter and subagents research; relevant to subagent integration surfaces.
- 🔴 **Aged** `research/docs/2026-03-25-workflow-interrupt-resume-bugs.md` - Workflow interrupt/resume bugs around session preservation, spinner, queued messages, and state persistence.
- 🔴 **Aged** `research/docs/2026-03-24-workflow-interrupt-stage-advancement-bug.md` - Workflow interrupt advances to next stage instead of staying on current stage; relevant to workflow session persistence/control flow.
- 🔴 **Aged** `research/docs/2026-03-20-ralph-workflow-redesign-analysis.md` - Ralph session-based prompt-chained workflow redesign analysis; relevant to workflow orchestration/session structure.
- 🔴 **Aged** `research/docs/2026-03-18-ralph-eager-dispatch-research.md` - Ralph eager sub-agent dispatch requirements; relevant to subagent/workflow fanout behavior.
- 🔴 **Aged** `research/docs/2026-03-13-copilot-foreground-subagent-premature-completion.md` - Copilot foreground sub-agent premature completion; relevant to subagent lifecycle/status reporting.
- 🔴 **Aged** `research/docs/2026-03-08-claude-subagent-tree-tool-call-streaming.md` - Claude subagent tree/tool-call streaming; relevant to subagent status trees.
- 🔴 **Aged** `research/docs/2026-03-06-copilot-sdk-session-events-schema-reference.md` - Copilot SDK session events schema; relevant to AgentSession/session event accounting.
- 🔴 **Aged** `research/docs/2026-03-06-claude-agent-sdk-event-schema.md` - Claude Agent SDK event schema reference; relevant to AgentSession and usage/event surfaces.
- 🔴 **Aged** `research/docs/2026-03-05-claude-at-subagent-streaming-done-state-ordering.md` - Claude `@` subagent streaming done-state ordering; relevant to subagent lifecycle/status correctness.
- 🔴 **Aged** `research/docs/2026-02-28-workflow-issues-research.md` - Workflow issues covering sub-agent tree streaming, code-review timing, and parallel task execution.
- 🔴 **Aged** `research/docs/2026-02-28-workflow-gaps-architecture.md` - Workflow gap architecture; relevant to workflow runtime, subagent execution, and UI rendering gaps.
- 🔴 **Aged** `research/docs/2026-02-27-workflow-tui-rendering-unification.md` - Workflow TUI rendering unification; relevant to workflow status display and UI integration.
- 🔴 **Aged** `research/docs/2026-02-25-workflow-sdk-standardization.md` - Workflow SDK standardization across graph engine, Ralph, sub-agents, state, and declarative API.
- 🔴 **Aged** `research/docs/2026-02-25-workflow-sdk-refactor-research.md` - Workflow SDK refactor and simplified syntax; relevant to workflow execution architecture.
- 🔴 **Aged** `research/docs/2026-02-25-workflow-sdk-patterns.md` - Workflow SDK usage patterns and examples.
- 🔴 **Aged** `research/docs/2026-02-25-workflow-sdk-design.md` - Workflow SDK public API design; referenced by later offload/resume spec as documenting per-stage persisted state.
- 🔴 **Aged** `research/docs/2026-02-25-ui-workflow-coupling.md` - UI/workflow coupling technical documentation; relevant to workflow status rendering.
- 🔴 **Aged** `research/docs/2026-02-23-sdk-subagent-api-research.md` - Sub-agent/background agent API research.
- 🔴 **Aged** `research/docs/2026-02-21-workflow-sdk-inline-mode-research.md` - Workflow SDK inline mode, visual indicators, and Ralph task persistence.
- 🔴 **Aged** `research/docs/2026-02-17-command-history-persistence-tui.md` - Command history persistence in TUI; adjacent to slash command/session UI persistence.
- 🔴 **Aged** `research/docs/2026-02-16-sub-agent-tree-inline-state-lifecycle-research.md` - Sub-agent tree inline state lifecycle research.
- 🔴 **Aged** `research/docs/2026-02-15-sub-agent-tree-status-lifecycle-sdk-parity.md` - Sub-agent tree status lifecycle and SDK parity.
- 🔴 **Aged** `research/docs/2026-02-15-subagent-event-flow-diagram.md` - Subagent event flow diagram; useful for lineage/status propagation.
- 🔴 **Aged** `research/docs/2026-02-14-subagent-output-propagation-issue.md` - Subagent output propagation issue.
- 🔴 **Aged** `research/docs/2026-02-13-emoji-unicode-icon-usage-catalog.md` - Icon/emoji usage catalog; only lightly relevant via status/footer UI symbols.
- 🔴 **Aged** `research/docs/2026-02-12-sub-agent-sdk-integration-analysis.md` - Sub-agent SDK integration analysis for built-in commands and custom sub-agent hookup.
- 🔴 **Aged** `research/docs/2026-02-12-sdk-ui-standardization-research.md` - SDK UI standardization research; relevant to footer/status bar and unified UI across agents.
- 🔴 **Aged** `research/docs/2026-02-12-sdk-ui-standardization-comprehensive.md` - Comprehensive SDK UI standardization; relevant to footer/status UI.
- 🔴 **Aged** `research/docs/2026-02-11-workflow-sdk-implementation.md` - Workflow SDK implementation with custom tools, sub-agents, graph execution, context monitoring, and retries.
- 🔴 **Aged** `research/docs/2026-02-05-subagent-ui-opentui-independent-context.md` - Subagent UI with OpenTUI independent context.
- 🔴 **Aged** `research/docs/2026-02-03-command-migration-notes.md` - Command migration notes; relevant to slash command implementation history.
- 🔴 **Aged** `research/docs/2026-02-02-atomic-builtin-workflows-research.md` - Atomic built-in workflows and commands research.
- 🔴 **Aged** `research/docs/2026-02-01-claude-code-ui-patterns-for-atomic.md` - Claude Code UI patterns for Atomic; includes slash command autocomplete, footer status line, and WorkflowStatusBar concepts.
- 🔴 **Aged** `research/docs/2026-01-31-atomic-current-workflow-architecture.md` - Atomic current workflow architecture; includes workflow UI/status bar references.
- 🔴 **Aged** `research/docs/2026-01-31-sdk-migration-and-graph-execution.md` - SDK migration and graph execution pattern design; relevant to AgentSession, workflow graph execution, session persistence, and telemetry.
- 🔴 **Aged** `research/docs/2026-01-31-claude-agent-sdk-research.md` - Claude Agent SDK research; relevant to AgentSession/session resume surfaces.
- 🔴 **Aged** `research/docs/2026-01-31-github-copilot-sdk-research.md` - GitHub Copilot SDK research; relevant to session events and usage surfaces.
- 🔴 **Aged** `research/docs/2026-01-31-opencode-sdk-research.md` - OpenCode SDK research; relevant to session/events and usage/cost metadata.
- 🔴 **Aged** `research/docs/2026-01-19-slash-commands.md` - Early slash command research.

## Related Specs

- 🟢 **Recent** `specs/2026-07-10-transitive-cost-status-bar.md` - Primary RFC for issue #1636; explicitly covers transitive cost in status bar, subagents/sub-subagents/workflow stages, `getTransitiveUsage()`, `/cost`, `/context`, and additive/no-breaking-changes posture.
- 🟡 **Moderate** `specs/2026-06-20-first-run-onboarding-workflow-routing.md` - Workflow routing spec; tangentially relevant to workflows/slash-style command routing.
- 🟡 **Moderate** `specs/2026-06-13-fix-issue-1353-workflow-overlay-focus.md` - Workflow overlay focus fix; relevant to workflow UI/status behavior.
- 🟡 **Moderate** `specs/2026-06-10-publish-release-workflow.md` - Release workflow spec; relevant only as workflow infrastructure reference.
- 🟡 **Moderate** `specs/2026-06-07-release-docs-workflow.md` - Release docs workflow spec; relevant only as workflow infrastructure reference.
- 🟡 **Moderate** `specs/2026-05-28-fix-issue-1087-builtin-skill-definitions-in-bastani-subagents-are-discovered-in.md` - Builtin skill discovery in subagents; relevant to subagent discovery.
- 🟡 **Moderate** `specs/2026-05-14-workflow-sdk-pi-subagents-api-parity.md` - Formal API parity spec for workflow direct execution and Pi subagents.
- 🟡 **Moderate** `specs/2026-05-14-workflow-sdk-fallback-models.md` - Workflow SDK fallback models; relevant to workflow stage runner and model/provider behavior.
- 🟡 **Moderate** `specs/2026-05-11-pi-workflows-extension.md` - Pi workflows extension technical design; relevant to workflows and extension integration.
- 🟡 **Moderate** `specs/2026-05-08-workflow-pane-offload-and-resume.md` - Workflow pane offload/resume; directly relevant to session persistence, per-stage metadata, native session IDs, and status/footer behavior.
- 🟡 **Moderate** `specs/2026-05-07-custom-workflows-settings-json.md` - Custom workflows via Atomic settings; relevant to workflow discovery/routing.
- 🟡 **Moderate** `specs/2026-05-06-sdk-self-contained-runworkflow.md` - Self-contained `runWorkflow()` SDK API design; relevant to workflow execution/session boundaries.
- 🔴 **Aged** `specs/2026-03-25-workflow-interrupt-resume-session-preservation.md` - Formal session preservation spec for workflow interrupt/resume.
- 🔴 **Aged** `specs/2026-03-25-workflow-interrupt-stage-advancement-fix.md` - Workflow interrupt/stage advancement fix.
- 🔴 **Aged** `specs/2026-03-23-ralph-workflow-redesign.md` - Ralph session-based prompt-chained workflow architecture.
- 🔴 **Aged** `specs/2026-03-18-ralph-eager-dispatch.md` - Ralph eager sub-agent dispatch.
- 🔴 **Aged** `specs/2026-03-18-event-bus-callback-elimination-sdk-event-types.md` - EventBus callback elimination and SDK event type catalog; relevant to session/subagent event accounting.
- 🔴 **Aged** `specs/2026-03-02-at-command-duplicate-subagent-tree-fix.md` - `@` command duplicate subagent tree fix.
- 🔴 **Aged** `specs/2026-03-02-unified-workflow-execution.md` - Unified workflow execution interface.
- 🔴 **Aged** `specs/2026-03-02-workflow-gaps-remediation.md` - Workflow gaps remediation.
- 🔴 **Aged** `specs/2026-03-02-workflow-issues-fixes.md` - Workflow issue fixes.
- 🔴 **Aged** `specs/2026-03-02-workflow-sdk-refactor.md` - Workflow SDK simplified syntax and module consolidation.
- 🔴 **Aged** `specs/2026-03-02-workflow-sdk-standardization.md` - Workflow SDK standardization.
- 🔴 **Aged** `specs/2026-03-02-workflow-tui-rendering-unification.md` - Workflow TUI rendering unification.
- 🔴 **Aged** `specs/2026-03-02-workflow-tui-rendering-unification-refactor.md` - Workflow TUI rendering unification refactor.
- 🔴 **Aged** `specs/2026-03-02-opencode-delegation-streaming-parity.md` - OpenCode delegation/streaming parity; relevant to subagent/workflow event propagation.
- 🔴 **Aged** `specs/2026-02-22-background-agents-sdk-pipeline-fix.md` - Background agents SDK pipeline fix.
- 🔴 **Aged** `specs/2026-02-21-workflow-sdk-inline-mode.md` - Workflow SDK inline mode and visual mode indicators.
- 🔴 **Aged** `specs/2026-02-20-sdk-v2-first-unified-layer.md` - SDK v2-first unified layer.
- 🔴 **Aged** `specs/2026-02-16-ralph-dag-orchestration.md` - Ralph DAG orchestration.
- 🔴 **Aged** `specs/2026-02-14-subagent-output-propagation-fix.md` - Formal fix for subagent output propagation.
- 🔴 **Aged** `specs/2026-02-12-sdk-ui-standardization.md` - SDK UI standardization; includes footer status, permission mode footer, subagent UI mapping.
- 🔴 **Aged** `specs/2026-02-11-workflow-sdk-implementation.md` - Workflow SDK implementation spec; covers custom tools, sub-agents, graph execution, session/checkpoint concepts.
- 🔴 **Aged** `specs/2026-02-09-markdown-rendering-tui.md` - TUI markdown rendering; includes status bar indicator concepts.
- 🔴 **Aged** `specs/2026-02-09-skill-loading-from-configs-and-ui.md` - Skill loading and UI; includes status bar/inline UI alternatives.
- 🔴 **Aged** `specs/2026-02-05-subagent-ui-independent-context.md` - Subagent UI independent context.
- 🔴 **Aged** `specs/2026-02-02-atomic-builtin-workflows-commands.md` - Atomic builtin workflows/commands.
- 🔴 **Aged** `specs/2026-02-01-chat-tui-parity-implementation.md` - Chat TUI parity implementation; includes WorkflowStatusBar.
- 🔴 **Aged** `specs/2026-02-01-claude-code-ui-patterns-enhancement.md` - Claude Code UI pattern enhancement; includes FooterStatus and slash command/autocomplete adjacent UI work.
- 🔴 **Aged** `specs/2026-01-31-tui-command-autocomplete-system.md` - TUI command autocomplete system; includes slash command autocomplete and proposed WorkflowStatusBar.
- 🔴 **Aged** `specs/2026-01-31-sdk-migration-and-graph-execution.md` - SDK migration and graph execution; discusses `CodingAgentSession`, `resumeSession`, checkpointing, subagents, telemetry, and session persistence.
- 🔴 **Aged** `specs/2026-01-21-anonymous-telemetry-implementation.md` - Telemetry implementation; includes `AgentSessionEvent` and local buffering/persistence; relevant to usage/event accounting background.

## Related Discussions / Notes

No `research/notes/` directory found.

## Other Relevant Research Areas

- `research/subagents/` exists but currently contains issue-1445 documents only:
  - `research/subagents/issue-1445-prior-research.md`
  - `research/subagents/issue-1445-current-split-plan-iteration-2.md`
  - `research/subagents/issue-1445-review-findings-iteration-2.md`
  - These appear specific to issue #1445 split/checker work and were not directly relevant to issue #1636/transitive cost except by directory theme.

## Highest-Signal Documents

1. 🟢 `specs/2026-07-10-transitive-cost-status-bar.md` - Primary issue #1636 RFC; most directly relevant.
2. 🟡 `specs/2026-05-08-workflow-pane-offload-and-resume.md` - Best existing session-persistence/offload/resume reference.
3. 🟡 `research/docs/2026-05-14-pi-subagents-api-parity-for-atomic-workflows.md` - Best subagents/workflow API parity research.
4. 🟡 `research/docs/2026-05-14-local-atomic-workflows-api-analysis.md` - Best local workflow/stage runner/AgentSession analysis.
5. 🔴 `specs/2026-01-31-sdk-migration-and-graph-execution.md` - Older but broadest session/checkpointing/subagents/telemetry design reference.
6. 🔴 `research/docs/2026-02-01-claude-code-ui-patterns-for-atomic.md` and 🔴 `specs/2026-02-01-claude-code-ui-patterns-enhancement.md` - Best footer/status bar UI history.

## Summary

Total: 69 relevant documents found.

Tier counts:
- 2 🟢 Recent
- 13 🟡 Moderate
- 54 🔴 Aged

Notes:
- `specs/2026-07-10-transitive-cost-status-bar.md` directly references GitHub issue #1636 and should be treated as the primary current design.
- Many workflow/subagent documents from February–March are aged and may be superseded by the May workflow/Pi documents and the July #1636 RFC.
- No research tickets or notes directories were present in this checkout.
`` Ма
