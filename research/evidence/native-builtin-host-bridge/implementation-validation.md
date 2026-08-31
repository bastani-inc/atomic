# Host-module bridge implementation report

## Outcome

Implemented the first independently reviewable Bun-runtime host-module bridge layer in commit `83176a3bf0fc492bf53d81fd7a64aefb5a14b1b2` (`feat(extensions): add Bun host-module bridge`). The bridge uses the compiled-binary-proven `Bun.plugin` `build.module()` object-loader surface and is not called by production extension routing.

## Acceptance evidence

| Criterion | Current-checkout evidence |
|---|---|
| Reuse exact live host module objects without duplicate package state | `host-module-bridge.ts` imports the existing memoized `getVirtualModules()` accessor; `extensions-host-module-bridge.test.ts` proves every registered specifier matches the map and every callback's `exports` is reference-identical with `toBe`. |
| Real compiled-launcher boundary with an external precompiled ESM bundle | `test/ci/extension-host-module-bridge-boundary.test.ts` keeps bare imports for `proper-lockfile`, `@bastani/atomic`, `@bastani/pi-ai`, and `@earendil-works/pi-ai`, builds the CJS sidecar, compiles a bytecode split launcher, and runs it. It proves CommonJS default/named identity, first-party ESM named-export identity and bidirectional shared mutation, and shared identity across the two pi-ai aliases. |
| Production routing unchanged | The only edit to `loader-virtual-modules.ts` exports `getVirtualModules`; search finds `installHostModuleBridge` only in its definition and tests. `loadExtensionModule`, `loadTransformedExtensionModule`, and `importExtensionModule` control flow are unchanged. |
| Node/npm and source checkout unchanged | Installer returns `{ installed: false, specifiers: [] }` unless `isBunBinary || isBundledBuild` and a callable Bun plugin runtime exists. Unit coverage proves the ordinary Node test environment never invokes `Bun.plugin`. |
| Idempotent and retryable | Unit coverage proves two installs return the same result and register once; a registration failure clears the memo and a second call succeeds. |
| Probe evidence preserved | Moved the authoritative report to `research/evidence/native-builtin-host-bridge/bun-compiled-plugin-probe.md`. |
| Docs current; no misleading changelog | `packages/coding-agent/docs/extensions.md` documents the internal seam and explicitly says production routing still uses jiti. No changelog entry was added because shipped behavior is unchanged. |

The interface preserves `Object.keys()` insertion order, does not normalize or deduplicate specifiers, and returns a mutable `string[]` as requested. The omitted/inert result uses an empty list. Duplicate handling is inherited verbatim from the existing `Record<string, object>` host map, whose keys are unique by JavaScript object semantics.

Production relative imports follow the repository's `.js` specifier convention. The spelling-neutral
`module-import-specifier-consistency` test requires every importer of a resolved module to use one spelling, so the
bridge could not adopt `.js` for `config` and `loader-virtual-modules` in isolation. Every production importer of those
two modules migrated together; no other module's specifiers changed.

## Commands and outcomes

- `npm ci --ignore-scripts` — exit 0; installed 554 packages.
- `npm run build` — exit 0; generated/built `@bastani/pi-ai`, restored its alias, and built the native N-API binding required by tests.
- `npm run test --workspace=@bastani/atomic -- extensions-host-module-bridge.test.ts` — exit 0; 1 file, 4 tests passed.
- `npx vitest --run --project ci test/ci/extension-host-module-bridge-boundary.test.ts` — exit 0; 1 file, 1 test passed after restoration. The executable printed `compiled host-module bridge probe: OK`.
- `npm run test --workspace=@bastani/atomic` — exit 0; 498 files passed, 4 skipped; 4109 tests passed, 40 skipped.
- First `npm run test:unit` — exit 1 because required generated `packages/coding-agent/dist/builtin/intercom` and the built `@bastani/atomic/workflows` export were absent. This was checkout setup, not an implementation failure.
- `npm run build --workspace=@bastani/atomic` — exit 0; produced the documented built-package fixtures.
- Second `npm run test:unit` — exit 0; 723 files and 7265 tests passed, 23 skipped.
- `npm run test:ci-contracts` — exit 0; 14 files and 75 tests passed.
- `npx vitest --run --project unit test/unit/module-import-specifier-consistency.test.ts` — exit 0; 1 file and 1 test passed after the `.js` migration closed both target-module spelling groups.
- `npm run check` — exit 0; Biome completed with one pre-existing informational `noUselessStringRaw` diagnostic in `test/ci/ci-workflow-contracts.test.ts`; both root `tsc` and coding-agent `tsgo` typechecks passed; shrinkwrap was current.
- Commit hook reran repository checks successfully before creating `83176a3bf0`.

## Required negative control

Temporarily inserted an unconditional not-installed return at the start of `installHostModuleBridge()`, then ran:

```text
npx vitest --run --project ci test/ci/extension-host-module-bridge-boundary.test.ts
```

It exited 1. The compiled executable exited 1 with stderr `host bridge did not install exactly once`, and the Vitest assertion reported `1 !== 0` at the startup exit-code check. The source was restored from a byte-for-byte saved copy; the same focused boundary command then exited 0 with 1 test passed. This proves the executable scenario cannot pass with the bridge disabled.

The original validation report incorrectly described comparing the external `@bastani/atomic` `createEventBus`
export with `{ ...createEventBus }` as an identity negative control. That comparison is vacuous: spreading a function
produces a plain object, so it only proves that the function is not that unrelated object. The meaningful
namespace-container variant does not break the boundary test either: spreading a host namespace changes its container
identity while retaining the same exported function and object references, which are the identities the boundary test
checks.

A genuine value-identity control temporarily changed the `@bastani/atomic` registration so its `createEventBus` export
was a fresh wrapper function that delegated to the host function. The focused command exited 1 with:

```text
FAIL  |ci| test/ci/extension-host-module-bridge-boundary.test.ts > compiled launcher exposes exact live host modules to an external ESM bundle
AssertionError: @bastani/atomic named export identity changed

1 !== 0

Test Files  1 failed (1)
Tests  1 failed (1)
```

The temporary implementation change was then restored byte-for-byte (`sha256` before and after:
`9de9bee75f353b8ebf6ccc35b20fc76fe6faa1c667abbaa07174f39664b0d713`). Re-running the same command exited 0:

```text
Test Files  1 passed (1)
Tests  1 passed (1)
```

This control breaks the exported value's reference identity rather than only replacing its namespace container, so it
demonstrates that the compiled-boundary assertion detects value-identity loss.

## Files changed

- `packages/coding-agent/src/core/extensions/host-module-bridge.ts`
- `packages/coding-agent/src/core/extensions/loader-virtual-modules.ts`
- `packages/coding-agent/test/extensions-host-module-bridge.test.ts`
- `test/ci/extension-host-module-bridge-boundary.test.ts`
- `packages/coding-agent/docs/extensions.md`
- `research/evidence/native-builtin-host-bridge/bun-compiled-plugin-probe.md`
- `research/evidence/native-builtin-host-bridge/implementation-validation.md`

## Risks and deferred work

- This slice intentionally does not install the bridge from production extension routing; native builtin routing is the next independently reviewable layer.
- Shared mutation evidence covers properties on exact exported object/function references, not reassignment of an ESM binding after registration. That distinction is recorded in the authoritative probe and is outside this contract.
- No out-of-contract defects were changed.
