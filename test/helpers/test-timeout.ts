/**
 * The one per-test budget for the whole repository, declared once.
 *
 * It replaces the `--timeout 30000` that `test:unit`, `test:integration` and
 * `test:ci-contracts` each used to spell out, and it keeps that policy's intent:
 * one platform-neutral value, enforced identically locally and in CI, never a
 * Windows-only branch. test/ci/ci-workflow-contracts.test.ts asserts all three
 * projects still resolve to this single value.
 *
 * It lives in a leaf module with no imports because both sides need it:
 * vitest.config.ts applies it, and test/helpers/bun-test-shim.ts clamps
 * `setDefaultTimeout` against it. The shim is what 629 test files import, so
 * reaching into vitest.config.ts from there would pull `vitest/config` -- and
 * vite with it -- into every test worker for one number.
 */
export const TEST_TIMEOUT_MS = 30_000;
