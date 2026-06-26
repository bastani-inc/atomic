# Online best practices for stable React/TUI widgets with fresh per-event wrapper objects

_Date: 2026-06-26_

## Summary

The strongest guidance from React’s official docs is: **do not let ephemeral object identity determine UI ownership or component identity**. When a framework creates a fresh wrapper/context object for each event, treat that object as an event payload, not as the identity of a panel/session/subagent. Use stable semantic IDs, stable keys, and a render tree whose component types/positions match across updates. For terminal UIs, tests should assert that frequent context/event replacement updates live state without unmounting or clearing already-rendered subtrees.

Cached docs checked first:

- `research/web/2026-06-26-react-list-keys-preserving-state-batching.md`
- `research/web/2026-06-26-ink-rendering-options-static-testing.md`
- `research/web/2026-04-08-opentui-testing.md`
- `research/web/2026-04-12-opentui-bun-react19-anti-patterns.md`

New useful source excerpts were persisted to:

- `research/web/2026-06-26-react-terminal-tui-identity-stability-best-practices.md`

## Detailed Findings

### Stable keys and semantic identity

**Source**: React docs, [Rendering Lists: keeping list items in order with `key`](https://react.dev/learn/rendering-lists#keeping-list-items-in-order-with-key)

**Key information**:

- Keys tell React “which array item each component corresponds to” so React can match children after sorting, insertion, or deletion.
- React’s rules: keys “must be unique among siblings” and “must not change”.
- React explicitly warns not to generate keys during render: `key={Math.random()}` causes keys to never match, recreates components/DOM every render, is slow, and loses user input/state.

**Practical implication for issue 1517**:

- Key subagent rows/cards/panes by a stable subagent/session ID, not by wrapper/context object identity, array index, or render-time generated values.
- Tests should simulate repeated events that create fresh wrapper objects for the same subagent and assert that the same visible row/pane remains mounted and does not blank/flicker.

### Preserve mounted subtrees by preserving tree position and component type

**Source**: React docs, [Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state)

**Key information**:

- React state is tied to a component’s position in the render tree.
- React preserves a component’s state while “the same component” remains at “the same position” in the UI tree.
- If a component is removed or a different component/wrapper type is rendered at the same position, React destroys state for that subtree.
- Rule of thumb from the docs: to preserve state between re-renders, the tree structure needs to “match up”.

**Practical implication for issue 1517**:

- Avoid conditionally swapping wrapper types around a live TUI region during event bursts. Prefer a stable outer component and stable child positions, with props changing inside it.
- Do not encode “active/inactive/loading/connected” by replacing a mounted live subtree with a different component type unless reset is intentional.
- Tests should verify that status/log/output subtrees retain previously rendered content across rapid context replacement and phase transitions.

### Avoid creating component identity inside render

**Source**: React docs, [Preserving and Resetting State — nested component function pitfall](https://react.dev/learn/preserving-and-resetting-state#different-components-at-the-same-position-reset-state)

**Key information**:

- Defining a component function inside another component creates a new function on every parent render.
- React treats that as a different component at the same position and resets all state below it.

**Practical implication for issue 1517**:

- Keep TUI widget component functions top-level/stable. Do not create per-context wrapper components, render callbacks that return newly defined component types, or dynamic component factories in render paths.
- Tests can catch this indirectly by asserting that local widget state/scroll/focus/output survives repeated parent renders caused by fresh event wrappers.

### Object identity is a poor ownership signal

**Source**: React docs, [`memo`](https://react.dev/reference/react/memo) and [`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)

**Key information**:

- `React.memo` compares props shallowly with `Object.is`; `Object.is({}, {})` is false.
- React says memoization is useless when props are “always different”, such as new objects/functions created during rendering.
- React also says visual artifacts caused by re-rendering are bugs to fix, not problems to mask with memoization.
- `useSyncExternalStore` requires repeated `getSnapshot` calls to return the same value while the underlying store has not changed; for mutable stores, cache snapshots and only return a new object when data changes.

**Practical implication for issue 1517**:

- If the framework creates a new context/wrapper per event, derive a stable key/owner token from semantic fields (`sessionId`, `subagentId`, `runId`, etc.). Do not compare or store ownership by `wrapper === previousWrapper`.
- Pass minimal primitive props to memoized leaf components where possible. If a richer derived object is needed, memoize/cache it by stable IDs and version numbers.
- For external-store style bridges, snapshots should be versioned/cached; do not return a fresh object solely because an event wrapper was fresh.

### Stable reconciliation model: keys are the hint React uses

**Source**: React legacy docs, [Reconciliation](https://legacy.reactjs.org/docs/reconciliation.html)

**Key information**:

- React’s diffing heuristic assumes different element types produce different trees and uses `key` to identify stable children between renders.
- Unstable keys cause many component instances and DOM nodes to be unnecessarily recreated, which can cause performance degradation and lost state.

**Practical implication for issue 1517**:

- Flicker in terminal React renderers often looks like React tearing down/recreating lines or containers. The fix should make reconciliation obvious: same component type + same position + stable key + changed props.
- Tests should include list reordering/insertion cases if subagent panels can be appended/prepended while live output is present.

### Throttling/debouncing should not hide live state

**Source**: React docs, [`useDeferredValue`](https://react.dev/reference/react/useDeferredValue#how-is-deferring-a-value-different-from-debouncing-and-throttling)

**Key information**:

- `useDeferredValue` lets urgent state update immediately while expensive subtrees lag and catch up.
- React contrasts this with throttling/debouncing: deferred rendering has no fixed delay, adapts to device speed, and is interruptible.
- React notes that debouncing/throttling remain useful for non-rendering work, such as reducing network requests.

**Practical implication for issue 1517**:

- Do not “fix” flicker by debouncing the actual subagent status/output store so the UI misses intermediate live states.
- If coalescing is needed for terminal frame rate, coalesce rendering/paint flushes, not the canonical state stream. The latest state should always be available to the next render.
- Tests should assert both: (1) no blank frame/flicker between events, and (2) the final/latest event state is not hidden behind an excessive debounce delay.

### Terminal/TUI-specific cached sources

**Sources**:

- Local cache, Ink rendering/testing notes: `research/web/2026-06-26-ink-rendering-options-static-testing.md` (from `https://github.com/vadimdemedes/ink`, commit noted in cache)
- Local cache, OpenTUI testing utilities: `research/web/2026-04-08-opentui-testing.md` (from `https://github.com/anomalyco/opentui`)

**Key information**:

- Ink docs expose render controls (`maxFps`, `incrementalRendering`, `onRender`) and `<Static>` patterns for completed output plus live output below.
- OpenTUI cache confirms headless React testing via `@opentui/react/test-utils`, deterministic terminal dimensions, `renderOnce()`, and frame capture helpers.

**Practical implication for issue 1517**:

- Prefer deterministic headless renderer tests that capture frames after each synthetic event.
- Use stable terminal width/height and explicit render flushes to avoid test-only flicker/noise.
- Assertions should look for absence of transient empty/placeholder regions between two non-empty states, not just the final state.

## Suggested test/fix checklist

1. **Fresh-wrapper regression**: emit two or more events for the same semantic subagent/session using distinct wrapper object instances; assert the visible widget remains populated throughout.
2. **Stable key assertion**: include same stable ID with changed object reference; verify no remount/reset symptoms such as cleared output, reset scroll/focus, or disappearing row.
3. **Insertion/reorder case**: add a new subagent before/above an existing live one; existing live subtree should keep its content and local state.
4. **No object ownership**: test that ownership lookup uses stable IDs by constructing equivalent wrapper objects that are not `===`.
5. **Live-state coalescing**: if throttling/render coalescing exists, assert the store records latest event immediately and the rendered frame catches up without prolonged stale/blank output.
6. **Preserve mounted skeleton**: loading/connecting/done states should update content inside a stable container, not swap the whole subtree unless reset is intended and tested.

## Additional resources

- React: [Rendering Lists](https://react.dev/learn/rendering-lists)
- React: [Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state)
- React: [`memo`](https://react.dev/reference/react/memo)
- React: [`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)
- React: [`useDeferredValue`](https://react.dev/reference/react/useDeferredValue)
- React legacy: [Reconciliation](https://legacy.reactjs.org/docs/reconciliation.html)

## Gaps or limitations

- I did not find framework-specific docs that directly describe “fresh wrapper objects per event” as a named pattern. The best evidence comes from React’s official reconciliation/state/key/object-identity guidance and TUI renderer testing docs.
- No code changes were made.
