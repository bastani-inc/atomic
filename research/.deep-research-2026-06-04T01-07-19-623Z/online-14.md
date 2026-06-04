## 1. Relevant external facts

- **Atomic extensions are TypeScript modules today, not a compiled Rust plugin ABI.**  
  The docs say extensions are loaded via **jiti** and can be written in TypeScript without compilation; `loader.ts` uses `createJiti` plus bundled virtual modules.  
  Source: `packages/coding-agent/docs/extensions.md`, `packages/coding-agent/src/core/extensions/loader.ts`.

- **The public extension contract is `ExtensionAPI` in `core/extensions/types.ts`.**  
  That file defines the stable surface extension authors use: `on(...)`, `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerMessageRenderer`, `registerProvider`, `unregisterProvider`, plus the event/type shapes.  
  Source: `packages/coding-agent/src/core/extensions/types.ts`.

- **Extensions depend on runtime UI, session, and model behaviors.**  
  The docs and runner show extensions can:
  - subscribe to lifecycle/events like `session_start`, `resources_discover`, `before_provider_request`, `tool_call`
  - interact with UI (`ctx.ui.confirm`, `notify`, `custom`, widgets, footer/header)
  - mutate providers dynamically
  - register tools/commands/flags after startup  
  Source: `packages/coding-agent/docs/extensions.md`, `packages/coding-agent/src/core/extensions/runner.ts`.

- **Startup ordering matters.**  
  Async extension factories are awaited before `session_start`, `resources_discover`, and provider registrations are flushed.  
  Source: `packages/coding-agent/docs/extensions.md`, `packages/coding-agent/src/core/extensions/loader.ts`.

- **The docs explicitly position the extension ABI as part of Atomic’s public compatibility surface.**  
  The docs call out `@bastani/atomic` exports for `ExtensionAPI`, `ExtensionContext`, and events, and show extensions importing those types directly.  
  Source: `packages/coding-agent/docs/extensions.md`.

## 2. Local implications

- If you migrate the repo from **TypeScript to Rust**, the biggest compatibility question is **not internal implementation** but **what happens to `ExtensionAPI`**.
- To preserve current ecosystem compatibility, Rust would need to either:
  1. **reimplement this TS-shaped plugin ABI** (likely via JS/TS embedding or FFI bridge), or
  2. **replace extensions with a new plugin model**, which is a breaking change for all existing extensions.
- The current extension docs imply users expect:
  - hot reload / auto-discovery
  - async init
  - runtime tool/provider registration
  - rich TUI/UI interaction
  - event interception and mutation  
  A Rust rewrite must preserve these behaviors or document them as breaks.
- `types.ts` is the source of truth for the migration boundary: keep the event names, handler signatures, and registration methods if you want drop-in compatibility.
- The `loader.ts` and `runner.ts` semantics matter as much as the type shapes:
  - async factory must block startup
  - provider registration timing must remain immediate after bind
  - stale context invalidation behavior must be preserved or redesigned

## 3. Version/API assumptions

- No explicit semver version was needed here; I treated the **current repo head** as authoritative.
- I assumed the relevant public API is the one exported from `packages/coding-agent/src/core/extensions/index.ts` and documented in `docs/extensions.md`.
- I did **not** verify whether any downstream third-party extension ecosystem pins a specific release.

## 4. Unverified or unnecessary research

- I did **not** research external Rust plugin frameworks, WASM host/plugin models, or JS embedding libraries, because the local repo evidence already shows the core compatibility issue: **the extension ABI is TS/JS-native today**.
- I also did **not** expand every event payload type in `ExtensionEvent`; for migration planning, the key point is that the entire union is part of the public ABI and therefore needs compatibility review.