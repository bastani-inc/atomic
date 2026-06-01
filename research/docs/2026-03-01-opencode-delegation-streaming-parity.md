---
date: 2026-03-01 09:59:48 UTC
researcher: OpenCode (gpt-5.3-codex)
git_commit: ede4debeb208749489229f9c2b703ed2aa940996
branch: lavaman131/feature/workflow-sdk
repository: workflow-sdk
topic: "OpenCode background-task delegation and streaming parity research for workflow-sdk TUI"
tags: [research, codebase, opencode, streaming, delegation, subagents, tui]
status: complete
last_updated: 2026-03-01
last_updated_by: OpenCode (gpt-5.3-codex)
---

# Research

## Research Question

Research the OpenCode codebase to understand how it delegates messages back to the main agent for background tasks/agents, then map the current TUI architecture in `workflow-sdk` against that design and identify concrete parity gaps in the current streaming architecture.

## Summary

OpenCode implements delegation as a first-class runtime loop behavior: a `task` tool creates or resumes a child session, wraps the child result in a stable `task_id` + `<task_result>` envelope, persists tool completion in session message parts, and then continues the parent loop by rebuilding model input from persisted tool results. The event stream is backed by typed bus events and SSE delivery (`/event`, `/global/event`) with explicit message-part delta/update semantics.

The current `workflow-sdk` TUI has a strong event-driven UI pipeline (adapters -> bus -> batch dispatcher -> correlation -> stream-part reducer -> render), plus background/sub-agent orchestration, but delegated outputs are primarily reconciled into UI state/messages rather than fed through a canonical parent-loop tool-result envelope equivalent to OpenCode’s `task` semantics. The architecture also has documented consumption gaps in the event pipeline (notably unconsumed event types and workflow events dropped before part mapping), which creates parity differences with OpenCode’s end-to-end streaming engine behavior.

## Detailed Findings

### OpenCode: Delegation Back to Main Agent Loop

- **Delegation trigger + tool path:** `TaskTool` is part of the standard tool registry and is executed from the processor tool-call flow (`packages/opencode/src/tool/registry.ts:112`, `packages/opencode/src/session/processor.ts:134`) ([registry](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/tool/registry.ts#L112), [processor](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/session/processor.ts#L134)).
- **Child session lifecycle:** task execution resumes an existing child by `task_id` or creates a new session with `parentID` set to parent session (`packages/opencode/src/tool/task.ts:67`, `packages/opencode/src/tool/task.ts:73`) ([task.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/tool/task.ts#L67), [task.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/tool/task.ts#L73)).
- **Delegated result envelope:** child output is returned to parent as `task_id` plus `<task_result>...</task_result>` (`packages/opencode/src/tool/task.ts:148`, `packages/opencode/src/tool/task.ts:150`) ([task.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/tool/task.ts#L148), [task.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/tool/task.ts#L150)).
- **Parent ingestion model:** loop continuation is tied to finish reason; when assistant finish is `tool-calls`, loop continues and regenerates model input from session history including tool outputs (`packages/opencode/src/session/prompt.ts:319`, `packages/opencode/src/session/prompt.ts:664`) ([prompt.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/session/prompt.ts#L319), [prompt.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/session/prompt.ts#L664)).
- **Tool-result reconciliation into model messages:** completed tool parts are transformed into model-message tool outputs via `toModelMessages` / `convertToModelMessages` (`packages/opencode/src/session/message-v2.ts:617`, `packages/opencode/src/session/message-v2.ts:705`) ([message-v2.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/session/message-v2.ts#L617), [message-v2.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/session/message-v2.ts#L705)).

### OpenCode: Streaming Engine Characteristics

- **Typed event model + envelope:** bus publishes typed payloads and forwards global envelope `{ directory, payload }` for stream consumers (`packages/opencode/src/bus/index.ts:45`, `packages/opencode/src/bus/index.ts:47`) ([bus/index.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/bus/index.ts#L45)).
- **SSE-first transport:** server exposes event streams and forwards bus updates (`packages/opencode/src/server/server.ts`, `packages/opencode/src/server/routes/global.ts`) ([server.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/server/server.ts), [global.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/server/routes/global.ts)).
- **Message-part level deltas/updates:** `message.part.updated` and `message.part.delta` are core runtime signals used by clients (`packages/opencode/src/session/message-v2.ts:460`, `packages/opencode/src/session/message-v2.ts:466`) ([message-v2.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/session/message-v2.ts#L460), [message-v2.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/session/message-v2.ts#L466)).
- **Client reconciliation path:** app/TUI layers subscribe to stream events and reconcile deltas + updates into normalized state (`packages/app/src/context/global-sync/event-reducer.ts`, `packages/opencode/src/cli/cmd/tui/context/sync.tsx`) ([event-reducer.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/app/src/context/global-sync/event-reducer.ts), [sync.tsx](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/cli/cmd/tui/context/sync.tsx)).

### workflow-sdk: Current Delegation + Streaming Implementation

- **Streaming entry + adapters:** TUI dispatches through `startChatUI`/`handleStreamMessage` and routes provider-specific streams into normalized bus events (`src/ui/index.ts:422`, `src/events/adapters/types.ts:15`) ([index.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/ui/index.ts#L422), [types.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/events/adapters/types.ts#L15)).
- **Bus + batching pipeline:** events flow through `AtomicEventBus`, `BatchDispatcher`, correlation, and stream-part consumer (`src/events/event-bus.ts:139`, `src/events/batch-dispatcher.ts:137`, `src/events/consumers/wire-consumers.ts:71`) ([event-bus.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/events/event-bus.ts#L139), [batch-dispatcher.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/events/batch-dispatcher.ts#L137), [wire-consumers.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/events/consumers/wire-consumers.ts#L71)).
- **Background/sub-agent streams:** parallel sub-agents run via isolated sessions and `SubagentStreamAdapter` emits `stream.agent.*` and scoped tool/text/thinking signals (`src/ui/chat.tsx:4552`, `src/events/adapters/subagent-adapter.ts:112`) ([chat.tsx](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/ui/chat.tsx#L4552), [subagent-adapter.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/events/adapters/subagent-adapter.ts#L112)).
- **Parent-side result handling:** child outputs are accumulated and merged into UI message state/parts (`src/events/adapters/subagent-adapter.ts:542`, `src/ui/chat.tsx:3906`) ([subagent-adapter.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/events/adapters/subagent-adapter.ts#L542), [chat.tsx](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/ui/chat.tsx#L3906)).
- **Loop continuation behavior:** stream continuation decisions are status/guard-driven rather than finish-reason (`tool-calls`) driven (`src/ui/parts/guards.ts:42`, `src/ui/utils/stream-continuation.ts:133`) ([guards.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/ui/parts/guards.ts#L42), [stream-continuation.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/ui/utils/stream-continuation.ts#L133)).

### Stage-by-Stage Parity Gaps (Current-State Comparison)

#### 1) Delegation trigger and lifecycle identity

- **OpenCode:** canonical `task` tool call lifecycle with resumable `task_id` (`packages/opencode/src/tool/task.ts:67`, `packages/opencode/src/tool/task.ts:148`) ([task.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/tool/task.ts#L67)).
- **workflow-sdk:** no equivalent runtime `task_id` token contract in `src/`; delegated identity uses provider-specific IDs (`tool_use_id`, `toolCallId`, `subagentId`) and session resume hooks (`src/sdk/clients/claude.ts:1211`, `src/events/adapters/copilot-adapter.ts:576`, `src/sdk/clients/opencode.ts:1661`) ([claude.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/sdk/clients/claude.ts#L1211), [copilot-adapter.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/events/adapters/copilot-adapter.ts#L576), [opencode.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/sdk/clients/opencode.ts#L1661)).
- **Gap:** no single, provider-agnostic `task_id` resume envelope equivalent.

#### 2) Child-parent session model

- **OpenCode:** child sessions are created with explicit `parentID` in core session model (`packages/opencode/src/tool/task.ts:73`, `packages/opencode/src/session/index.ts:645`) ([task.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/tool/task.ts#L73), [session/index.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/session/index.ts#L645)).
- **workflow-sdk:** OpenCode client includes child-parent mapping in adapter/client state (`src/sdk/clients/opencode.ts:485`, `src/sdk/clients/opencode.ts:1073`), but this is not a cross-provider core runtime session primitive ([opencode.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/sdk/clients/opencode.ts#L485), [opencode.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/sdk/clients/opencode.ts#L1073)).
- **Gap:** parent-child linkage exists, but parity is adapter-scoped rather than engine-core.

#### 3) Delegated output envelope back to parent loop

- **OpenCode:** explicit parent-facing `<task_result>` envelope (`packages/opencode/src/tool/task.ts:150`) ([task.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/tool/task.ts#L150)).
- **workflow-sdk:** no `<task_result>` equivalent in runtime source; delegated result is propagated through stream events and UI state composition (`src/events/adapters/subagent-adapter.ts:542`, `src/ui/chat.tsx:3906`) ([subagent-adapter.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/events/adapters/subagent-adapter.ts#L542), [chat.tsx](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/ui/chat.tsx#L3906)).
- **Gap:** no canonical text envelope contract carrying delegated result + resume handle.

#### 4) Parent-loop ingestion semantics

- **OpenCode:** loop continuation is finish-reason aware and rehydrates model input from persisted tool-result parts (`packages/opencode/src/session/prompt.ts:319`, `packages/opencode/src/session/message-v2.ts:705`) ([prompt.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/session/prompt.ts#L319), [message-v2.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/session/message-v2.ts#L705)).
- **workflow-sdk:** stream completion/continuation is managed by UI/tool status guards and callbacks (`src/ui/chat.tsx:2585`, `src/ui/parts/guards.ts:42`) ([chat.tsx](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/ui/chat.tsx#L2585), [guards.ts](https://github.com/bastani-inc/atomic/blob/ede4debeb208749489229f9c2b703ed2aa940996/src/ui/parts/guards.ts#L42)).
- **Gap:** no OpenCode-equivalent parent loop that consumes delegated outputs as canonical model-history tool results.

#### 5) Streaming event completeness and reconciliation

- **OpenCode:** streaming is centered around message-part delta/update events consumed by sync reducers (`packages/opencode/src/session/message-v2.ts:460`, `packages/app/src/context/global-sync/event-reducer.ts`) ([message-v2.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/opencode/src/session/message-v2.ts#L460), [event-reducer.ts](https://github.com/anomalyco/opencode/blob/38704acacddad821d157d9a2c093e3751e016f53/packages/app/src/context/global-sync/event-reducer.ts)).
- **workflow-sdk:** event architecture is broad and typed, but documented analysis shows events emitted yet not consumed in current stream consumer path (`research/docs/2026-02-28-workflow-gaps-architecture.md:343`, `research/docs/2026-02-28-workflow-gaps-architecture.md:320`).
- **Gap:** parity difference in end-to-end stream completeness; some emitted events do not reach rendered part state in current workflow-sdk architecture.

#### 6) Workflow-specific stream mapping coverage

- **OpenCode:** message-part lifecycle events are directly represented in sync state.
- **workflow-sdk:** workflow adapters publish workflow step/task updates, while current consumer mapping coverage is narrower and can drop events before part conversion (`src/events/adapters/workflow-adapter.ts:110`, `src/events/consumers/stream-pipeline-consumer.ts:192`, with historical gap documentation in `research/docs/2026-02-28-workflow-gaps-architecture.md:372`).
- **Gap:** current workflow event mapping and part registry coverage do not fully mirror OpenCode’s message-part-centric reconciliation path.

## Code References

- `packages/opencode/src/tool/task.ts:67` - Resume existing child session by `task_id`.
- `packages/opencode/src/tool/task.ts:73` - Create child session with `parentID`.
- `packages/opencode/src/tool/task.ts:150` - Wrap delegated output in `<task_result>` envelope.
- `packages/opencode/src/session/prompt.ts:319` - Continue parent loop when finish reason is `tool-calls`.
- `packages/opencode/src/session/message-v2.ts:705` - Convert persisted message/tool parts to model messages.
- `packages/opencode/src/bus/index.ts:45` - Publish typed payload and global envelope.
- `packages/opencode/src/server/routes/global.ts` - SSE stream endpoint for global events.
- `src/ui/index.ts:422` - workflow-sdk stream ingress (`handleStreamMessage`).
- `src/events/event-bus.ts:139` - Event schema validation and dispatch.
- `src/events/batch-dispatcher.ts:137` - Frame-batched dispatcher flush scheduling.
- `src/events/adapters/subagent-adapter.ts:112` - Sub-agent stream lifecycle events (`stream.agent.start`).
- `src/events/adapters/subagent-adapter.ts:542` - Child output accumulation for delegated stream.
- `src/ui/chat.tsx:3906` - Merge delegated/parallel results into message state.
- `src/ui/parts/guards.ts:42` - Guard-based continuation/finalization logic.
- `research/docs/2026-02-28-workflow-gaps-architecture.md:343` - Historical inventory of emitted-but-unconsumed events.

## Architecture Documentation

The two systems share an event-driven design, but the architectural center differs:

- **OpenCode center:** session runtime + persisted message parts + tool-call loop continuation; delegated child outputs are normalized into parent model history before the next generation step.
- **workflow-sdk center:** adapter-normalized event bus + UI stream-part reducers; delegated child outputs are primarily reconciled in UI-layer message/parts and provider-specific correlation state.

This is why both can render rich parallel-agent streams, while only OpenCode shows a single canonical delegation contract (`task_id` + `<task_result>`) directly tied to the parent generation loop semantics.

## Historical Context (from research/)

- `research/docs/2026-02-26-opencode-event-bus-patterns.md` - Documents OpenCode global bus, SSE distribution, and batching/coalescing model.
- `research/docs/2026-02-23-258-background-agents-sdk-event-pipeline.md` - Documents workflow-sdk background-agent pipeline stages and provider-specific correlation behavior.
- `research/docs/2026-02-28-workflow-gaps-architecture.md` - Documents current event-consumption and part-registry gaps in workflow-sdk stream architecture.
- `research/workflow-gaps.md` - Compact gap inventory used as supplemental historical context.

## Related Research

- `research/docs/2026-02-26-streaming-architecture-event-bus-migration.md`
- `research/docs/2026-02-26-streaming-event-bus-spec-audit.md`
- `research/docs/2026-02-28-workflow-tui-rendering-unification-refactor.md`
- `research/docs/2026-02-16-opencode-tui-chat-architecture.md`

## Open Questions

1. In workflow-sdk, should delegated child outputs remain primarily UI-layer artifacts, or be represented in a provider-agnostic parent-loop message contract equivalent to OpenCode’s task envelope semantics?
2. Which currently emitted-but-unconsumed stream events are intentionally non-rendered vs unintentionally dropped in the present architecture?
3. For cross-provider parity, which delegated identity key is the canonical equivalent to OpenCode `task_id` (`tool_use_id`, `toolCallId`, `subagentId`, or a synthesized runtime ID)?
