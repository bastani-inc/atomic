---
date: 2026-02-23 00:45:53 UTC
researcher: Copilot
git_commit: b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092
branch: fix/tui-streaming-rendering
repository: atomic
topic: "Fix the thinking tag text getting grouped together across multiple streams"
tags: [research, codebase, streaming, thinking-tags, tui-rendering]
status: complete
last_updated: 2026-02-23
last_updated_by: Copilot
---

# Research

## Research Question

Fix the thinking tag text getting grouped together across multiple streams.

Observed output example:

```text
∴ Thinking...
Planning parallel commit setupFinalizing commit with pre-checks and co-author trailer
```

## Summary

Current code paths collect thinking text by concatenating incoming `thinking` chunks into a single `thinkingText` string for a stream loop, then repeatedly upsert one streaming `ReasoningPart` with the full accumulated text. The UI update path for thinking metadata targets the current `streamingMessageIdRef`, which is a single mutable reference used by stream callbacks, and `ThinkingMetaEvent` carries no stream identifier. Existing codebase patterns show per-session/per-execution separation through keyed `Map` structures in multiple areas, while thinking metadata updates currently flow through unkeyed message-level updates.

## Detailed Findings

### 1) Claude SDK emits thinking deltas as chunked events

- The Claude client handles `content_block_delta` and emits `type: "thinking"` when `event.delta.type === "thinking_delta"` ([src/sdk/clients/claude.ts:730-818](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/sdk/clients/claude.ts#L730-L818)).
- Each emitted thinking message includes `content` and `metadata.streamingStats.thinkingMs/outputTokens` ([src/sdk/clients/claude.ts:801-817](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/sdk/clients/claude.ts#L801-L817)).

### 2) UI stream loop accumulates thinking text by string concatenation

- In `streamAndProcess`, `thinkingText` starts as `""` and is appended with each thinking chunk via `thinkingText += message.content` ([src/ui/index.ts:1338](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/ui/index.ts#L1338), [src/ui/index.ts:1425-1427](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/ui/index.ts#L1425-L1427)).
- The loop publishes accumulated metadata through `onMeta({ ..., thinkingText })` after processing thinking events ([src/ui/index.ts:1446](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/ui/index.ts#L1446)).

### 3) Thinking metadata is applied to the current streaming message

- The chat component updates state by reading `streamingMessageIdRef.current` and applying a `thinking-meta` event to that message ([src/ui/chat.tsx:3440-3456](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/ui/chat.tsx#L3440-L3456), [src/ui/chat.tsx:5138-5155](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/ui/chat.tsx#L5138-L5155)).
- `streamingMessageIdRef` is a single shared ref in this component ([src/ui/chat.tsx:1773](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/ui/chat.tsx#L1773)).

### 4) Stream pipeline keeps one active streaming reasoning part

- `ThinkingMetaEvent` includes `thinkingText`/`thinkingMs` and optional `includeReasoningPart`, with no stream/source ID field ([src/ui/parts/stream-pipeline.ts:49-58](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/ui/parts/stream-pipeline.ts#L49-L58)).
- `upsertThinkingMeta` finds the last streaming reasoning part and replaces its content with `event.thinkingText`; otherwise it creates one reasoning part ([src/ui/parts/stream-pipeline.ts:414-463](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/ui/parts/stream-pipeline.ts#L414-L463)).
- Reasoning display prints a single heading (`Thinking...` while streaming) and renders the accumulated markdown content ([src/ui/components/parts/reasoning-part-display.tsx:46-63](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/ui/components/parts/reasoning-part-display.tsx#L46-L63)).

### 5) Existing separation patterns elsewhere in codebase

- Per-session state in SDK clients uses keyed `Map` structures (e.g., `sessions: Map<string, ClaudeSessionState>`) ([src/sdk/clients/claude.ts:273](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/sdk/clients/claude.ts#L273)).
- Copilot session state uses nested maps for per-session/per-tool identity mapping ([src/sdk/clients/copilot.ts:126](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/sdk/clients/copilot.ts#L126)).
- UI streaming state also uses keyed map structures for tool executions ([src/ui/hooks/use-streaming-state.ts:35-50](https://github.com/bastani/atomic/blob/b29d8b8d3c1fa82a7ad43fc2da310719ac3c4092/src/ui/hooks/use-streaming-state.ts#L35-L50)).

### 6) External documentation references

- Anthropic TypeScript SDK stream event types define `content_block_delta` and `thinking_delta` (`ThinkingDelta`) in the official source: https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/src/resources/messages/messages.ts
- Anthropic TypeScript SDK helper docs describe `MessageStream` event callbacks and accumulated snapshot behavior: https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/helpers.md
- OpenTUI repository docs describe component rendering/update model (`@opentui/core`, `@opentui/react`) used by this project's UI layer: https://github.com/anomalyco/opentui

## Code References

- `src/sdk/clients/claude.ts:730-818` - Stream event handling for `content_block_*` and `thinking_delta`.
- `src/sdk/clients/claude.ts:148-187` - Thinking extraction from completed beta message blocks.
- `src/ui/index.ts:1332-1447` - Thinking accumulator, timing updates, and `onMeta` emission.
- `src/ui/chat.tsx:1773` - Shared `streamingMessageIdRef`.
- `src/ui/chat.tsx:3440-3456` - `handleMeta` updates streaming message via `thinking-meta`.
- `src/ui/chat.tsx:5138-5155` - Additional `handleMeta` path with same update pattern.
- `src/ui/parts/stream-pipeline.ts:49-58` - `ThinkingMetaEvent` shape.
- `src/ui/parts/stream-pipeline.ts:414-463` - `upsertThinkingMeta` behavior.
- `src/ui/components/parts/reasoning-part-display.tsx:46-63` - Single reasoning heading/content render.
- `src/sdk/clients/copilot.ts:126` - Per-session keyed map in client state.
- `src/ui/hooks/use-streaming-state.ts:35-50` - Keyed tool execution state in UI hook.

## Architecture Documentation

- Thinking output travels through a pipeline of: SDK stream event -> UI stream loop accumulation -> message metadata event -> part upsert -> reasoning renderer.
- Accumulation happens as whole-string growth (`thinkingText += chunk`) before rendering.
- Rendering path keeps one active streaming reasoning part per message and updates that part with full accumulated content.
- Message-target selection for thinking updates is resolved through current streaming message reference in chat state.

## Historical Context (from research/)

- `research/docs/2026-02-12-tui-layout-streaming-content-ordering.md` - Documents stream content ordering via offsets and mixed rendering paths.
- `research/docs/2026-02-15-ui-inline-streaming-vs-pinned-elements.md` - Documents inline stream segments vs pinned UI elements.
- `research/docs/2026-02-09-token-count-thinking-timer-bugs.md` - Documents streaming metadata/timing behavior across SDKs.
- `research/docs/2026-02-17-message-truncation-dual-view-system.md` - Documents message windowing and transcript architecture around active streaming UI.

## Related Research

- `research/docs/2026-02-16-opentui-rendering-architecture.md`
- `research/docs/2026-02-16-opencode-message-rendering-patterns.md`
- `research/docs/2026-02-16-atomic-chat-architecture-current.md`
- `research/docs/2026-02-16-sub-agent-tree-inline-state-lifecycle-research.md`

## Open Questions

- Under which runtime paths multiple simultaneous thinking producers can target the same streaming message in practice (foreground stream overlap, background handoff, or queued replacement windows).
- Whether all SDK clients provide equivalent source identity for thinking events at the point they enter `streamAndProcess`.
- How often concurrent `handleMeta` callbacks can interleave around streaming message ID transitions during round-robin interruption paths.
