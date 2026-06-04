## 1. Relevant external facts

- **`jiti` is a runtime TypeScript/ESM loader for Node.js** and is used as a dynamic module bridge, not a Rust-compatible plugin system. Source: *unjs/jiti README* / *jiti package docs*.
  - Impact: anything currently loaded through `jiti` (extensions, workflows) is a hard migration boundary.
- **MCP is JSON-RPC over UTF-8, with stdio and Streamable HTTP transports**. Source: *Model Context Protocol Specification → Transports*.
  - Impact: MCP can be migrated as a protocol adapter/service boundary, not necessarily as in-process Rust code.
- **Rust does not have a stable ABI for arbitrary dynamic linking across crates**; plugin-style loading needs a deliberate ABI strategy (e.g. C FFI or ABI helper crates). Source: *Rust forum discussion on dynamic libraries* and crates like `abi_stable` / `dynamic-plugin`.
  - Impact: a “drop-in TS plugin replacement” in Rust is non-trivial; plan for either process boundaries or an explicit plugin ABI.

## 2. Local implications

- Your repo is currently centered on **one publishable CLI package** (`packages/coding-agent`) that bundles the rest of the extension ecosystem into `dist/builtin/`.
- The biggest Rust-migration risk is **dynamic loading**:
  - `packages/coding-agent/src/core/extensions/loader.ts`
  - `packages/workflows/src/extension/workflow-module-loader.ts`
- The most migration-friendly boundaries are already **protocol/process oriented**:
  - CLI entrypoint (`src/cli.ts`, `src/main.ts`)
  - session persistence (`core/session-manager.ts`)
  - intercom broker (`packages/intercom/broker/broker.ts`)
  - MCP server manager (`packages/mcp/server-manager.ts`)
- The hardest “full port” areas are:
  - TUI (`pi-tui` dependency + custom UI behavior)
  - web-access (heavy dependency orchestration)
  - subagents/workflows/extensions (dynamic TS modules)
- Practical architecture: **migrate the core CLI/runtime to Rust first**, then keep extensions/workflows as:
  1. Rust-native modules with a new ABI, or
  2. separate subprocesses / sidecars invoked by the Rust core.
- For this repo, a phased migration is more realistic than a big-bang rewrite:
  1. CLI + config + session format
  2. intercom + MCP transport
  3. tool/runtime orchestration
  4. TUI
  5. extension/workflow compatibility layer
  6. web-access/subagents internals

## 3. Version/API assumptions

- `jiti` assumption: current code uses the **2.x runtime loader model** (`jiti.import` / sync `require`-like loading).
- MCP assumption: the repo should target the **current MCP JSON-RPC transport model** (stdio + HTTP), not a custom one.
- Rust assumption: use **process boundaries first** unless you want to commit to a stable plugin ABI design upfront.

## 4. Unverified or unnecessary research

- I did **not** verify every nested TUI/workflow/subagent file; the migration shape is clear enough from the locator plus package manifests.
- I did **not** research Rust UI frameworks or exact FFI crate choices yet; that’s only needed once you pick a target architecture.
- If you want, the next useful step is a **subsystem-by-subsystem Rust migration matrix** with “rewrite / wrap / keep in TS / subprocess” decisions.