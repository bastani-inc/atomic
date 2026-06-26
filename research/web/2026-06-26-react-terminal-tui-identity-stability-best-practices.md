---
source_url: https://react.dev/learn/rendering-lists; https://react.dev/learn/preserving-and-resetting-state; https://react.dev/reference/react/memo; https://react.dev/reference/react/useDeferredValue; https://react.dev/reference/react/useSyncExternalStore; https://legacy.reactjs.org/docs/reconciliation.html
fetched_at: 2026-06-26
fetch_method: fetch_content + existing cache reuse
query: stable terminal/React TUI widgets when framework creates fresh wrapper objects per event
---

# React/TUI identity stability best-practice excerpts

Authoritative docs most relevant to fresh wrapper objects per event:

- React keys: keys tell React which array item a component corresponds to; use IDs from data, not generated during render. Rules: keys must be unique among siblings and “must not change”. Pitfall: `key={Math.random()}` means keys never match between renders, causing components/DOM to be recreated and losing input/state. Source: https://react.dev/learn/rendering-lists#keeping-list-items-in-order-with-key
- React state preservation: state is tied to a position in the UI tree. React preserves state while the same component remains at the same position; removing it, changing its type, or changing the wrapper/subtree structure destroys state. The page explicitly says: “if you want to preserve the state between re-renders, the structure of your tree needs to ‘match up’”. Source: https://react.dev/learn/preserving-and-resetting-state
- React component definitions/identity: defining component functions inside another component creates a different function each render, so React treats it as a different component at the same position and resets subtree state. Source: https://react.dev/learn/preserving-and-resetting-state#different-components-at-the-same-position-reset-state
- React reconciliation (legacy but still useful conceptual model): React’s O(n) diff assumes different element types produce different trees and keys hint stable children. Unstable keys cause instances/DOM nodes to be recreated, degrading performance and losing child state. Source: https://legacy.reactjs.org/docs/reconciliation.html
- React.memo/object props: memoization is not correctness. Fix visual artifacts as bugs first. `memo` is ineffective if props are always new; React compares props with `Object.is`, so `{}` !== `{}`. Prefer passing minimum primitive/semantic props or memoizing derived objects/functions. Source: https://react.dev/reference/react/memo
- useSyncExternalStore snapshots: repeated `getSnapshot` calls must return the same value while the store has not changed. For mutable stores, cache immutable snapshots and only return a new object when underlying data changes. `subscribe` should also be stable to avoid resubscription every render. Source: https://react.dev/reference/react/useSyncExternalStore
- useDeferredValue/live state: use it to keep urgent state immediate while a slow subtree lags/catches up. React docs contrast it with throttling/debouncing: no fixed delay, adapts to device speed, and background renders are interruptible. Source: https://react.dev/reference/react/useDeferredValue#how-is-deferring-a-value-different-from-debouncing-and-throttling
- Existing local Ink cache relevant to terminal rendering/testing: `research/web/2026-06-26-ink-rendering-options-static-testing.md` summarizes Ink `<Static>`, stable root keys, maxFps/incremental rendering, and testing helpers.
- Existing local OpenTUI cache relevant to headless tests: `research/web/2026-04-08-opentui-testing.md` summarizes `@opentui/react/test-utils` and stable snapshot practices.
