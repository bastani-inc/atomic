## 1. Established patterns

- **`jiti` is the standard dynamic loader for authored TS/JS.**
  - `packages/coding-agent/src/core/extensions/loader.ts` uses `createJiti(...)`.
  - `packages/workflows/src/extension/workflow-module-loader.ts` uses the same pattern for workflow files.
  - Docs explicitly say extensions/workflows “load via jiti, so TypeScript works without compilation.”

- **Loader semantics are intentionally “runtime-native,” not build-time transpiled.**
  - Both loaders set `moduleCache: false` so edits stay observable.
  - `workflow-module-loader.ts` sets `tryNative: false` so `jiti` owns `.ts/.js/.mjs/.cjs` resolution.
  - This means plugin authors can ship raw TypeScript.

- **Virtual modules are a core compatibility layer.**
  - `extensions/loader.ts` defines `VIRTUAL_MODULES` for:
    - `@bastani/atomic`
    - `@earendil-works/pi-*`
    - `@sinclair/typebox`
  - `workflow-module-loader.ts` exposes `@bastani/workflows` and builtin workflow modules in-memory.
  - Pattern: preserve author-facing import specifiers even when the runtime isn’t a normal `node_modules` tree.

- **There are two loader modes: dev alias resolution vs bundled-binary virtual modules.**
  - `extensions/loader.ts` has `getAliases()` for Node/dev, and `virtualModules` for Bun binary mode.
  - This split is a recurring portability convention.

- **Modules are normalized before discovery/validation.**
  - `workflow-module-loader.ts` materializes export descriptors and normalizes CJS/default interop.
  - It then validates branded workflow shape (`__piWorkflow`, `name`, `run`, etc.).
  - That shows the repo treats plugin loading as “discover then validate,” not “trust and execute blindly.”

- **Some non-TS plugin-ish paths already fall back to subprocess execution.**
  - `packages/subagents/src/runs/background/async-execution.ts` locates `jiti` and spawns `node process.execPath` + `jiti-cli`.
  - So even today, some “dynamic execution” is already an external process boundary.

## 2. Variations / exceptions

- **Extensions are broader than workflows.**
  - Extension loader bridges to agent core, TUI, AI, and TypeBox packages.
  - Workflow loader is narrower and focuses on `@bastani/workflows` SDK + builtin workflows.

- **Bundled binary vs source-tree behavior differs.**
  - In dev, loaders rely on filesystem/package resolution.
  - In compiled Bun binary mode, they rely on explicit virtual modules to keep imports working.

- **Subagents use `jiti` as a runtime toolchain dependency, not just a loader.**
  - `async-execution.ts` resolves the `jiti` CLI and spawns it for detached async runs.
  - That’s a separate dependency surface from extension/workflow loading.

- **The repo already preserves compatibility with upstream/legacy package names.**
  - `extensions/loader.ts` aliases both `@bastani/*` and `@mariozechner/*`.
  - That suggests migration must keep specifier compatibility, not just code behavior.

## 3. Anti-patterns or risks

- **Rust can’t directly replace this without a new plugin strategy.**
  - The current model depends on executing authored TS/JS at runtime.
  - A pure Rust binary would break that unless you:
    1. embed a JS runtime,
    2. keep a JS sidecar process,
    3. or define a new Rust-native plugin ABI.

- **`jiti` is doing more than “loading files.”**
  - It handles TS syntax, ESM/CJS interop, local imports, and in-memory SDK aliases.
  - A Rust port needs equivalent resolution semantics, not just file reading.

- **Virtual module behavior is part of the public contract.**
  - User workflows/extensions import `@bastani/atomic`, `@bastani/workflows`, and builtin subpaths.
  - Breaking these specifiers would be a migration-level breaking change.

- **There’s a cache/editability tension.**
  - `moduleCache: false` makes edits visible but can make discovery slower.
  - The code comments note real performance costs when aliasing to on-disk SDK graphs.

- **Cross-boundary runtime compatibility is already fragile.**
  - Comments mention jiti module cache boundaries, duck-typing, and stale contexts.
  - Rust migration would likely magnify these boundary issues if it adds FFI or subprocess layers.

## 4. Evidence index

- `packages/coding-agent/src/core/extensions/loader.ts`
  - `createJiti(...)`
  - `VIRTUAL_MODULES`
  - `getAliases()`
  - dev/binary split

- `packages/workflows/src/extension/workflow-module-loader.ts`
  - `createJiti(...)`
  - `moduleCache: false`
  - `tryNative: false`
  - `WORKFLOWS_VIRTUAL_MODULES`
  - `loadWorkflowModule()`, `collectWorkflowModuleCandidates()`

- `packages/coding-agent/docs/extensions.md`
  - “Extensions are loaded via jiti, so TypeScript works without compilation.”

- `packages/coding-agent/docs/workflows.md`
  - “Workflow files are loaded via jiti…”

- `packages/subagents/src/runs/background/async-execution.ts`
  - `resolveJitiCliPath()`
  - `spawn(process.execPath, [jitiCliPath, runner, cfgPath], ...)`

- `packages/coding-agent/docs/changelog.mdx`
  - packaged workflow discovery resolves through `jiti`

- `packages/coding-agent/CHANGELOG.md`
  - prior fixes around `jiti` aliasing, virtual modules, and extension loading in compiled binary

If you want, I can turn this into a **Rust migration decision matrix** next: “keep JS plugins,” “embed JS runtime,” or “replace with Rust-native plugins.”