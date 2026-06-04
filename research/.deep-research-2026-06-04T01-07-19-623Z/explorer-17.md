## Partition 17: Interactive TUI shell, components, themes, keybindings, and `pi-tui` replacement strategy

### Locator
## 1. Must-read paths

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`  
  Main interactive TUI app shell. Owns startup, editor, chat layout, overlays, selectors, status/footer, and most keyboard-driven UX.

- `packages/coding-agent/src/modes/interactive/components/index.ts`  
  Central export surface for all interactive UI pieces.

- `packages/coding-agent/src/modes/interactive/components/chat-session-host.ts`  
  Key extension-host bridge for custom UI/editor integration; very relevant to replacing `pi-tui` without breaking extension APIs.

- `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`  
  Shows how Atomic layers app-level keybindings on top of the base editor.

- `packages/coding-agent/src/core/keybindings.ts`  
  Source of all app/TUI keybinding IDs, defaults, and legacy migrations.

- `packages/coding-agent/src/modes/interactive/theme/theme.ts`  
  Theme schema, color tokens, theme loading/hot reload, and terminal color-mode handling.

- `packages/coding-agent/src/modes/interactive/theme/*.json`  
  Built-in themes (`dark`, `light`, Catppuccin variants). These are the baseline Rust-port styling contracts.

- `packages/coding-agent/docs/tui.md`  
  Canonical component API for `@earendil-works/pi-tui` usage and extension UI expectations.

- `packages/coding-agent/docs/keybindings.md`  
  Exact keybinding IDs/defaults/customization format.

- `packages/coding-agent/docs/themes.md`  
  Exact theme format, token list, discovery rules, and hot-reload behavior.

- `packages/coding-agent/package.json`  
  Confirms `@earendil-works/pi-tui` is a hard dependency of the current TUI stack.

## 2. Supporting paths

- `packages/coding-agent/src/modes/interactive/components/*.ts`  
  Individual UI widgets: selectors, messages, tool views, login/oauth dialogs, footer, tree/session browsers, loaders, etc.

- `packages/coding-agent/test/*interactive*`  
  Interactive-mode regression coverage; useful for preserving behavior during a Rust rewrite.

- `packages/coding-agent/test/*theme*`  
  Theme parsing/export/builtin tests.

- `packages/coding-agent/test/*keybindings*`  
  Keybinding migration and behavior tests.

- `packages/coding-agent/docs/usage.md`  
  User-facing interactive command list and mode behavior.

- `packages/coding-agent/docs/extensions.md`  
  Extension UI contract; especially custom renderers, `ctx.ui.custom()`, and keybinding injection.

- `packages/coding-agent/docs/settings.md`  
  Where theme/keybinding-related settings are stored and surfaced.

- `packages/coding-agent/docs/terminal-setup.md`  
  Terminal limitations that affect modified keys like `Shift+Enter`.

- `packages/coding-agent/docs/tmux.md`  
  Special-case key behavior in tmux.

## 3. Entry points / symbols

- `InteractiveMode` in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `KeybindingsManager` in `packages/coding-agent/src/core/keybindings.ts`
- `KEYBINDINGS` in `packages/coding-agent/src/core/keybindings.ts`
- `AppKeybinding` / `AppKeybindings` in `packages/coding-agent/src/core/keybindings.ts`
- `initTheme`, `theme`, `getEditorTheme`, `getMarkdownTheme`, `getSelectListTheme` in `packages/coding-agent/src/modes/interactive/theme/theme.ts`
- `ThemeJsonSchema` in `packages/coding-agent/src/modes/interactive/theme/theme.ts`
- `chat-session-host.ts` exports around `ExtensionUIContext` / editor factory hookup
- `CustomEditor` in `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`
- `keyHint`, `keyText`, `rawKeyHint` in `packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts`
- `theme/*.json` builtins (`dark`, `light`, `catppuccin-*`)

## 4. Gaps or uncertainty

- I verified the interactive shell is built on `@earendil-works/pi-tui`, but I did **not** fully trace every `pi-tui`-backed widget class here.
- I did **not** verify whether any non-interactive mode shares UI primitives that must also move with the Rust TUI.
- The exact Rust replacement strategy for `pi-tui` is still open from this partition alone:
  - keep JS/TS UI via embedded runtime,
  - reimplement a compatible TUI/component system in Rust,
  - or split UI into a Rust host with a compatibility layer.
- `packages/coding-agent/docs/tui.md` is the best contract doc, but it describes the current JS API, not a migration target.
- Some extension UI behavior is likely coupled to `chat-session-host.ts`; that file deserves deeper follow-up before any Rust ABI design.

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

The interactive shell is a **stateful TUI app** built on `@earendil-works/pi-tui`, with `InteractiveMode` as the top-level orchestrator. It owns:

- startup and terminal setup
- chat/editor layout
- overlays and selectors
- session/model/theme/keybinding controls
- extension UI hosting
- live streaming render updates

The core UI contract is not just “draw text”; it is a **component system** with focus, invalidation, input routing, overlays, and custom extension renderers. The most migration-sensitive piece is `ChatSessionHost`, which bridges agent/session state into the UI and exposes commands like prompt/steer/follow-up, bash execution, interrupt/resume, and custom dialogs/widgets.

## 2. Key flows and invariants

### Input → action dispatch
- Keybindings are centralized in `core/keybindings.ts`.
- Defaults include app actions (`app.*`) and inherited TUI actions (`tui.*`).
- Old binding names are migrated on startup to namespaced IDs.
- Some bindings are platform-specific:
  - `ctrl+z` disabled on Windows for suspend
  - `ctrl+v` vs `alt+v` for clipboard image paste

### Theme flow
- Themes are JSON files validated against a strict schema.
- Every theme must define all tokens; there are no optional colors.
- Theme loading supports:
  - built-ins
  - global/project/package discovery
  - CLI overrides
  - hot reload on file change
- Terminal color mode detection decides between truecolor and 256-color fallback.

### UI composition flow
- `interactive-mode.ts` pulls in many widgets from `components/`.
- `components/index.ts` is the public UI surface for extension and app use.
- `ChatSessionHost` manages:
  - transcript state
  - live message streaming
  - editor focus
  - queued follow-ups
  - compaction state
  - animation/render throttling
- It also hosts custom extension UI and can render overlays/dialogs.

### Invariants
- Component render output must fit terminal width.
- Focusable components must propagate focus to embedded editors/inputs for IME correctness.
- Themes must remain schema-complete.
- Keybinding IDs are stable API, including extension-facing hints.
- The interactive shell is coupled to session/runtime state; UI is not isolated from business logic.

## 3. Tests / validation

Evidence from the locator suggests coverage exists for:
- interactive mode regressions
- theme parsing/export/builtin behavior
- keybinding migration/defaults

What remains to verify:
- whether the current CI actually runs all interactive tests
- whether custom extension UI behavior is covered
- whether theme hot reload and IME/focus edge cases are tested

For a Rust migration, the highest-value validation set would be:
- keybinding parity tests
- theme schema/load/hot-reload tests
- transcript/editor focus behavior
- overlay/dialog lifecycle tests
- extension custom UI compatibility tests

## 4. Risks, unknowns, and verification steps

### Biggest migration risk: `pi-tui` compatibility
This partition is deeply dependent on `pi-tui`’s component model:
- `Component.render(width) -> string[]`
- input handling
- invalidation
- focus/IME behavior
- overlays and custom UI

A Rust replacement must decide whether to:
1. reimplement this API in Rust,
2. embed JS/TS for UI compatibility,
3. or split the app into a Rust host plus compatibility layer.

### Extension ABI coupling
`ChatSessionHost` is likely the hardest compatibility boundary because extensions can inject custom UI, editors, and dialogs. Replacing the TUI without preserving this ABI risks breaking existing extensions.

### Theme and keybinding contracts
These are effectively user-facing APIs:
- theme token names and discovery paths
- keybinding IDs and migration behavior
- platform-specific defaults

### Unknowns to verify
- exact set of interactive widgets that rely on `pi-tui` internals
- whether non-interactive modes share any UI primitives
- how much extension UI depends on `tui`, `keybindings`, and `editorFactory` injection
- whether current tests cover IME, overlays, and hot reload

### Practical Rust-migration takeaway
For this partition, the safest path is a **compatibility-first TUI rewrite**, not a visual rewrite:
- preserve component/render/input contracts
- preserve keybinding IDs
- preserve theme schema and token names
- preserve extension custom UI hooks
- verify session/editor/overlay lifecycles before replacing internals

### Online Researcher
## 1. Relevant external facts

- `@earendil-works/pi-tui` is the current TUI framework behind Atomic’s interactive shell; its core `Component` contract is `render(width): string[]`, optional `handleInput(data)`, optional `wantsKeyRelease`, and `invalidate()` for theme changes. Source docs also note styles are line-local and the TUI appends full resets per line.  
  - Docs: “TUI Components” / `pi-tui` API.
- `pi-tui` supports `Focusable` + `CURSOR_MARKER` for IME-safe cursor placement in text inputs/editor-like widgets. Container components must propagate focus to child inputs to preserve IME behavior.
- Rust TUI stacks usually split into:
  - `ratatui` for rendering/layout/widgets, and
  - `crossterm` for raw mode + keyboard/mouse/resize events. `ratatui` does not provide input handling itself.  
  - `crossterm::event` supports keyboard, mouse, resize, raw mode, bracketed paste, and key modifiers.  
- There are also higher-level Rust TUI frameworks like `reratui`, but they are not the default/standard replacement; they add React-like state/hooks on top of `ratatui`.

## 2. Local implications

- Your repo’s interactive shell is tightly coupled to `pi-tui` through:
  - `interactive-mode.ts` (shell lifecycle/layout/overlays),
  - `chat-session-host.ts` (extension UI bridge),
  - `custom-editor.ts` (keybinding layering),
  - `core/keybindings.ts` (canonical action IDs/defaults),
  - `theme/theme.ts` + built-in theme JSONs.
- So a Rust migration is not just “rewrite rendering”; it must preserve:
  1. the `Component`-style contract,
  2. focus/IME behavior,
  3. overlay/custom UI APIs used by extensions,
  4. theme invalidation/hot reload,
  5. exact keybinding IDs and defaults documented in `docs/keybindings.md`.
- `package.json` shows `@earendil-works/pi-tui` is a hard runtime dependency today, so replacing it requires either:
  - a Rust host with a compatibility layer for the existing component API, or
  - a deliberate breaking change for extension authors.
- The theme docs define 51 required color tokens and built-in theme discovery paths; a Rust port must keep those tokens/config paths stable or provide a migration layer.
- The keybinding docs show many app/editor/session actions are namespaced and user-configurable; preserving the same IDs is the safest migration path.

## 3. Version/API assumptions

- `@earendil-works/pi-tui` current dependency version in this repo: `^0.78.0`.
- `ratatui` current docs reflect the `0.30.x` workspace split and the default `crossterm` backend.
- `crossterm` event API assumptions: raw mode required, key/mouse/resize events available, bracketed paste supported.
- I assume your Rust target would likely be `ratatui + crossterm` unless you intentionally want a more opinionated framework like `reratui`.

## 4. Unverified or unnecessary research

- I did **not** verify a Rust library that exactly reproduces `pi-tui`’s component/overlay/IME contract.
- I did **not** need deeper docs on every widget to answer the migration shape; the key issue is API compatibility, not individual widget internals.
- I did **not** verify whether your extension ecosystem depends on any undocumented `pi-tui` behaviors beyond the public docs and the `chat-session-host.ts` bridge.