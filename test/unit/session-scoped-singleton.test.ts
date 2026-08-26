/**
 * Unit tests for createSessionScopedSingleton: adopt must create a fresh
 * instance for a previously unseen scope instead of handing that scope the
 * live instance from the last adopt.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import {
	createSessionScopedSingleton,
	resetSessionScopedSingletonPreAdoptionForTests,
} from "../../packages/workflows/src/shared/session-scoped-singleton.ts";

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

beforeEach(() => {
	resetSessionScopedSingletonPreAdoptionForTests();
});

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

test("recovery can reclaim current state only when returning to an existing scope", () => {
	const singleton = createSessionScopedSingleton("workflows:reload-recovery-probe:v1", createCancellable);
	const parentScope = createEventBus();
	const childScope = createEventBus();
	const unseenScope = createEventBus();

	const parentState = singleton.adopt(parentScope);
	const childState = singleton.adopt(childScope);
	childState.cancel();

	const unseen = singleton.adoptWithResult(unseenScope, {
		preserveCurrentWhenTargetExists: () => true,
	});
	assert.equal(unseen.preservedCurrent, false, "a new session must never inherit the prior session state");
	assert.notEqual(unseen.instance, childState);

	const reboundChild = singleton.adopt(childScope);
	assert.equal(reboundChild, childState);
	const recovered = singleton.adoptWithResult(parentScope, {
		preserveCurrentWhenTargetExists: (current, target) => current.cancelled && !target.cancelled,
	});
	assert.equal(recovered.preservedCurrent, true);
	assert.equal(recovered.instance, childState);
	assert.notEqual(recovered.instance, parentState);
	assert.equal(singleton.facade.cancelled, true);
});

test("duplicate module copies adopt the populated pre-adoption state for one key", async () => {
	const source = new URL("../../packages/workflows/src/shared/session-scoped-singleton.ts", import.meta.url).href;
	const copyA = (await import(
		/* @vite-ignore */ `${source}?duplicate-copy=a`
	)) as typeof import("../../packages/workflows/src/shared/session-scoped-singleton.ts");
	const copyB = (await import(/* @vite-ignore */ `${source}?duplicate-copy=b`)) as typeof copyA;
	assert.notEqual(copyA, copyB);

	const key = `workflows:duplicate-copy-probe-${Math.random()}:v1`;
	const singletonA = copyA.createSessionScopedSingleton(key, createCancellable);
	const singletonB = copyB.createSessionScopedSingleton(key, createCancellable);
	const localA = singletonA.current();
	const localB = singletonB.current();
	localA.cancel();

	const scope = createEventBus();
	const adoptedByB = singletonB.adopt(scope);
	const adoptedByA = singletonA.adopt(scope);
	assert.equal(adoptedByB, localA);
	assert.notEqual(adoptedByB, localB);
	assert.equal(adoptedByA, adoptedByB);
	assert.equal(adoptedByA.cancelled, true);
	assert.equal(singletonA.current(), adoptedByA);
	assert.equal(singletonB.current(), adoptedByA);
	assert.equal(singletonA.facade.cancelled, true);
	assert.equal(singletonB.facade.cancelled, true);
});
