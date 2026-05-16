---
date: 2026-02-27 20:35:00 UTC
researcher: Claude Opus 4.6
git_commit: 60eb3008ad545a33bdce33a6c54efbdbde7f12ad
branch: lavaman131/feature/workflow-sdk
repository: workflow-sdk
topic: "Unifying Workflow Executor Rendering with Main TUI Chat Interface"
tags: [research, codebase, workflow, streaming, rendering, tui, event-bus, sub-agents, token-counts, thinking-blocks]
status: complete
last_updated: 2026-02-27
last_updated_by: Claude Opus 4.6
---

# Research: Unifying Workflow Executor Rendering with Main TUI Chat Interface

## Research Question

Document how the main TUI chat interface renders streaming output, token counts, thinking blocks, sub-agent trees, text blocks, tool blocks, and spinners — and compare this with how the workflow executor currently renders its output. Identify the specific rendering components, data flows, and integration points that would need to be unified so that workflow execution uses the exact same rendering pipeline as the main chat interface, making workflows feel like a native part of the chat experience rather than a separate execution mode.

## Summary

The main TUI chat interface and the workflow executor use fundamentally different rendering paths. The chat interface implements a sophisticated event-driven pipeline: SDK adapters normalize vendor-specific streams into `BusEvent`s → `AtomicEventBus` → `BatchDispatcher` (60fps frame-aligned batching) → `StreamPipelineConsumer` → `StreamPartEvent` reducer → React state (`Part[]` arrays) → registry-dispatched renderers. This pipeline supports streaming text, thinking blocks, token counts, spinners, sub-agent trees, tool blocks, and code blocks — all rendered incrementally.

The workflow executor bypasses this entire pipeline. It outputs only two static `context.addMessage()` calls (start/completion), delegates sub-agent execution to `spawnSubagentParallel` which silently consumes SDK streams without rendering, and emits `workflow.step.*` / `workflow.task.*` bus events that have **no active UI consumers**. Token counts, thinking blocks, and streaming text from workflow sub-agents are discarded. The sub-agent tree shows agents spawned by the workflow but without the rich per-agent streaming, tool progress, or thinking metadata that the main chat displays.

To unify these rendering paths, the key architectural change is: workflow sub-agents must stream through the same event bus → batch dispatcher → pipeline consumer → UI reducer path as normal chat messages, rather than running in silent isolated sessions.

## Detailed Findings

### 1. Main TUI Chat Rendering Pipeline

The main chat renders through a multi-stage pipeline with clear separation of concerns:

#### 1.1 Entry Point and Bootstrap

`startChatUI()` at `src/ui/index.ts:205` creates singleton instances:
- `AtomicEventBus` — typed pub/sub with Zod schema validation (`src/events/event-bus.ts:57`)
- `BatchDispatcher` — 16ms frame-aligned batching with double-buffer swap (`src/events/batch-dispatcher.ts:71`)

These are injected into the React tree via `EventBusProvider` (`src/events/event-bus-provider.tsx:72`), wrapping `ChatApp` (`src/ui/chat.tsx:1595`).

#### 1.2 SDK Stream Adapters

Three SDK-specific adapters normalize vendor events to `BusEvent`s:

| Adapter                 | File                                         | Pattern                    | SDK API               |
| ----------------------- | -------------------------------------------- | -------------------------- | --------------------- |
| `ClaudeStreamAdapter`   | `src/events/adapters/claude-adapter.ts:56`   | Pull-based `AsyncIterable` | `query()` generator   |
| `CopilotStreamAdapter`  | `src/events/adapters/copilot-adapter.ts:82`  | Push-based `EventEmitter`  | `session.on()` events |
| `OpenCodeStreamAdapter` | `src/events/adapters/opencode-adapter.ts:73` | Hybrid pull+push           | SSE + `client.on()`   |

Each adapter publishes normalized events to the bus:
- `stream.text.delta` / `stream.text.complete` — text content
- `stream.thinking.delta` / `stream.thinking.complete` — reasoning blocks
- `stream.tool.start` / `stream.tool.complete` — tool execution
- `stream.agent.start` / `stream.agent.update` / `stream.agent.complete` — sub-agent lifecycle
- `stream.usage` — token counts
- Plus session, permission, HITL, and skill events

#### 1.3 Event Bus → UI Consumer Pipeline

`wireConsumers()` at `src/events/consumers/wire-consumers.ts:64` establishes the processing chain:

```
SDK Adapter → bus.publish() → dispatcher.enqueue() 
  → 16ms flush → correlation.enrich() → pipeline.processBatch()
    → StreamPartEvent[] → React state reducer
```

Key transformations:
- `CorrelationService` (`src/events/consumers/correlation-service.ts:52`): Enriches events with `resolvedToolId`, `resolvedAgentId`, `isSubagentTool`, `suppressFromMainChat`
- `EchoSuppressor` (`src/events/consumers/echo-suppressor.ts:13`): Filters duplicate tool result text
- `StreamPipelineConsumer` (`src/events/consumers/stream-pipeline-consumer.ts:60`): Maps `BusEvent` → `StreamPartEvent` (text-delta, thinking-meta, tool-start, tool-complete, text-complete)

#### 1.4 React State Reducer

`applyStreamPartEvent()` at `src/ui/parts/stream-pipeline.ts:799` is the core state reducer that immutably updates `ChatMessage` objects:

- **`text-delta`** → `handleTextDelta()` — appends/creates/merges `TextPart` entries with tool boundary splitting
- **`thinking-meta`** → `upsertThinkingMeta()` — creates/updates `ReasoningPart` entries
- **`tool-start`** → `upsertToolPartStart()` — creates `ToolPart` with pending state, finalizes last streaming TextPart
- **`tool-complete`** → `upsertToolPartComplete()` — updates ToolPart with result, output, duration
- **`parallel-agents`** → `mergeParallelAgentsIntoParts()` — inserts/updates `AgentPart` entries at task tool boundaries

Parts are stored in a sorted `Part[]` array using binary search insertion (`src/ui/parts/store.ts:42`) with timestamp-encoded IDs (`src/ui/parts/id.ts:20`) for chronological ordering.

#### 1.5 Part Registry Rendering

`MessageBubbleParts` at `src/ui/components/parts/message-bubble-parts.tsx:130` iterates the `Part[]` array and dispatches each part to a type-specific renderer via `PART_REGISTRY` (`src/ui/components/parts/registry.tsx:22`):

| Part Type      | Renderer                 | Visual                                                |
| -------------- | ------------------------ | ----------------------------------------------------- |
| `text`         | `TextPartDisplay`        | `●` bullet prefix + markdown content                  |
| `reasoning`    | `ReasoningPartDisplay`   | `∴ Thinking...` / `∴ Thought (Xs)` with dimmed style  |
| `tool`         | `ToolPartDisplay`        | Tool-specific renderers via `ToolResultRegistry`      |
| `agent`        | `AgentPartDisplay`       | `ParallelAgentsTree` with foreground/background split |
| `task-list`    | `TaskListPartDisplay`    | `TaskListBox` with topological sorting                |
| `skill-load`   | `SkillLoadPartDisplay`   | Skill loading status                                  |
| `mcp-snapshot` | `McpSnapshotPartDisplay` | MCP server status                                     |
| `compaction`   | `CompactionPartDisplay`  | Context compaction banner                             |

#### 1.6 Token Count Display

Token usage flows through `stream.usage` bus events (`src/events/bus-events.ts:53`), subscribed at `src/ui/chat.tsx:2755`. The `outputTokens` value is baked onto the `ChatMessage` via `setMessagesWindowed()`. Display occurs in two places:

- **During streaming**: `LoadingIndicator` at `src/ui/chat.tsx:1038` shows `↓ Xk tokens` via `formatTokenCount()` (k/M suffixes)
- **After completion**: `CompletionSummary` at `src/ui/chat.tsx:1104` shows `⣿ Verb for Xs · ↓ Xk tokens · thought for Xs`

Completion summary visibility requires `durationMs >= 1000` (`src/ui/utils/loading-state.ts:70`).

#### 1.7 Thinking Block Display

Thinking content flows through `stream.thinking.delta` → `StreamPipelineConsumer` → `thinking-meta` StreamPartEvent → `upsertThinkingMeta()`. Duration flows through `stream.thinking.complete` → direct bus subscription at `src/ui/chat.tsx:2789`.

`ReasoningPartDisplay` at `src/ui/components/parts/reasoning-part-display.tsx:47` renders with:
- `∴ Thinking...` header during streaming
- `∴ Thought (Xs)` header when finalized with `durationMs`
- Dimmed markdown syntax style via `createDimmedSyntaxStyle(syntaxStyle, 0.6)`

#### 1.8 Spinner/Loading

`LoadingIndicator` at `src/ui/chat.tsx:1038` uses braille animation frames (`⣾⣽⣻⢿⡿⣟⣯⣷`) at 120ms per frame. Verb selection: `"Reasoning"` if `thinkingMs > 0`, else `"Composing"`. Enhanced info line shows elapsed time, token count, and thinking duration.

Visibility via `shouldShowMessageLoadingIndicator()` at `src/ui/utils/loading-state.ts:35`: true when `message.streaming === true` or active background agents exist.

#### 1.9 Sub-Agent Tree

Agent events (`stream.agent.start/update/complete`) are subscribed at `src/ui/chat.tsx:2813-2907`, updating `parallelAgents` React state. A `useEffect` at `chat.tsx:3197` syncs live agents into the streaming message's `Part[]` array.

`ParallelAgentsTree` at `src/ui/components/parallel-agents-tree.tsx:593` renders:
- Sorted by status priority (running → pending → background → completed → interrupted → error)
- Tree connectors: `├─`, `└─`, `│`, `╰`
- Status colors: completed=green, error=red, pending/interrupted=yellow, running=muted
- Per-agent tool count, current tool, elapsed time, result text
- Background agents shown separately with distinct header
- Max 5 visible agents with `"...and N more"` overflow

### 2. Workflow Executor Rendering (Current State)

#### 2.1 Two Direct UI Calls

The workflow executor at `src/workflows/executor.ts:122` has exactly two rendering calls:

1. **Start message** (`executor.ts:150-153`): `context.addMessage("assistant", "Starting **${definition.name}** workflow...")`
2. **Completion message** (`executor.ts:325-328`): `context.addMessage("assistant", "**${definition.name}** workflow completed successfully.")`

These produce static text in the chat — no streaming, no incremental rendering, no parts-based display.

#### 2.2 Silent Sub-Agent Execution

Sub-agents are executed via `context.spawnSubagentParallel` implemented at `src/ui/chat.tsx:3889-4068`:

- Each agent creates an **independent SDK session** via `createSubagentSession()` (`chat.tsx:3940`)
- The stream is consumed silently — text chunks accumulate in `summaryParts` (`chat.tsx:3979`)
- Tool uses are counted but **not displayed** (`chat.tsx:3977`)
- **No text deltas are rendered** during sub-agent execution
- **No thinking blocks** are captured — only `"tool_use"` and `"text"` message types are checked (`chat.tsx:3976-3980`)
- **No token counts** are tracked — usage events are discarded
- Output is truncated to 4000 characters (`chat.tsx:4011`)
- Sessions are destroyed after completion (`chat.tsx:4033`)

#### 2.3 Bus Events Published but Not Consumed

The `WorkflowEventAdapter` (`src/events/adapters/workflow-adapter.ts:31`) publishes:

| Event                    | Published At          | UI Consumer           |
| ------------------------ | --------------------- | --------------------- |
| `workflow.step.start`    | `executor.ts:268-273` | **None**              |
| `workflow.step.complete` | `executor.ts:259-263` | **None**              |
| `workflow.task.update`   | `executor.ts:290-296` | **None**              |
| `stream.agent.start`     | `executor.ts:196-198` | Yes — `chat.tsx:2813` |
| `stream.agent.complete`  | `executor.ts:205-210` | Yes — `chat.tsx:2885` |

The `stream.agent.*` events are consumed, so the sub-agent tree **does** show workflow agents. However, these agents appear without tool progress, streaming text, thinking blocks, or token counts because the independent SDK sessions don't publish to the shared bus.

#### 2.4 What the Workflow Executor Does NOT Do

- ❌ Does not create SDK stream adapters for sub-agent sessions
- ❌ Does not publish `stream.text.delta` or `stream.thinking.delta` events
- ❌ Does not render incremental text or thinking blocks
- ❌ Does not track or emit token usage (`stream.usage`)
- ❌ Does not render tool calls incrementally (`stream.tool.start/complete`)
- ❌ Does not publish `stream.agent.update` events (method exists but never called from executor)
- ❌ Does not use the `BatchDispatcher` or `StreamPipelineConsumer` pipeline

### 3. Gap Analysis: Chat vs Workflow Rendering

| Feature               | Main Chat                                            | Workflow Executor                                            |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| Streaming text        | ✅ Incremental via `stream.text.delta`                | ❌ Text accumulated silently, output truncated to 4000 chars  |
| Token counts          | ✅ Via `stream.usage` → `CompletionSummary`           | ❌ Not tracked or displayed                                   |
| Thinking blocks       | ✅ Via `stream.thinking.delta` → `ReasoningPart`      | ❌ Not captured from sub-agent streams                        |
| Spinner with metadata | ✅ Elapsed time, tokens, thinking duration            | ⚠️ Basic streaming flag only via `context.setStreaming(true)` |
| Sub-agent tree        | ✅ Full tree with tool counts, current tool, duration | ⚠️ Tree shows but without live tool progress                  |
| Tool blocks           | ✅ Rendered inline with status, collapsible output    | ❌ Tool uses counted but not rendered                         |
| Text blocks           | ✅ Markdown-rendered with `●` bullet prefix           | ❌ Only start/completion static messages                      |
| Code blocks           | ✅ Syntax-highlighted via `CodeBlock` component       | ❌ Not applicable (no streaming content)                      |
| Completion summary    | ✅ Duration, tokens, thinking time                    | ❌ No per-agent or per-step summary                           |
| Parts-based rendering | ✅ Full `Part[]` pipeline with registry dispatch      | ❌ Not used — only `context.addMessage()`                     |

### 4. Integration Points for Unification

#### 4.1 The Core Problem: Silent Sessions

The fundamental issue is at `src/ui/chat.tsx:3889-4068` where `spawnSubagentParallel` creates independent SDK sessions that don't publish to the shared event bus. Each sub-agent's stream is consumed in a tight loop:

```typescript
// chat.tsx:3970-3984 — current silent consumption
for await (const msg of stream) {
  if (msg.type === "tool_use") { toolUses++; }
  else if (msg.type === "text") { summaryParts.push(msg.content); }
}
```

This discards all thinking blocks, token counts, and tool lifecycle events.

#### 4.2 What Would Need to Change

**Option A — Bus-Integrated Sub-Agent Sessions**: Instead of silently consuming sub-agent streams, create SDK stream adapters for each sub-agent session and have them publish to the shared `AtomicEventBus`. The correlation service would need to recognize sub-agent session IDs and attribute events to the parent agent.

Key files that would change:
- `src/ui/chat.tsx:3889-4068` (`spawnSubagentParallel`) — create adapters instead of silent consumption
- `src/events/consumers/correlation-service.ts` — track sub-agent session ownership
- `src/ui/parts/stream-pipeline.ts` — handle nested agent rendering (sub-agent text/tools inside parent agent context)

**Option B — Workflow-Specific Stream Adapter**: Enhance `WorkflowEventAdapter` to forward sub-agent SDK events as `stream.text.delta`, `stream.thinking.delta`, `stream.tool.*`, and `stream.usage` events scoped to the workflow context.

Key files that would change:
- `src/events/adapters/workflow-adapter.ts` — add text/thinking/tool/usage publishing methods
- `src/workflows/executor.ts` — consume sub-agent streams through the adapter instead of silently
- `src/ui/chat.tsx` — consume workflow-scoped stream events in the UI reducer

**Option C — Inline Agent Rendering**: Instead of running sub-agents in isolated sessions, run them as "inline" agents that render directly into the parent chat's message stream, similar to how normal chat streaming works.

Key considerations:
- Each workflow node could produce a new assistant message with full parts-based rendering
- The `streamAndWait()` mechanism already pipes through the normal rendering pipeline
- Node transitions could be displayed as progress markers between rendered messages

#### 4.3 Existing Infrastructure That Supports Unification

Several components already support the unification:

1. **`streamAndWait()`** at `src/ui/chat.tsx:4070-4081` — already pipes through normal chat streaming. Workflow nodes that need to run a full agent turn could use this path instead of `spawnSubagentParallel`.

2. **`WorkflowEventAdapter`** at `src/events/adapters/workflow-adapter.ts` — already publishes `stream.agent.*` events. Could be extended to publish text/thinking/tool/usage events.

3. **`CorrelationService`** at `src/events/consumers/correlation-service.ts` — already enriches events with agent context. The `resolvedAgentId` and `isSubagentTool` fields could scope sub-agent rendering.

4. **`AgentPartDisplay`** at `src/ui/components/parts/agent-part-display.tsx` — already handles foreground/background split. Workflow agents could carry inline content.

5. **`PART_REGISTRY`** at `src/ui/components/parts/registry.tsx` — extensible by adding new part types for workflow-specific content (e.g., step progress, node transitions).

6. **Event bus event types** at `src/events/bus-events.ts` — `workflow.step.start/complete` and `workflow.task.update` events already exist but lack UI consumers.

#### 4.4 Data Flow for Unified Rendering

The target data flow would be:

```
Workflow Executor
  → for each graph node:
    → SDK Adapter publishes to AtomicEventBus (same as normal chat)
    → BatchDispatcher batches at 60fps
    → CorrelationService attributes to parent workflow agent
    → StreamPipelineConsumer maps to StreamPartEvents
    → React reducer updates ChatMessage.parts[]
    → MessageBubbleParts renders via PART_REGISTRY
    → Text, thinking, tools, tokens all visible per-agent
```

### 5. Workflow-Specific UI Elements

#### 5.1 Visual Differentiation (Already Exists)

- **Teal border**: `src/ui/chat.tsx:6014-6017` — input border changes to `themeColors.accent` when `workflowActive`
- **Footer hints**: `src/ui/chat.tsx:6106-6132` — shows "workflow · Esc to interrupt · ctrl+c twice to exit"
- **Auto-approval**: `src/ui/chat.tsx:3071-3076, 3139-3147` — HITL prompts auto-approved during workflow

#### 5.2 Task List Rendering (Two Modes)

- **Inline**: `TaskListPartDisplay` via parts registry — shows tasks within message parts
- **Persistent**: `TaskListPanel` at `src/ui/components/task-list-panel.tsx:157` — file-watching component that reads `tasks.json` from session directory

#### 5.3 WorkflowChatState

At `src/ui/chat.tsx:814-843`, the `WorkflowChatState` tracks:
- `workflowActive`, `workflowType`, `initialPrompt`
- `currentNode`, `iteration`, `maxIterations`
- `pendingApproval`, `specApproved`, `feedback`
- `workflowConfig` with `sessionId`, `userPrompt`, `workflowName`

### 6. CommandContext — The Bridge Interface

The `CommandContext` at `src/ui/commands/registry.ts:75-168` is the interface between workflow executors and the TUI:

| Method                    | Purpose                         | Used by Workflow            |
| ------------------------- | ------------------------------- | --------------------------- |
| `addMessage()`            | Static text into chat           | ✅ Start/completion messages |
| `setStreaming()`          | Toggle streaming indicator      | ✅ On/off only               |
| `sendSilentMessage()`     | Send message without user input | ❌                           |
| `spawnSubagentParallel()` | Run parallel SDK sessions       | ✅ Silent execution          |
| `streamAndWait()`         | Stream through normal pipeline  | ❌ Not used by executor      |
| `waitForUserInput()`      | Block for user response         | ❌ Not used by executor      |
| `updateWorkflowState()`   | Update workflow UI state        | ✅ Active/type/config        |
| `setWorkflowSessionDir()` | Enable task panel               | ✅ On first tasks            |
| `setWorkflowSessionId()`  | Set session ID                  | ✅ On first tasks            |
| `setWorkflowTaskIds()`    | Guard task persistence          | ✅ On first tasks            |

Key observation: `streamAndWait()` already pipes through the full rendering pipeline but the workflow executor uses `spawnSubagentParallel()` instead.

## Code References

### Main TUI Rendering Pipeline
- `src/ui/index.ts:205` — `startChatUI()` entry point, creates bus and dispatcher
- `src/ui/index.ts:446-454` — SDK adapter selection by agent type
- `src/ui/chat.tsx:1595` — `ChatApp` main React component
- `src/ui/chat.tsx:2626-2740` — Stream part event processing callback
- `src/ui/chat.tsx:2755-2787` — Token count (`stream.usage`) subscription
- `src/ui/chat.tsx:2789-2830` — Thinking complete subscription
- `src/ui/chat.tsx:2813-2907` — Agent lifecycle subscriptions
- `src/ui/chat.tsx:1038-1077` — `LoadingIndicator` (spinner with metadata)
- `src/ui/chat.tsx:1104-1139` — `CompletionSummary` (post-stream stats)
- `src/ui/parts/stream-pipeline.ts:799-871` — `applyStreamPartEvent()` reducer
- `src/ui/parts/stream-pipeline.ts:624-752` — `mergeParallelAgentsIntoParts()`
- `src/ui/components/parts/registry.tsx:22-31` — `PART_REGISTRY` type→renderer mapping
- `src/ui/components/parts/text-part-display.tsx:41` — Text rendering
- `src/ui/components/parts/reasoning-part-display.tsx:47` — Thinking rendering
- `src/ui/components/parts/tool-part-display.tsx:106` — Tool rendering
- `src/ui/components/parts/agent-part-display.tsx:53` — Agent tree rendering
- `src/ui/components/parallel-agents-tree.tsx:593` — Tree component

### Event Bus System
- `src/events/event-bus.ts:57` — `AtomicEventBus` pub/sub
- `src/events/batch-dispatcher.ts:71` — Frame-aligned batching
- `src/events/bus-events.ts:33-60` — 27 typed event definitions
- `src/events/consumers/wire-consumers.ts:64` — Pipeline wiring
- `src/events/consumers/stream-pipeline-consumer.ts:60` — BusEvent→StreamPartEvent mapping
- `src/events/consumers/correlation-service.ts:52` — Event enrichment/correlation

### SDK Adapters
- `src/events/adapters/claude-adapter.ts:56` — Claude → BusEvent
- `src/events/adapters/copilot-adapter.ts:82` — Copilot → BusEvent
- `src/events/adapters/opencode-adapter.ts:73` — OpenCode → BusEvent
- `src/events/adapters/workflow-adapter.ts:31` — Workflow → BusEvent (producer-side)

### Workflow Executor
- `src/workflows/executor.ts:122` — `executeWorkflow()` entry point
- `src/workflows/executor.ts:150-153` — Start message (only direct rendering)
- `src/workflows/executor.ts:188-243` — Sub-agent spawn wiring
- `src/workflows/executor.ts:248-322` — Graph streaming loop
- `src/workflows/executor.ts:325-328` — Completion message
- `src/ui/chat.tsx:3889-4068` — `spawnSubagentParallel` (silent consumption)
- `src/ui/chat.tsx:3970-3984` — Silent stream consumption loop

### Workflow Graph Engine
- `src/workflows/graph/compiled.ts:253` — `GraphExecutor` class
- `src/workflows/graph/compiled.ts:322` — `streamSteps()` async generator
- `src/workflows/graph/stream.ts:56` — `StreamRouter` class
- `src/workflows/ralph/graph.ts:98` — `createRalphWorkflow()` builder

### Workflow UI Integration
- `src/ui/commands/workflow-commands.ts:623` — `createWorkflowCommand()`
- `src/ui/commands/registry.ts:75-168` — `CommandContext` interface
- `src/ui/chat.tsx:814-843` — `WorkflowChatState` type
- `src/ui/chat.tsx:4070-4081` — `streamAndWait()` implementation
- `src/ui/chat.tsx:6014-6017` — Teal border during workflow

## Architecture Documentation

### Current Architecture: Two Parallel Rendering Paths

```
PATH 1 — Main Chat (Full Rendering):
  User Message → SDK session.stream()
    → SDKStreamAdapter (Claude/Copilot/OpenCode)
      → bus.publish(stream.text.delta, stream.thinking.delta, etc.)
        → BatchDispatcher (16ms batching)
          → CorrelationService (enrichment)
            → StreamPipelineConsumer (BusEvent → StreamPartEvent)
              → chat.tsx callback → applyStreamPartEvent()
                → ChatMessage.parts[] update
                  → MessageBubbleParts → PART_REGISTRY → renderers

PATH 2 — Workflow Executor (Minimal Rendering):
  /ralph command → executeWorkflow()
    → context.addMessage("Starting workflow...")
    → for await (step of streamGraph()):
      → eventAdapter.publishStepStart()     ← NO UI CONSUMER
      → eventAdapter.publishTaskUpdate()    ← NO UI CONSUMER
      → spawnSubagentParallel():
        → createSubagentSession()           ← INDEPENDENT session
        → for await (msg of stream):        ← SILENT consumption
          → summaryParts.push(msg.content)  ← NO rendering
        → return SubagentResult             ← truncated to 4000 chars
    → context.addMessage("Workflow completed.")
```

### Target Architecture: Unified Rendering Path

```
UNIFIED PATH — Workflows Using Chat Pipeline:
  /ralph command → executeWorkflow()
    → for each graph node:
      → Create SDKStreamAdapter for sub-agent session
      → adapter.startStreaming() publishes to shared bus
        → Same pipeline as PATH 1:
          → BatchDispatcher → CorrelationService → StreamPipelineConsumer
            → chat.tsx reducer → Part[] → renderers
      → Result: Full streaming text, thinking, tools, tokens visible
    → workflow.step.* events consumed by new UI components
    → Per-node completion summaries with token counts
```

### Event Type Coverage

| BusEventType               | Published by Chat | Published by Workflow         | Consumed by UI             |
| -------------------------- | ----------------- | ----------------------------- | -------------------------- |
| `stream.text.delta`        | ✅ via SDK adapter | ❌                             | ✅ `StreamPipelineConsumer` |
| `stream.text.complete`     | ✅ via SDK adapter | ❌                             | ✅ `StreamPipelineConsumer` |
| `stream.thinking.delta`    | ✅ via SDK adapter | ❌                             | ✅ `StreamPipelineConsumer` |
| `stream.thinking.complete` | ✅ via SDK adapter | ❌                             | ✅ `chat.tsx:2789`          |
| `stream.tool.start`        | ✅ via SDK adapter | ❌                             | ✅ `StreamPipelineConsumer` |
| `stream.tool.complete`     | ✅ via SDK adapter | ❌                             | ✅ `StreamPipelineConsumer` |
| `stream.agent.start`       | ✅ via SDK adapter | ✅ via workflow adapter        | ✅ `chat.tsx:2813`          |
| `stream.agent.update`      | ✅ via SDK adapter | ⚠️ method exists, never called | ✅ `chat.tsx:2870`          |
| `stream.agent.complete`    | ✅ via SDK adapter | ✅ via workflow adapter        | ✅ `chat.tsx:2885`          |
| `stream.usage`             | ✅ via SDK adapter | ❌                             | ✅ `chat.tsx:2755`          |
| `workflow.step.start`      | N/A               | ✅ via workflow adapter        | ❌ **No consumer**          |
| `workflow.step.complete`   | N/A               | ✅ via workflow adapter        | ❌ **No consumer**          |
| `workflow.task.update`     | N/A               | ✅ via workflow adapter        | ❌ **No consumer**          |

### Component File Inventory

| Directory                  | Files                  | Purpose                                              |
| -------------------------- | ---------------------- | ---------------------------------------------------- |
| `src/ui/parts/`            | 24 (12 impl + 12 test) | Stream pipeline, part store, handlers, guards, types |
| `src/ui/components/parts/` | 15 (10 impl + 5 test)  | Part renderer components                             |
| `src/ui/components/`       | 27 (17 impl + 10 test) | UI components (tree, indicators, dialogs)            |
| `src/ui/utils/`            | 38 (18 impl + 20 test) | Formatting, state, lifecycle, background agents      |
| `src/events/`              | 14 (7 impl + 7 test)   | Event bus core, batching, hooks                      |
| `src/events/adapters/`     | 7 (5 impl + 2 test)    | SDK-specific stream adapters                         |
| `src/events/consumers/`    | 6 (3 impl + 3 test)    | Event consumers, correlation, echo suppression       |
| `src/workflows/`           | 7                      | Executor, session, index                             |
| `src/workflows/graph/`     | ~15                    | Graph engine, builder, types, node factories         |
| `src/workflows/ralph/`     | ~10                    | Ralph-specific graph, state, prompts, definition     |

## Historical Context (from research/)

### Directly Related Research Documents

- `research/docs/2026-02-26-streaming-architecture-event-bus-migration.md` — Documents the callback-to-event-bus migration. The streaming pipeline now routes through `AtomicEventBus`, but the migration was incomplete for workflow rendering.

- `research/docs/2026-02-26-streaming-event-bus-spec-audit.md` — Audits the event bus spec implementation. Confirms that `workflow.step.*` and `workflow.task.*` events are defined and published but have no UI consumers.

- `research/docs/2026-02-25-unified-workflow-execution-research.md` — Analyzes why workflows cannot share the main chat's rendering pipeline generically. Identifies 9 Ralph-specific coupling points that need generalization.

- `research/docs/2026-02-25-ui-workflow-coupling.md` — Maps UI↔workflow coupling. Shows `CommandContext` as the sole communication bridge. Identifies Ralph-specific state in chat.tsx (session dir, task IDs, TodoWrite guards).

- `research/docs/2026-02-21-workflow-sdk-inline-mode-research.md` — Confirms workflows already run inline via `streamAndWait()`. However, `streamAndWait()` is used for chat-based workflow mode, not for the graph executor's sub-agent execution.

- `research/docs/2026-02-15-subagent-event-flow-diagram.md` — Documents a race condition in background agent events where `tool.complete` fires before `subagent.complete`. Relevant to workflow rendering since workflow sub-agents are background agents.

- `research/docs/2026-02-12-sdk-ui-standardization-comprehensive.md` — Confirms UI components (ToolResult, ParallelAgentsTree, TaskListIndicator) are already SDK-agnostic. Event normalization across all three SDKs is complete.

- `research/docs/2026-02-12-tui-layout-streaming-content-ordering.md` — Identifies the dual-channel rendering issue: interleaved segments (text+tools) vs fixed-position components (agent tree, task list). Relevant to how workflow content would be positioned.

- `research/docs/2026-02-09-token-count-thinking-timer-bugs.md` — Documents bugs in the streaming metadata pipeline: completion summary threshold was too high, thinking metadata missing from OpenCode/Copilot SDKs. These bugs affect both chat and workflow rendering.

- `research/docs/2026-02-25-graph-execution-engine-technical-documentation.md` — Technical reference for the graph engine. Confirms the engine is fully generic with no UI dependencies. Any compiled graph streams `StepResult` objects via async generator.

- `research/docs/2026-02-25-ralph-workflow-implementation.md` — Technical reference for the Ralph workflow specifically. Three-phase graph: planner → worker loop → review & fix. Uses builder pattern.

- `research/docs/2026-02-11-workflow-sdk-implementation.md` — Earlier workflow SDK design document.

## Related Research

- `research/docs/2026-02-25-workflow-sdk-design.md`
- `research/docs/2026-02-25-workflow-sdk-patterns.md`
- `research/docs/2026-02-25-workflow-sdk-standardization.md`
- `research/docs/2026-02-25-workflow-sdk-refactor-research.md`
- `research/docs/2026-02-25-workflow-registration-flow.md`
- `research/docs/2026-02-16-atomic-chat-architecture-current.md`
- `research/docs/2026-02-16-opencode-message-rendering-patterns.md`
- `research/docs/2026-02-15-sub-agent-tree-status-lifecycle-sdk-parity.md`
- `research/docs/2026-02-23-258-background-agents-sdk-event-pipeline.md`

## Open Questions

1. **Concurrency model**: If multiple workflow sub-agents stream simultaneously through the shared bus, how should the UI interleave their content? Should each agent get its own collapsible section, or should content merge into a single stream?

2. **Agent nesting depth**: The current sub-agent tree supports flat agent lists. Workflow graphs can have sub-agents that themselves spawn sub-agents (e.g., Ralph's worker uses the "worker" agent type which may use Task tools internally). How deep should the tree render?

3. **Per-node vs per-agent rendering**: Should each graph node's execution produce a separate assistant message in the chat, or should all nodes render within a single message with step transitions shown as dividers?

4. **Token aggregation**: Should token counts be shown per-agent, per-node, per-step, or aggregated for the entire workflow?

5. **Context window management**: Sub-agent sessions are currently independent and destroyed after use. If they stream through the shared bus, the correlation service needs to track multiple concurrent sessions without conflicting with the parent session's state.

6. **`workflow.step.*` and `workflow.task.*` event consumers**: These events are published but have no UI subscribers. Should they be rendered as progress indicators, step markers, or integrated into the parts system?

7. **Backward compatibility**: Existing `spawnSubagentParallel` consumers expect `SubagentResult` return values. A unified approach must still provide these results while also rendering incrementally.
