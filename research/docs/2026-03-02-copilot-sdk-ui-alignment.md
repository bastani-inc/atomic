---
date: 2026-03-02 01:35:08 UTC
researcher: OpenCode
git_commit: 0206c8ce8fb735fdf355eb95a48dd18775136f86
branch: lavaman131/feature/workflow-sdk
repository: workflow-sdk
topic: "Research Copilot SDK UI features and alignment map for OpenCode and Claude Agent SDK UI"
tags:
    [
        research,
        codebase,
        copilot-sdk,
        opencode-sdk,
        claude-agent-sdk,
        opentui,
        ui-alignment,
    ]
status: complete
last_updated: 2026-03-02
last_updated_by: OpenCode
last_updated_note: "Added follow-up research documenting OpenCode auto-compaction chat-stall gap"
---

# Research

## Research Question

Research the Copilot SDK UI features in this codebase and document how the OpenCode and Claude Agent SDK UI surfaces align with them, including feature parity, interaction patterns, visual language, architecture, and SDK-specific constraints.

## Summary

The repository already uses a shared OpenTUI chat surface and a provider-normalized event pipeline for Copilot, OpenCode, and Claude. Copilot-specific behavior appears mainly at adapter and command-dispatch boundaries, while most UI rendering components (parts registry, task panel, model selector, status/footer, transcript, and parallel agents tree) are shared.

Alignment in the current codebase is expressed as: (1) unified UI primitives and event contracts, (2) provider-specific stream adapters that map SDK-native events to canonical `stream.*` bus events, and (3) targeted branch points where provider semantics differ (model switching session behavior, sub-agent invocation mechanics, and certain event constraints).

## Detailed Findings

### Copilot UI Feature Set (Current State)

- Chat runtime selects `CopilotStreamAdapter` at startup and routes it through shared `ChatApp`/event bus wiring ([`src/ui/index.ts:462`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/index.ts#L462), [`src/ui/index.ts:475`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/index.ts#L475)).
- Copilot adapter publishes normalized events (`stream.text.*`, `stream.thinking.*`, `stream.tool.*`, `stream.agent.*`, `stream.session.*`) to the shared bus ([`src/events/adapters/copilot-adapter.ts:98`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/copilot-adapter.ts#L98), [`src/events/adapters/copilot-adapter.ts:268`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/copilot-adapter.ts#L268)).
- Slash command UX and autocomplete are shared across providers (`/model`, `/agent`, `/skill`, workflows), rendered inline in chat ([`src/ui/chat.tsx:6877`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L6877), [`src/ui/commands/registry.ts:319`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/commands/registry.ts#L319), [`src/ui/commands/builtin-commands.ts:308`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/commands/builtin-commands.ts#L308)).
- Model selector dialog supports grouped providers, keyboard navigation, context window display, and optional reasoning effort selection ([`src/ui/components/model-selector-dialog.tsx:55`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/model-selector-dialog.tsx#L55), [`src/ui/components/model-selector-dialog.tsx:185`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/model-selector-dialog.tsx#L185)).
- Task panel and task indicator are persistent/session-linked via workflow task files ([`src/ui/components/task-list-panel.tsx:159`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/task-list-panel.tsx#L159), [`src/ui/commands/workflow-commands.ts:731`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/commands/workflow-commands.ts#L731)).
- Parallel agents tree and background-agent footer are rendered from the same shared components/state model ([`src/ui/components/parallel-agents-tree.tsx:743`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/parallel-agents-tree.tsx#L743), [`src/ui/components/background-agent-footer.tsx:17`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/background-agent-footer.tsx#L17)).

### OpenCode and Claude UI Feature Set (Current State)

- Startup chooses provider-specific adapters for OpenCode/Claude in the same runtime path ([`src/ui/index.ts:457`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/index.ts#L457), [`src/ui/index.ts:460`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/index.ts#L460)).
- OpenCode and Claude adapters emit the same canonical tool/thinking/agent/session events consumed by shared UI reducers ([`src/events/adapters/opencode-adapter.ts:822`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/opencode-adapter.ts#L822), [`src/events/adapters/claude-adapter.ts:560`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/claude-adapter.ts#L560), [`src/events/consumers/stream-pipeline-consumer.ts:151`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/consumers/stream-pipeline-consumer.ts#L151)).
- Sub-agent dispatch path differs by provider but shares command surface: OpenCode/Claude pass structured `agent` options; Copilot uses Task-tool instruction dispatch ([`src/ui/chat.tsx:4629`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L4629), [`src/ui/chat.tsx:4635`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L4635), [`src/ui/chat.tsx:4642`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L4642), [`src/ui/commands/agent-commands.ts:315`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/commands/agent-commands.ts#L315)).
- Model switching behavior is unified through `UnifiedModelOperations` with provider-specific internals (Claude supportedModels aliasing, OpenCode provider models, Copilot list/set through SDK client path) ([`src/models/model-operations.ts:143`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/models/model-operations.ts#L143), [`src/models/model-operations.ts:229`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/models/model-operations.ts#L229), [`src/models/model-operations.ts:270`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/models/model-operations.ts#L270)).
- Shared transcript rendering and parts-based message bubble rendering are provider-agnostic once events are normalized ([`src/ui/components/transcript-view.tsx:84`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/transcript-view.tsx#L84), [`src/ui/components/parts/registry.tsx:24`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/parts/registry.tsx#L24)).

### Alignment Map: Copilot vs OpenCode/Claude Surfaces

- **Rendering layer:** all three flow into the same part registry and stream reducer (`PART_REGISTRY`, `applyStreamPartEvent`) ([`src/ui/components/parts/registry.tsx:24`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/parts/registry.tsx#L24), [`src/ui/parts/stream-pipeline.ts:1063`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/parts/stream-pipeline.ts#L1063)).
- **Event contracts:** `SDKStreamAdapter` and event-coverage policy define cross-provider contract, with Copilot constraints on `message.delta` and `message.complete` mappings ([`src/events/adapters/types.ts:16`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/types.ts#L16), [`src/events/adapters/event-coverage-policy.ts:136`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/event-coverage-policy.ts#L136)).
- **Session lifecycle:** startup/session creation/interrupt/stream ownership are shared in `startChatUI`; adapters differ only at stream ingress ([`src/ui/index.ts:380`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/index.ts#L380), [`src/ui/index.ts:454`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/index.ts#L454), [`src/ui/index.ts:511`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/index.ts#L511)).
- **Sub-agent invocation semantics:** same user-level command shape, different provider transport semantics (`options.agent` vs Task tool instruction) ([`src/ui/chat.tsx:4627`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L4627), [`src/ui/commands/agent-commands.ts:327`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/commands/agent-commands.ts#L327)).
- **Config discovery surfaces:** unified command discovery scans `.claude`, `.opencode`, `.github` plus user/global variants; Copilot-specific manual loaders include `.github` and `~/.copilot` hierarchies ([`src/ui/commands/agent-commands.ts:34`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/commands/agent-commands.ts#L34), [`src/ui/commands/skill-commands.ts:56`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/commands/skill-commands.ts#L56), [`src/config/copilot-manual.ts:128`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/config/copilot-manual.ts#L128)).

### Visual Language and Interaction Grammar (Frontend Design Lens, Current Implementation)

- Theme system defines explicit semantic color tokens and dual palettes (Catppuccin Mocha/Latte), reused across UI components ([`src/ui/theme.tsx:20`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/theme.tsx#L20), [`src/ui/theme.tsx:215`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/theme.tsx#L215), [`src/ui/theme.tsx:247`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/theme.tsx#L247)).
- Interaction model is keyboard-first and consistent across surfaces (j/k arrows, enter, esc, number shortcuts, ctrl-modified global toggles) in model selector, autocomplete, transcript/task panel toggles ([`src/ui/components/model-selector-dialog.tsx:199`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/model-selector-dialog.tsx#L199), [`src/ui/chat.tsx:5881`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L5881), [`src/ui/chat.tsx:5702`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L5702)).
- Status language is compact and layered: footer status, queue indicator, task list indicator, background-agent footer, and loading/completion summaries ([`src/ui/components/footer-status.tsx:39`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/footer-status.tsx#L39), [`src/ui/components/queue-indicator.tsx:103`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/queue-indicator.tsx#L103), [`src/ui/components/task-list-indicator.tsx:52`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/task-list-indicator.tsx#L52)).
- Reasoning/thinking has dedicated visual treatment in stream parts and syntax dimming utilities, reused regardless of provider source ([`src/events/consumers/stream-pipeline-consumer.ts:138`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/consumers/stream-pipeline-consumer.ts#L138), [`src/ui/theme.tsx:549`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/theme.tsx#L549)).

### External Copilot SDK/CLI Documentation (UI-Relevant)

- Copilot SDK repository and docs: session lifecycle, streaming events, tool execution events, and language SDK examples.
    - https://github.com/github/copilot-sdk
    - https://github.com/github/copilot-sdk/blob/main/docs/getting-started.md
    - https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts
    - https://github.com/github/copilot-sdk/blob/main/nodejs/samples/chat.ts
- Copilot CLI docs: interactive mode, model selection, streaming toggle, resume/session controls, agent/skill command surfaces.
    - https://docs.github.com/en/copilot/reference/cli-command-reference
    - https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli
    - https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/configure-copilot-cli
- ACP server reference for custom terminal/IDE frontends.
    - https://docs.github.com/en/copilot/reference/acp-server

## Code References

- `src/ui/index.ts:230` - Unified model operation wiring (`sdkSetModel`) across provider clients.
- `src/ui/index.ts:457` - OpenCode stream adapter selection.
- `src/ui/index.ts:460` - Claude stream adapter selection.
- `src/ui/index.ts:462` - Copilot stream adapter selection.
- `src/ui/chat.tsx:4493` - Model selector apply path with reasoning effort and persisted preference.
- `src/ui/chat.tsx:4629` - OpenCode sub-agent dispatch semantics.
- `src/ui/chat.tsx:4635` - Claude sub-agent dispatch semantics.
- `src/ui/chat.tsx:4642` - Copilot Task-tool dispatch semantics.
- `src/ui/commands/agent-commands.ts:34` - Cross-provider agent discovery paths.
- `src/ui/commands/skill-commands.ts:56` - Cross-provider skill discovery paths.
- `src/config/copilot-manual.ts:128` - Copilot agent loading and precedence across `.github`, `.claude`, `.opencode`, and global paths.
- `src/models/model-operations.ts:143` - Provider switch for listAvailableModels.
- `src/events/adapters/types.ts:16` - Shared SDK stream adapter contract.
- `src/events/adapters/event-coverage-policy.ts:150` - Provider event-coverage policy matrix.
- `src/events/consumers/stream-pipeline-consumer.ts:128` - Canonical bus-event to stream-part mapping.
- `src/ui/components/parts/registry.tsx:24` - Shared part renderer registry used by all providers.
- `src/ui/theme.tsx:215` - Dark theme semantic token values.
- `src/ui/theme.tsx:247` - Light theme semantic token values.

## Architecture Documentation

The UI architecture is composed of four layers:

1. **Provider client + adapter ingress**
    - SDK clients expose provider-native session/event APIs.
    - Provider adapters (`opencode`, `claude`, `copilot`) normalize events into canonical bus events.

2. **Shared event infrastructure**
    - `EventBus` + `BatchDispatcher` + stream consumer wiring coalesce events and pass normalized batches to UI state handlers.

3. **Stream-part and state normalization**
    - Canonical events map to stream part events (`text-delta`, `tool-start`, `thinking-meta`, `agent-*`).
    - Reducers reconcile stream parts into message state.

4. **Provider-agnostic UI composition**
    - Shared rendering components: message bubble parts, transcript view, task panel, footer/status, model selector, parallel agents tree.
    - Provider distinctions remain at dispatch and model/session semantics boundaries.

## Historical Context (from research/)

- `research/docs/2026-02-12-sdk-ui-standardization-comprehensive.md` - Documents existing cross-SDK UI normalization strategy and known parity notes.
- `research/docs/2026-02-23-sdk-subagent-api-research.md` - Documents provider differences in sub-agent hierarchy identifiers and lifecycle event shape.
- `research/docs/2026-02-25-ui-workflow-coupling.md` - Documents coupling points between workflow runtime state and chat UI command/state surfaces.
- `research/docs/2026-02-26-streaming-architecture-event-bus-migration.md` - Documents stream primitive heterogeneity and event-bus unification model.
- `research/docs/2026-03-01-opencode-delegation-streaming-parity.md` - Documents delegation and continuation behavior differences across SDK paths.

## Related Research

- `research/docs/2026-01-31-github-copilot-sdk-research.md`
- `research/docs/2026-01-31-opencode-sdk-research.md`
- `research/docs/2026-01-31-claude-agent-sdk-research.md`
- `research/docs/2026-02-15-sub-agent-tree-status-lifecycle-sdk-parity.md`
- `research/docs/2026-03-01-opencode-tui-concurrency-bottlenecks.md`

## Open Questions

- Copilot event-coverage policy includes constrained mappings for `message.complete`; this document records the current mapping but does not trace every downstream UX implication in each workflow mode.
- Provider-specific model-switch semantics are documented in code paths; runtime behavior under every CLI/provider deployment mode (local vs remote/copilot ACP variants) is not exhaustively enumerated here.
- Existing research documents include multiple parity investigations; this report synthesizes the most relevant current-state findings and code references for UI alignment.

## Follow-up Research 2026-03-02 01:45:21 UTC

### Follow-up Question

Investigate why sub-agent UI behavior matches `docs/ui-design-patterns.md` for Copilot but appears to miss tool-call streaming and remains in initialization state for Claude/OpenCode.

### Findings

- Design-pattern expectation explicitly requires transition from initialization to execution with tool-use counts and current tool lines ([`docs/ui-design-patterns.md:46`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/docs/ui-design-patterns.md#L46), [`docs/ui-design-patterns.md:56`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/docs/ui-design-patterns.md#L56)).
- In current tree rendering, tool/text inline parts are globally suppressed; the tree shows progress via sub-status + current-tool line rather than raw tool blocks ([`src/ui/components/parallel-agents-tree.tsx:151`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/parallel-agents-tree.tsx#L151)).
- "Initializing" persists while an agent is running/pending and `toolUses` is `0`/`undefined`; execution text appears only when `toolUses > 0`, and current-tool line also requires `toolUses > 0` ([`src/ui/components/parallel-agents-tree.tsx:597`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/parallel-agents-tree.tsx#L597), [`src/ui/components/parallel-agents-tree.tsx:600`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/parallel-agents-tree.tsx#L600), [`src/ui/components/parallel-agents-tree.tsx:613`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/parallel-agents-tree.tsx#L613)).
- `toolUses/currentTool` display depends on `stream.agent.update` handling in chat subscriptions (side channel) rather than stream-part mapping ([`src/ui/chat.tsx:3452`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L3452), [`src/events/consumers/stream-pipeline-consumer.ts:242`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/consumers/stream-pipeline-consumer.ts#L242)).
- Sub-agent tool count increments are emitted by `SubagentToolTracker` (`toolCount += 1` on tool start) and published as `stream.agent.update` ([`src/events/adapters/subagent-tool-tracker.ts:64`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/subagent-tool-tracker.ts#L64), [`src/events/adapters/subagent-tool-tracker.ts:97`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/subagent-tool-tracker.ts#L97)).
- Copilot path includes parent-agent resolution via `parentId`/`parentToolCallId` plus early-tool buffering/replay keyed by subagent or tool call, then tracker updates ([`src/events/adapters/copilot-adapter.ts:610`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/copilot-adapter.ts#L610), [`src/events/adapters/copilot-adapter.ts:650`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/copilot-adapter.ts#L650), [`src/events/adapters/copilot-adapter.ts:919`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/copilot-adapter.ts#L919)).
- Claude path gates tool events by root session equality and requires parent-agent resolution + tracker registration for tool-count updates; unresolved early events are queued by agent/tool correlation keys ([`src/events/adapters/claude-adapter.ts:562`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/claude-adapter.ts#L562), [`src/events/adapters/claude-adapter.ts:590`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/claude-adapter.ts#L590), [`src/events/adapters/claude-adapter.ts:592`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/claude-adapter.ts#L592), [`src/events/adapters/claude-adapter.ts:1136`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/claude-adapter.ts#L1136)).
- OpenCode path gates updates by owned-session membership and parent-agent resolution from explicit parent IDs or discovered child-session mappings; ownership is established from `subagent.start` metadata (`subagentSessionId`) ([`src/events/adapters/opencode-adapter.ts:825`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/opencode-adapter.ts#L825), [`src/events/adapters/opencode-adapter.ts:936`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/opencode-adapter.ts#L936), [`src/events/adapters/opencode-adapter.ts:1013`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/opencode-adapter.ts#L1013), [`src/events/adapters/opencode-adapter.ts:1631`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/opencode-adapter.ts#L1631)).

### Follow-up Evidence Map

- UI state transition rule (Initializing -> tool-count execution): `src/ui/components/parallel-agents-tree.tsx:597`, `src/ui/components/parallel-agents-tree.tsx:600`, `src/ui/components/parallel-agents-tree.tsx:613`.
- Agent update channel location: `src/ui/chat.tsx:3452`, `src/events/consumers/stream-pipeline-consumer.ts:242`.
- Tracker increment source: `src/events/adapters/subagent-tool-tracker.ts:64`.
- Provider-specific conditions:
    - Copilot: `src/events/adapters/copilot-adapter.ts:610`, `src/events/adapters/copilot-adapter.ts:919`.
    - Claude: `src/events/adapters/claude-adapter.ts:562`, `src/events/adapters/claude-adapter.ts:590`, `src/events/adapters/claude-adapter.ts:1136`.
    - OpenCode: `src/events/adapters/opencode-adapter.ts:825`, `src/events/adapters/opencode-adapter.ts:1013`, `src/events/adapters/opencode-adapter.ts:1631`.

### Historical Context for This Follow-up

- `research/docs/2026-02-28-workflow-issues-research.md` documents the same initialization/tool-use dependency and split-channel update path (`:69`, `:87`, `:93`, `:107`).
- `research/docs/2026-03-01-opencode-delegation-streaming-parity.md` documents continued event-consumption gaps in streamed rendering paths (`:70`, `:71`).

## Follow-up Research 2026-03-02 01:55:41 UTC

### Follow-up Question

Investigate why, for OpenCode/Claude sub-agent trees, task descriptions can disappear after completion and display sub-agent names instead, and document edge cases for natural-language and `@`-symbol invocation paths.

### Findings

- The displayed row title uses `getAgentTaskLabel`, which returns `agent.name` whenever `agent.task` is considered generic (`""`, `"sub-agent task"`, `"subagent task"`) ([`src/ui/components/parallel-agents-tree.tsx:248`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/parallel-agents-tree.tsx#L248), [`src/ui/components/parallel-agents-tree.tsx:253`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/parallel-agents-tree.tsx#L253)).
- OpenCode emits repeated `subagent.start` events for the same logical sub-agent from multiple code paths (initial synthesis, child-session discovery, running-time relabel, completion-time relink, AgentPart/SubtaskPart merges) ([`src/sdk/clients/opencode.ts:1382`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.ts#L1382), [`src/sdk/clients/opencode.ts:1459`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.ts#L1459), [`src/sdk/clients/opencode.ts:1475`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.ts#L1475), [`src/sdk/clients/opencode.ts:1539`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.ts#L1539), [`src/sdk/clients/opencode.ts:1658`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.ts#L1658), [`src/sdk/clients/opencode.ts:1724`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.ts#L1724)).
- Task text normalization falls back to `agentType` when no `toolInput` description/prompt/task and no explicit event task exist; this creates non-descriptive task labels that match agent names ([`src/events/adapters/task-turn-normalization.ts:117`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/task-turn-normalization.ts#L117), [`src/events/adapters/task-turn-normalization.ts:123`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/task-turn-normalization.ts#L123)).
- Chat-side merge on repeated `stream.agent.start` updates active rows in place with `task: data.task || agent.task`; terminal rows (`completed/error/interrupted`) are removed and recreated. Both paths can replace previously visible labels when incoming start events carry fallback task text ([`src/ui/chat.tsx:3405`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L3405), [`src/ui/chat.tsx:3427`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L3427), [`src/ui/chat.tsx:3442`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L3442)).
- Deduplication keeps non-generic tasks when present, but if merged candidates both carry generic/fallback task text, final display still resolves to agent name ([`src/ui/components/parallel-agents-tree.tsx:323`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/parallel-agents-tree.tsx#L323), [`src/ui/components/parallel-agents-tree.tsx:337`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/parallel-agents-tree.tsx#L337), [`src/ui/components/parallel-agents-tree.tsx:591`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/components/parallel-agents-tree.tsx#L591)).
- Claude sub-agent starts rely on hook-derived task fields or a `task_started` cache; when neither yields descriptive text, normalized fallback behavior applies ([`src/sdk/clients/claude.ts:1252`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L1252), [`src/sdk/clients/claude.ts:1781`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L1781), [`src/events/adapters/claude-adapter.ts:1040`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/claude-adapter.ts#L1040)).

### Invocation Edge Cases (Natural Language and `@`)

- Submit-time agent mention execution only runs when the message starts with `@`; embedded/mid-sentence `@agent` text is not routed through the mention branch on normal submit ([`src/ui/chat.tsx:6550`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L6550)).
- Prefix `@agent` input uses `parseAtMentions` and executes one command per parsed mention with args segmented between mention tokens ([`src/ui/utils/mention-parsing.ts:58`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/utils/mention-parsing.ts#L58), [`src/ui/utils/mention-parsing.ts:76`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/utils/mention-parsing.ts#L76), [`src/ui/chat.tsx:6581`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L6581)).
- Autocomplete mention mode can execute an agent even for mid-text mentions by extracting `remaining = (before + after).trim()` and running `executeCommand` directly ([`src/ui/chat.tsx:6235`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L6235), [`src/ui/chat.tsx:6238`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L6238), [`src/ui/chat.tsx:6252`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L6252)).
- Natural-language (non-`@`) inputs go through normal `sendMessage` streaming and depend on SDK-generated sub-agent metadata for task labels, not explicit command args ([`src/ui/chat.tsx:6588`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L6588), [`src/ui/chat.tsx:6669`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L6669), [`src/ui/index.ts:475`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/index.ts#L475)).

### Relevant Existing Tests

- Adapter lifecycle and task/updates/completion coverage: `src/events/adapters/adapters.test.ts:2313`, `src/events/adapters/adapters.test.ts:2427`, `src/events/adapters/adapters.test.ts:2432`, `src/events/adapters/adapters.test.ts:2438`.
- OpenCode repeated synthesized starts and stable subagentType assertions: `src/sdk/clients/opencode.events.test.ts:2337`, `src/sdk/clients/opencode.events.test.ts:2431`, `src/sdk/clients/opencode.events.test.ts:2435`.
- Terminal-row replacement with new starts: `src/ui/subagent-tree-orphan-fix.test.ts:93`, `src/ui/subagent-tree-orphan-fix.test.ts:112`, `src/ui/subagent-tree-orphan-fix.test.ts:117`, `src/ui/subagent-tree-orphan-fix.test.ts:139`.
- Mention path single-assistant-message behavior: `src/ui/chat.at-command-single-assistant-message.test.ts:41`, `src/ui/chat.at-command-single-assistant-message.test.ts:62`.

## Follow-up Research 2026-03-02 02:07:35 UTC

### Follow-up Question

Investigate why task tool output is not propagated into the main chat response for `@` sub-agent invocations, especially in OpenCode and Claude SDK paths.

### Findings

- `@agent` execution routes through silent command dispatch (`executeCommand` -> `sendSilentMessage` -> `startAssistantStream`) rather than normal user message submission ([`src/ui/chat.tsx:6581`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L6581), [`src/ui/chat.tsx:4608`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L4608), [`src/ui/chat.tsx:3572`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L3572)).
- OpenCode `@agent` command marks streams as `isAgentOnlyStream: true`; Claude `@agent` command does not set this flag ([`src/ui/commands/agent-commands.ts:319`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/commands/agent-commands.ts#L319), [`src/ui/commands/agent-commands.ts:325`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/commands/agent-commands.ts#L325), [`src/ui/commands/registry.ts:39`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/commands/registry.ts#L39)).
- Agent-scoped text/tool events are routed into agent inline parts, not main assistant `message.content`; main content accumulation explicitly skips `agentId` deltas ([`src/ui/chat.tsx:2938`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L2938), [`src/ui/parts/stream-pipeline.ts:1070`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/parts/stream-pipeline.ts#L1070), [`src/ui/parts/stream-pipeline.ts:1150`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/parts/stream-pipeline.ts#L1150)).
- OpenCode agent-only finalization contains the only explicit promotion of sub-agent results into main message content, but it is gated: when `msg.toolCalls.length > 0`, content is left unchanged instead of replaced with aggregated agent results ([`src/ui/chat.tsx:4015`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L4015), [`src/ui/chat.tsx:4027`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L4027)).
- Claude non-agent-only completion path (`handleStreamComplete`) finalizes stream state/parts but does not copy `parallelAgents[].result` into main message content ([`src/ui/chat.tsx:2869`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L2869), [`src/ui/chat.tsx:2882`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L2882)).
- For both providers, `stream.agent.complete.result` is preserved on agent rows in tree state, but stream-part mapping intentionally omits `stream.agent.*` from the main part pipeline ([`src/ui/chat.tsx:3519`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L3519), [`src/events/consumers/stream-pipeline-consumer.ts:242`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/consumers/stream-pipeline-consumer.ts#L242)).
- Existing stream-pipeline tests assert that completed sub-agent results remain separate from main continuation text, matching this behavior ([`src/ui/parts/stream-pipeline.test.ts:814`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/parts/stream-pipeline.test.ts#L814), [`src/ui/parts/stream-pipeline.test.ts:859`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/parts/stream-pipeline.test.ts#L859)).

### Provider-Specific Emission Notes

- Claude: sub-agent completion result comes from task-notification summary path to `subagent.complete` and then adapter `stream.agent.complete` ([`src/sdk/clients/claude.ts:1273`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L1273), [`src/events/adapters/claude-adapter.ts:1110`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/claude-adapter.ts#L1110)).
- OpenCode: synthesized task-agent completion emits `result` from task tool output into `subagent.complete`, then adapter publishes `stream.agent.complete` ([`src/sdk/clients/opencode.ts:1547`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.ts#L1547), [`src/events/adapters/opencode-adapter.ts:989`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/opencode-adapter.ts#L989)).

### Related Test Coverage

- `@` command single assistant message creation: `src/ui/chat.at-command-single-assistant-message.test.ts:41`, `src/ui/chat.at-command-single-assistant-message.test.ts:62`.
- Agent-only finalization guard logic: `src/ui/chat.stream-lifecycle-run-guard.test.ts:47`, `src/ui/chat.stream-lifecycle-run-guard.test.ts:72`.
- Main-text vs subagent-result separation expectations: `src/ui/parts/stream-pipeline.test.ts:814`, `src/ui/parts/stream-pipeline.test.ts:929`.

## Follow-up Research 2026-03-02 02:15:07 UTC

### Follow-up Question

Investigate why Claude `@` sub-agent invocation does not show sub-agent tree entries and whether this path uses separate context/session isolation.

### Findings

- Claude `@agent` command path does pass the agent name through end-to-end into Claude SDK query options (`options.agent`) ([`src/ui/commands/agent-commands.ts:325`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/commands/agent-commands.ts#L325), [`src/ui/index.ts:479`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/index.ts#L479), [`src/events/adapters/claude-adapter.ts:304`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/claude-adapter.ts#L304), [`src/sdk/clients/claude.ts:794`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L794), [`src/sdk/clients/claude.stream-agent-option.test.ts:84`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.stream-agent-option.test.ts#L84)).
- Claude tree rows require `stream.agent.start`; `stream.agent.update` and `stream.agent.complete` only mutate existing rows and do not create new entries ([`src/ui/chat.tsx:3369`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L3369), [`src/ui/chat.tsx:3452`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L3452), [`src/ui/chat.tsx:3503`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L3503)).
- Claude client stream message mapping does not synthesize sub-agent lifecycle from stream chunks; `subagent.start`/`subagent.complete` are hook-driven pathways (`SubagentStart`/`SubagentStop`) ([`src/sdk/clients/claude.ts:114`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L114), [`src/sdk/clients/claude.ts:133`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L133), [`src/sdk/clients/claude.ts:1716`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L1716)).
- Adapter handler for Claude `subagent.start` filters by exact wrapped session match (`event.sessionId === this.sessionId`), so non-matching routed events are dropped before bus publish ([`src/events/adapters/claude-adapter.ts:1026`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/events/adapters/claude-adapter.ts#L1026)).
- Hook routing logic maps SDK `session_id` back to wrapped session IDs and can fall back to unresolved/ambiguous resolution paths; this is the path that determines whether sub-agent lifecycle events attach to the active UI session ([`src/sdk/clients/claude.ts:1451`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L1451), [`src/sdk/clients/claude.ts:1512`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L1512), [`src/sdk/clients/claude.ts:1821`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L1821)).

### Session/Context Behavior for Claude `@agent`

- `@agent` invocation uses the same wrapped Claude session stream path (`sendSilentMessage` -> `startAssistantStream` -> `handleStreamMessage`), not `createSubagentSession` ([`src/ui/chat.tsx:4608`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L4608), [`src/ui/chat.tsx:3572`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L3572), [`src/ui/index.ts:422`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/index.ts#L422)).
- Claude stream path resumes the same SDK session (`options.resume = sdkSessionId`) and applies `options.agent` per-turn; no new wrapped session is created for `@agent` dispatch ([`src/sdk/clients/claude.ts:789`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L789), [`src/sdk/clients/claude.ts:791`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L791), [`src/sdk/clients/claude.ts:794`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L794)).
- Context usage (`inputTokens`, `outputTokens`, `contextWindow`) is stored and reported from this same session state, so accounting is shared with the parent session flow ([`src/sdk/clients/claude.ts:1085`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L1085), [`src/sdk/clients/claude.ts:1086`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L1086), [`src/sdk/clients/claude.ts:1324`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/claude.ts#L1324)).
- The code path that explicitly creates isolated session contexts is `spawnSubagentParallel` via `createSubagentSession`, which is separate from `@agent` command dispatch ([`src/ui/chat.tsx:813`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L813), [`src/ui/chat.tsx:4667`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L4667), [`src/ui/chat.tsx:4728`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L4728)).

### Supporting SDK Documentation (repo docs)

- Claude SDK `Options.agent` is documented as "Agent name for the main thread" ([`docs/claude-agent-sdk.md:144`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/docs/claude-agent-sdk.md#L144)).
- Claude SDK `agents` option documents programmatic subagent definitions ([`docs/claude-agent-sdk.md:145`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/docs/claude-agent-sdk.md#L145)).

## Follow-up Research 2026-03-02 02:27:44 UTC

### Follow-up Question

Investigate reported OpenCode SDK behavior where auto-compaction freezes/stalls the chat TUI instead of cleanly resuming or finalizing the turn.

### Findings

- OpenCode stream auto-compaction is executed inline in the active stream loop (`await session.summarize()` in both proactive-threshold and overflow paths), so stream progress is serialized behind compaction completion ([`src/sdk/clients/opencode.ts:2607`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.ts#L2607), [`src/sdk/clients/opencode.ts:2638`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.ts#L2638)).
- `summarize()` has no abort-signal or timeout guard: it awaits SDK summarize then awaits `session.messages()` refresh before the stream loop can proceed, creating a stall point when either call hangs/slow-paths ([`src/sdk/clients/opencode.ts:2688`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.ts#L2688), [`src/sdk/clients/opencode.ts:2698`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.ts#L2698)); by contrast, prompt dispatch wires abort handling (`promptAsync(..., { signal })`) in stream/send paths ([`src/sdk/clients/opencode.ts:2231`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.ts#L2231), [`src/sdk/clients/opencode.ts:2487`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.ts#L2487)).
- Chat finalization still depends on `stream.session.idle` continuation gating and does not branch on compaction-specific idle reason (`context_compacted`), so a stalled/missed post-compaction terminal path leaves stream state active ([`src/ui/chat.tsx:3157`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L3157), [`src/ui/chat.tsx:3186`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L3186)).
- Continuation policy intentionally keeps loops alive on `tool-calls`/`unknown` finish reasons and any pending-work flags; when these flags are not cleared after compaction, `handleStreamComplete()` is skipped and chat remains in streaming/stalled mode ([`src/ui/utils/stream-continuation.ts:70`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/utils/stream-continuation.ts#L70), [`src/ui/utils/stream-continuation.ts:113`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/utils/stream-continuation.ts#L113), [`src/ui/chat.session-idle-flush.test.ts:180`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.session-idle-flush.test.ts#L180)).
- Queue dispatch is gated by `isStreaming`; once stream state is stuck, queued user turns do not dispatch, matching the observed “chat stalled/frozen” behavior at the TUI layer ([`src/ui/utils/stream-continuation.ts:236`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/utils/stream-continuation.ts#L236), [`src/ui/chat.tsx:2111`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/ui/chat.tsx#L2111)).
- Current OpenCode proactive-compaction test coverage confirms summarize invocation but does not assert end-to-end UI lifecycle recovery (stream finalization, queue unblocking, or post-compaction continuation), leaving this stall class unguarded ([`src/sdk/clients/opencode.events.test.ts:2543`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.events.test.ts#L2543), [`src/sdk/clients/opencode.events.test.ts:2634`](https://github.com/bastani/atomic/blob/0206c8ce8fb735fdf355eb95a48dd18775136f86/src/sdk/clients/opencode.events.test.ts#L2634)).

### Implementation Gap (Documented)

- The OpenCode auto-compaction path is missing a resilient completion contract for the chat runtime: compaction work is inline and blocking, but lifecycle completion/queue recovery still assumes timely terminal stream events. There is no compaction-specific watchdog/fallback to force safe stream finalization when compaction stalls or lifecycle events do not fully reconcile.
