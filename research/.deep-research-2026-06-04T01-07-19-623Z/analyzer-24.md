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