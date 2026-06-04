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