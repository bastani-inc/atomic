## 1. Relevant external facts

- **No Rust baseline exists in this repo**: the research artifact found **no `Cargo.toml` or `*.rs` files**, so this is a greenfield Rust migration, not a port.
- **Bun/TypeScript runtime assumptions are baked in** today:
  - `packages/coding-agent` is the published CLI/package boundary.
  - `packages/workflows` and other companion packages ship as **raw TypeScript**.
- **Dynamic TS loading is a major compatibility boundary**:
  - `packages/coding-agent/src/core/extensions/loader.ts`
  - `packages/workflows/src/extension/workflow-module-loader.ts`
  These imply the current system can load user code at runtime, which Rust cannot mirror directly without an embedding or IPC strategy.
- **Current behavior is organized around a few core contracts**:
  - session/runtime creation: `createAgentSession()`
  - CLI bootstrap: `main()`
  - session persistence: `session-manager.ts`
  - model/provider registry: `model-registry.ts`
  - tool surface: `core/tools/`
  - RPC surface: `modes/rpc/`
  - interactive TUI: `modes/interactive/`
- **Load-bearing external dependencies are not in this repo**:
  - `pi-*` behavior is referenced but not vendored, so Rust migration must replace or wrap those semantics.

## 2. Local implications

- **Best migration order**:
  1. **Rust CLI shell + RPC/headless core**
  2. **Session manager + model registry + builtin tools**
  3. **Interactive TUI**
  4. **Extension/workflow runtime**
- **Hardest part is extension compatibility**:
  - If you need to preserve user-defined TS extensions/workflows, Rust should likely start as a **host/orchestrator** that shells out to TS or loads plugins over IPC.
  - A full native Rust plugin ABI would require redesigning the extension contracts.
- **The likely “stable seam” is RPC**:
  - The `modes/rpc/` surface is probably the easiest place to preserve behavior while swapping the implementation underneath.
- **Subprocess boundaries already exist**:
  - `subagents`, `mcp`, and `web-access` suggest there are already natural process/service boundaries that could become Rust-native wrappers or remain external helpers.
- **Worktree/session semantics should be preserved first**:
  - `session-manager.ts` and `subagents` worktree logic are likely user-visible behavior, so they should be migrated before “nice-to-have” UI details.

## 3. Version/API assumptions

- I’m assuming:
  - **TypeScript is the current source of truth**
  - **Bun is the current runtime/tooling**
  - **Rust migration means replacing the `@bastani/atomic` runtime layer**, not just adding a Rust helper binary
- I did **not** verify external Rust ecosystem choices yet (for example: `tokio`, `clap`, `serde`, `ratatui`, `reqwest`) because they are not needed to interpret this repo’s current structure.
- If you want a real implementation plan, the next decision is whether the target is:
  - **full rewrite**
  - **Rust host + TS compatibility layer**
  - **hybrid core in Rust, plugins in TS**

## 4. Unverified or unnecessary research

- Not needed yet:
  - exact Rust crate choices
  - platform-specific packaging details
  - binary distribution strategy in Rust
- Unverified:
  - how much of the `pi-*` behavior must remain API-compatible
  - whether TS extension loading must remain first-class
  - whether the interactive TUI must be preserved exactly or can be redesigned

If you want, I can turn this into a **module-by-module migration map**: “rewrite first / wrap first / keep TS for now.”