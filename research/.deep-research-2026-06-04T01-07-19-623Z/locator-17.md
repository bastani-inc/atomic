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