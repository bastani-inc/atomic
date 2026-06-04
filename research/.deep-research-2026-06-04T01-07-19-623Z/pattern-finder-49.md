## 1. Established patterns

- **Raw TypeScript companion packages are the norm, not an exception.**  
  `packages/workflows`, `packages/subagents`, `packages/mcp`, `packages/web-access`, and `packages/intercom` all publish `main`/`exports` pointing directly at `.ts` files and ship `files` entries that include source `.ts` instead of compiled artifacts.  
  - Example: `packages/workflows/package.json` → `main: "./src/index.ts"`, `exports["."].default: "./src/index.ts"`.
  - Example: `packages/mcp/package.json` → `main: "./index.ts"`.

- **Runtime discovery is extension-driven and manifest-backed.**  
  Each companion package advertises itself through `pi.extensions`, `pi.skills`, or `pi.prompts`, which means migration has to preserve a plugin-discovery contract, not just code behavior.  
  - Example: `packages/subagents/package.json` exposes `./src/extension/index.ts` via `pi.extensions`.
  - Example: `packages/intercom/package.json` exposes both `extensions` and `skills`.

- **`jiti` is the shared “execute TypeScript at runtime” mechanism.**  
  The scout flags `packages/coding-agent/src/core/extensions/loader.ts` and workflow loading as the key dynamic-loading boundary. This is the main compatibility seam if Rust becomes the host.

- **The repo treats Bun + TypeScript as the execution substrate.**  
  Package `engines` are `bun >=1.3.14`, and the root workflow assumes Bun scripts and Bun tests. That means the current ecosystem is coupled to TS runtime semantics, not just syntax.

- **TypeBox is a repeated schema/ABI primitive.**  
  Multiple companion packages depend on `typebox`, suggesting a common pattern of schema-first runtime validation and typed authoring APIs.

## 2. Variations / exceptions

- **`packages/workflows` is the most “library-like” companion package.**  
  It has a richer export surface (`./builtin`, `./builtin/*`) and separate authoring/types entrypoints, unlike simpler single-entry extensions.

- **`packages/subagents` and `packages/intercom` include bundled internal assets.**  
  They ship `agents/`, `skills/`, `prompts/`, and UI/broker subtrees, so they’re closer to “mini platforms” than thin extensions.

- **`packages/mcp` is the most protocol-heavy integration.**  
  It pulls in `@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`, `open`, and `zod`, so it likely needs a different Rust migration path than purely local orchestration packages.

- **`packages/web-access` is dependency-heavy for parsing/extraction.**  
  Its reliance on `readability`, `linkedom`, `turndown`, and `unpdf` suggests a portability hotspot where Rust replacements may be straightforward for parsing but not for behavior parity.

- **`packages/intercom` is unusually protocol-shaped.**  
  Its `broker/**` and `types.ts` imply a local IPC channel that could map well to Rust, but its UI and session-routing behavior still depend on the TS ecosystem.

## 3. Anti-patterns or risks

- **No existing Rust boundary exists.**  
  There is no `Cargo.toml` / `.rs` baseline, so a migration cannot be incremental by default unless you create a new Rust host or service boundary.

- **Dynamic TS plugin loading is the biggest lock-in.**  
  A pure Rust rewrite breaks `jiti`-loaded workflows/extensions unless you preserve JS execution somehow (embedded JS, subprocess bridge, or a new plugin ABI).

- **The companion packages are intentionally source-distributed.**  
  Their `.ts` entrypoints and `files` lists are a compatibility contract. Replacing them with Rust means either abandoning user-authored TS extensions or building a new authoring story.

- **Multiple external runtime dependencies are load-bearing.**  
  `pi-agent-core`, `pi-ai`, `pi-tui`, plus MCP/web parsing libs, mean a Rust port is not just syntax translation; it is replacing several runtime ecosystems.

- **Shared manifest conventions couple package identity to discovery.**  
  `pi.extensions`, `pi.skills`, and `pi.prompts` are part of the architecture. A Rust migration that ignores these will break extension/resource discovery even if core CLI works.

## 4. Evidence index

- `packages/workflows/package.json` — raw TS exports, `jiti`, `typebox`, `pi` manifest.
- `packages/subagents/package.json` — raw TS extension entrypoint, `pi` manifest, peer deps on `pi-*`.
- `packages/mcp/package.json` — raw TS entrypoint, MCP SDK dependencies.
- `packages/web-access/package.json` — raw TS entrypoint, parser/extraction deps.
- `packages/intercom/package.json` — raw TS entrypoint, broker/UI files, `pi` manifest.
- `research/.deep-research-2026-06-04T01-07-19-623Z/00-codebase-scout.md` — identifies `jiti` as the core compatibility risk and lists migration-relevant subsystems.