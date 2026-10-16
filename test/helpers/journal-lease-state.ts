import assert from "node:assert/strict";
import type { LeaseState } from "../../packages/workflows/src/durable/journal/types.js";

/** A read may advance store-clock age, but must not change persisted ownership or renewal. */
export function assertLeaseStateUnchanged(
	actual: LeaseState | undefined,
	expected: LeaseState | undefined,
	message?: string,
): void {
	if (expected === undefined) {
		assert.equal(actual, undefined, message);
		return;
	}
	assert.ok(actual, message);
	const { ageMs: actualAge, ...actualLease } = actual;
	const { ageMs: expectedAge, ...expectedLease } = expected;
	assert.deepEqual(actualLease, expectedLease, message);
	assert.ok(Number.isSafeInteger(actualAge) && actualAge >= expectedAge, message);
}
