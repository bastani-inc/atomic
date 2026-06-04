## Partition 16: Resource loading, package discovery, manifests, and builtin resource merging

### Locator
## 1. Must-read paths

- `packages/coding-agent/src/core/package-manager.ts`  
  Core package/resource discovery engine. This is where `package.json` manifests, `atomic`/legacy `pi` keys, local paths, npm/git packages, auto-discovery, deduping, and precedence are implemented.

- `packages/coding-agent/src/core/resource-loader.ts`  
  Merges package-discovered resources with CLI-injected resources and builtin packages, then loads extensions/skills/prompts/themes/workflows into runtime state.

- `packages/coding-agent/src/core/extensions/loader.ts`  
  Extension loading boundary; important because resource discovery ultimately feeds dynamic module loading.

- `packages/coding-agent/docs/packages.md`  
  User-facing contract for package structure, manifest keys, convention dirs, filtering, and scope/dedup rules. Essential for preserving behavior in Rust.

- `docs/ci.md`  
  Explains builtin package bundling and the publish/build shape; useful for understanding how resource files are shipped today.

## 2. Supporting paths

- `packages/coding-agent/test/package-manager.test.ts`  
  Direct tests for package discovery, path resolution, symlink handling, manifest parsing, and precedence.

- `packages/coding-agent/test/resource-loader.test.ts`  
  Tests the merge/load layer: workflow resource refresh, collision handling, and loader behavior.

- `packages/coding-agent/test/suite/regressions/2781-skill-collision-precedence.test.ts`  
  Verifies override precedence between package/user/project skills.

- `packages/coding-agent/test/suite/regressions/3616-settings-inmemory-reload.test.ts`  
  Likely covers reload semantics when settings are in-memory.

- `test/unit/package-metadata.test.ts`  
  Verifies published package metadata, including bundled assets and the atomic/pi manifest compatibility contract.

- `packages/workflows/package.json`  
  Relevant because workflows are part of the resource-discovery surface.

## 3. Entry points / symbols

- `DefaultPackageManager.resolve()`  
  Returns resolved resources for extensions/skills/prompts/themes/workflows.

- `DefaultPackageManager.resolveExtensionSources()`  
  Temporary/CLI extension discovery path.

- `getManifestFromPackageJson()` / `readPiManifestFile()`  
  Manifest compatibility: `atomic` key plus legacy `pi` shim.

- `manifestEntriesForResource()`  
  Maps manifest keys to resource types, including `workflows` / `workflow`.

- `collectAutoExtensionEntries()`  
  Auto-discovers extension entrypoints (`index.ts`, `index.js`, direct `.ts/.js` files).

- `collectSkillEntries()` / `collectAutoPromptEntries()` / `collectAutoThemeEntries()`  
  Convention-directory discovery for skills, prompts, themes.

- `applyPatterns()` / `isEnabledByOverrides()`  
  Filtering semantics for `!`, `+`, `-` resource filters.

- `dedupePackages()` / `packageSourcesMatch()` / `getPackageIdentity()`  
  Scope-aware package deduplication and project-vs-user precedence.

- `DefaultResourceLoader.reload()`  
  Top-level merge point for resolved package resources + builtin packages + CLI overrides.

- `collectWorkflowResources()`  
  The explicit merge point for workflow resources from package/CLI/builtin sources.

## 4. Gaps or uncertainty

- I could verify the resource-loading and manifest paths directly, but not the full CI gate for `packages/coding-agent/test` vs root test runs.
- `docs/packages.md` is the key contract doc; other docs may also mention resource loading, but I didn’t verify additional cross-references.
- The exact builtin-package bundling mechanism lives outside this partition; `docs/ci.md` points to it, but I didn’t fully trace the bundling scripts here.
- Rust migration impact is clear: this partition is the compatibility layer for package discovery and manifest semantics, so breaking changes here would affect extension/workflow loading immediately.

### Pattern Finder
## 1. Established patterns

- **`package.json` is the manifest source of truth.**  
  Package discovery reads `package.json` and looks for an `atomic` key, with legacy `pi` compatibility still supported.  
  - `packages/coding-agent/docs/packages.md`
  - `packages/coding-agent/src/core/package-manager.ts:2231-2240`

- **Manifest-driven loading beats convention, but convention remains a fallback.**  
  If a manifest exists, declared arrays decide what loads; otherwise the loader scans standard directories.  
  - `packages/coding-agent/src/core/package-manager.ts:2115-2154`
  - `packages/coding-agent/docs/packages.md`

- **One resource pipeline handles extensions, skills, prompts, themes, and workflows.**  
  The same resolution machinery is reused across all resource types via `RESOURCE_TYPES`, `getTargetMap`, and `ResolvedPaths`.  
  - `packages/coding-agent/src/core/package-manager.ts:923-980`
  - `packages/coding-agent/src/core/package-manager.ts:2491-2555`

- **Precedence is explicit and stable.**  
  Project beats user, local settings beat auto-discovery, and package resources rank lowest.  
  - `packages/coding-agent/src/core/package-manager.ts:166-177`
  - `packages/coding-agent/src/core/package-manager.ts:928-939`
  - `packages/coding-agent/test/package-manager.test.ts` (“project resources over user”, symlink precedence)

- **Resource merging is canonicalized and first-win.**  
  Resolved entries are sorted by precedence, then deduped by canonical path.  
  - `packages/coding-agent/src/core/package-manager.ts:2533-2555`

- **Package filters are layered, not replacing manifests.**  
  User patterns (`!`, `+`, `-`) narrow or override what the manifest allows.  
  - `packages/coding-agent/src/core/package-manager.ts:732-740`
  - `packages/coding-agent/src/core/package-manager.ts:2180-2228`
  - `packages/coding-agent/docs/packages.md`

- **Builtin package merging is a separate, late step.**  
  `DefaultResourceLoader` merges resolved user/project resources with builtin workspace packages, then loads extensions and resource files from that combined set.  
  - `packages/coding-agent/src/core/resource-loader.ts:300-305`
  - `packages/coding-agent/src/core/resource-loader.ts:379-505`
  - `packages/coding-agent/src/core/builtin-packages.ts`

- **Skills have special “directory to `SKILL.md`” normalization.**  
  A skill directory may resolve to `SKILL.md` if present, and source metadata is remapped to that file.  
  - `packages/coding-agent/src/core/resource-loader.ts:386-405`
  - `packages/coding-agent/test/resource-loader.test.ts` (“ignore extra markdown files”, skills from dirs)

## 2. Variations / exceptions

- **Workflows are the main manifest exception.**  
  If `atomic.workflows` / `pi.workflows` is missing, conventional `workflows/` and `workflow/` directories are still scanned.  
  - `packages/coding-agent/src/core/package-manager.ts:2129-2136`
  - `packages/coding-agent/docs/packages.md`

- **Extensions use “smart discovery,” not pure recursion.**  
  `index.ts` / `index.js` and manifest-declared entries are preferred; nested directories are only explored one level deep for extension files.  
  - `packages/coding-agent/src/core/package-manager.ts:545-627`

- **Skills and prompts are simpler than extensions.**  
  Skills use `SKILL.md` conventions and `.md` files; prompts use `.md`; themes use `.json`.  
  - `packages/coding-agent/src/core/package-manager.ts:629-640`

- **Temporary/CLI paths are merged differently.**  
  CLI-provided extension paths are loaded as temporary sources and merged after the resolved package graph.  
  - `packages/coding-agent/src/core/resource-loader.ts:430-505`

- **Builtin package discovery depends on checkout layout.**  
  `getBuiltinPackagePaths()` searches source-checkout paths, dist paths, and executable-relative `builtin/<package>` paths.  
  - `packages/coding-agent/src/core/builtin-packages.ts`

## 3. Anti-patterns or risks

- **Manifest compatibility is already dual-track (`atomic` + `pi`).**  
  A Rust port must preserve or explicitly break this backwards compatibility.  
  - `packages/coding-agent/docs/packages.md`
  - `packages/coding-agent/src/core/package-manager.ts:2237-2240`

- **Path identity is subtle.**  
  The system mixes raw paths, resolved paths, symlinks, and canonicalized paths; wrong normalization can cause duplicate loads or wrong precedence.  
  - `packages/coding-agent/src/core/package-manager.ts:2539-2549`
  - `packages/coding-agent/test/package-manager.test.ts` (symlinked resources loaded once)

- **Filtering semantics are nontrivial.**  
  `!`, `+`, `-` interact with include/exclude logic and exact-vs-glob matching differently for skills vs other resources.  
  - `packages/coding-agent/src/core/package-manager.ts:656-740`

- **Builtin merging is layout-sensitive.**  
  It assumes specific source/dist/executable directory shapes; a Rust rewrite needs an equivalent packaging story.  
  - `packages/coding-agent/src/core/builtin-packages.ts`
  - `docs/ci.md` (bundled builtin packages under `dist/builtin/`)

- **Discovery is intentionally permissive and filesystem-heavy.**  
  The loader scans directories, symlinks, ignore files, and multiple fallback roots; easy to regress in Rust if you simplify too early.  
  - `packages/coding-agent/src/core/package-manager.ts:575-627`
  - `packages/coding-agent/src/core/resource-loader.ts`

## 4. Evidence index

- `packages/coding-agent/src/core/package-manager.ts`
  - `545-627` extension discovery
  - `629-740` resource collection + pattern semantics
  - `923-980` global/project/package resolution order
  - `2115-2154` manifest-vs-convention behavior
  - `2180-2289` package filtering and manifest file collection
  - `2331-2555` manifest read + canonical dedupe

- `packages/coding-agent/src/core/resource-loader.ts`
  - `300-505` merging package resources with builtin/CLI paths
  - `386-405` skill directory → `SKILL.md`
  - `548-559` builtin package resource resolution

- `packages/coding-agent/src/core/builtin-packages.ts`
  - builtin package path lookup across source/dist/runtime layouts

- `packages/coding-agent/docs/packages.md`
  - manifest format, convention directories, filter semantics, scope/dedup rules

- `packages/coding-agent/test/resource-loader.test.ts`
  - skill discovery, symlink dedupe, collision precedence

- `packages/coding-agent/test/package-manager.test.ts`
  - local/project/user resolution and resource precedence behavior

### Analyzer
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

### Online Researcher
## 1. Relevant external facts

- **npm `package.json` is the canonical package manifest format**; it must be actual JSON, and fields like `name`, `version`, `keywords`, `dependencies`, `peerDependencies`, and `bundleDependencies` are standard npm metadata. `keywords` specifically improve discoverability in `npm search`.  
  Source: **package.json | npm Docs**

- **`bundleDependencies` / `bundledDependencies` are honored by npm pack/publish** and are used to ship selected dependencies inside the tarball.  
  Source: **package.json | npm Docs**

- **`peerDependencies` are the right mechanism for host-plugin compatibility**: npm treats them as compatibility constraints rather than normal runtime deps.  
  Source: **package.json | npm Docs**

- **Local path dependencies and git URLs are valid npm package sources**.  
  Source: **package.json | npm Docs**

- **The repo’s package contract is more specific than npm’s generic manifest**: `atomic` / legacy `pi` keys define resource lists, and conventional dirs are used when manifests are absent.  
  Source: **`packages/coding-agent/docs/packages.md`**

## 2. Local implications

- In a TS→Rust migration, **do not change the manifest contract**. `package.json` parsing must still support:
  - `atomic` and legacy `pi`
  - `extensions`, `skills`, `prompts`, `themes`, `workflows` / singular `workflow`
  - glob patterns, `!` excludes, `+` includes, and scope precedence

- **Resource discovery is the migration boundary**, not just JSON parsing:
  - package discovery (`npm`, `git`, local path)
  - conventional directories fallback
  - dedupe/precedence rules across user/project scope
  - builtin package merging in the resource loader

- If Rust replaces the TS loader, it must preserve npm-compatible package semantics where this repo relies on them, especially:
  - **`peerDependencies`** for bundled host SDKs
  - **`bundleDependencies`** for shipping nested packages
  - **git/local source handling** for package installation/discovery

- The biggest risk is changing **ordering/precedence**: `resource-loader.ts` merges package resources, builtin resources, and CLI-injected resources. Any Rust rewrite must keep “first wins” collision behavior identical.

## 3. Version/API assumptions

- Assumed npm manifest behavior from **npm v10/v11 docs**.
- Assumed package contract from current repo docs:
  - `atomic` key is primary
  - `pi` key remains backward-compatible
  - workflows may use `workflow` as a singular alias
- Assumed resource file conventions remain:
  - `extensions/*.ts|.js`
  - `skills/**/SKILL.md` and top-level `.md`
  - `prompts/*.md`
  - `themes/*.json`
  - `workflows/*.ts|.js|.mjs|.cjs`

## 4. Unverified or unnecessary research

- I did **not** verify Rust crate choices for globbing, ignore rules, or package parsing; that’s implementation detail, not contract.
- I did **not** trace the full builtin packaging pipeline from CI scripts here; the local docs already show the relevant published-package shape.
- I did **not** research broader Node module-resolution behavior because this partition is about **resource loading and manifest semantics**, not JS module loading itself.