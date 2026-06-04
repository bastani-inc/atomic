## 1. Behavioral model

This partition is the **raw TypeScript companion-package layer** that currently depends on the Bun/TS host and is bundled into `@bastani/atomic` at build time.

Key behavior:
- These packages are **not compiled independently**; they ship as `.ts` sources and are loaded directly by the host.
- They extend the core CLI with:
  - workflows (`packages/workflows`)
  - subagents (`packages/subagents`)
  - MCP integration (`packages/mcp`)
  - web access (`packages/web-access`)
  - intercom IPC (`packages/intercom`)
- The host relies on **dynamic TS/JS loading** (`jiti`) for user-authored workflows/extensions, so compatibility is not just source format but **runtime execution semantics**.
- Current architecture implies a Rust migration must decide whether these packages become:
  1. Rust-native modules,
  2. JS/TS plugins kept alive via an embedded or sidecar JS runtime,
  3. or a new ABI/protocol boundary.

## 2. Key flows and invariants

### Bundling / distribution
- `docs/ci.md` and package manifests indicate companion packages are copied into the Atomic distribution rather than published as separate compiled artifacts.
- Invariant: **the host expects raw TS package structure and imports to remain resolvable**.

### Extension/workflow loading
- `packages/workflows/src/extension/workflow-module-loader.ts` and `packages/coding-agent/src/core/extensions/loader.ts` use dynamic loading of TS/JS modules.
- Invariant: **user-authored workflow/extension code is executable code, not just data**.
- This is the biggest Rust migration constraint: Rust cannot directly preserve this without a JS execution layer or a new plugin language/ABI.

### Subagent orchestration
- `packages/subagents/src/runs/shared/pi-spawn.ts` shows subagents are often spawned as **child processes**.
- Invariant: subprocess isolation is already part of the design, so a Rust host could preserve this pattern more easily than in-process embedding.

### MCP and external services
- `packages/mcp/server-manager.ts` manages multiple transport types and lifecycle/auth behavior.
- `packages/web-access/*` relies on external fetch/extraction/search providers.
- Invariant: these packages are **I/O heavy and adapter-shaped**, which makes them more migratable than dynamic plugin loaders.

### Intercom
- `packages/intercom/broker/` is an IPC/framing layer.
- Invariant: this is a strong candidate for **Rust replacement with a stable local protocol**, because it already behaves like a transport boundary.

## 3. Tests / validation

Evidence from the artifacts suggests validation is split across:
- root Bun tests (`test/unit`, `test/integration`)
- package-specific tests
- docs/specs for expected behavior contracts

For this partition specifically, the critical validations are:
- workflow loading still resolves user `.ts` modules
- subagent spawning still isolates state and preserves session semantics
- MCP transports still connect/authenticate/proxy correctly
- web fetch/extract behavior still returns comparable normalized content
- intercom message framing and routing remain stable

What’s unclear:
- whether CI fully covers package-local tests in `packages/coding-agent/test/`
- whether companion packages have exhaustive integration tests for cross-package behavior

## 4. Risks, unknowns, and verification steps

### Main risks
- **Dynamic TS execution is the hardest incompatibility**.
  - A pure Rust rewrite breaks `jiti`-based loading unless replaced.
- **Host/package coupling is strong**.
  - Raw TS packages depend on host conventions, path layout, and Bun/Node-like module resolution.
- **External `pi-*` dependencies are not in-repo**.
  - Their behavior must be reimplemented, wrapped, or replaced separately.
- **Migration may fracture extension compatibility**.
  - Existing workflows, agents, and custom extensions likely assume executable TS.

### Migration options
1. **Full Rust host + JS plugin runtime**
   - Keep companion packages as TS/JS plugins.
   - Best compatibility, but highest runtime complexity.
2. **Rust host + subprocess JS sidecar**
   - Keep the TS ecosystem in a separate Node/Bun service.
   - Easier isolation, weaker performance/UX.
3. **Rust-native rewrite of core + new declarative plugin ABI**
   - Best long-term stability.
   - Highest compatibility breakage.
4. **Hybrid**
   - Rust core for CLI/session/tooling, JS for workflows/extensions/MCP/web adapters.

### Verify next
- identify every dynamic import / `jiti` call site
- enumerate which companion APIs are consumed by core host vs external users
- classify packages into:
  - data/config only
  - adapter/service layer
  - executable plugin layer
- decide whether backward compatibility with existing `.ts` workflows/extensions is a hard requirement

If you want, I can turn this into a **migration matrix**: package-by-package with “keep in JS / port to Rust / bridge via IPC / remove” recommendations.