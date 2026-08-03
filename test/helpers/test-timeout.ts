/**
 * The one per-test budget for the whole repository, declared once.
 *
 * It replaces the `--timeout 30000` that `test:unit`, `test:integration` and
 * `test:ci-contracts` each used to spell out, and it keeps that policy's intent:
 * one platform-neutral value, enforced identically locally and in CI, never a
 * Windows-only branch. test/ci/ci-workflow-contracts.test.ts asserts all three
 * projects still resolve to this single value.
 *
 * It lives in a leaf module with no imports so vitest.config.ts can apply it
 * without pulling anything else into every test worker.
 */
export const TEST_TIMEOUT_MS = 30_000;
