import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { getDurableBackendProcessOwner } from "../../packages/workflows/src/durable/backend-process-owner.js";
import { getDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";

const owner = getDurableBackendProcessOwner();
const original = { ...owner };
const initialized = new InMemoryDurableBackend();
const initializing = Promise.resolve(initialized);
const warningSink = (_message: string): void => {};
let previousInjected: InMemoryDurableBackend | undefined;
let previousOverride: InMemoryDurableBackend | undefined;
let completed = 0;

afterAll(() => {
	Object.assign(owner, original);
});

// These ordinary, ordered tests exercise the real configured beforeEach twice.
// The second verifies the transition from an explicit override to a fresh backend.
for (const ordinal of [0, 1]) {
	test(`durable setup installs a fresh factory-visible backend before test ${ordinal + 1}`, () => {
		assert.equal(completed, ordinal);
		const injected = getDurableBackend();
		assert.ok(injected instanceof InMemoryDurableBackend);
		assert.equal(injected, owner.injectedBackend);
		assert.notEqual(injected, previousInjected);
		assert.notEqual(injected, previousOverride);
		assert.equal(injected.persistent, false);
		if (ordinal === 1) {
			assert.equal(owner.initializedBackend, initialized);
			assert.equal(owner.initializing, initializing);
			assert.equal(owner.warningSink, warningSink);
			assert.equal(owner.warningReported, true);
		}
		owner.initializedBackend = initialized;
		owner.initializing = initializing;
		owner.warningSink = warningSink;
		owner.warningReported = true;
		const override = new InMemoryDurableBackend();
		setDurableBackend(override);
		assert.equal(getDurableBackend(), override);
		previousInjected = injected;
		previousOverride = override;
		completed++;
	});
}
