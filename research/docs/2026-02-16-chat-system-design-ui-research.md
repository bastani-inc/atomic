---
date: 2026-02-16 08:01:24 UTC
researcher: GitHub Copilot CLI
git_commit: f4c3330950f6747dc6ccc64e942743f1a0bfefa2
branch: lavaman131/hotfix/sub-agent-display
repository: atomic
topic: "Chat system design & UI research: drawing from OpenCode TUI and OpenTUI rendering architecture"
tags:
    [
        research,
        codebase,
        tui,
        chat-ui,
        opencode,
        opentui,
        sub-agents,
        streaming,
        content-ordering,
        hitl,
        frontend-design,
    ]
status: complete
last_updated: 2026-02-16
last_updated_by: GitHub Copilot CLI
---

# Research: Chat System Design & UI

## Research Question

Deep-dive into `docs/opencode` and `docs/opentui` to draw inspiration about how to properly implement the chat system design + UI, specifically addressing:

1. Custom UI rendering components failing to have correct states for the sub-agent tree
2. Components like ask_question and sub-agent tree not correctly placed in stream order
3. Preserving the chatbox top-to-bottom streaming and bottom-pinning behavior

## Summary

This research synthesizes findings from 7 parallel sub-agent investigations covering the OpenCode TUI architecture (`docs/opencode/`), OpenTUI rendering primitives (`docs/opentui/`), and the current Atomic CLI chat system (`src/ui/chat.tsx`). The core architectural difference is that **OpenCode uses an ordered parts-based message model** where every content type (text, tools, sub-agents, HITL prompts) is a first-class `Part` object sorted by timestamp-encoded IDs, while **Atomic uses an offset-based segment model** (`buildContentSegments()`) that captures character offsets and splices text at those positions. This difference is the root cause of all three reported issues.

**Key findings:**

| Aspect              | OpenCode (Reference)                                               | Atomic (Current)                                                                                   |
| ------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Message model       | `Part[]` array sorted by monotonic ID                              | `content: string` + offset-based `buildContentSegments()`                                          |
| Content ordering    | Part IDs encode creation timestamp → lexicographic = chronological | Character offset capture at `msg.content.length` → fragile arithmetic                              |
| Sub-agent tree      | Inline as task tool's child session tool parts                     | `AgentPart` segment inserted by offset, but multiple finalization paths mark completed prematurely |
| HITL (ask_question) | Overlay on ToolPart via `tool.callID` linkage, rendered inline     | Fixed-position dialog inside ScrollBox, not at chronological position                              |
| Background agents   | Tool mode drives status assignment                                 | `background` status defined in types but never assigned at runtime                                 |
| Text interleaving   | New TextPart created after each tool boundary                      | Text after tool appears in segments area, but meta-components stay pinned below                    |
| ScrollBox           | `stickyScroll: true, stickyStart: "bottom"` (OpenTUI)              | Same ScrollBox configuration (no change needed)                                                    |

## Detailed Findings

### 1. OpenCode TUI Chat Architecture

**Source:** `docs/opencode/` (local copy of `anomalyco/opencode`)

#### 1.1 Parts-Based Message Model

OpenCode represents messages using an ordered array of typed `Part` objects. Each part has a discriminated union type:

- **TextPart** (`docs/opencode/packages/sdk/js/src/v2/gen/types.gen.ts:263-278`): `id`, `messageID`, `text`, `time.start/end`
- **ToolPart** (`types.gen.ts:419-430`): `id`, `messageID`, `callID`, `tool`, `state` (pending/running/completed/error)
- **ReasoningPart** (`types.gen.ts:295-308`): `id`, `messageID`, `text`, `time`
- **AgentPart** (`types.gen.ts:477-488`): `id`, `messageID`, `name`, `source`
- **SubtaskPart** (`types.gen.ts:280-293`): `id`, `messageID`, `prompt`, `description`, `agent`
- 6+ additional part types (FilePart, StepStartPart, StepFinishPart, PatchPart, RetryPart, CompactionPart)

#### 1.2 ID-Based Chronological Ordering

Part IDs encode creation timestamps for automatic chronological sorting:

- **Generation** (`docs/opencode/packages/opencode/src/id/id.ts:55-74`): `Identifier.ascending("part")` produces `prt_<12-hex-chars><14-random-base62>`
- First 6 bytes encode: `(timestamp_ms * 0x1000 + counter)` in big-endian
- **Result**: Lexicographic sorting of IDs = chronological ordering
- **Database**: Parts retrieved with `ORDER BY id` (`docs/opencode/packages/opencode/src/session/message-v2.ts:771`)
- **Frontend**: Binary search insertion maintains sorted order (`docs/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx:281-298`)

#### 1.3 Rendering Pipeline

```
Stream Event → Session.updatePart() → Database → Bus event → SSE →
Frontend listener → Binary search insert in store → SolidJS reactive render →
<For each={parts}> → PART_MAPPING[part.type] → Dynamic component
```

- **Part registry** (`docs/opencode/packages/ui/src/components/message-part.tsx:484-497`): `PART_MAPPING` maps part types to renderer components
- **Dynamic dispatch**: `<Dynamic component={PART_MAPPING[part.type]} part={part} />`
- **Throttled text rendering**: `createThrottledValue()` at 100ms intervals for text deltas

#### 1.4 HITL/Ask Question Implementation

Questions are **NOT separate parts**. They are session-scoped requests linked to tool parts via `tool.callID`:

- **Store structure** (`docs/opencode/packages/ui/src/context/data.tsx:25-30`): `question: { [sessionID]: QuestionRequest[] }`
- **QuestionRequest** (`types.gen.ts:643-654`): Contains `id`, `sessionID`, `questions[]`, and optional `tool: { messageID, callID }`
- **Rendering** (`message-part.tsx:547-665`): `ToolPartDisplay` checks if the first pending question matches this tool's `callID`. If so, it renders `<QuestionPrompt>` immediately after the tool UI.
- **50ms delay** before showing question for smooth appearance (`message-part.tsx:618-625`)
- **Effect**: Question appears inline at the chronological position where the tool is in the message stream

#### 1.5 Sub-Agent (Task Tool) Implementation

- **Child session syncing** (`message-part.tsx:879-901`): When task tool completes with `metadata.sessionId`, the UI syncs that child session's data
- **Child tool parts** (`message-part.tsx:948-1071`): `getSessionToolParts()` collects all tool parts from the child session and renders them as a flat list
- **Status**: Derived from tool state (pending/running/completed/error) — same discriminated union

### 2. OpenTUI Rendering Architecture

**Source:** `docs/opentui/` (local copy of `anomalyco/opentui`)

#### 2.1 Core Primitives

- **BoxRenderable** (`docs/opentui/packages/core/src/renderables/Box.ts`): Container with borders, backgrounds, Yoga flexbox layout, gap properties
- **TextRenderable** (`docs/opentui/packages/core/src/renderables/Text.ts`): Styled text with child TextNode tree
- **ScrollBoxRenderable** (`docs/opentui/packages/core/src/renderables/ScrollBox.ts`): Scrollable container with sticky scroll, viewport culling, scrollbars

#### 2.2 ScrollBox Sticky Behavior

- **Component hierarchy** (ScrollBox.ts:60-67): `wrapper → viewport → content + scrollbars`
- **Options**: `stickyScroll: boolean`, `stickyStart: "bottom" | "top" | "left" | "right"`
- **State tracking** (lines 87-95): `_stickyScrollBottom`, `_hasManualScroll`, `_isApplyingStickyScroll`
- **Auto-scroll flow**:
    1. Content height increases → `onSizeChange` → `recalculateBarProps()` (lines 633-678)
    2. If `stickyScroll && !_hasManualScroll`: snap to `maxScrollTop` (lines 647-661)
    3. User scrolls up → `_hasManualScroll = true` → pauses auto-scroll
    4. User scrolls back to bottom → `updateStickyState()` clears manual flag → resumes

#### 2.3 Layout Engine

- **Yoga/Flexbox integration** (`Renderable.ts:199-201`): Shared Yoga config, each renderable wraps a Yoga node
- **Three-pass rendering**: Lifecycle pass → Layout calculation → Render list building
- **Delta rendering**: Cell-by-cell diff for efficient terminal updates
- **Viewport culling**: O(log n + k) algorithm for visible children

#### 2.4 React Integration

- **Host config reconciler** (`docs/opentui/packages/react/src/host-config.ts`): Maps React JSX to OpenTUI renderables
- **Component catalogue** (`docs/opentui/packages/react/src/components.ts`): Registers `box`, `text`, `scrollbox`, `input`, etc.
- **Hooks**: Standard React hooks (`useState`, `useEffect`) work normally; OpenTUI-specific hooks include `useRenderer()`, `useKeyboard()`, `useTerminalDimensions()`

### 3. Current Atomic Chat Architecture

**Source:** `src/ui/chat.tsx` and related components

#### 3.1 Offset-Based Content Segments

The `buildContentSegments()` function (`src/ui/chat.tsx:1287-1483`) constructs segments by:

1. Capturing `contentOffsetAtStart = msg.content.length` when tools start
2. Sorting tool calls by offset
3. Slicing text at offset positions to create interleaved text/tool segments
4. Adding agent and task segments at their captured offsets

#### 3.2 Sub-Agent Tree Issues

**Premature completion** — Multiple finalization paths mark agents "completed" while background tasks may still run:

- `tool.complete` handler (`src/ui/index.ts:649-664`): Unconditionally sets running/pending → completed
- Stream finalization effect (`src/ui/chat.tsx:2672-2680`): Maps all running → completed
- Normal completion path (`src/ui/chat.tsx:3335-3341`): Same finalization
- Alternate completion path (`src/ui/chat.tsx:4774-4780`): Same finalization

**Background status never assigned** — `background` exists in `AgentStatus` type (`src/ui/components/parallel-agents-tree.tsx:26`) and in rendering logic, but no runtime code ever sets `status: "background"`.

#### 3.3 HITL Placement Issue

The `UserQuestionDialog` is rendered as a **fixed-position overlay** inside the ScrollBox (`src/ui/chat.tsx:5358-5364`), not at the chronological position where the question was asked. This means if text streams after the question, the question dialog stays at the bottom rather than appearing inline with the tool that triggered it.

#### 3.4 Layout Structure

```
<box flexDirection="column">
  [Compaction/Todo summary — above scrollbox]
  <scrollbox stickyScroll={true} stickyStart="bottom">
    [Message stream]
    [Input area]
    [Active HITL dialog — fixed position, should be inline]
  </scrollbox>
  [TaskListPanel — pinned below scrollbox for Ralph]
</box>
```

### 4. Key Architectural Differences

#### 4.1 Message Model Comparison

| Feature         | OpenCode                                      | Atomic                                             |
| --------------- | --------------------------------------------- | -------------------------------------------------- |
| Content storage | `Part[]` array (typed objects)                | `content: string` (raw text)                       |
| Tool tracking   | ToolPart within parts array                   | `toolCalls: MessageToolCall[]` (separate array)    |
| Agent tracking  | Task tool child session sync                  | `parallelAgents: ParallelAgent[]` (separate array) |
| HITL tracking   | QuestionRequest linked to ToolPart via callID | `UserQuestionDialog` as fixed-position overlay     |
| Ordering        | Part ID lexicographic sort                    | Character offset arithmetic                        |
| Interleaving    | Natural — new TextPart after each tool        | Computed — `buildContentSegments()` splices text   |

#### 4.2 Why OpenCode's Approach Solves Atomic's Issues

1. **Sub-agent state correctness**: Parts have explicit state machines (pending → running → completed/error). No offset-based "meta-component" that sits outside the segment flow.

2. **Stream ordering**: Parts are ordered by creation timestamp IDs. When text arrives after a tool, it's a new TextPart with a later ID — automatically positioned after the tool. No offset arithmetic needed.

3. **HITL placement**: Questions overlay the ToolPart that triggered them. The ToolPart's position in the parts array IS the chronological position. No need for a separate dialog.

### 5. Frontend Design Synthesis

A comprehensive design reference has been generated at `research/docs/2026-02-16-chat-system-design-reference.md` covering:

1. **Message Part Model** (§3): Full TypeScript type definitions for all Part types, with discriminated unions for tool state
2. **Rendering Pipeline** (§4): Event → Part mapping, binary search insertion, text delta accumulation, throttled rendering
3. **Component Composition** (§5): PART_REGISTRY dispatch, MessageBubble with inline parts, ToolPartDisplay with inline HITL
4. **Sub-Agent Lifecycle** (§6): Corrected state machine with background agent handling, `shouldFinalizeOnToolComplete()` guard
5. **Stream Ordering** (§7): Timestamp-encoded IDs, concurrent tool handling, text splitting at tool boundaries
6. **Layout & ScrollBox** (§8): Unchanged ScrollBox config, content layout, message window eviction
7. **Migration Strategy** (§9): 5-phase incremental migration plan with risk mitigations

Key design decisions in the reference:

- Parts replace segments — ordered `Part[]` with timestamp-encoded IDs replaces `buildContentSegments()`
- HITL is a tool overlay — questions render inline after their ToolPart, not as fixed-position dialogs
- Background agents have distinct lifecycle — `shouldFinalizeOnToolComplete()` guard at every finalization path
- Text splits naturally — new TextPart created after each tool boundary, eliminating offset arithmetic
- Binary search maintains order — incremental insertion, no full re-sort
- Throttled rendering — 100ms debounce on TextPart content
- ScrollBox untouched — `stickyScroll=true, stickyStart="bottom"` preserved exactly

## Code References

### OpenCode TUI

- [`docs/opencode/packages/sdk/js/src/v2/gen/types.gen.ts:263-522`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opencode/packages/sdk/js/src/v2/gen/types.gen.ts#L263-L522) — Part type definitions
- [`docs/opencode/packages/opencode/src/id/id.ts:55-74`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opencode/packages/opencode/src/id/id.ts#L55-L74) — Timestamp-encoded ID generation
- [`docs/opencode/packages/opencode/src/session/message-v2.ts:771`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opencode/packages/opencode/src/session/message-v2.ts#L771) — Parts ordered by ID
- [`docs/opencode/packages/opencode/src/session/processor.ts:45-349`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opencode/packages/opencode/src/session/processor.ts#L45-L349) — Stream processing pipeline
- [`docs/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx:281-318`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx#L281-L318) — Binary search insertion in store
- [`docs/opencode/packages/ui/src/components/message-part.tsx:484-497`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opencode/packages/ui/src/components/message-part.tsx#L484-L497) — Part registry + dynamic dispatch
- [`docs/opencode/packages/ui/src/components/message-part.tsx:535-667`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opencode/packages/ui/src/components/message-part.tsx#L535-L667) — ToolPartDisplay with inline HITL
- [`docs/opencode/packages/ui/src/components/message-part.tsx:874-1077`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opencode/packages/ui/src/components/message-part.tsx#L874-L1077) — Task tool sub-agent rendering
- [`docs/opencode/packages/ui/src/components/session-turn.tsx:186-289`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opencode/packages/ui/src/components/session-turn.tsx#L186-L289) — SessionTurn message hierarchy

### OpenTUI

- [`docs/opentui/packages/core/src/renderables/ScrollBox.ts:44-58`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opentui/packages/core/src/renderables/ScrollBox.ts#L44-L58) — ScrollBoxOptions
- [`docs/opentui/packages/core/src/renderables/ScrollBox.ts:87-95`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opentui/packages/core/src/renderables/ScrollBox.ts#L87-L95) — Sticky scroll state variables
- [`docs/opentui/packages/core/src/renderables/ScrollBox.ts:161-227`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opentui/packages/core/src/renderables/ScrollBox.ts#L161-L227) — Sticky scroll state machine
- [`docs/opentui/packages/core/src/renderables/ScrollBox.ts:633-678`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opentui/packages/core/src/renderables/ScrollBox.ts#L633-L678) — recalculateBarProps (auto-scroll on content grow)
- [`docs/opentui/packages/core/src/renderables/Box.ts`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opentui/packages/core/src/renderables/Box.ts) — BoxRenderable container
- [`docs/opentui/packages/react/src/host-config.ts`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/docs/opentui/packages/react/src/host-config.ts) — React reconciler host config

### Atomic CLI (Current)

- [`src/ui/chat.tsx:1287-1483`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/src/ui/chat.tsx#L1287-L1483) — buildContentSegments()
- [`src/ui/chat.tsx:1502-1757`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/src/ui/chat.tsx#L1502-L1757) — MessageBubble rendering
- [`src/ui/chat.tsx:2607-2631`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/src/ui/chat.tsx#L2607-L2631) — Parallel agent bridge to streaming message
- [`src/ui/chat.tsx:5358-5364`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/src/ui/chat.tsx#L5358-L5364) — Fixed-position HITL dialog
- [`src/ui/index.ts:649-664`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/src/ui/index.ts#L649-L664) — tool.complete premature agent finalization
- [`src/ui/components/parallel-agents-tree.tsx:26`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/src/ui/components/parallel-agents-tree.tsx#L26) — AgentStatus type with background
- [`src/ui/components/parallel-agents-tree.tsx:158-166`](https://github.com/bastani-inc/atomic/blob/f4c3330950f6747dc6ccc64e942743f1a0bfefa2/src/ui/components/parallel-agents-tree.tsx#L158-L166) — Status color mapping

## Architecture Documentation

### Current Architecture (Atomic)

```
SDK Events → handleChunk/handleToolStart/handleToolComplete
  → ChatMessage state updates (content string, toolCalls array, parallelAgents array)
  → React re-render
  → buildContentSegments(content, toolCalls) + fixed-position meta-components
  → MessageBubble renders: [segments...] + [agents tree] + [spinner] + [tasks]
  → OpenTUI Yoga layout → terminal output
```

**Issues with current architecture:**

- Text segments and meta-components (agents tree, task list, HITL dialog) live in separate rendering channels
- Meta-components are always rendered after all segments, regardless of chronological position
- Multiple finalization paths can mark agents completed while still running
- `background` status is typed but never assigned

### Reference Architecture (OpenCode)

```
SDK Events → Session.updatePart() → Database upsert → Bus event → SSE transport
  → Frontend listener → Binary search insert in store by Part ID
  → SolidJS reactive render
  → <For each={filteredParts()}> → PART_MAPPING[part.type] → Dynamic component
  → OpenTUI Yoga layout → terminal output
```

**Why this solves the issues:**

- All content types are parts in a single sorted array — no separate channels
- Part IDs encode creation time — ordering is automatic and deterministic
- Tool state is a discriminated union with explicit transitions — no ambiguous finalization
- HITL overlays the ToolPart that triggered it — inherits chronological position

## Historical Context (from research/)

- `research/docs/2026-02-16-opencode-tui-chat-architecture.md` — Full OpenCode TUI architecture analysis with code examples
- `research/docs/2026-02-16-opentui-rendering-architecture.md` — Full OpenTUI rendering primitives documentation
- `research/docs/2026-02-16-atomic-chat-architecture-current.md` — Current Atomic chat.tsx comprehensive reference
- `research/docs/2026-02-16-opencode-deepwiki-research.md` — DeepWiki findings for OpenCode message/streaming/HITL patterns
- `research/docs/2026-02-16-opentui-deepwiki-research.md` — DeepWiki findings for OpenTUI ScrollBox/rendering/events
- `research/docs/2026-02-16-opencode-message-rendering-patterns.md` — Concrete code patterns from OpenCode
- `research/docs/2026-02-16-chat-system-design-reference.md` — Frontend design synthesis with full type definitions, migration strategy
- `research/docs/2026-02-15-ui-inline-streaming-vs-pinned-elements.md` — Prior inline vs pinned analysis
- `research/docs/2026-02-16-sub-agent-tree-inline-state-lifecycle-research.md` — Prior sub-agent state lifecycle analysis
- `research/docs/2026-02-15-sub-agent-tree-status-lifecycle-sdk-parity.md` — SDK parity for lifecycle events
- `research/docs/2026-02-12-tui-layout-streaming-content-ordering.md` — Prior content ordering analysis

## Related Research

- `research/docs/2026-02-12-sdk-ui-standardization-comprehensive.md`
- `research/docs/2026-02-14-subagent-output-propagation-issue.md`
- `research/docs/2026-02-15-subagent-premature-completion-investigation.md`
- `research/docs/2026-02-15-subagent-event-flow-diagram.md`
- `research/docs/2026-02-01-chat-tui-parity-implementation.md`
- `research/docs/2026-02-01-claude-code-ui-patterns-for-atomic.md`

## Open Questions

1. **Migration scope**: Should the parts-based model be adopted incrementally (phase-by-phase as described in the design reference) or as a single large refactor?
2. **SolidJS vs React**: OpenCode uses SolidJS for fine-grained reactivity; Atomic uses React. The parts model works with both, but SolidJS's `createMemo` + `<For>` provides more efficient granular updates than React's full re-render model. Should Atomic consider adopting SolidJS patterns via OpenTUI's React reconciler?
3. **Database persistence**: OpenCode persists parts to SQLite and syncs via SSE. Atomic currently uses in-memory state only. Should parts be persisted for session recovery?
4. **Ralph task panel**: The pinned TaskListPanel for Ralph workflows operates outside the message stream intentionally. Should it remain pinned or also become inline? (Current design reference keeps it pinned.)
5. **Viewport culling**: Atomic currently sets `viewportCulling={false}` for text selection. Could the parts model enable culling since each part is a discrete renderable?
