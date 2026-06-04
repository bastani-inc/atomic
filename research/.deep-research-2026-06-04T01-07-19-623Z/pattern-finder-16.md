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