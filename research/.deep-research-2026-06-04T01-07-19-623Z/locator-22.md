# 1. Must-read paths

- `docs/ci.md` — explains the bundling contract: only `@bastani/atomic` is published, and `packages/*` companions are copied into `dist/builtin/`.
- `packages/coding-agent/package.json` — defines the publishable package, `build`/`copy-assets`/`copy-builtin-packages` scripts, and the exported `./workflows` subpaths.
- `packages/coding-agent/scripts/copy-builtin-packages.ts` — actual source-to-`dist/builtin/` copier for `@bastani/workflows`, `subagents`, `mcp`, `web-access`, `intercom`.
- `packages/coding-agent/scripts/copy-runtime-dependencies.ts` — copies runtime `node_modules` dependencies into release bundles; critical for any Rust packaging plan.
- `scripts/build-binaries.sh` — assembles binaries, copies `dist/builtin/`, and stages `node_modules` into per-platform archives.
- `packages/coding-agent/src/core/builtin-packages.ts` — runtime discovery of bundled package locations in source, dist, and binary layouts.
- `packages/coding-agent/src/core/resource-loader.ts` — consumes builtin package paths during extension/resource loading.
- `packages/coding-agent/src/main.ts` — wires `getBuiltinPackagePaths()` into app startup.
- `packages/coding-agent/scripts/verify-workflow-sdk-types.ts` — verifies the workflow ambient/type bridge produced by bundling.

# 2. Supporting paths

- `packages/coding-agent/tsconfig.build.json` — shows the build emits `dist/` from raw TS; useful if replacing with Rust-generated artifacts.
- `packages/coding-agent/src/index.ts` — re-exports `getBuiltinPackagePaths` and SDK surfaces.
- `packages/coding-agent/src/core/extensions/loader.ts` — relevant because builtin packages are still loaded through the JS/TS extension system.
- `packages/workflows/package.json` — companion package shape and private workspace status.
- `packages/subagents/package.json`
- `packages/mcp/package.json`
- `packages/web-access/package.json`
- `packages/intercom/package.json`
- `.github/workflows/test.yml` and `.github/workflows/publish.yml` — CI/release checks that validate bundled packages and release archives.
- `scripts/bump-version.ts` — all workspace versions stay in sync, which affects release packaging.

# 3. Entry points / symbols

- `copy-builtin-packages.ts`
  - `WORKSPACE_BUILTINS`
  - `copyFilteredDirectory()`
  - `emitWorkflowAuthoringTypes()`
  - `pruneRawWorkflowAuthoringSources()`
  - `writeWorkflowsAmbientDeclaration()`
  - `injectWorkflowsAmbientReference()`
- `copy-runtime-dependencies.ts`
  - `copyRuntimeDependencies()`
  - `dependencyRequests()`
  - `copyPackageDirectory()`
- `builtin-packages.ts`
  - `WORKSPACE_BUILTINS`
  - `getBuiltinPackagePaths()`
  - `firstExistingPackageDir()`
- `package.json`
  - `build`
  - `copy-assets`
  - `copy-builtin-packages`
  - `copy-binary-assets`
  - `build:binary`

# 4. Gaps or uncertainty

- I did not verify the exact test files that cover `copy-builtin-packages.ts` or `copy-runtime-dependencies.ts`.
- I did not inspect the full `.github/workflows/publish.yml`; it likely mirrors `scripts/build-binaries.sh`, but that needs confirmation.
- The Rust migration impact here is still indirect: these paths show the current TS packaging/runtime contract, but not the target Rust architecture.