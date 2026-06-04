## 1. Relevant external facts

No extra external research was necessary beyond the repo-local docs/artifacts for this pass.

The main compatibility facts come from the repo itself:
- `packages/coding-agent` is the published CLI/runtime boundary.
- `packages/workflows`, `packages/subagents`, `packages/mcp`, `packages/web-access`, and `packages/intercom` are raw TypeScript companion packages.
- `packages/coding-agent/src/core/extensions/loader.ts` uses dynamic TS/JS loading via `jiti`.
- `packages/workflows/src/extension/workflow-module-loader.ts` also loads user-authored `.ts` workflows.
- `docs/ci.md` and `scripts/build-binaries.sh` define the current bundled/packaged distribution model.

## 2. Local implications

A full TS→Rust migration is not “rewrite the CLI in Rust” only. The main compatibility seams are:

1. **Extension/plugin loading**
   - Today the repo depends on loading TS at runtime.
   - Rust cannot directly preserve `jiti`-style TS extension loading.
   - This is the biggest migration blocker.

2. **Companion packages**
   - `workflows`, `subagents`, `mcp`, `web-access`, and `intercom` are currently TS-first.
   - You need a plan for each:
     - keep as JS/TS sidecars,
     - replace with a new ABI,
     - or reimplement in Rust.

3. **Session and protocol compatibility**
   - `session-manager.ts`, RPC mode, and intercom broker imply file/protocol compatibility requirements.
   - These are good Rust port boundaries because they can be preserved with stable schemas.

4. **Best migration shape**
   - Start with **Rust core + JS compatibility layer**.
   - Preserve:
     - CLI flags,
     - session format,
     - RPC protocol,
     - extension ABI where possible.
   - Then migrate internals package by package.

## 3. Version/API assumptions

Assumptions based on local context:
- Current runtime is **Bun ≥ 1.3.14** and raw TypeScript.
- The Rust rewrite would likely need to preserve:
  - CLI command names and flags,
  - `.atomic` / `.pi` config behavior,
  - session JSONL format,
  - extension and workflow loading semantics.
- If you change the extension ABI, that is a breaking change and should be treated as a major-version migration.

## 4. Unverified or unnecessary research

Unverified:
- Exact replaceability of upstream `pi-*` dependencies from Rust.
- Whether every companion package can be safely preserved via subprocess/JS embedding.
- Whether package-local tests fully cover the compatibility surface.

Unnecessary for this pass:
- Deep external ecosystem research.
- Rust crate selection.
- Build-system design beyond the current compatibility boundaries.

If you want, I can turn this into a **phased migration plan** with “safe to port first / risky to port last” priorities.