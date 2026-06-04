## 1. Established patterns

- **The repo treats `pi-agent-core`, `pi-ai`, and `pi-tui` as load-bearing platform libraries, not optional helpers.**
  - `packages/coding-agent/package.json` depends on all three directly.
  - `packages/coding-agent/src/core/sdk.ts` is the main boundary for agent/session/model/tool wiring.
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts` and many `modes/interactive/components/*` files are tightly coupled to `pi-tui`.

- **There are already “boundary” modules that would be the cleanest Rust replacement points.**
  - `src/core/sdk.ts`
  - `src/core/agent-session.ts`
  - `src/core/model-registry.ts`
  - `src/core/extensions/loader.ts`
  - `src/modes/interactive/*`
  These are the most obvious seams for either Rust-native reimplementation or FFI/proxy binding.

- **The repo uses adapter-style wrappers around upstream types.**
  - `src/core/messages.ts` extends `@earendil-works/pi-agent-core` via declaration merging.
  - `src/core/extensions/types.ts` defines the public extension ABI.
  - `src/core/extensions/loader.ts` aliases both `@earendil-works/*` and `@mariozechner/*` package names.
  This suggests the current design expects compatibility shims, not direct hard-coded internals.

- **UI is built as many small components over a shared TUI runtime.**
  - `modes/interactive/components/*`
  - `core/tools/ask-user-question/view/*`
  - `core/keybindings.ts`
  This is a strong signal that `pi-tui` replacement must preserve a component-oriented API, not just terminal drawing primitives.

## 2. Variations / exceptions

- **Some code is only lightly coupled to the external packages.**
  - Types only: `import type { ... } from "@earendil-works/pi-agent-core"` / `pi-ai` / `pi-tui`.
  - These are easier to swap with Rust-generated bindings or local type facades.

- **The `pi-*` aliases are still supported alongside `@earendil-works/*`.**
  - `src/core/extensions/loader.ts` maps both namespaces.
  - This shows the project already handles renames/compatibility layers, which is useful for a staged migration.

- **Not all TUI behavior is core platform behavior.**
  - Some parts are pure presentation (`components/*`).
  - Some parts are protocol-level (`interactive-mode.ts`, key handling, session selector, model selector).
  - Some parts are business logic embedded in UI files, which will be harder to port cleanly.

- **The package manifest already mixes internal and external responsibilities.**
  - `package.json` includes build/copy logic, bundled assets, and runtime dependencies together.
  - That means a Rust migration will likely need a new packaging story, not just code translation.

## 3. Anti-patterns or risks

- **Deep coupling to external TS APIs.**
  - `Agent`, `Model`, `Api`, `AssistantMessage`, `ThinkingLevel`, `Component`, `TUI` are used everywhere.
  - A Rust rewrite cannot “just replace imports”; it needs an API compatibility plan.

- **Dynamic plugin loading is a major migration blocker.**
  - `src/core/extensions/loader.ts` uses `jiti` and module alias rewriting.
  - Any Rust host must decide whether to:
    1. keep JS/TS plugins alive,
    2. re-spec the plugin ABI,
    3. or shell out to a JS sidecar.

- **TUI contracts are implicitly public.**
  - Many components rely on `pi-tui` primitives like `Container`, `Markdown`, `SelectList`, `Loader`, `Input`, `TUI`.
  - Replacing `pi-tui` means preserving rendering, focus, layout, keybinding, and markdown behavior.

- **ABI drift risk is high because the project uses declaration merging and cross-package type assumptions.**
  - Example: `messageTransformer` in `src/core/messages.ts`.
  - This is convenient in TS, but brittle when translated to Rust unless the message schema is frozen.

- **Package name compatibility is already a migration hazard.**
  - Both `@earendil-works/*` and `@mariozechner/*` appear in code and loader maps.
  - Rust migration should probably normalize on one canonical internal namespace early.

## 4. Evidence index

- `packages/coding-agent/package.json`
  - Direct deps on `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`
- `packages/coding-agent/src/core/sdk.ts`
  - Primary orchestration boundary for model/session/tool integration
- `packages/coding-agent/src/core/agent-session.ts`
  - Session/runtime wrapper around `Agent`
- `packages/coding-agent/src/core/model-registry.ts`
  - Model/auth/provider registry surface
- `packages/coding-agent/src/core/messages.ts`
  - Declaration merging against `pi-agent-core`
- `packages/coding-agent/src/core/extensions/loader.ts`
  - `jiti` loader + alias map for both package namespaces
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - Heavy `pi-tui` integration
- `packages/coding-agent/src/modes/interactive/components/*`
  - UI component ecosystem built on `pi-tui`
- `packages/coding-agent/src/core/tools/ask-user-question/view/*`
  - Rich custom UI built on TUI primitives
- `packages/coding-agent/src/core/keybindings.ts`
  - TUI-level keybinding coupling

If you want, I can turn this into a **Rust migration strategy matrix** next: *replace vs bind vs isolate* for each of the three libraries.