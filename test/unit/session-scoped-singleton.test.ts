/**
 * Unit tests for createSessionScopedSingleton: adopt must create a fresh
 * instance for a previously unseen scope instead of handing that scope the
 * live instance from the last adopt.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { createSessionScopedSingleton } from "../../packages/workflows/src/shared/session-scoped-singleton.ts";

interface Cancellable {
	cancelled: boolean;
	cancel(): void;
}

function createCancellable(): Cancellable {
	return {
		cancelled: false,
		cancel() {
			this.cancelled = true;
		},
	};
}

test("adopt isolates two scopes and does not alias cancellation across them", () => {
	const singleton = createSessionScopedSingleton("workflows:isolation-probe:v1", createCancellable);
	const scopeA = createEventBus();
	const scopeB = createEventBus();

	const stateA = singleton.adopt(scopeA);
	assert.equal(stateA.cancelled, false);

	const stateB = singleton.adopt(scopeB);
	assert.notEqual(stateB, stateA);
	assert.equal(stateB.cancelled, false);

	stateB.cancel();
	assert.equal(stateB.cancelled, true);
	assert.equal(stateA.cancelled, false);
	assert.equal(singleton.current(), stateB);
	assert.equal(singleton.facade.cancelled, true);

	const reboundA = singleton.adopt(scopeA);
	assert.equal(reboundA, stateA);
	assert.equal(reboundA.cancelled, false);
	assert.equal(singleton.facade.cancelled, false);
});
