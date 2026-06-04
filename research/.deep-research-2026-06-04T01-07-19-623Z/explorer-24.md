## Partition 24: Workflow dynamic module loading, discovery, and user workflow compatibility

### Locator
## 1. Must-read paths

- `packages/workflows/src/extension/workflow-module-loader.ts` — key compatibility boundary: dynamic user workflow `.ts` loading via `jiti`; a Rust migration must decide whether to preserve this JS loading model or replace it.
- `packages/workflows/src/workflows/define-workflow.ts` — workflow DSL/type shape; useful to preserve authoring semantics if rewriting execution/runtime in Rust.
- `packages/workflows/src/runs/` — workflow execution model (foreground/background, resume/cancel, validation, worktrees); this is the runtime behavior Rust must match.
- `packages/workflows/src/tui/` — workflow UI overlay/graph/widget layer; matters if the Rust app keeps interactive workflow UX.
- `packages/workflows/builtin/` — built-in workflows; shows what “user workflow compatibility” currently means in practice.
- `packages/coding-agent/src/core/extensions/loader.ts` — general extension loader; another dynamic TS/JS boundary that a Rust host must replace or bridge.
- `packages/coding-agent/src/core/extensions/types.ts` — public extension ABI; important for deciding what plugin contract survives migration.
- `packages/coding-agent/docs/extensions.md` — human-facing extension contract; use to map current behavior to any Rust plugin design.
- `packages/coding-agent/docs/rpc.md` and `packages/coding-agent/src/modes/rpc/` — likely the easiest Rust-compatible automation surface.
- `packages/coding-agent/src/core/resource-loader.ts` and `packages/coding-agent/src/core/package-manager.ts` — discovery/packaging mechanics for builtins, packages, and manifests.
- `docs/ci.md` and `packages/coding-agent/package.json` — show how the current TypeScript build/distribution is assembled, including bundled companion packages.
- `packages/coding-agent/src/main.ts` and `packages/coding-agent/src/cli.ts` — top-level CLI orchestration; useful to define Rust entrypoints and mode parity.

## 2. Supporting paths

- `packages/coding-agent/src/core/sdk.ts` — central session/runtime boundary around tools, model access, auth, and extensions.
- `packages/coding-agent/src/core/agent-session.ts` — stateful runtime wrapper; likely one of the hardest pieces to port.
- `packages/coding-agent/src/core/session-manager.ts` and `packages/coding-agent/docs/session-format.md` — session persistence contract.
- `packages/coding-agent/src/core/model-registry.ts` and `packages/coding-agent/docs/models.md` — provider/auth/model compatibility surface.
- `packages/coding-agent/src/core/tools/` — built-in tool ABI (`read`, `bash`, `edit`, `write`, etc.); core to agent parity.
- `packages/coding-agent/src/core/tools/bash.ts` and `packages/coding-agent/src/core/exec.ts` — process execution semantics.
- `packages/coding-agent/src/core/tools/edit.ts`, `write.ts`, `file-mutation-queue.ts` — filesystem mutation safety.
- `packages/coding-agent/src/modes/interactive/` and `packages/coding-agent/docs/tui.md` — TUI behavior, keybindings, overlays.
- `packages/subagents/src/extension/index.ts` — subagent extension entrypoint.
- `packages/subagents/src/runs/shared/pi-spawn.ts` and `worktree.ts` — subprocess vs in-process decision point, plus git worktree isolation.
- `packages/mcp/index.ts` and `packages/mcp/server-manager.ts` — MCP tool proxying, server lifecycle, transport handling.
- `packages/web-access/index.ts`, `extract.ts`, `github-extract.ts`, `video-extract.ts` — web/search/fetch dependencies and external tooling.
- `packages/intercom/index.ts` and `packages/intercom/broker/` — local IPC/broker protocol, strong candidate for Rust-native replacement.
- `test/unit`, `test/integration`, `packages/coding-agent/test/` — current behavioral coverage to preserve during migration.

## 3. Entry points / symbols

- `packages/workflows/src/extension/workflow-module-loader.ts`
  - `loadWorkflowModule(...)` / loader utilities (dynamic module loading path)
- `packages/workflows/src/workflows/define-workflow.ts`
  - workflow definition helpers and TypeBox-backed schema inference
- `packages/coding-agent/src/core/extensions/loader.ts`
  - extension discovery/loading entry
- `packages/coding-agent/src/core/extensions/types.ts`
  - extension tool/command/event/provider interfaces
- `packages/coding-agent/src/core/sdk.ts`
  - `createAgentSession(...)`
- `packages/coding-agent/src/main.ts`
  - CLI mode selection, config, session startup
- `packages/coding-agent/src/cli.ts`
  - process entrypoint (`main()`)
- `packages/coding-agent/src/core/session-manager.ts`
  - session persistence/branching
- `packages/coding-agent/src/core/model-registry.ts`
  - provider/model resolution
- `packages/coding-agent/src/modes/rpc/`
  - RPC protocol entrypoints
- `packages/subagents/src/extension/index.ts`
  - `subagent` tool registration
- `packages/mcp/index.ts`
  - MCP adapter entrypoint
- `packages/intercom/broker/`
  - broker/client/framing symbols for IPC

## 4. Gaps or uncertainty

- I could not verify any Rust baseline: no `Cargo.toml` or `*.rs` exists in the repo, so the migration shape is still undefined.
- The exact `jiti`-based loading contract for workflows/extensions is the main unknown risk; it likely needs an explicit compatibility strategy.
- Some design docs/specs in `specs/` are historical and may not match the current tree exactly.
- CI coverage for package-specific tests (especially `packages/coding-agent/test/`) is not fully confirmed from the scout artifact alone.
- A Rust rewrite will also need a decision on whether to preserve `.atomic`/legacy `.pi` config compatibility, session JSONL format, and raw `.ts` workflow authoring.

### Pattern Finder
## 1. Established patterns

- **Discovery is precedence-based and “first registered wins.”**  
  `packages/workflows/src/extension/discovery.ts` loads sources in a fixed order:
  `settings-project → project-local → settings-global → user-global → package → bundled`.  
  Duplicate `normalizedName` values are rejected with `DUPLICATE_NAME` warnings.

- **User workflows are treated as real TS/JS modules, not a separate DSL.**  
  `workflow-module-loader.ts` uses `jiti/static` with `tryNative: false` and `moduleCache: false`, so `.ts/.js/.mjs/.cjs` files are evaluated dynamically and reloaded on edit.

- **The `@bastani/workflows` package is part of the import contract.**  
  The loader injects in-memory virtual modules for both the SDK root and builtins (`@bastani/workflows`, `@bastani/workflows/builtin/*`) to keep discovery fast and consistent.

- **Workflow exports are normalized before registration.**  
  `collectWorkflowModuleCandidates()` checks `default` first, then named exports, so a single file can expose multiple workflow definitions.

- **Only branded workflow objects are accepted.**  
  `validateWorkflowDefinitionShape()` requires `__piWorkflow === true`, a non-empty `name` and `normalizedName`, and a callable `run`.  
  This is enforced by `defineWorkflow(...).compile()` branding in `define-workflow.ts`.

- **Config-driven discovery is supported in both array and named-map forms.**  
  `config-loader.ts` and `discovery.ts` allow `projectWorkflows` / `globalWorkflows` as `string[]` or `Record<string,string>`, preserving `configuredName` when provided.

- **Backward compatibility with legacy paths is explicit.**  
  User-global discovery scans both Atomic and legacy `.pi`-style locations via `CONFIG_DIR_NAMES`.

## 2. Variations / exceptions

- **Bundled workflows are handled differently from user workflows.**  
  Bundled entries come from a manifest and are merged synchronously/shape-only in startup paths, while file-based workflows go through dynamic import.

- **Config validation is strict, but missing files are not fatal.**  
  Invalid config emits `CONFIG_INVALID`; missing workflow paths emit `PATH_NOT_FOUND`; unreadable dirs are quietly skipped.

- **A workflow file may export multiple candidate definitions.**  
  Tests cover default export vs named export collisions, so “one file = one workflow” is not assumed.

- **Discovery can be partial.**  
  `includeBundled` can be disabled, and package workflow paths are optional, so the registry can be assembled from subsets of sources.

- **Naming is user-facing but registry-keyed by `normalizedName`.**  
  `name` is display text; `normalizedName` is the stable identity used for deduplication and lookup.

## 3. Anti-patterns or risks

- **Rust cannot directly preserve the current plugin model.**  
  The system currently executes arbitrary user-authored TypeScript via `jiti`. A Rust-only loader would break compatibility unless you embed JS, spawn a JS runtime, or redesign the ABI.

- **Discovery semantics are load-bearing and easy to regress.**  
  Small changes to export ordering, duplicate handling, or precedence will change which workflow “wins.”

- **The brand check is not just structural.**  
  Hand-rolled objects with `__piWorkflow` are rejected; compatibility depends on the `defineWorkflow().compile()` brand path.

- **Reload behavior depends on fresh evaluation.**  
  `moduleCache: false` is intentional so `/workflow reload` and edit cycles see file changes immediately.

- **User expectations include legacy path compatibility.**  
  Dropping `.pi`-style locations or named-map config aliases would be a breaking change.

## 4. Evidence index

- `packages/workflows/src/extension/workflow-module-loader.ts`
  - `createJiti(...)`
  - `virtualModules`
  - `collectWorkflowModuleCandidates()`
  - `validateWorkflowDefinitionShape()`

- `packages/workflows/src/extension/discovery.ts`
  - precedence order
  - `scanWorkflowDir()`
  - `loadFromPaths()`
  - `discoverWorkflows()`
  - `DUPLICATE_NAME` / `PATH_NOT_FOUND` / `CONFIG_INVALID`

- `packages/workflows/src/extension/config-loader.ts`
  - `projectWorkflows` / `globalWorkflows`
  - merge-by-scope behavior
  - path resolution and legacy compatibility

- `packages/workflows/src/workflows/define-workflow.ts`
  - `stampWorkflowDefinition()`
  - `isBrandedWorkflowDefinition()`
  - `.compile()` branding path

- Tests:
  - `test/unit/discovery-module-imports.test.ts`
  - `test/unit/discovery.test.ts`
  - `test/unit/config-loader-helpers.test.ts`
  - `test/unit/config-provenance.test.ts`
  - `test/unit/builtin-workflows.test.ts`

### Analyzer
## 1. Behavioral model

This partition is the **workflow plugin discovery layer**.

- `loadWorkflowModule()` loads user-authored workflow files through **jiti**, with `tryNative: false`, `moduleCache: false`, and in-memory virtual modules for `@bastani/workflows` and its builtins. That means each workflow file is re-evaluated fresh, but SDK imports stay fast and stable.
- `collectWorkflowModuleCandidates()` accepts **both `default` and named exports** from a file; default is checked first.
- `validateWorkflowDefinitionShape()` only accepts objects minted by `defineWorkflow(...).compile()`:
  - `__piWorkflow === true`
  - branded via WeakSet
  - non-empty `name` / `normalizedName`
  - callable `run`
- `discoverWorkflows()` merges sources in strict precedence order:
  1. settings-project
  2. project-local
  3. settings-global
  4. user-global
  5. package
  6. bundled
- Duplicate `normalizedName` is **first-wins**; lower-precedence entries emit `DUPLICATE_NAME`.
- Invalid files/configs do not abort discovery; they emit diagnostics like `IMPORT_FAILED`, `PATH_NOT_FOUND`, `CONFIG_INVALID`, or `INVALID_DEFINITION`.

## 2. Key flows and invariants

### Discovery flow
1. Validate optional `DiscoveryConfig`.
2. Load settings-project / project-local / settings-global / user-global / package / bundled in precedence order.
3. For path-based sources:
   - resolve relative paths against the scope’s base dir,
   - detect missing paths as `PATH_NOT_FOUND`,
   - scan directories for `.ts/.js/.mjs/.cjs`,
   - import each file and collect all exports.
4. Register candidates into an immutable-style registry; duplicates are skipped.

### Important invariants
- **Discovery is permissive**: one bad file should not stop the whole scan.
- **Export order matters**: default export wins over later named exports in the same file.
- **Source metadata is preserved**: `kind`, `filePath`, and sometimes `configuredName` are part of the compatibility contract.
- **Bundled startup discovery is synchronous** via `discoverStartupWorkflowsSync()`, but normal discovery is async.
- **Bundled workflows are lowest precedence** and are omitted if `includeBundled=false`.

### Migration implications for Rust
A Rust port must decide whether to:
- embed a JS engine / loader to preserve `.ts`/`.js` workflow compatibility,
- replace workflows with a Rust-native plugin ABI,
- or shell out to a JS sidecar for discovery/execution.

This partition is the clearest “user workflow compatibility” boundary.

## 3. Tests / validation

Coverage is strong and behavior-driven:

- `test/unit/discovery.test.ts`
  - bundled manifest correctness
  - `INVALID_DEFINITION` / `DUPLICATE_NAME`
  - registry immutability-style behavior
  - source-shape invariants
- `test/unit/discovery-module-imports.test.ts`
  - `.js`, `.mjs`, `.cjs` support
  - default + named export collection
  - `PATH_NOT_FOUND`
  - `CONFIG_INVALID`
  - precedence ordering across all source kinds
  - `filePath` / `configuredName` metadata
- Integration tests:
  - `test/integration/custom-registry.test.ts`
  - `test/integration/runtime-wiring.test.ts`

## 4. Risks, unknowns, and verification steps

### Risks
- The **jiti-based TS loading model** is the main migration blocker.
- Workflow compatibility depends on **raw TypeScript authoring**, not just runtime behavior.
- The discovery contract is tightly coupled to `@bastani/workflows` virtual module aliases.

### Unknowns
- Whether Rust should preserve `.ts` workflow authoring directly or require precompiled plugins.
- Whether bundled/package workflows must remain discoverable without JS.
- How much of the current “first-wins + diagnostics” behavior must remain exact.

### Verify next
- Inspect `packages/workflows/src/extension/index.ts` for how discovery is consumed at startup/runtime.
- Check `packages/workflows/docs` / workflow authoring docs for any external compatibility promises.
- Decide on one of three migration strategies:
  1. **Rust host + embedded JS loader**
  2. **Rust host + JS sidecar for workflow loading**
  3. **Rust-native workflow ABI with a compatibility shim**

### Online Researcher
## 1. Relevant external facts

- **`jiti` can load TS/ESM/CJS at runtime** and supports options like `moduleCache` and `tryNative` (`jiti` README / npm docs).
- **`jiti/static` exists specifically for bundled runtimes** and is meant to ensure `babel.cjs` is statically included (jiti PR #430).
- **Bun resolves `.js` imports to `.ts` files** in TS-friendly mode, and can execute raw TypeScript directly (`Bun Module Resolution`, `Bun TypeScript` docs).
- **Bun supports `"bun"` export conditions** for shipping untranspiled TS directly in npm packages (`Bun Module Resolution` docs).

## 2. Local implications

- Your workflow system currently depends on **runtime TS loading**, not just TS types. In `packages/workflows/src/extension/workflow-module-loader.ts`, user workflows are discovered by evaluating authored files through `jiti`, with `virtualModules` to fake `@bastani/workflows` and builtins.
- A Rust rewrite **cannot preserve this behavior implicitly**; it must choose one of:
  1. keep a JS/TS loader bridge,
  2. switch user workflows to another authoring format, or
  3. embed a JS runtime / transpiler path.
- The current setup also relies on **fresh re-evaluation on reload** (`moduleCache: false`) while keeping SDK aliases in-memory. That means Rust needs a matching invalidation model if it wants `/workflow reload` parity.
- `defineWorkflow(...).compile()` produces a **branded runtime object** with a sentinel (`__piWorkflow`) and `WeakSet` brand checks. Rust must preserve the authoring contract if you want old workflow files to remain valid.
- The extension loader in `packages/coding-agent/src/core/extensions/loader.ts` shows the same pattern at a broader level: **dynamic extension discovery, virtual aliases, and TS/JS interop** are core platform behavior, not just workflow behavior.

## 3. Version/API assumptions

- Assumed `jiti` behavior is from current docs for the `createJiti` API and `jiti/static`.
- Assumed Bun module resolution behavior matches current Bun docs for TS/JS interop and `"bun"` exports.
- No Rust-side API baseline exists in this repo yet, so the migration target is still undefined.

## 4. Unverified or unnecessary research

- I did **not** verify a Rust crate/runtime strategy yet (for example, whether you’d use a JS engine, WASM, or a native parser/loader), because the repo currently has no Rust baseline.
- I also did not research whether the workflow DSL itself should change; locally, the bigger constraint is **runtime compatibility of authored workflows**, not the DSL syntax alone.