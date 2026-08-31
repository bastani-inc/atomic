# Native builtin routing validation

## Environment

- Bun: `1.4.0`
- OS/architecture: `Darwin arm64` (`uname -sm` => `Darwin arm64`)
- Repository branch: `perf/native-builtin-loader`
- Implementation commits under test:
  - `1e93c4a0d025566cc81a5689445e47fa84ac39fa` — `feat(extensions): native-load installed builtins`
  - `c74aa5f5c0fabc943b7857bf8cf0954245d8f8c8` — `test(extensions): cover native builtin routing`
  - `6d49ed2f66a70422ee9c2d5d0cf7ccc63bcc1914` — `docs(extensions): document native builtin reloads`
- Additional validation commits:
  - `ab4aa85f7989c3374f9e7adb9684e23be469b3a4` — `test(extensions): verify Node skips native builtin cache`
  - `docs(evidence): record native builtin routing validation` — the signed commit containing this document; its hash is reported by `git log` after creation because a commit cannot embed its own hash.
  - `79e29a3f6a397117908ad01da3d5cca48b5a931d` — `fix(builtin): make native extension bundles self-contained`.
  - `83a15f4fc51e876df60a7f7dd95ac7d1254bcf8b` — `test(ci): guard native builtin dependency closure`.
  - `286031a89e` — `fix(extensions): contain missing native binding`.
  - `3ba9519efe` — `fix(builtin): preserve MCP xdg-open fallback`.
  - `627f11a083` — `test(ci): make native builtin guards hermetic`.
  - `cc64ca9fa9` — `docs(extensions): clarify reload state reuse`.

## Result table

| Area | Result | Evidence |
|---|---|---|
| Trusted entry classification | **PASS** | The original focused run passed 4 files and 26 tests. After adding the Node cache guard regression, the same command passed 4 files and 27 tests. The tests cover exactly five identity-verified installed entries and reject arbitrary, sibling, manifest-only, source, and spoofed-package paths. |
| Editable reload behavior | **PASS** | Focused graph-manifest tests observed both direct entry edits and transitive dependency edits. Editable TypeScript extensions remain on the jiti/content-hash path. |
| Compiled production route | **PASS after regression repair** | The original fixture proved host identity but imported only bridge-registered packages and therefore missed unresolved third-party imports. The strengthened fixture bundles and executes `chalk`; a new contract inspects all five installed entries; and an extracted real release binary starts and reports commands/resources from all five builtin packages. |
| Node/npm route | **PASS** | Under Node, the new focused test loads an identity-verified installed entry through the real loader and proves that the persistent native-builtin factory cache remains unpopulated. The full coding-agent, root unit, and root integration suites also passed under Node. |
| Static checks | **PASS** | `npm run check` passed Biome, root `tsc --noEmit`, coding-agent tsgo build and typetests, and shrinkwrap verification. |

## Commands and observed results

### Focused loader tests

```sh
npx vitest --run --root packages/coding-agent \
  test/native-builtin-entries.test.ts \
  test/extensions-graph-manifest-reuse.test.ts \
  test/extensions-loader-virtual-modules.test.ts \
  test/extensions-host-module-bridge.test.ts
```

Before the Node cache guard regression was added, the result was 4 files passed and 26 tests passed. With the new regression, the result was 4 files passed and 27 tests passed.

The new test alone also passed:

```text
Test Files  1 passed (1)
     Tests  4 passed (4)
```

### Compiled boundary

```sh
npm run test:ci-contracts -- test/ci/extension-host-module-bridge-boundary.test.ts
```

Observed result: 1 file passed and 1 test passed. Verbose output showed three real Bun builds:

1. An ESM extension bundle with its host imports externalized.
2. The CJS application sidecar containing the production loader.
3. A `--compile --bytecode` launcher.

The test then executed the compiled launcher, which printed:

```text
compiled native-builtin production loader probe: OK
```

### Regression discovered by the real release binary

The first validation verdict was premature. Building and extracting the actual Darwin arm64 archive, then running `./atomic --help`, failed before showing help:

```text
error: Mandatory bundled Intercom is unavailable: Failed to load extension:
Cannot find package 'chalk' imported from .../builtin/intercom/index.bundle.mjs
```

`copy-builtin-packages.ts` had built every installed entry with `packages: "external"`. The former jiti route resolved those bare dependencies from the shipped `node_modules`; native `import()` from a Bun compiled binary cannot resolve an external file's transitive bare imports. All five entries retained unregistered packages, so this was a startup-breaking regression rather than an isolated Intercom problem.

The repair removes `packages: "external"` for installed extension entries and reachable workflow builtin bundles. Bun now embeds third-party JavaScript while preserving exact host identities as explicit externals. The explicit host set was completed for the registered `@bastani/pi-ai` entries and `proper-lockfile`.

Two dependencies required deliberate handling:

- `linkedom`'s Node entry probes the optional native `canvas` peer, whose missing `.node` build made Bun fail. The builtin-only build plugin resolves `linkedom` to its API-compatible `linkedom/worker` entry, which has no canvas dependency. The raw source import stays unchanged, so Node/npm and source-checkout behavior is untouched.
- `@bastani/atomic-natives` is a genuine native binding and cannot be embedded. The installed bundles keep it external; the compiled host loads the shipped platform binding by its runtime package path and registers that exact live exports object through the host bridge.

### Dependency-closure contract and strengthened boundary

`test/ci/native-builtin-bundle-imports.test.ts` builds the installed package, parses every one of the five installed entry bundles, and rejects every bare import that is neither a Node builtin nor a real `getVirtualModules()` key. With the old `packages: "external"` setting restored temporarily, it failed with a list beginning:

```text
workflows: cross-spawn
workflows: chalk
workflows: highlight.js/lib/core.js
```

The compiled boundary fixture now imports and calls `chalk.green()`. With `chalk` temporarily externalized to reproduce the old bundle shape, the compiled executable failed with:

```text
Cannot find package 'chalk' imported from .../builtin/intercom/index.bundle.mjs
```

After bundling `chalk`, the fixture passed while its proper-lockfile, Atomic, and pi-ai host imports remained external and identity-shared.

### Real archive end to end

The final implementation was built with:

```sh
./scripts/build-binaries.sh --skip-deps --skip-install --skip-package-build \
  --offline-model-data --platform darwin-arm64
```

The archive was extracted to `/tmp/atomic-e2e/atomic`. The checkout's `packages/coding-agent/dist/builtin` was temporarily hidden during execution so the compiled build-time `import.meta.url` could not select checkout artifacts instead of the extracted payload.

The earlier run recorded here used `ATOMIC_AGENT_DIR`, which Atomic does not read. It therefore used the caller's default agent directory; the run proved startup and builtin discovery, but it did **not** prove agent-directory isolation. `./atomic --help` still exited 0 and began:

```text
atomic - AI coding assistant with read, bash, edit, write, find, search, ask_user_question, todo tools
```

An offline RPC `get_commands` request also exited 0. Its response identified builtin resources from the extracted payload for all five packages: `/workflow` and `/workflows` from workflows, subagent skills including `skill:subagent`, `/mcp` and `/mcp-auth` from MCP, `/websearch` and related commands from web-access, and `/intercom` plus `skill:intercom` from Intercom. Every `sourceInfo.path` was under `/private/tmp/atomic-e2e/atomic/builtin/...`; no checkout path or extension-load error appeared.

After the review repair, the archive was rebuilt and extracted to `/tmp/atomic-review-e2e/atomic`, with the checkout's `dist/builtin` again hidden. Both commands used the real `ATOMIC_CODING_AGENT_DIR=/tmp/atomic-review-agent` override. `./atomic --help` and the offline RPC request exited 0. RPC returned 28 commands and included `workflow`, `workflows`, `skill:subagent`, `mcp`, `mcp-auth`, `websearch`, `intercom`, and `skill:intercom`. The extracted `builtin/mcp/xdg-open` existed with mode `0755`.

### Review-round repairs

- The compiled boundary fixture now sets `ATOMIC_CODING_AGENT_DIR`, so its jiti-cache check is hermetic and inspects the directory the product actually uses. For the liveness control, the native route was temporarily disabled, the read poison was neutralized, and the fixture exited after the jiti load. The outer assertion then failed specifically with `AssertionError: native builtin created jiti cache` and `true !== false`. The production route passed after restoration.
- Loading `@bastani/atomic-natives` is contained. A successful require returns the exact same exports object; a failed require omits only that virtual-module registration. Removing the containment made the focused test fail with `Error: native binding unavailable` at `loadOptionalAtomicNatives`. The in-place `npm run build:binary --workspace=@bastani/atomic` artifact, which does not stage the native package under `dist/node_modules`, now runs `dist/atomic --help` successfully with exit 0.
- The bundled MCP extension keeps `open` embedded but copies its vendored `xdg-open` beside `index.bundle.mjs` and preserves executable mode. Omitting the copy made the closure test fail with `ENOENT .../dist/builtin/mcp/xdg-open`.
- The dependency-closure contract now checks all five installed entries, the workflow SDK bundle, and every emitted workflow builtin entry and split chunk. Restoring `packages: "external"` still failed with unregistered imports beginning `cross-spawn`, `chalk`, and `highlight.js`. Injecting a control import into a generated chunk failed with `workflows/builtin/chunk-0x6e303p.js: review-control-unregistered`.
- The extension documentation now states the retained-factory behavior accurately: an unchanged editable graph can reuse module state in Bun single-file builds; an edit anywhere in the graph forces re-evaluation. Fixed installed builtins always reuse their factories across reloads.

### Repository checks and suites

```sh
npm run check
npm run test --workspace=@bastani/atomic
npm run test:unit
npm run test:integration
```

Observed results:

- `npm run check`: passed, including Biome, `tsc --noEmit`, coding-agent tsgo build and typetests, and shrinkwrap verification. Biome reported one pre-existing informational `noUselessStringRaw` diagnostic outside this change.
- Coding-agent suite: 499 files passed, 4 files skipped; 4115 tests passed, 40 tests skipped.
- Root unit suite: 723 files passed; 7265 tests passed, 23 tests skipped.
- Root integration suite: 40 files passed; 506 tests passed.
- Full CI-contract suite: 15 files passed; 76 tests passed.
- Final focused host-module run: 1 file passed; 5 tests passed.
- Final compiled-boundary plus dependency-closure run: 2 files passed; 2 tests passed.

During the repair validation, one full unit attempt had a single 32.5-second fixture-report timeout in `interactive-engine-inherited-discovery.test.ts` while all other 7,264 tests passed. That file immediately passed alone (2 tests), and the required full rerun then passed all 723 files and 7,265 tests. No product assertion failed.

An initial root-unit invocation reported 4 failed tests because `packages/coding-agent/dist/builtin` did not exist: the coding-agent workspace build had not yet run. After:

```sh
npm --workspace=@bastani/atomic run build
```

the affected focused tests passed (2 files, 47 tests), and the subsequent full unit run passed with the totals above. This was missing setup, not a loader regression.

### PR #2774 review repairs

- Greptile identified that `packages/coding-agent/test/native-builtin-entries.test.ts` used `node:assert/strict` instead of the package suite's Vitest `expect` convention. Commit `7e2bff55bc` converts only that package test while preserving its four test names, assertion meanings, and cache-population explanation.
- The dependency-closure test derived its builtin set from `builtinModules`. Node 22 omits prefix-only modules such as `node:sqlite` from that list even though the runtime supports them. Commit `6762a79250` uses `isBuiltin` as the authoritative predicate and adds a fast invariant test that accepts `node:sqlite` and `node:fs` while rejecting the third-party `acorn` specifier.

The exact CI-floor runtime demonstrated the version-specific mismatch:

```sh
/tmp/node-v22.19.0-darwin-arm64/bin/node -e 'const { builtinModules, isBuiltin } = require("node:module"); console.log({ builtinModulesHasNodeSqlite: builtinModules.includes("node:sqlite"), isBuiltinNodeSqlite: isBuiltin("node:sqlite"), isBuiltinNodeFs: isBuiltin("node:fs"), isBuiltinAcorn: isBuiltin("acorn") });'
```

```text
{
  builtinModulesHasNodeSqlite: false,
  isBuiltinNodeSqlite: true,
  isBuiltinNodeFs: true,
  isBuiltinAcorn: false
}
```

The first fast invariant test asserted Node's `isBuiltin` API directly rather than the dependency-closure guard, so reverting the guard to the old `builtinModules` set could not make that test fail. Commit `d15b73fe21` extracts `isPermittedSpecifier`, routes both the artifact scan and the fast test through it, and pins prefix-only and ordinary builtins, rejected and registered third-party bare imports, and relative imports.

Temporarily restoring the old `builtinModules` predicate in `isPermittedSpecifier` proved that the focused test is now coupled to the guard. The exact Node 22 red run was:

```sh
PATH=/tmp/node-v22.19.0-darwin-arm64/bin:$PATH node -v
PATH=/tmp/node-v22.19.0-darwin-arm64/bin:$PATH npx vitest run --project ci test/ci/native-builtin-bundle-imports.test.ts -t "specifier permits Node builtins, registered host imports, and relative imports only"
```

```text
v22.19.0

 RUN  v4.1.10 /Users/tonystark/Documents/projects/atomic-native-builtin-loader

 ❯ |ci| test/ci/native-builtin-bundle-imports.test.ts (2 tests | 1 failed | 1 skipped) 3ms
   × specifier permits Node builtins, registered host imports, and relative imports only 2ms

 FAIL  |ci| test/ci/native-builtin-bundle-imports.test.ts > specifier permits Node builtins, registered host imports, and relative imports only
AssertionError: Expected values to be strictly equal:

false !== true

 ❯ test/ci/native-builtin-bundle-imports.test.ts:58:9
     58|  assert.equal(isPermittedSpecifier("node:sqlite", emptyHostSpecifiers)…

 Test Files  1 failed (1)
      Tests  1 failed | 1 skipped (2)
```

After restoring `isBuiltin`, the same command passed under the same runtime:

```sh
PATH=/tmp/node-v22.19.0-darwin-arm64/bin:$PATH node -v
PATH=/tmp/node-v22.19.0-darwin-arm64/bin:$PATH npx vitest run --project ci test/ci/native-builtin-bundle-imports.test.ts -t "specifier permits Node builtins, registered host imports, and relative imports only"
```

```text
v22.19.0

 RUN  v4.1.10 /Users/tonystark/Documents/projects/atomic-native-builtin-loader

 Test Files  1 passed (1)
      Tests  1 passed | 1 skipped (2)
   Duration  1.97s (transform 1.31s, setup 1.87s, import 9ms, tests 1ms, environment 0ms)
```

Final validation results for this repair round:

- `npm run check`: passed Biome, both TypeScript checks, and shrinkwrap verification; Biome reported the existing informational `noUselessStringRaw` diagnostic in `test/ci/ci-workflow-contracts.test.ts`.
- `npm run test --workspace=@bastani/atomic -- native-builtin-entries`: 1 file passed and 4 tests passed.
- `npm run test:ci-contracts`: 15 files passed and 77 tests passed.

## Negative controls

### Compiled builtin bypass

The native branch was temporarily gated with `false &&`, then the compiled-boundary test was run. It failed with:

```text
AssertionError: jiti read builtin source
```

The source was restored before the passing run. This proves that the compiled test's jiti-bypass assertion is load-bearing rather than vacuous.

### Node single-file guard

The `isSingleFileBuild && ` term was temporarily removed from the production guard, leaving:

```ts
if (isNativeBuiltinExtensionPath(extensionPath)) {
```

Running the new focused test produced this exact failure output:

```text
 RUN  v4.1.10 /Users/tonystark/Documents/projects/atomic-native-builtin-loader/packages/coding-agent

 ❯ |agent| test/native-builtin-entries.test.ts (4 tests | 1 failed) 19ms
   × does not retain installed builtin factories in the native cache under Node 7ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |agent| test/native-builtin-entries.test.ts > does not retain installed builtin factories in the native cache under Node
AssertionError: Expected values to be strictly equal:

true !== false


- Expected
+ Received

- false
+ true

 ❯ test/native-builtin-entries.test.ts:96:9
     94|  // Under Node both .mjs routes converge behaviorally, so cache popula…
     95|  // the faithful observable that the single-file-build guard remained …
     96|  assert.equal(extensionLoaderTestHooks.hasNativeBuiltinFactory(entry),…
       |         ^
     97| });
     98|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
```

The original guard was then restored. The same command passed 1 file and all 4 tests. This proves that the cache-population assertion detects removal of the Node/single-file boundary.

## Pre-existing behavior, not a regression

A separate diagnostic used an untrusted plain `.mjs` file in a temporary directory. `isNativeBuiltinExtensionPath()` returned `false`, so none of this slice's native-builtin routing could execute. The first load returned `"first"`; after rewriting the file and calling `clearExtensionCache()`, the second load still returned `"first"`. A `.ts` file in the same diagnostic returned `"first"` before its edit and `"edited"` afterward.

That `.mjs` behavior comes from jiti's native-import route plus Node's ESM cache and predates this slice. It is not evidence that the persistent native-builtin cache leaked into Node. In this slice, the new production branch is guarded by `isSingleFileBuild &&`; with both `isBunBinary` and `isBundledBuild` false, the branch is inert and the remaining Node control flow is unchanged from the base commit.

Installed `.bundle.mjs` files in an npm installation are shipped artifacts, not editable user source. Editable user, project, and package extensions and user workflows retain the jiti/content-hash behavior, including re-evaluation after direct or transitive TypeScript source edits.

## What this does not prove

- The local real-archive evidence covers only Darwin arm64 with Bun 1.4.0. Windows and Linux compiled behavior is covered by CI, not by a local run recorded here.
- There is no robust behavioral discriminator between the two `.mjs` routes under vitest: its module runner resolves bare specifiers for either route, while Node's ESM cache makes edit/reload behavior converge. The Node boundary is therefore evidenced structurally by the inert production guard, the falsifiable persistent-cache-population invariant, and the green Node test suites.
- Exact exported-object identity and mutation were tested. This does not claim that reassigning a host ESM binding after bridge registration becomes a live binding in the external bundle.
- The validation proves routing and reload semantics; it does not claim a cross-platform startup-time measurement or quantify a production speedup.

## Verdict

The final tested implementation native-imports only exact installed entries of identity-verified Atomic builtin packages in Bun compiled or bundled single-file builds. Each installed entry is self-contained except for Node builtins and exact live host modules registered by the bridge, including the shared native control plane. A real extracted archive starts successfully and exposes resources from all five builtin packages. Those fixed factories survive reload without jiti source reads, transforms, hashing, or graph-manifest work. The Node guard is load-bearing, source-checkout entries remain untrusted, and editable TypeScript extension graphs continue to re-evaluate after direct and transitive edits.
