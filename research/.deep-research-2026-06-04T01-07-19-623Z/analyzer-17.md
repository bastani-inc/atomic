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