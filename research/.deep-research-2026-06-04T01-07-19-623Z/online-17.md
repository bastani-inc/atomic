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