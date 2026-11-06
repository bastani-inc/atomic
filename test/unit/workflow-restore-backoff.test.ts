import assert from "node:assert/strict";
import { test } from "vitest";
import { RESTORE_BACKOFF, RestoreBackoff } from "../../packages/workflows/src/workers/restore-backoff.js";

test("a binding whose restores keep failing waits twice as long after each failure, up to the bound (#4416)", () => {
	let now = 0;
	const backoff = new RestoreBackoff(() => now);
	const waits = Array.from({ length: 9 }, () => backoff.failed("k"));
	assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
	assert.deepEqual(RESTORE_BACKOFF, { firstMs: 1_000, maxMs: 60_000 });
	now = 59_999;
	assert.equal(backoff.waiting("k"), true, "it waits until the last failure's wait is over");
	now = 60_000;
	assert.equal(backoff.waiting("k"), false, "and restores again once it is");
	assert.equal(backoff.failed("k"), 60_000, "a failure after the wait waits the bound again");
});

test("a restore that succeeds forgets the binding's failures; other bindings never wait for it (#4416)", () => {
	let now = 0;
	const backoff = new RestoreBackoff(() => now, { firstMs: 10, maxMs: 1_000 });
	assert.equal(backoff.waiting("k"), false, "a binding that never failed does not wait");
	assert.equal(backoff.succeeded("k"), false, "nor has failures to forget");
	assert.equal(backoff.failed("k"), 10);
	assert.equal(backoff.failed("k"), 20);
	assert.equal(backoff.waiting("other"), false);
	assert.equal(backoff.failed("other"), 10, "each binding counts its own failures");
	assert.equal(backoff.succeeded("k"), true);
	assert.equal(backoff.waiting("k"), false);
	assert.equal(backoff.failed("k"), 10, "the next failure waits as the first did");
	now = 9;
	assert.equal(backoff.waiting("k"), true);
	now = 10;
	assert.equal(backoff.waiting("k"), false);
});

test("a host's backoff follows the process clock by default (#4416)", () => {
	const backoff = new RestoreBackoff();
	backoff.failed("k");
	assert.equal(backoff.waiting("k"), true, "a second has not passed since the failure");
});
