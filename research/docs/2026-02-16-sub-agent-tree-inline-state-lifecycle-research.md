---
date: 2026-02-16 04:28:43 UTC
researcher: GitHub Copilot CLI
git_commit: 460864d3c6a18c43126eaa7d0945e7dfa3803d6a
branch: lavaman131/hotfix/sub-agent-display
repository: atomic
topic: "Sub-agent tree inline rendering and lifecycle state correctness while background tasks continue running"
tags:
    [
        research,
        codebase,
        tui,
        sub-agents,
        streaming,
        status-lifecycle,
        debugger,
        frontend-design,
    ]
status: complete
last_updated: 2026-02-16
last_updated_by: GitHub Copilot CLI
---

# Research

## Research Question

Use frontend-design/debugger-style investigation to review incorrect sub-agent state behavior in the TUI sub-agent tree, ensure tree rendering stays inline with stream content (not pinned), and verify lifecycle state signaling: grey pending/in-progress, yellow interrupted (Ctrl+C/ESC), red spawn failure, green successful completion. Investigate why state is marked done while background tasks are still running.

## Summary

The sub-agent tree is implemented as an inline content segment in the assistant stream, not as a pinned panel. Premature “done/green” state comes from lifecycle finalization paths that convert `running/pending` to `completed` during `tool.complete` and message finalization, even when background work may still be active. Color semantics already match the requested mapping (`completed` green, `interrupted` yellow, `error` red, otherwise muted/grey), but `background` is defined in types/render logic and is not assigned in runtime state transitions.

## Detailed Findings

### 1) Sub-agent tree is inline in the chat stream

- Segment builder inserts `agents` segments by content offset in `buildContentSegments` (`src/ui/chat.tsx:1287-1482`).
- Agent groups are inserted using task/tool offsets (`src/ui/chat.tsx:1346-1378`).
- Message rendering maps `segment.type === "agents"` to `<ParallelAgentsTree .../>` inline (`src/ui/chat.tsx:1687-1702`).
- Live updates are anchored into the currently streaming message (`src/ui/chat.tsx:2626-2638`), explicitly to avoid “last-row overlay” behavior.

### 2) Pinned rendering exists for Ralph task panel, not for sub-agent tree

- `TaskListPanel` is rendered outside chat scrollbox only when `ralphSessionDir` is active (`src/ui/chat.tsx:5416-5422`).
- Inline task rendering is gated by `inlineTasksEnabled={!ralphSessionDir}` and `message.tasksPinned` (`src/ui/chat.tsx:1598-1602`, `src/ui/chat.tsx:5220`).
- Sub-agent tree does not use this pinned panel path; it remains segment-based inline rendering.

### 3) Status model and color semantics

- Agent status union: `"pending" | "running" | "completed" | "error" | "background" | "interrupted"` (`src/ui/components/parallel-agents-tree.tsx:26`).
- Color mapping in `getStatusIndicatorColor`:
    - `completed` -> success/green
    - `interrupted` -> warning/yellow
    - `error` -> error/red
    - all other statuses -> muted/grey (`src/ui/components/parallel-agents-tree.tsx:158-166`).
- Header state derives from status counts and marks finished when `runningCount === 0` and completed agents exist (`src/ui/components/parallel-agents-tree.tsx:607-651`).

### 4) Lifecycle transition flow for sub-agents

- `tool.start` for Task eagerly creates an agent with `status: "running"` (`src/ui/index.ts:517-541`).
- `subagent.start` correlates and updates/merges eager entry (`src/ui/index.ts:784-867`).
- `subagent.complete` sets terminal status to completed or error based on `success` (`src/ui/index.ts:871-895`).
- `tool.complete` also writes result and can force running/pending -> completed (`src/ui/index.ts:649-664`, `src/ui/index.ts:707-714`).

### 5) Why states can be marked done before background work truly finishes

- Primary early-completion path:
    - `tool.complete` finalizes status when agent is `running/pending` (`src/ui/index.ts:658-660`).
- Additional finalization paths in chat stream completion also convert `running/pending` to completed:
    - agent-only stream finalization (`src/ui/chat.tsx:2672-2680`)
    - normal completion path (`src/ui/chat.tsx:3335-3341`)
    - alternate completion path (`src/ui/chat.tsx:4774-4780`)
- Active/defer checks only consider `running/pending` and not `background`:
    - UI index cleanup gate (`src/ui/index.ts:467-470`)
    - stream defer checks (`src/ui/chat.tsx:2645-2649`, `src/ui/chat.tsx:3327-3332`, `src/ui/chat.tsx:4766-4771`).
- Runtime creation path sets eager agents to `running` regardless of Task mode (`src/ui/index.ts:534`), while Task UI renderer reads `input.mode` only for display (`src/ui/tools/registry.ts:693-697`).

### 6) Interrupt and failure signaling paths

- Interrupt path maps `running/pending` -> `interrupted` and clears live agents (`src/ui/chat.tsx:3905-3917`).
- Failure path maps `subagent.complete` with `success === false` to `error` (`src/ui/index.ts:882-887`).

### 7) SDK parity for lifecycle events

- Unified event contract includes `subagent.start` and `subagent.complete` (`src/sdk/types.ts:274-287`, `src/sdk/types.ts:390-413`).
- Copilot maps `subagent.started/completed/failed` into unified events (`src/sdk/copilot-client.ts:132-146`).
- Claude maps `SubagentStart/SubagentStop` hook events (`src/sdk/claude-client.ts:112-121`).
- OpenCode maps `agent` and `step-finish` parts into subagent events (`src/sdk/opencode-client.ts:654-669`).

### 8) Concrete change surfaces identified by debugger-style analysis

Observed code locations that govern the incorrect premature completion behavior:

- `src/ui/index.ts:658-660`, `src/ui/index.ts:711`
- `src/ui/chat.tsx:2673-2678`, `src/ui/chat.tsx:3339-3340`, `src/ui/chat.tsx:4778-4779`
- `src/ui/index.ts:467-470`, `src/ui/chat.tsx:2645-2649`, `src/ui/chat.tsx:3327-3332`, `src/ui/chat.tsx:4766-4771`

These are the current-state transition points where background-aware lifecycle handling would need to be applied for strict correctness.

## Code References

- [`src/ui/chat.tsx:1287-1482`](https://github.com/bastani/atomic/blob/460864d3c6a18c43126eaa7d0945e7dfa3803d6a/src/ui/chat.tsx#L1287-L1482) - Segment construction and inline insertion model.
- [`src/ui/chat.tsx:1687-1702`](https://github.com/bastani/atomic/blob/460864d3c6a18c43126eaa7d0945e7dfa3803d6a/src/ui/chat.tsx#L1687-L1702) - Inline rendering of `ParallelAgentsTree`.
- [`src/ui/chat.tsx:2626-2638`](https://github.com/bastani/atomic/blob/460864d3c6a18c43126eaa7d0945e7dfa3803d6a/src/ui/chat.tsx#L2626-L2638) - Live-agent anchoring into streaming message.
- [`src/ui/chat.tsx:5416-5422`](https://github.com/bastani/atomic/blob/460864d3c6a18c43126eaa7d0945e7dfa3803d6a/src/ui/chat.tsx#L5416-L5422) - Pinned Ralph task panel render path.
- [`src/ui/components/parallel-agents-tree.tsx:26`](https://github.com/bastani/atomic/blob/460864d3c6a18c43126eaa7d0945e7dfa3803d6a/src/ui/components/parallel-agents-tree.tsx#L26) - `AgentStatus` union.
- [`src/ui/components/parallel-agents-tree.tsx:158-166`](https://github.com/bastani/atomic/blob/460864d3c6a18c43126eaa7d0945e7dfa3803d6a/src/ui/components/parallel-agents-tree.tsx#L158-L166) - Status color mapping.
- [`src/ui/index.ts:517-541`](https://github.com/bastani/atomic/blob/460864d3c6a18c43126eaa7d0945e7dfa3803d6a/src/ui/index.ts#L517-L541) - Eager Task agent creation.
- [`src/ui/index.ts:871-895`](https://github.com/bastani/atomic/blob/460864d3c6a18c43126eaa7d0945e7dfa3803d6a/src/ui/index.ts#L871-L895) - Subagent completion status mapping.
- [`src/ui/index.ts:649-664`](https://github.com/bastani/atomic/blob/460864d3c6a18c43126eaa7d0945e7dfa3803d6a/src/ui/index.ts#L649-L664) - Tool-complete result propagation and status finalization.
- [`src/ui/chat.tsx:3335-3341`](https://github.com/bastani/atomic/blob/460864d3c6a18c43126eaa7d0945e7dfa3803d6a/src/ui/chat.tsx#L3335-L3341) - Stream completion finalization mapping.
- [`src/ui/chat.tsx:3905-3911`](https://github.com/bastani/atomic/blob/460864d3c6a18c43126eaa7d0945e7dfa3803d6a/src/ui/chat.tsx#L3905-L3911) - Interrupt mapping to `interrupted`.
- [`src/ui/tools/registry.ts:693-697`](https://github.com/bastani/atomic/blob/460864d3c6a18c43126eaa7d0945e7dfa3803d6a/src/ui/tools/registry.ts#L693-L697) - Task `mode` captured for display.
- [`src/sdk/types.ts:274-287`](https://github.com/bastani/atomic/blob/460864d3c6a18c43126eaa7d0945e7dfa3803d6a/src/sdk/types.ts#L274-L287) - Unified event type contract.

## Architecture Documentation

Current architecture combines:

1. Event-driven sub-agent lifecycle in `src/ui/index.ts` (tool/subagent start/complete handlers),
2. Inline segment composition in `buildContentSegments` (`src/ui/chat.tsx`),
3. Message-anchored live updates (`src/ui/chat.tsx` effect at `2626-2638`),
4. Theme/status rendering in `ParallelAgentsTree` (`src/ui/components/parallel-agents-tree.tsx`).

This architecture already supports inline sub-agent-tree rendering, but completion-state correctness depends on finalization gates and status transitions in several call sites.

## Historical Context (from research/)

- `research/docs/2026-02-15-sub-agent-tree-status-lifecycle-sdk-parity.md` - prior lifecycle and SDK-parity mapping.
- `research/docs/2026-02-15-ui-inline-streaming-vs-pinned-elements.md` - inline-vs-pinned behavior analysis.
- `research/docs/2026-02-14-subagent-output-propagation-issue.md` - prior rendering/lifecycle observations.
- `research/docs/2026-02-15-subagent-premature-completion-investigation.md` - debugger-focused root-cause trace.
- `research/docs/2026-02-15-subagent-event-flow-diagram.md` - event timeline diagrams for lifecycle paths.

## Related Research

- `research/docs/2026-02-15-subagent-premature-completion-SUMMARY.md`
- `research/docs/2026-02-15-subagent-premature-completion-quick-ref.md`
- `research/docs/2026-02-15-subagent-premature-completion-fix-comparison.md`
- `research/docs/2026-02-12-tui-layout-streaming-content-ordering.md`
- `specs/2026-02-16-ui-inline-streaming-vs-pinned-elements.md`
- `specs/2026-02-14-subagent-output-propagation-fix.md`

## Open Questions

- What is the canonical event that should mark background-mode Task agents terminal in UI (`subagent.complete`, `read_agent`, or another completion signal)?
- Should `background` be assigned as a first-class runtime status (currently typed/rendered but not assigned)?
- Should finalization checks treat `background` as active for deferral logic across all completion paths?
