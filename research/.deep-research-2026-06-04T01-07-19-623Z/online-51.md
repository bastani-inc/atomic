## 1. Relevant external facts

- **Rust is a compiled language/ecosystem**: a TS-to-Rust migration would move you from Bun/TS runtime loading to a `cargo` workspace, compiled binaries, and explicit plugin boundaries.
- **Dynamic TS loading won’t carry over directly**: your repo currently relies on `jiti`-style runtime loading for extensions/workflows; Rust cannot execute arbitrary `.ts` modules natively.
- **Bun currently supports raw `.ts` execution**: this repo’s current architecture assumes no build step for `packages/workflows` and raw TS companion packages.

## 2. Local implications

- The **biggest migration risk** is the extension/plugin model:
  - `packages/coding-agent/src/core/extensions/loader.ts`
  - `packages/workflows/src/extension/workflow-module-loader.ts`
  - Anything expecting user-authored TS modules will need a new host/plugin strategy.
- The likely migration split is:
  1. **Rust core CLI/runtime** for entrypoint, sessions, tools, process execution, config, RPC, and persistence.
  2. **Bridge layer** for any remaining TS-only extensibility, or a full redefinition of extension APIs.
- Files that define the **hard contracts** you must preserve or consciously break:
  - CLI/mode dispatch: `packages/coding-agent/src/cli.ts`, `main.ts`
  - Session/state: `core/sdk.ts`, `agent-session.ts`, `session-manager.ts`
  - Tool ABI: `core/extensions/types.ts`
  - TUI/RPC surfaces: `modes/interactive/`, `modes/rpc/`
  - Workflow semantics: `packages/workflows/src/**`
  - Subagent/MCP/intercom/web integrations: their package entrypoints and protocol code.
- Because this repo ships **raw TS companion packages**, a full Rust rewrite likely means replacing that distribution model too, not just translating files.

## 3. Version/API assumptions

- Assumes your current repo is still using:
  - **Bun ≥ 1.3.14**
  - **TypeScript 5.x**
  - **raw TS package loading** for companion packages
- Assumes `pi`/`@earendil-works/pi-*` dependencies remain external until replaced or wrapped.
- Assumes you want a **behavior-preserving migration** first, not a redesign.

## 4. Unverified or unnecessary research

- I did **not** need external docs to identify the main migration shape; the local repo artifacts already show the key boundaries.
- Not yet verified:
  - exact Rust crate layout you want
  - whether extensions/workflows must remain user-authored code
  - whether you want a **hybrid Rust + TS** architecture or a **full replacement**
  - compatibility expectations for session formats, RPC, and TUI behavior

If you want, I can turn this into a **step-by-step migration plan** for this repo (phased, with module-by-module Rust replacement order).