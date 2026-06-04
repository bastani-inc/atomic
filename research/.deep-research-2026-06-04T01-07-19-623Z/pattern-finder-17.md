## 1. Established patterns

- **TUI state is built from small composable components, not one monolith.**  
  `interactive-mode.ts` assembles screens from many `Component` classes in `src/modes/interactive/components/*` (e.g. `AssistantMessageComponent`, `ToolExecutionComponent`, `ThemeSelectorComponent`, `SessionSelectorComponent`).

- **Most interactive widgets follow the same contract: `render()`, optional `handleInput()`, and `invalidate()`.**  
  The docs and code both treat invalidation as the key cache-reset mechanism for theme changes and state updates.

- **Selection UIs use a callback-driven pattern.**  
  Components like `ThemeSelectorComponent`, `SettingsSelectorComponent`, `ModelSelectorComponent`, `ShowImagesSelectorComponent` wire `onSelect`, `onCancel`, and sometimes `onSelectionChange` callbacks into `SelectList`.

- **Theme is a global singleton with hot-reload semantics.**  
  `theme/theme.ts` exposes a global `theme` proxy plus `initTheme()`, `setTheme()`, `setRegisteredThemes()`, and `onThemeChange()`. `interactive-mode.ts` listens for theme changes and calls `ui.invalidate()`.

- **Theme tokens are centralized and strongly named.**  
  `ThemeColor` / `ThemeBg` in `theme.ts` define a fixed token set (`toolTitle`, `toolOutput`, `customMessageText`, `mdCodeBlockBorder`, etc.). The UI consistently calls `theme.fg(token, text)` / `theme.bg(token, text)`.

- **Keybindings are also centralized and declared as named actions.**  
  `core/keybindings.ts` defines app actions like `app.interrupt`, `app.model.select`, `app.tools.expand`, then `interactive-mode.ts` renders them via `keyDisplayText()` / `formatKeyText()` in the hotkeys panel.

- **The interactive shell dynamically regenerates UI sections rather than mutating raw strings.**  
  Examples: the settings selector, hotkeys panel, update banner, and tool execution blocks all rebuild component trees and then request a re-render.

## 2. Variations / exceptions

- **Some components are stateful shells around embedded child components.**  
  `ToolExecutionComponent`, `AssistantMessageComponent`, `BranchSummaryMessageComponent`, and `CustomMessageComponent` rebuild child trees inside `updateContent()`/`updateDisplay()`.

- **A few widgets intentionally no-op `invalidate()`.**  
  Some components are effectively static (`WorkingStatusComponent`, `FastModeSelectorComponent`, some tiny helper views), while others use `invalidate()` to rebuild cached content.

- **The selector API is not fully uniform across widgets.**  
  `ThemeSelectorComponent` expects `SelectList.onSelectionChange`, while other selector components rely only on `onSelect`/`onCancel`. This suggests API drift across TUI versions.

- **Theme loading supports three sources.**  
  Built-in JSON themes, custom filesystem themes, and “registered” in-memory themes from resource loading all coexist.

- **Markdown rendering gets special treatment.**  
  `interactive-mode.ts` and message components keep a separate `MarkdownTheme` path rather than treating markdown as plain text styling.

## 3. Anti-patterns or risks

- **Heavy coupling to `@earendil-works/pi-tui` API shape.**  
  Current code imports types like `EditorTheme`, `MarkdownTheme`, `SelectListTheme`, `TUI`, `SelectListLayoutOptions`, and uses methods like `setCustomBgFn()` / `invalidate()` that may not exist in a Rust replacement.

- **Theme strings are often pre-baked into component children.**  
  If a component stores `theme.fg(...)` output instead of recomputing on render, theme switching requires explicit rebuild logic. This is a migration hotspot.

- **The UI depends on global invalidation behavior.**  
  `interactive-mode.ts` assumes `ui.invalidate()` will propagate through every component subtree after theme changes.

- **Keybinding labels are generated dynamically from a registry.**  
  Hotkey help text is not hardcoded; a Rust port must preserve the registry + display formatting pipeline or the help UI will drift.

- **Version skew / API mismatch is already visible in the tree.**  
  The fixture logs show build failures from TUI API mismatches (`EditorTheme`, `SelectListTheme`, `setCustomBgFn`, `invalidate` on `TUI`, `onSelectionChange`), which is a strong signal that replacement work needs compatibility shims or a deliberate API redesign.

## 4. Evidence index

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - registers themes, listens for theme changes, invalidates UI, renders hotkeys, builds selectors.
- `packages/coding-agent/src/modes/interactive/theme/theme.ts`
  - global theme proxy, theme tokens, theme loading, hot reload, `invalidate` expectations.
- `packages/coding-agent/src/modes/interactive/components/index.ts`
  - catalog of TUI building blocks.
- `packages/coding-agent/src/modes/interactive/components/theme-selector.ts`
  - `SelectList`-based selector pattern and `onSelectionChange` usage.
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`
  - nested component rebuild pattern + markdown/theme handling.
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
  - complex component orchestration, cached render state, theme-driven backgrounds.
- `packages/coding-agent/src/core/keybindings.ts`
  - centralized keybinding registry and app-action naming convention.
- `packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts`
  - formatting/display layer for keybinding help.
- `packages/coding-agent/docs/tui.md`
  - documented component contract, invalidation, focus, and theming expectations.
- `packages/coding-agent/test/test-theme-colors.ts`
  - theme token coverage and renaming pressure (`toolText` → `toolTitle`/`toolOutput`).
- `packages/coding-agent/test/fixtures/large-session.jsonl`
  - concrete evidence of TUI API mismatch during build/release attempts.