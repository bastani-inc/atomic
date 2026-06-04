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