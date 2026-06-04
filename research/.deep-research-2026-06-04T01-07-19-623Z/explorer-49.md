## Partition 49: Raw TypeScript companion package compatibility and migration options

### Locator
## 1. Must-read paths

- `packages/coding-agent/package.json` — published CLI/package boundary, bin entry, build scripts, runtime deps.
- `packages/coding-agent/src/cli.ts` — process/bootstrap entrypoint.
- `packages/coding-agent/src/main.ts` — top-level orchestration for modes, config, sessions, resources.
- `packages/coding-agent/src/core/sdk.ts` — `createAgentSession()`; main host/runtime seam.
- `packages/coding-agent/src/core/extensions/types.ts` — public extension ABI to preserve or replace.
- `packages/coding-agent/src/core/extensions/loader.ts` — dynamic TS/JS loading via `jiti`; biggest Rust compatibility issue.
- `packages/coding-agent/src/core/session-manager.ts` — session JSONL + branching persistence contract.
- `packages/coding-agent/src/core/model-registry.ts` — provider/auth/model resolution surface.
- `packages/coding-agent/src/core/tools/` — built-in tool semantics (`read`, `bash`, `edit`, `write`, etc.).
- `packages/coding-agent/src/modes/interactive/` — TUI/runtime interaction layer.
- `packages/coding-agent/src/modes/print-mode.ts` — headless output mode.
- `packages/coding-agent/src/modes/rpc/` — machine-facing automation protocol; likely easiest Rust port boundary.
- `packages/coding-agent/docs/{extensions,sdk,rpc,tui,packages,models,session-format}.md` — canonical compatibility docs.
- `docs/ci.md` — explains bundled companion packages and release shape.
- `scripts/build-binaries.sh` — current binary distribution model.
- `packages/workflows/package.json` — raw-TS companion package contract.
- `packages/workflows/src/extension/workflow-module-loader.ts` — user workflow `.ts` loading.
- `packages/workflows/src/workflows/define-workflow.ts` — workflow DSL/type surface.
- `packages/subagents/src/extension/index.ts` — subagent extension entrypoint.
- `packages/subagents/src/runs/shared/pi-spawn.ts` — child-process orchestration decision point.
- `packages/mcp/index.ts` — MCP extension entrypoint and tool registration.
- `packages/mcp/server-manager.ts` — MCP transport/lifecycle handling.
- `packages/web-access/index.ts` — web/search/fetch tool registration.
- `packages/web-access/{extract.ts,github-extract.ts,video-extract.ts}` — external extraction dependencies.
- `packages/intercom/index.ts` — intercom extension entrypoint.
- `packages/intercom/broker/` — IPC/framing protocol, strong candidate for Rust replacement.
- `package.json`, `bunfig.toml`, `tsconfig.json`, `tsconfig.base.json`, `prek.toml` — repo-wide runtime/build constraints.
- `.github/workflows/{test.yml,publish.yml}` — CI/release contract that migration will change.

## 2. Supporting paths

- `packages/coding-agent/src/cli/args.ts` — CLI parity surface.
- `packages/coding-agent/src/config.ts` — `.atomic`/`.pi` config and env compatibility.
- `packages/coding-agent/src/core/agent-session.ts` — session state/runtime wrapper.
- `packages/coding-agent/src/core/resource-loader.ts` — package/resource discovery.
- `packages/coding-agent/src/core/package-manager.ts` — manifest/discovery compatibility.
- `packages/coding-agent/src/core/skills.ts`, `packages/coding-agent/src/core/prompt-templates.ts` — prompt/skill loading.
- `packages/coding-agent/src/core/compaction/` — context management behavior.
- `packages/coding-agent/src/core/export-html/` — export/share surface.
- `packages/coding-agent/src/core/tools/{edit.ts,write.ts,bash.ts}` — file mutation and process execution details.
- `packages/workflows/src/runs/` — workflow runtime lifecycle and persistence.
- `packages/workflows/src/tui/` — workflow UI overlay.
- `packages/workflows/builtin/` — built-in workflow semantics.
- `packages/subagents/src/agents/` — built-in agent definitions.
- `packages/subagents/src/runs/{foreground,background}/` — async execution model.
- `packages/subagents/src/runs/shared/worktree.ts` — git worktree isolation.
- `packages/mcp/{config.ts,README.md,OAUTH.md}` — configuration and auth expectations.
- `packages/web-access/{curator-server.ts,storage.ts,summary-review.ts}` — browsing/curation persistence.
- `test/unit`, `test/integration`, `packages/coding-agent/test/` — behavior coverage map.

## 3. Entry points / symbols

- `createAgentSession()` in `packages/coding-agent/src/core/sdk.ts`
- `main()` in `packages/coding-agent/src/main.ts`
- CLI bootstrap in `packages/coding-agent/src/cli.ts`
- `loadExtension()` / extension loader path in `packages/coding-agent/src/core/extensions/loader.ts`
- Extension ABI types in `packages/coding-agent/src/core/extensions/types.ts`
- Session persistence APIs in `packages/coding-agent/src/core/session-manager.ts`
- Workflow loader APIs in `packages/workflows/src/extension/workflow-module-loader.ts`
- Workflow DSL helpers in `packages/workflows/src/workflows/define-workflow.ts`
- MCP server lifecycle in `packages/mcp/server-manager.ts`
- Intercom broker protocol in `packages/intercom/broker/`
- Subagent process boundary in `packages/subagents/src/runs/shared/pi-spawn.ts`

## 4. Gaps or uncertainty

- No verified Rust codebase exists here: no `Cargo.toml`, no `*.rs` files.
- The main unresolved question is plugin strategy: keep executing TS/JS, replace with a new ABI, or shell out to JS services.
- External `pi-*` dependencies are not in-repo, so their exact replaceability from Rust is unverified.
- CI coverage for package-local tests (`packages/coding-agent/test/`) is uncertain.
- Some specs under `specs/` are design history and may not match current implementation exactly.

### Pattern Finder
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

### Analyzer
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

### Online Researcher
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