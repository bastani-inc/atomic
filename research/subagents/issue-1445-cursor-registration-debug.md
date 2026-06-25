# Issue #1445 cursor registration / model resolver refactor debug report

Date: 2026-06-20  
CWD: `/home/alexlavaee/Documents/projects/github_work/atomic-file-length-limit`  
Mode: inspect-only debugging. I did not modify source or test files; this report file is the only written artifact.

## Summary

The targeted failure is reproducible with Bun. The only failing assertion in `test/unit/cursor-registration.test.ts` is a source-text assertion that still expects the Cursor default model literal to live in `packages/coding-agent/src/core/model-resolver.ts`.

After the model resolver refactor, `model-resolver.ts` became a barrel/re-export module, and the default model map moved to `packages/coding-agent/src/core/model-resolver-defaults.ts`. The Cursor default is still present as `cursor: "composer-2"` and is still publicly exported from `packages/coding-agent/src/core/model-resolver.ts` via `defaultModelPerProvider`.

Therefore this looks like a test/update issue, not a runtime behavior regression. With `breaking_changes_allowed=false`, the behavior-preserving fix should update the test import/assertion to verify the public export (or, less ideally, read the new defaults file). Do **not** duplicate/move the literal back into `model-resolver.ts`; keep the barrel re-export in place.

## Reproduction

### Command

```bash
bun test test/unit/cursor-registration.test.ts
```

### Exact output

```text
bun test v1.3.14 (0d9b296a)

test/unit/cursor-registration.test.ts:
(pass) Cursor provider registration > registers Cursor OAuth provider with estimated models and streamSimple [4.34ms]
(pass) Cursor provider registration > registers reference lifecycle cleanup hooks for Cursor session state [1.22ms]
(pass) Cursor provider registration > registers a valid token-free cached live catalog at startup [0.23ms]
(pass) Cursor provider registration > cached live catalogs do not inject undiscovered composer defaults [0.12ms]
(pass) Cursor provider registration > login-persisted live-only models are available to the next provider runtime [0.71ms]
(pass) Cursor provider registration > session_start discovers live models from stored Cursor OAuth credentials when cache is missing [1.79ms]
(pass) Cursor provider registration > session_shutdown flushes pending stored-credential discovery to the live catalog cache [1.70ms]
(pass) Cursor provider registration > session_shutdown still disposes runtime when session cleanup fails [1.89ms]
(pass) Cursor provider registration > session_start skips live model discovery without stored Cursor credentials [1.49ms]
(pass) Cursor provider registration > stored-credential live model discovery is deduped by access token [3.59ms]
(pass) Cursor provider registration > catalog cache ignores missing/corrupt files and writes live catalogs atomically without credentials [1.18ms]
(pass) Cursor provider registration > login and refresh use the production UUID generator, re-register live catalogs, and write the cache [1.77ms]
(pass) Cursor provider registration > login keeps live-only models out of memory when catalog cache persistence fails [0.41ms]
(pass) Cursor provider registration > refresh returns rotated credentials when best-effort catalog discovery rejects [0.38ms]
(pass) Cursor provider registration > first authenticated stream schedules one tracked rediscovery task and writes the live cache [2.91ms]
(pass) Cursor provider registration > first-use rediscovery retries after an empty or failed reference discovery [2.68ms]
(pass) Cursor provider registration > dispose aborts pending first-use rediscovery and does not hang when discovery ignores abort [12.53ms]
(pass) Cursor provider registration > login model discovery is best-effort like the reference provider [1.55ms]
700 | 		const builtins = readFileSync("packages/coding-agent/src/core/builtin-packages.ts", "utf8");
701 | 		const copyScript = readFileSync("packages/coding-agent/scripts/copy-builtin-packages.ts", "utf8");
702 | 		const resolver = readFileSync("packages/coding-agent/src/core/model-resolver.ts", "utf8");
703 | 		assert.match(builtins, /@bastani\/cursor/u);
704 | 		assert.match(copyScript, /@bastani\/cursor/u);
705 | 		assert.match(resolver, /cursor:\s*"composer-2"/u);
               ^
AssertionError: The input did not match the regular expression /cursor:\s*"composer-2"/u. Input:

'/**\n' +
  ' * Model resolution, scoping, and initial selection\n' +
  ' */\n' +
  '\n' +
  'export { defaultModelPerProvider } from "./model-resolver-defaults.ts";\n' +
  'export { resolveCliModel } from "./model-resolver-cli.ts";\n' +
  'export { findInitialModel, resolveSavedModelReference, restoreModelFromSession } from "./model-resolver-initial.ts";\n' +
  'export { findExactModelReferenceMatch, parseModelPattern } from "./model-resolver-patterns.ts";\n' +
  'export { resolveModelScope } from "./model-resolver-scope.ts";\n' +
  'export type {\n' +
  '  InitialModelResult,\n' +
  '  ParsedModelResult,\n' +
  '  ResolveCliModelResult,\n' +
  '  ScopedModel,\n' +
  '} from "./model-resolver-types.ts";\n' +
  ''

      at internalMatch (node:assert:561:55)
      at match (node:assert:565:16)
      at <anonymous> (/home/alexlavaee/Documents/projects/github_work/atomic-file-length-limit/test/unit/cursor-registration.test.ts:705:10)
(fail) Cursor provider registration > host wiring includes bundled package copy and default model resolution [1.33ms]

 18 pass
 1 fail
Ran 19 tests across 1 file. [205.00ms]


Command exited with code 1
```

## Related model resolver validation

### Command

```bash
bun test packages/coding-agent/test/model-resolver.test.ts
```

### Exact output

```text
bun test v1.3.14 (0d9b296a)

packages/coding-agent/test/model-resolver.test.ts:
(pass) parseModelPattern > simple patterns without colons > exact match returns model with undefined thinking level [0.23ms]
(pass) parseModelPattern > simple patterns without colons > partial match returns best model with undefined thinking level [1.06ms]
(pass) parseModelPattern > simple patterns without colons > no match returns undefined model and thinking level [0.06ms]
(pass) parseModelPattern > patterns with valid thinking levels > sonnet:high returns sonnet with high thinking level [0.04ms]
(pass) parseModelPattern > patterns with valid thinking levels > gpt-4o:medium returns gpt-4o with medium thinking level [0.02ms]
(pass) parseModelPattern > patterns with valid thinking levels > all valid thinking levels work [0.28ms]
(pass) parseModelPattern > patterns with invalid thinking levels > sonnet:random returns sonnet with undefined thinking level and warning [0.04ms]
(pass) parseModelPattern > patterns with invalid thinking levels > gpt-4o:invalid returns gpt-4o with undefined thinking level and warning [0.02ms]
(pass) parseModelPattern > OpenRouter models with colons in IDs > qwen3-coder:exacto matches the model with undefined thinking level [0.02ms]
(pass) parseModelPattern > OpenRouter models with colons in IDs > openrouter/qwen/qwen3-coder:exacto matches with provider prefix [0.01ms]
(pass) parseModelPattern > OpenRouter models with colons in IDs > qwen3-coder:exacto:high matches model with high thinking level [0.03ms]
(pass) parseModelPattern > OpenRouter models with colons in IDs > openrouter/qwen/qwen3-coder:exacto:high matches with provider and thinking level [0.02ms]
(pass) parseModelPattern > OpenRouter models with colons in IDs > gpt-4o:extended matches the extended model with undefined thinking level [0.01ms]
(pass) parseModelPattern > invalid thinking levels with OpenRouter models > qwen3-coder:exacto:random returns model with undefined thinking level and warning [0.02ms]
(pass) parseModelPattern > invalid thinking levels with OpenRouter models > qwen3-coder:exacto:high:random returns model with undefined thinking level and warning [0.04ms]
(pass) parseModelPattern > edge cases > empty pattern matches via partial matching [0.24ms]
(pass) parseModelPattern > edge cases > pattern ending with colon treats empty suffix as invalid [0.03ms]
(pass) resolveCliModel > resolves --model provider/id without --provider [0.19ms]
(pass) resolveCliModel > resolves fuzzy patterns within an explicit provider [0.04ms]
(pass) resolveCliModel > supports --model <pattern>:<thinking> (without explicit --thinking) [0.08ms]
(pass) resolveCliModel > prefers exact model id match over provider inference (OpenRouter-style ids) [0.03ms]
(pass) resolveCliModel > does not strip invalid :suffix as thinking level in --model (treat as raw id) [0.06ms]
(pass) resolveCliModel > allows custom model ids for explicit providers without double prefixing [0.03ms]
(pass) resolveCliModel > scrubs inherited context-window options from explicit provider fallback models [0.10ms]
(pass) resolveCliModel > returns a clear error when there are no models [0.02ms]
(pass) resolveCliModel > prefers provider/model split over gateway model with matching id [0.04ms]
(pass) resolveCliModel > resolves provider-prefixed fuzzy patterns (openrouter/qwen -> openrouter model) [0.03ms]
(pass) default model selection > openai defaults track current models
(pass) default model selection > zai, minimax, cerebras, and ant-ling defaults track current models [0.01ms]
(pass) default model selection > ai-gateway default tracks current model
(pass) default model selection > findInitialModel accepts explicit provider custom model ids [0.21ms]
(pass) default model selection > findInitialModel restores saved custom Cursor model ids from an authenticated provider template [0.13ms]
(pass) default model selection > restoreModelFromSession restores saved custom Cursor model ids from an authenticated provider template [0.16ms]
(pass) default model selection > restoreModelFromSession scrubs inherited context-window options from fallback models [0.07ms]
(pass) default model selection > findInitialModel selects ai-gateway default when available [0.14ms]

 35 pass
 0 fail
 129 expect() calls
Ran 35 tests across 1 file. [146.00ms]
```

### Public export smoke check

Command:

```bash
bun -e 'import { defaultModelPerProvider } from "./packages/coding-agent/src/core/model-resolver.ts"; console.log(defaultModelPerProvider.cursor)'
```

Output:

```text
composer-2
```

### Moved literal smoke check

Command:

```bash
bun -e 'import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; const resolver = readFileSync("packages/coding-agent/src/core/model-resolver-defaults.ts", "utf8"); assert.match(resolver, /cursor:\s*"composer-2"/u); console.log("model-resolver-defaults.ts contains cursor default literal")'
```

Output:

```text
model-resolver-defaults.ts contains cursor default literal
```

## File/line evidence

- `test/unit/cursor-registration.test.ts:699-706` has the failing test. It reads `packages/coding-agent/src/core/model-resolver.ts` as text at line 702 and asserts `/cursor:\s*"composer-2"/u` at line 705.
- `packages/coding-agent/src/core/model-resolver.ts:5` re-exports `defaultModelPerProvider` from `./model-resolver-defaults.ts`.
- `packages/coding-agent/src/core/model-resolver-defaults.ts:4-14` now contains the `defaultModelPerProvider` object, including `cursor: "composer-2"` at line 14.
- `packages/coding-agent/src/core/model-resolver-defaults.ts:41-50` contains `findPreferredAvailableModel`, also moved out of the old monolithic resolver.
- `packages/coding-agent/src/core/model-resolver-patterns.ts:4` imports `defaultModelPerProvider` from the new defaults module; `buildFallbackModel` consumes it at `packages/coding-agent/src/core/model-resolver-patterns.ts:98-109`.
- `packages/coding-agent/src/core/model-resolver-initial.ts:6` imports `findPreferredAvailableModel` from the new defaults module and uses it at `packages/coding-agent/src/core/model-resolver-initial.ts:99-103`.
- `packages/coding-agent/test/model-resolver.test.ts:4-10` imports `defaultModelPerProvider` from the public barrel `../src/core/model-resolver.ts`, and those model resolver tests pass.

## Root cause

The failure is caused by a stale implementation-coupled assertion, not by loss of the Cursor default.

Before the refactor, `packages/coding-agent/src/core/model-resolver.ts` contained the full `defaultModelPerProvider` object literal inline. After the refactor, that source literal moved to `packages/coding-agent/src/core/model-resolver-defaults.ts`, while `model-resolver.ts` became a small barrel file. The test still scans the barrel file's text for the literal, so it fails even though the public export still resolves to the same value.

## Recommended behavior-preserving fix

Preferred fix in `test/unit/cursor-registration.test.ts`:

1. Import the public model resolver export from the same public surface consumers use:

   ```ts
   import { defaultModelPerProvider } from "../../packages/coding-agent/src/core/model-resolver.ts";
   ```

2. In `host wiring includes bundled package copy and default model resolution`, replace the source-text resolver assertion with a value assertion:

   ```ts
   assert.equal(defaultModelPerProvider.cursor, "composer-2");
   ```

3. Keep the existing `@bastani/cursor` builtins/copy-script checks and `catalog-cache.ts` existence check.

This preserves behavior and avoids coupling the Cursor registration test to the internal file split.

Acceptable but less ideal alternative: read `packages/coding-agent/src/core/model-resolver-defaults.ts` instead of `model-resolver.ts` in this test. That would make the test pass, but it would still test an implementation file path instead of the public model resolver API.

Do **not** duplicate the default map literal back into `packages/coding-agent/src/core/model-resolver.ts`; that would undermine the file-length/model-resolver refactor and create two possible sources of truth. The necessary re-export already exists at `packages/coding-agent/src/core/model-resolver.ts:5`. If another branch lacks that line, add/restore the re-export; in this checkout it is already present.

Optional hardening: add a Cursor-specific default assertion to `packages/coding-agent/test/model-resolver.test.ts` near the existing default-model tests (`packages/coding-agent/test/model-resolver.test.ts:425-441`), e.g. `expect(defaultModelPerProvider.cursor).toBe("composer-2")`.

## Retest plan after implementation

Run:

```bash
bun test test/unit/cursor-registration.test.ts
bun test packages/coding-agent/test/model-resolver.test.ts
```

Expected result after the test assertion update: `test/unit/cursor-registration.test.ts` should go from `18 pass / 1 fail` to all 19 passing, and the model resolver suite should remain all 35 passing.

## Prevention recommendations

- Avoid tests that grep source text for behavior-sensitive values when a public export exists. Import and assert the runtime value instead.
- For file-length/splitting refactors, scan for tests that read implementation files by path (`readFileSync("...src/core/...")`) and update them to public-interface assertions.
- Keep `packages/coding-agent/src/core/model-resolver.ts` as the compatibility barrel so existing imports remain non-breaking.
