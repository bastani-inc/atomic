---
title: Online research - stable React Ink/TUI rendering best practices for issue 1517
created_at: 2026-06-26
research_question: Stable terminal/TUI rendering with React Ink during frequent state updates while preserving live streaming state
breaking_changes_allowed: false
sources_cached:
  - research/web/2026-06-26-ink-rendering-options-static-testing.md
  - research/web/2026-06-26-ink-testing-library.md
  - research/web/2026-06-26-react-list-keys-preserving-state-batching.md
  - research/web/2026-04-08-opentui-testing.md
---

## Summary

Authoritative guidance points to the same practical strategy for flicker-free Ink TUIs: preserve React identity, keep terminal geometry stable, and limit write frequency without discarding live state. For issue 1517, the validation target should be that frequent streaming updates update text in-place rather than unmounting/remounting rows or collapsing panels between frames.

Most relevant findings:

1. **Stable list identity is mandatory.** React says keys identify list items across inserts/deletes/reorders and must not change or be generated during render; random keys cause components and DOM/output nodes to be recreated every render and lose state. Source: React list keys docs: https://react.dev/learn/rendering-lists#keeping-list-items-in-order-with-key
2. **Avoid unmount/remount for live rows/panels.** React preserves component state only while the same component remains at the same position in the render tree; removing/replacing a subtree destroys its state. Source: https://react.dev/learn/preserving-and-resetting-state
3. **Reserve layout height.** Ink supports fixed and min/max heights for `<Box>`, in rows, which is directly relevant for keeping panels from collapsing during empty/loading/intermediate states. Source permalink: [`readme.md` lines 452-502](https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L452-L502).
4. **Throttle frame output at the renderer boundary when possible.** Ink exposes `maxFps` to cap render updates and `incrementalRendering` to update changed lines instead of redrawing everything, explicitly to reduce flickering in frequently updating UIs. Source permalink: [`readme.md` lines 2661-2677](https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L2661-L2677).
5. **Use `<Static>` only for append-only completed/log output, not mutable live rows.** Ink documents `<Static>` as permanently rendering output above live content, but previous static items do not rerender. Source permalink: [`readme.md` lines 1472-1542](https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L1472-L1542).
6. **Test actual frames.** Ink recommends `ink-testing-library`; it exposes `lastFrame`, all `frames`, `rerender`, `unmount`, and stdin writes, which is suitable for regression tests asserting no blank/intermediate collapsed frames. Source permalinks: Ink testing section [`readme.md` lines 2964-2980](https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L2964-L2980) and ink-testing-library API [`readme.md` lines 41-79](https://github.com/vadimdemedes/ink-testing-library/blob/1673165d94905066f13b1bc6e1f9eacef8f3688e/readme.md#L41-L79).

## Detailed Findings

### 1. React identity: stable keys and stable tree positions

**Sources**:
- React Rendering Lists: https://react.dev/learn/rendering-lists#keeping-list-items-in-order-with-key
- React Preserving and Resetting State: https://react.dev/learn/preserving-and-resetting-state

**Key information**:
- React keys tell React which array item a component corresponds to, especially when items move, are inserted, or are deleted.
- React explicitly warns that keys must not change and should not be generated during render. It says `key={Math.random()}` causes keys to never match between renders, recreating components every time and losing state.
- React preserves state for a component only while it remains the same component at the same render-tree position. If a component is removed or a different component/type is rendered at that position, React destroys state below it.

**Practical implication for flicker**:
- Rows/panels representing streaming tasks should use durable task/message IDs as keys, not array indexes for a changing list and never random IDs in render.
- Prefer rendering the same row/panel component with changed props/status over conditional branches that swap component types or remove the subtree temporarily.
- Loading/empty/error states inside a live row should generally be content variants within the same row shell, not replacement of the whole row shell.

**Validation implications**:
- Add/update tests that reorder, append, complete, and stream-update rows; assert existing rows preserve their visual slots and do not disappear for a frame.
- If frame snapshots include unique row labels, ensure labels remain present across every captured frame after first appearance unless the underlying item is intentionally removed.

### 2. Ink layout stability: preserve panel height and placeholders

**Source**: Ink README, Box sizing. Ink documents `<Box height={...}>`, `minHeight`, and `maxHeight` as row-based sizing primitives: [`readme.md` lines 452-502](https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L452-L502).

**Key information**:
- `height` is “Height of the element in lines (rows).”
- `minHeight` sets a minimum height in lines.
- `maxHeight` sets a maximum height in lines.

**Practical implication for flicker**:
- Terminal UIs are sensitive to line count changes because redraws clear/repaint lines. If a panel emits zero lines during loading or a list temporarily shrinks, lower panels move upward and then downward, perceived as flicker.
- Reserve the expected height for panels and rows even while data is loading or streaming. Placeholder rows/blank `Text` lines are useful when content is temporarily unavailable.
- Use `minHeight` for panels whose content can be briefly empty but should not collapse.

**Validation implications**:
- Frame tests should assert a stable number of lines for the affected panel region across rapid state changes.
- Include cases for empty → loading → streaming → complete transitions; no frame should show collapsed panel height unless intentionally designed.

### 3. Ink frequent update controls: `maxFps`, `incrementalRendering`, `waitUntilRenderFlush`

**Source**: Ink render options: [`readme.md` lines 2640-2697](https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L2640-L2697).

**Key information**:
- `onRender` runs after each render/re-render with render metrics, but does not wait for stream flush.
- `debug: true` renders each update as separate output instead of replacing previous output.
- `maxFps` defaults to 30 and controls how frequently UI can update to prevent excessive rerendering; lower values can help very frequently updating components reduce CPU.
- `incrementalRendering` updates only changed lines rather than redrawing the entire output and is documented as reducing flickering and improving performance for frequently updating UIs.
- `concurrent` enables React concurrent rendering; Ink notes concurrent timing can affect tests and may require `act()`.

Ink also exposes `waitUntilRenderFlush()` to await pending output being flushed after a rerender: [`readme.md` lines 2895-2908](https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L2895-L2908).

**Practical implication for flicker**:
- Preserve live streaming state in memory, but coalesce UI publication to a reasonable frame rate. Avoid rendering every token/chunk if the terminal cannot display it usefully.
- Prefer renderer-level frame capping (`maxFps`) or app-level batching to a strategy that drops streaming state.
- Evaluate `incrementalRendering` for issue 1517 because the Ink docs directly identify it as a flicker-reduction option for frequent updates.
- Avoid using `debug: true` for flicker validation unless the goal is intentionally to inspect every frame; it changes replacement behavior.

**Validation implications**:
- Use tests or manual repro to compare number of frames and line stability with high-frequency updates.
- Assertions should care about final/latest live state and absence of blank/collapsed intermediate frames, not one frame per input chunk.
- If using `waitUntilRenderFlush`, validate the frame after stdout flush, not immediately after triggering rerender.

### 4. Append-only output: Ink `<Static>` is useful but not for mutable live rows

**Source**: Ink `<Static>` docs: [`readme.md` lines 1472-1542](https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L1472-L1542), root keys: [`readme.md` lines 1564-1587](https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L1564-L1587).

**Key information**:
- `<Static>` permanently renders output above everything else and is for completed tasks/logs that do not change after rendering.
- Ink’s example keeps a live progress line below the static completed test output.
- Important limitation: `<Static>` only renders new items and ignores previous items; changes to prior items do not trigger rerender.
- Ink requires a key on the root component returned for each static item.

**Practical implication for flicker**:
- Completed, immutable rows can move to `<Static>` to reduce redraw pressure in the live region.
- Streaming rows/panels should not be rendered via `<Static>` if their content changes; they need the live Ink tree.
- A mixed model is appropriate: immutable history static, current active tasks live with stable identity and reserved height.

**Validation implications**:
- If a task transitions from live to completed/static, verify it happens once and does not duplicate or disappear.
- Tests should assert completed rows no longer mutate after static emission, while live rows continue updating below.

### 5. React batching, memoization, deferred work, and transitions

**Sources**:
- React batching: https://react.dev/learn/queueing-a-series-of-state-updates#react-batches-state-updates
- React `memo`: https://react.dev/reference/react/memo
- React `useDeferredValue`: https://react.dev/reference/react/useDeferredValue#deferring-re-rendering-for-a-part-of-the-ui
- React `useTransition`: https://react.dev/reference/react/useTransition#preventing-unwanted-loading-indicators

**Key information**:
- React batches state updates within event handlers to avoid too many rerenders and half-finished renders.
- `memo` can skip rerendering when props are unchanged, but React cautions it is a performance optimization, not a correctness fix; visual artifacts from rerendering are component bugs.
- `memo` is ineffective if props are always new objects/functions; props should be minimized or memoized.
- `useDeferredValue` lets slow UI lag behind fast state and then catch up; React explicitly distinguishes it from fixed debouncing/throttling.
- `useTransition` marks updates as non-blocking and can avoid hiding already revealed content behind fallback indicators.

**Practical implication for flicker**:
- Batch streaming chunks into frame-sized updates, but retain all latest streamed content in state/ref/model.
- Memoization may reduce CPU and redraw pressure for rows whose visible props did not change, but it should not be used to mask unmount/remount or unstable layout.
- If Ink concurrent mode is enabled, `useDeferredValue`/`useTransition` may help keep urgent live indicators responsive while slower panels lag gracefully; validate carefully because concurrent timing changes tests.

**Validation implications**:
- Include high-frequency updates to one row while sibling rows remain unchanged; sibling frames should not blink or reset.
- Include a slow/large panel and a live status indicator; the status should continue updating while the slow panel catches up.

### 6. Testing approaches: frame snapshots and input simulation

**Sources**:
- Ink testing recommendation: [`readme.md` lines 2964-2980](https://github.com/vadimdemedes/ink/blob/25766aec618bd62030069f57dd081e5ebdd46add/readme.md#L2964-L2980)
- ink-testing-library usage/API: [`readme.md` lines 11-25](https://github.com/vadimdemedes/ink-testing-library/blob/1673165d94905066f13b1bc6e1f9eacef8f3688e/readme.md#L11-L25), [`readme.md` lines 41-79](https://github.com/vadimdemedes/ink-testing-library/blob/1673165d94905066f13b1bc6e1f9eacef8f3688e/readme.md#L41-L79), stdout frame APIs [`readme.md` lines 107-124](https://github.com/vadimdemedes/ink-testing-library/blob/1673165d94905066f13b1bc6e1f9eacef8f3688e/readme.md#L107-L124)
- Cached OpenTUI testing notes: `research/web/2026-04-08-opentui-testing.md`

**Key information**:
- Ink itself recommends `ink-testing-library` for component output testing.
- `ink-testing-library` exposes `lastFrame()`, `frames`, `rerender()`, `unmount()`, and stdin writes.
- The existing cached OpenTUI testing research similarly emphasizes test renderers with captured frames, useful as a cross-TUI validation pattern even though issue 1517 is Ink-specific.

**Practical validation plan**:
- Capture all frames during a scripted burst of streaming updates.
- Assert no frame contains known flicker signatures: missing row title, missing panel border/header, zero-height panel, duplicated row, or reset progress text.
- Assert `lastFrame()` contains the latest streamed state.
- Assert frame count is bounded if throttling/batching is expected.
- Use stdin simulation where user navigation/selection should remain stable during stream updates.

## Additional Resources

- Ink README/source snapshot cached at `research/web/2026-06-26-ink-rendering-options-static-testing.md`.
- ink-testing-library snapshot cached at `research/web/2026-06-26-ink-testing-library.md`.
- React docs index and relevant pages cached at `research/web/2026-06-26-react-list-keys-preserving-state-batching.md`.
- Existing OpenTUI testing cache: `research/web/2026-04-08-opentui-testing.md`.

## Gaps or Limitations

- Ink’s README documents `incrementalRendering` and `maxFps`, but this research did not benchmark issue-1517-specific output. Treat them as candidate configuration/validation points, not proof they alone fix the flicker.
- React guidance is renderer-agnostic; the identity/state-preservation rules apply because Ink is a React renderer, but terminal-specific behavior must be validated with frame/output tests.
- No code changes are proposed here per task scope.
