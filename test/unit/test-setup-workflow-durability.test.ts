import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { getDurableBackendProcessOwner } from "../../packages/workflows/src/durable/backend-process-owner.js";
import { getDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { MemoryJournalBackend as InMemoryDurableBackend } from "../helpers/workflow-journal.js";

const owner = getDurableBackendProcessOwner();
const original = { ...owner };
const initialized = new InMemoryDurableBackend();
const selected = new Map([["memory", { ready: Promise.resolve(initialized) }]]);
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
			assert.equal(owner.selectedBackends, selected);
		}
		owner.initializedBackend = initialized;
		owner.selectedBackends = selected;
		const override = new InMemoryDurableBackend();
		setDurableBackend(override);
		assert.equal(getDurableBackend(), override);
		previousInjected = injected;
		previousOverride = override;
		completed++;
	});
}
