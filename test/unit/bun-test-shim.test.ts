import { test } from "bun:test";
import assert from "node:assert/strict";
import { clampDefaultTimeout, it, mock, setDefaultTimeout, test as shimTest } from "../helpers/bun-test-shim.js";
import { TEST_TIMEOUT_MS } from "../helpers/test-timeout.js";

/**
 * `setDefaultTimeout` is Bun's file-level default-timeout setter, and the shim
 * serves it to every file that still imports `bun:test`.
 *
 * The clamp is the whole point: this repository declares one per-test budget and
 * `test/ci/ci-workflow-contracts.test.ts` asserts every suite resolves to it, so
 * a file that could raise its own default would put a budget in the tree that
 * nothing else enforces. There is no live caller above the declared value today,
 * which is exactly why an unconditional setter looked correct.
 */
test("setDefaultTimeout may lower a file's budget but never raise it", () => {
  assert.equal(clampDefaultTimeout(TEST_TIMEOUT_MS), TEST_TIMEOUT_MS);
  assert.equal(clampDefaultTimeout(5_000), 5_000);
  assert.equal(clampDefaultTimeout(TEST_TIMEOUT_MS + 1), TEST_TIMEOUT_MS);
  assert.equal(clampDefaultTimeout(600_000), TEST_TIMEOUT_MS);
  // The setter is the clamp plus vitest's own call, so applying the repository
  // budget is a no-op rather than an error.
  setDefaultTimeout(TEST_TIMEOUT_MS);
});

/**
 * The other silent-no-op hazards the shim exists to close. A name that resolved
 * to `undefined` would turn a modifier into a runtime error at best and a
 * skipped declaration at worst.
 */
test("the shim exports the Bun API surface this repository actually imports", () => {
  assert.equal(shimTest, it);
  assert.equal(typeof it.serial, "function");
  assert.equal(typeof it.skip, "function");
  assert.equal(typeof it.each, "function");
  assert.equal(typeof mock, "function");
  assert.equal(typeof mock.restore, "function");
  // mock.module has no equivalent with the same semantics, so it must throw
  // rather than silently do nothing.
  assert.throws(() => mock.module("node:fs", () => ({})), /no vitest equivalent/);
});
