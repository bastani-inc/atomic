---
source_url: https://react.dev/llms.txt; https://react.dev/learn/rendering-lists; https://react.dev/learn/preserving-and-resetting-state; https://react.dev/learn/queueing-a-series-of-state-updates; https://react.dev/reference/react/memo; https://react.dev/reference/react/useDeferredValue; https://react.dev/reference/react/useTransition
fetched_at: 2026-06-26
fetch_method: fetch_content llms.txt + docs pages
topic: React keys, identity, state preservation, batching, memoization, transitions/deferred rendering
---

# React rendering stability notes

Authoritative React docs relevant to terminal/TUI flicker:
- List keys: keys must be stable, unique among siblings, and not generated during render; random keys recreate components and lose state: https://react.dev/learn/rendering-lists#keeping-list-items-in-order-with-key
- State preservation/reset: React preserves state while the same component stays at the same position; removing/replacing components destroys state: https://react.dev/learn/preserving-and-resetting-state
- Batching: React waits until event handler code completes before processing queued state updates, reducing half-finished renders: https://react.dev/learn/queueing-a-series-of-state-updates#react-batches-state-updates
- `memo`: optimization only; fix visual artifacts as bugs first, minimize always-new props: https://react.dev/reference/react/memo
- `useDeferredValue`: lets a slow part of UI lag/catch up and is distinct from fixed throttling/debouncing: https://react.dev/reference/react/useDeferredValue#deferring-re-rendering-for-a-part-of-the-ui
- `useTransition`: marks updates as non-blocking and avoids hiding already-revealed content with unwanted loading indicators: https://react.dev/reference/react/useTransition#preventing-unwanted-loading-indicators
