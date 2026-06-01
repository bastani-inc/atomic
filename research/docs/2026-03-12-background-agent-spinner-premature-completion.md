---
date: 2026-03-12 17:02:03 PDT
researcher: Copilot
git_commit: 93ca1e2513d78cf8da5e2ab4f5f74d24c8677309
branch: lavaman131/hotfix/background-subagents
repository: atomic
topic: "Background agent spinner premature completion — root cause analysis across Copilot and Claude adapters"
tags:
    [
        research,
        codebase,
        copilot-adapter,
        claude-adapter,
        background-agents,
        streaming,
        spinner,
        premature-completion,
        ui-state,
    ]
status: complete
last_updated: 2026-03-12
last_updated_by: Copilot
---

# Background Agent Spinner Premature Completion

## Research Question

Resolve a bug in Copilot SDK adapter (and verify if the same issue happens in Claude Agent SDK adapter) where the main UI spinner stops prematurely when background agents are running. The user observes that background work completes, but the UI becomes unresponsive — requiring a manual Enter keypress to continue seeing remaining steps. Reference the expected UI patterns defined in `docs/ui-design-patterns.md` for background sub-agents.

## Summary

The main UI spinner stopping while background agents are still running is **by design** in the provider-agnostic streaming layer — background agents are explicitly excluded from the stream continuation gates. However, two bugs compound to make this design fail silently:

1. **Copilot adapter: `state.isActive = false` drops background agent events** — After the streaming `finally` block runs in `runtime.ts:155`, the provider-router guard at `provider-router.ts:61-67` silently discards all subsequent SDK events (including `subagent.complete`) because `state.isActive` is `false`. Background agents finish, but the UI never learns about it.

2. **Claude adapter: identical structural issue** — `streaming-runtime.ts:233-234` clears `activeSubagentBackgroundById` and publishes idle in its `finally` block, using the same provider-agnostic UI layer that excludes background agents from continuation gates.

3. **UI layer: `isStreaming` always becomes `false`** — `createStoppedStreamControlState()` at `stream-continuation.ts:153` unconditionally returns `isStreaming: false`. Background agents are preserved in state and have metadata retained (`preserveStreamingStart`, `preserveStreamingMeta`), but the spinner stops regardless.

The "manual Enter to continue" behavior likely stems from the conversation continuation queue (`continueQueuedConversationRef`) requiring user interaction to re-engage the streaming loop after `isStreaming` goes `false`.

The existing infrastructure for background agent UI (status colors, footer, tree hints, Ctrl+F termination, flush mechanism) is fully built but **cannot activate** because the adapter-level event gate (`state.isActive` / equivalent) prevents background completion events from reaching the UI layer.

## Detailed Findings

### 1. Copilot Adapter — Event Gate Blocks Background Agent Completion

The Copilot streaming lifecycle in [`runtime.ts`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/services/events/adapters/providers/copilot/runtime.ts) follows a `for await` loop with a `finally` block (lines 142–157):

```
finally {
  cleanupCopilotOrphanedTools(state, publish);
  publish("stream.session.idle", { reason: state.pendingIdleReason ?? "unknown" });
  state.isActive = false;  // line 155 — THE KEY BLOCKER
}
```

After `state.isActive = false`, the provider event callback at [`provider-router.ts:61-67`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/services/events/adapters/providers/copilot/provider-router.ts#L61-L67) enforces:

```typescript
if (!state.isActive || event.sessionId !== state.sessionId) {
    return; // silently drops ALL events
}
```

This means when a background agent completes and the SDK emits a `subagent.complete` event, it is **silently discarded** — `handleCopilotSubagentComplete` at [`subagent-handlers.ts:150`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/services/events/adapters/providers/copilot/subagent-handlers.ts#L150) never fires, and `stream.agent.complete` is never published to the UI.

**State at idle with background agents running:**

| State Field                    | Value                                   | Effect                                     |
| ------------------------------ | --------------------------------------- | ------------------------------------------ |
| `state.isActive`               | `false`                                 | Blocks ALL further event processing        |
| `subagentTracker.agents`       | Still contains background agent entries | Stale state, never cleaned up              |
| `state.toolCallIdToSubagentId` | Still has mapping                       | Stale state                                |
| Provider subscription          | Still active on the SDK                 | Events arrive but are dropped by the guard |

### 2. Copilot Two-Phase Idle Pattern

The Copilot adapter uses a deferred idle publication pattern:

1. SDK emits `session.idle` → [`handleCopilotSessionIdle`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/services/events/adapters/providers/copilot/session-handlers.ts#L30) stashes the reason in `state.pendingIdleReason` and completes any synthetic foreground agent
2. The `for await` loop exhausts (no more events from SDK)
3. `finally` block publishes the actual `stream.session.idle` after cleanup

This ensures idle is always the **last** event published. However, it also means `state.isActive = false` is set immediately after idle, with no window for background agent events.

### 3. Background Agent Detection Pipeline (Copilot)

Background agent detection works correctly — the bug is not in detection, but in post-idle event gating:

1. Tool call processed → [`isCopilotTaskTool`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/services/events/adapters/providers/copilot/support.ts) checks tool name against `"task"`, `"launch_agent"`, `"agent"` + `knownAgentNames`
2. [`extractCopilotTaskToolMetadata`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/services/events/adapters/providers/copilot/support.ts#L70-L90) extracts `isBackground` from `run_in_background === true || mode === "background"`
3. Stored in `state.taskToolMetadata` map by `toolCallId`
4. Consumed at [`handleCopilotSubagentStart`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/services/events/adapters/providers/copilot/subagent-handlers.ts#L90) → propagated into `stream.agent.start` event with `isBackground: true`

### 4. Claude Adapter — Same Structural Issue

The Claude adapter at [`streaming-runtime.ts`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/services/events/adapters/providers/claude/streaming-runtime.ts) has the same pattern in its `finally` block (lines 225–235):

```
finally {
  cleanupOrphanedTools(state, publish);  // clears activeSubagentBackgroundById
  publish("stream.session.idle", { reason: ... });
}
```

**Key differences from Copilot:**

| Aspect                | Copilot                                   | Claude                                  |
| --------------------- | ----------------------------------------- | --------------------------------------- |
| Idle publication      | Two-phase (stash → publish in finally)    | Direct publish in finally               |
| Background tracking   | `state.taskToolMetadata` map              | `activeSubagentBackgroundById` map      |
| Event handler pattern | Flat standalone functions                 | Factory pattern (`handler-factory.ts`)  |
| Post-idle event gate  | `state.isActive` check in provider-router | Equivalent guard in streaming loop exit |

**Identical behavior:** Both publish `stream.session.idle` without checking for active background agents, and both share the same provider-agnostic UI layer that excludes background agents from continuation gates.

### 5. Provider-Agnostic Stream Completion Pipeline

The completion pipeline is a 3-gate orchestrator at [`use-completion.ts:75`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/state/chat/stream/use-completion.ts#L75) (`handleStreamComplete()`):

**Gate 1: `finishInterruptedStreamIfNeeded()`** — Handles aborted streams. Clears ALL agents (foreground + background). Not relevant to the bug.

**Gate 2: `deferStreamCompletionIfNeeded()`** at [`use-deferred-completion.ts:37-87`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/state/chat/stream/use-deferred-completion.ts#L37-L87) — Defers completion when foreground agents/tools are still active. **Explicitly excludes background agents** via `hasActiveForegroundAgents()`. Has a 30-second safety timeout.

**Gate 3: `finalizeCompletedStream()`** at [`use-finalized-completion.ts:41-127`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/state/chat/stream/use-finalized-completion.ts#L41-L127) — Terminal path. This is where background agents are handled:

```
// line 60 — background agents pass through unchanged
if (agent.background) return agent;

// line 93 — only background agents survive
setParallelAgents(remaining);

// line 95 — controls metadata preservation
hasRemainingBackgroundAgents = remaining.length > 0;

// line 104 — preserves metadata but isStreaming still goes false
stopSharedStreamState({ preserveStreamingStart: true, preserveStreamingMeta: true });
```

The central exclusion mechanism lives at [`guards.ts:20-24`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/state/parts/guards.ts#L20-L24) (`shouldFinalizeOnToolComplete`) and [`guards.ts:30-37`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/state/parts/guards.ts#L30-L37) (`hasActiveForegroundAgents`), which exclude agents where `agent.background === true` and `status === "background"`.

### 6. `isStreaming` Always Goes `false` — By Design

[`stream-continuation.ts:147-161`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/lib/ui/stream-continuation.ts#L147-L161) (`createStoppedStreamControlState`) **unconditionally** returns `isStreaming: false`:

```typescript
// line 153 — always false, no conditional for background agents
isStreaming: false,
```

Inside `stopSharedStreamState()` at `use-runtime-controls.ts:227`:

- `isStreamingRef.current = false` (line 251)
- `setIsStreaming(false)` (line 260) — the React state update that triggers re-render and **stops the spinner**

When `hasRemainingBackgroundAgents` is `true`, two fields ARE preserved:

- `streamingStartRef.current` retains its timestamp value
- `streamingMetaRef.current` retains output token counts / thinking ms

But `isStreaming` is still `false` — the spinner stops regardless.

### 7. Exact Event Flow: Completion With Background Agents Running

1. Backend emits `stream.turn.end` → `use-session-subscriptions.ts:147`: stores `finishReason`
2. Backend emits `stream.session.idle` → `use-session-subscriptions.ts:161`: validates run ID & streaming state
3. `shouldContinueParentSessionLoop()` evaluates: `hasActiveForegroundAgents` = `false` → returns `{ shouldContinue: false, reason: "terminal" }`
4. `handleStreamComplete()` called → 3-gate pipeline
5. Gate 2 (`deferStreamCompletionIfNeeded`): `hasActiveForegroundAgents()` = `false` → returns `false` (no deferral)
6. Gate 3 (`finalizeCompletedStream`):
    - `getActiveBackgroundAgents()` returns `[{id: "bg1", background: true, status: "background"}]`
    - `setBackgroundAgentMessageId(messageId)` — anchors background agents to message
    - Message updated with `streaming: false`
    - `setParallelAgents([bg1])` — only background agents survive
    - `stopSharedStreamState({ preserveStreamingStart: true, preserveStreamingMeta: true })`
7. `isStreaming = false` → **spinner stops**
8. Background agent continues executing on SDK side
9. SDK emits completion event → **dropped by `state.isActive` guard** (Copilot) or equivalent (Claude)
10. UI never receives `stream.agent.complete` → background agent stays in `"background"` status forever
11. User presses Enter → new streaming loop starts → UI re-engages

### 8. Background Agent UI Infrastructure (Exists but Cannot Activate)

The UI layer has comprehensive background agent support that is fully built but unreachable due to the adapter-level event gate:

**`parallel-agents-tree.tsx`** ([link](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/components/parallel-agents-tree.tsx)):

- `AgentStatus` union type includes `"background"` (line 26)
- Color mapping: `"background"` → grey/muted (lines 153-166)
- Sort order supports `"background"` status (lines 591-598)
- `ParallelAgent` interface has `background?: boolean` field (line 15-34)

**`background-agent-footer.ts`** ([link](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/lib/ui/background-agent-footer.ts)):

- `isBackgroundAgent()` — canonical dual check: `agent.background === true || agent.status === "background"`
- `getActiveBackgroundAgents()` — filters by active status
- `isShadowForegroundAgent()` — lines 20-64

**`loading-state.ts`** ([link](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/lib/ui/loading-state.ts)):

- Lines 35-55: Loading indicator checks for background agents (`agent.background && agent.status === "background"`)
- Lines 69-78: Completion summary suppressed during active background agents

**`use-background-dispatch.ts`** ([link](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/state/chat/controller/use-background-dispatch.ts)):

- `sendBackgroundMessageToAgent()` — queues updates for background agents
- `flushPendingBackgroundUpdatesToAgent()` — sends via `session.send()`, guarded by `!isStreaming` (flush only happens AFTER main stream ends)

**`use-agent-subscriptions.ts`** ([link](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/src/state/chat/stream/use-agent-subscriptions.ts)):

- Line 97: Sets `status: data.isBackground ? "background" : "running"` on agent creation
- Lines 343-363: Post-completion background message dispatch — works IF `stream.agent.complete` fires

**Expected UI from `docs/ui-design-patterns.md`:**

- Tree-based rendering for foreground vs. background sub-agent invocation
- Footer status with `[N] local agents` count
- Completion state rendering with background agent awareness
- Ctrl+F termination support for background agents

All of this infrastructure works correctly — the gap is that `stream.agent.complete` never fires for background agents because the adapter-level event gate drops the SDK event before it reaches the UI layer.

### 9. The "Manual Enter to Continue" Behavior

The user reports needing to press Enter to see remaining steps. This is likely caused by the conversation continuation mechanism:

- After `isStreaming` goes `false`, the streaming loop exits
- `flushPendingBackgroundUpdatesToAgent()` is guarded by `!isStreaming` — it CAN flush after the stream ends
- But `session.send()` inside the flush would need to start a NEW streaming loop
- Starting a new streaming loop likely requires `continueQueuedConversationRef` to fire
- This may be gated on user input (Enter keypress) to avoid automatically sending messages

This creates a deadlock: background agent updates are queued and ready to flush, but flushing requires a new stream, and starting a new stream requires user interaction.

## Code References

### Copilot Adapter (Bug Source)

- `src/services/events/adapters/providers/copilot/runtime.ts:142-157` — `finally` block, `state.isActive = false` at line 155
- `src/services/events/adapters/providers/copilot/provider-router.ts:61-67` — Event guard that drops events when `!state.isActive`
- `src/services/events/adapters/providers/copilot/session-handlers.ts:30` — `handleCopilotSessionIdle` stashes reason
- `src/services/events/adapters/providers/copilot/subagent-handlers.ts:90` — `handleCopilotSubagentStart` propagates `isBackground`
- `src/services/events/adapters/providers/copilot/subagent-handlers.ts:150` — `handleCopilotSubagentComplete` never fires post-idle
- `src/services/events/adapters/providers/copilot/support.ts:70-90` — `extractCopilotTaskToolMetadata` detects `isBackground`

### Claude Adapter (Same Pattern)

- `src/services/events/adapters/providers/claude/streaming-runtime.ts:225-235` — `finally` block clears state + publishes idle
- `src/services/events/adapters/providers/claude/tool-state.ts:52,423-450` — `activeSubagentBackgroundById` map
- `src/services/events/adapters/providers/claude/subagent-event-handlers.ts` — Background tracking set/delete

### Stream Completion Pipeline (Provider-Agnostic)

- `src/state/chat/stream/use-session-subscriptions.ts:161` — `stream.session.idle` handler
- `src/state/chat/stream/use-completion.ts:75` — `handleStreamComplete()` 3-gate orchestrator
- `src/state/chat/stream/use-deferred-completion.ts:37-87` — Deferral logic excludes background agents
- `src/state/chat/stream/use-finalized-completion.ts:41-127` — Terminal finalization preserves background agents
- `src/state/chat/stream/use-agent-subscriptions.ts:64-365` — Agent lifecycle event handlers
- `src/state/parts/guards.ts:20-37` — `shouldFinalizeOnToolComplete` and `hasActiveForegroundAgents`

### UI Components

- `src/components/parallel-agents-tree.tsx:15-34,153-166,591-598` — Agent tree with background status support
- `src/lib/ui/background-agent-footer.ts` — Background agent detection and footer
- `src/lib/ui/loading-state.ts:35-78` — Loading indicator and completion summary
- `src/state/chat/controller/use-background-dispatch.ts` — Background message queuing and flush
- `src/lib/ui/stream-continuation.ts:75-161` — Continuation logic and `createStoppedStreamControlState`

### Design Reference

- `docs/ui-design-patterns.md` — Expected background sub-agent UI patterns

## Architecture Documentation

### Current Streaming Architecture (3 Layers)

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: SDK Adapter (Provider-Specific)               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   Copilot    │  │   Claude    │  │  OpenCode   │     │
│  │  runtime.ts  │  │ streaming-  │  │   (TBD)     │     │
│  │              │  │ runtime.ts  │  │             │     │
│  └──────┬───────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                 │                │            │
│         ▼                 ▼                ▼            │
│  ┌──────────────────────────────────────────────┐       │
│  │  publish("stream.*", event)                  │       │
│  │  Provider-agnostic event bus                 │       │
│  └──────────────────┬───────────────────────────┘       │
└─────────────────────┼───────────────────────────────────┘
                      │
┌─────────────────────┼───────────────────────────────────┐
│  Layer 2: State Management (React Hooks)                │
│                     ▼                                   │
│  ┌──────────────────────────────────────────────┐       │
│  │  use-session-subscriptions.ts                │       │
│  │  → stream.session.idle handler               │       │
│  │  → shouldContinueParentSessionLoop()         │       │
│  └──────────────────┬───────────────────────────┘       │
│                     ▼                                   │
│  ┌──────────────────────────────────────────────┐       │
│  │  use-completion.ts (handleStreamComplete)    │       │
│  │  Gate 1: finishInterruptedStreamIfNeeded     │       │
│  │  Gate 2: deferStreamCompletionIfNeeded       │       │
│  │  Gate 3: finalizeCompletedStream             │       │
│  └──────────────────┬───────────────────────────┘       │
│                     ▼                                   │
│  ┌──────────────────────────────────────────────┐       │
│  │  use-finalized-completion.ts                 │       │
│  │  → Preserves background agents               │       │
│  │  → Sets backgroundAgentMessageId             │       │
│  │  → stopSharedStreamState() → isStreaming=false│      │
│  └──────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
                      │
┌─────────────────────┼───────────────────────────────────┐
│  Layer 3: UI Rendering                                  │
│                     ▼                                   │
│  ┌──────────────────────────────────────────────┐       │
│  │  parallel-agents-tree.tsx                    │       │
│  │  → Renders agent tree with status colors     │       │
│  │  → Background agents shown in grey           │       │
│  │  background-agent-footer.ts                  │       │
│  │  → Footer with [N] active agents count       │       │
│  │  loading-state.ts                            │       │
│  │  → Spinner driven by isStreaming state        │       │
│  └──────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
```

### Event Flow Diagram: Background Agent Bug

```
SDK (Copilot/Claude)          Adapter Layer              UI State Layer           UI Rendering
─────────────────────    ─────────────────────     ─────────────────────     ─────────────────

1. session.idle ───────► handleSessionIdle
                         stash pendingIdleReason

2. for-await exhausts

3. finally block ──────► cleanupOrphanedTools
                         publish stream.session.idle ──► handleStreamComplete()
                         state.isActive = false          │
                                                         ├─ Gate 2: no foreground → skip defer
                                                         │
                                                         ├─ Gate 3: finalizeCompletedStream
                                                         │  ├─ bg agents preserved
                                                         │  ├─ backgroundAgentMessageId set
                                                         │  └─ isStreaming = false ─────────► SPINNER STOPS
                                                         │
                                                         └─ Background agent still in parallelAgents
                                                            with status="background"

4. bg agent completes
   subagent.complete ──► provider-router:
                         if (!state.isActive) {
                           return; // DROPPED ✗
                         }
                         handleSubagentComplete
                           NEVER CALLED
                         stream.agent.complete
                           NEVER PUBLISHED ──────────► use-agent-subscriptions
                                                        NEVER TRIGGERED

                                                      Agent stays status="background" FOREVER

5. User presses Enter ─────────────────────────────► New streaming loop starts
                                                     UI re-engages
```

## Historical Context (from research/)

Six prior research documents investigated closely related issues:

- [`research/docs/2026-02-23-258-background-agents-sdk-event-pipeline.md`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/research/docs/2026-02-23-258-background-agents-sdk-event-pipeline.md) — Issue #258 pipeline investigation. Documents the SDK event pipeline for background agents and identifies gaps in event propagation.

- [`research/docs/2026-02-15-subagent-premature-completion-SUMMARY.md`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/research/docs/2026-02-15-subagent-premature-completion-SUMMARY.md) — Executive summary of premature completion investigation. First identified the race condition between idle publication and background agent lifecycle.

- [`research/docs/2026-02-15-subagent-premature-completion-investigation.md`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/research/docs/2026-02-15-subagent-premature-completion-investigation.md) — Root cause analysis of premature completion. Identified `src/ui/index.ts:648-663` and `src/ui/chat.tsx` as primary bug locations (possibly older code path).

- [`research/docs/2026-02-15-subagent-premature-completion-fix-comparison.md`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/research/docs/2026-02-15-subagent-premature-completion-fix-comparison.md) — Code fix comparison. Evaluated multiple approaches to fixing premature completion.

- [`research/docs/2026-02-15-subagent-event-flow-diagram.md`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/research/docs/2026-02-15-subagent-event-flow-diagram.md) — Event flow and race condition diagrams. Visual documentation of the streaming lifecycle.

- [`research/docs/2026-02-16-sub-agent-tree-inline-state-lifecycle-research.md`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/research/docs/2026-02-16-sub-agent-tree-inline-state-lifecycle-research.md) — Sub-agent tree inline state lifecycle. Documents how agents are tracked and rendered in the tree UI.

**Note:** The prior research (Feb 2026) identifies `src/ui/index.ts` and `src/ui/chat.tsx` as primary bug locations. The current codebase appears to have a newer state-based architecture (`src/state/chat/stream/`) that coexists with or replaces the older UI code path. Both exhibit the same fundamental issue.

### Existing Specs

- [`specs/2026-02-22-background-agents-sdk-pipeline-fix.md`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/specs/2026-02-22-background-agents-sdk-pipeline-fix.md) — Specification for fixing the SDK pipeline for background agents.
- [`specs/2026-02-22-background-agents-ui-issue-258-parity-hardening.md`](https://github.com/bastani/atomic/blob/93ca1e2513d78cf8da5e2ab4f5f74d24c8677309/specs/2026-02-22-background-agents-ui-issue-258-parity-hardening.md) — Specification for UI parity hardening related to issue #258.

## Related Research

- `research/docs/2026-02-23-258-background-agents-sdk-event-pipeline.md`
- `research/docs/2026-02-15-subagent-premature-completion-SUMMARY.md`
- `research/docs/2026-02-15-subagent-premature-completion-investigation.md`
- `research/docs/2026-02-15-subagent-premature-completion-fix-comparison.md`
- `research/docs/2026-02-15-subagent-event-flow-diagram.md`
- `research/docs/2026-02-16-sub-agent-tree-inline-state-lifecycle-research.md`
- `specs/2026-02-22-background-agents-sdk-pipeline-fix.md`
- `specs/2026-02-22-background-agents-ui-issue-258-parity-hardening.md`

## Open Questions

1. **Older vs newer code paths:** Prior research (Feb 2026) identifies `src/ui/index.ts:648-663` and `src/ui/chat.tsx` as primary bug locations with 3 finalization paths and 4-5 deferral checks. The current analysis focuses on `src/state/chat/stream/` hooks. Do both code paths execute? Is one a legacy path being replaced? Understanding this would clarify whether a fix needs to target one or both paths.

2. **`session.send()` re-engagement:** Does the `session.send()` call inside `flushPendingBackgroundUpdatesToAgent()` actually trigger a new streaming loop that re-engages the UI? If so, the "Enter to continue" may be a separate issue from the event dropping.

3. **Continuation queue gating:** Is `continueQueuedConversationRef` gated on user input? If the conversation continuation mechanism requires explicit user action to start a new stream, this creates a secondary bottleneck independent of the adapter-level event gate.

4. **OpenCode adapter:** Does the OpenCode adapter (if implemented) share the same pattern? All three adapters share the provider-agnostic UI layer, so the `isStreaming = false` behavior would be identical, but the adapter-level event gating may differ.

5. **`abortBackgroundAgents` full abort:** Both adapters' `abortBackgroundAgents` delegate to the same full abort mechanism — neither performs selective background-only abort. Is this intentional? A Ctrl+C during background agent execution would abort ALL agents rather than just background ones.
