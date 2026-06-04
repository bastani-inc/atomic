## 1. Behavioral model

This partition is the repo’s **resource discovery and merge layer**.

It does three things:

1. **Reads package manifests** (`package.json`, plus legacy `pi`/new `atomic` keys).
2. **Discovers resources** from package conventions and explicit manifest entries:
   - extensions
   - skills
   - prompts
   - themes
   - workflows
3. **Merges sources with precedence**:
   - builtin resources
   - package-discovered resources
   - CLI-injected resources
   - override/filter rules

For a Rust migration, this is the compatibility boundary that decides whether your new host can still “see” the same extension/workflow ecosystem.

## 2. Key flows and invariants

### Manifest parsing
- `getManifestFromPackageJson()` / `readPiManifestFile()` normalize package metadata.
- The loader accepts both `atomic` and legacy `pi` manifest shapes.
- This is a hard compatibility invariant: old packages still need to resolve.

### Resource discovery
- `DefaultPackageManager.resolve()` is the main entry.
- It gathers resources by type using convention-based discovery:
  - auto extension entrypoints
  - skill directories
  - prompt directories
  - theme directories
- `manifestEntriesForResource()` maps manifest keys to resource categories, including workflow aliases.

### Filtering and precedence
- `applyPatterns()` and `isEnabledByOverrides()` implement `!`, `+`, `-` style include/exclude behavior.
- `dedupePackages()` / `packageSourcesMatch()` / `getPackageIdentity()` ensure package identity is stable across user/project scopes.
- Invariant: **project-local definitions can override or shadow user/builtin ones** when identity matches and precedence rules allow it.

### Merge layer
- `DefaultResourceLoader.reload()` is the top-level merge point.
- `collectWorkflowResources()` is the explicit workflow merge path.
- This layer combines:
  - package-resolved resources
  - builtin packages
  - CLI overrides
- Important coupling: once merged, downstream extension/workflow loading assumes the final list is already filtered and deduped.

## 3. Tests / validation

Evidence points to direct coverage in:
- `packages/coding-agent/test/package-manager.test.ts`
  - path resolution
  - symlink handling
  - manifest parsing
  - precedence
- `packages/coding-agent/test/resource-loader.test.ts`
  - reload semantics
  - workflow refresh
  - collision handling
- `packages/coding-agent/test/suite/regressions/2781-skill-collision-precedence.test.ts`
  - override precedence
- `test/unit/package-metadata.test.ts`
  - bundled assets and manifest compatibility

What’s still unclear:
- whether `packages/coding-agent/test` is fully run in CI or only selectively
- whether built-in package bundling is validated by a dedicated integration test

## 4. Risks, unknowns, and verification steps

### Risks for Rust migration
- **Manifest compatibility risk**: breaking `atomic`/`pi` keys will break existing packages.
- **Discovery semantics risk**: convention-based loading is implicit; Rust must match it exactly.
- **Precedence risk**: user/project/builtin ordering is easy to get subtly wrong.
- **Workflow coupling**: workflows are part of this same discovery surface, so a mismatch breaks authoring/runtime loading immediately.

### Unknowns
- Exact behavior for every manifest edge case.
- Full CI/test coverage for package/resource loading.
- Whether any undocumented manifest fields are consumed elsewhere.

### Verify by
- Running the package/resource loader tests.
- Comparing discovered resources before/after migration on a representative repo.
- Checking fixtures for:
  - legacy `pi` manifests
  - nested/local packages
  - symlinked packages
  - duplicate resource names across scopes
  - workflow manifest aliases