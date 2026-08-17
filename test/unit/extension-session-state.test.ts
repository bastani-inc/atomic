/**
 * Unit tests for the host session-scoped extension-state primitive:
 * - canonical-bus resolution in packages/coding-agent/src/core/event-bus.ts
 * - the loader-api registration mapping each extension `events` facade to the
 *   shared bus it forwards to
 * - packages/coding-agent/src/core/extension-session-state.ts, which keys
 *   per-session state on that canonical bus so successive load generations of
 *   one session re-bind to the same state while distinct buses stay isolated.
 */

import assert from "node:assert/strict";
import { sessionScopedExtensionState as sessionScopedExtensionStateFromIndex } from "@bastani/atomic";
import { test } from "vitest";
import type { EventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import {
	canonicalEventBusFor,
	createEventBus,
	registerCanonicalEventBus,
} from "../../packages/coding-agent/src/core/event-bus.ts";
import { sessionScopedExtensionState } from "../../packages/coding-agent/src/core/extension-session-state.ts";
import { loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/loader-core.ts";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.ts";

/** A minimal facade shaped like the per-extension `events` object. */
function facade(): EventBus {
	return { emit: () => {}, on: () => () => {} };
}

test("canonicalEventBusFor returns the same canonical bus for two distinct facades over one shared bus", () => {
	const bus = createEventBus();
	const facadeA = facade();
	const facadeB = facade();
	registerCanonicalEventBus(facadeA, bus);
	registerCanonicalEventBus(facadeB, bus);

	assert.equal(canonicalEventBusFor(facadeA), bus);
	assert.equal(canonicalEventBusFor(facadeB), bus);
	assert.equal(canonicalEventBusFor(facadeA), canonicalEventBusFor(facadeB));
	assert.notEqual(facadeA, facadeB);
});

test("canonicalEventBusFor returns an unregistered object unchanged", () => {
	const orphan = facade();
	assert.equal(canonicalEventBusFor(orphan), orphan);
});

test("canonicalEventBusFor returns a canonical bus unchanged: buses are fixed points", () => {
	const bus = createEventBus();
	assert.equal(canonicalEventBusFor(bus), bus);
});

test("the events facade built for each extension resolves to the bus it forwards to", async () => {
	const bus = createEventBus();
	const eventsPerLoad: EventBus[] = [];
	const loadOnce = async () => {
		await loadExtensionFromFactory(
			(pi) => {
				eventsPerLoad.push(pi.events);
			},
			process.cwd(),
			bus,
			createExtensionRuntime(),
		);
	};
	await loadOnce();
	await loadOnce();

	// Each load generation builds a distinct facade...
	assert.equal(eventsPerLoad.length, 2);
	assert.notEqual(eventsPerLoad[0], eventsPerLoad[1]);
	// ...but both resolve to the one shared bus.
	assert.equal(canonicalEventBusFor(eventsPerLoad[0]), bus);
	assert.equal(canonicalEventBusFor(eventsPerLoad[1]), bus);
});

test("sessionScopedExtensionState returns the identical object for repeated (scope, key) calls", () => {
	const bus = createEventBus();
	const first = sessionScopedExtensionState(bus, "counter:v1", () => ({ count: 0 }));
	const second = sessionScopedExtensionState(bus, "counter:v1", () => ({ count: 99 }));
	assert.equal(second, first);
	assert.equal(second.count, 0);
});

test("sessionScopedExtensionState calls create exactly once per (scope, key) pair", () => {
	const bus = createEventBus();
	let calls = 0;
	const create = () => {
		calls += 1;
		return { ordinal: calls };
	};
	const state = sessionScopedExtensionState(bus, "once:v1", create);
	sessionScopedExtensionState(bus, "once:v1", create);
	sessionScopedExtensionState(bus, "once:v1", create);

	assert.equal(calls, 1);
	assert.equal(state.ordinal, 1);
});

test("sessionScopedExtensionState keys distinct scopes apart", () => {
	const busA = createEventBus();
	const busB = createEventBus();
	const stateA = sessionScopedExtensionState(busA, "same-key:v1", () => ({ where: "a" }));
	const stateB = sessionScopedExtensionState(busB, "same-key:v1", () => ({ where: "b" }));

	assert.notEqual(stateA, stateB);
	assert.equal(stateA.where, "a");
	assert.equal(stateB.where, "b");
});

test("sessionScopedExtensionState keys distinct keys apart within one scope", () => {
	const bus = createEventBus();
	const alpha = sessionScopedExtensionState(bus, "alpha:v1", () => ({ id: "alpha" }));
	const beta = sessionScopedExtensionState(bus, "beta:v1", () => ({ id: "beta" }));

	assert.notEqual(alpha, beta);
	assert.equal(alpha.id, "alpha");
	assert.equal(beta.id, "beta");
});

test("two facades over one bus share state; facades over two different buses do not", () => {
	const busA = createEventBus();
	const busB = createEventBus();
	const facadeA1 = facade();
	const facadeA2 = facade();
	const facadeB = facade();
	registerCanonicalEventBus(facadeA1, busA);
	registerCanonicalEventBus(facadeA2, busA);
	registerCanonicalEventBus(facadeB, busB);

	const first = sessionScopedExtensionState(facadeA1, "state:v1", () => ({ generation: 1 }));
	// The next load generation's facade over the same bus re-binds to the
	// state its predecessor created.
	const rebound = sessionScopedExtensionState(facadeA2, "state:v1", () => ({ generation: 2 }));
	assert.equal(rebound, first);
	assert.equal(rebound.generation, 1);

	const isolated = sessionScopedExtensionState(facadeB, "state:v1", () => ({ generation: 3 }));
	assert.notEqual(isolated, first);
	assert.equal(isolated.generation, 3);
});

test("state captured through successive load generations of one session survives re-evaluation", async () => {
	const bus = createEventBus();
	let events: EventBus | undefined;

	await loadExtensionFromFactory(
		(pi) => {
			events = pi.events;
		},
		process.cwd(),
		bus,
		createExtensionRuntime(),
	);
	const first = sessionScopedExtensionState(events!, "generation:v1", () => ({ loads: 1 }));

	await loadExtensionFromFactory(
		(pi) => {
			events = pi.events;
		},
		process.cwd(),
		bus,
		createExtensionRuntime(),
	);
	const second = sessionScopedExtensionState(events!, "generation:v1", () => ({ loads: 2 }));

	assert.equal(second, first);
	assert.equal(second.loads, 1);
});

test("two extensions on one session share a key; callers must namespace keys themselves", async () => {
	const bus = createEventBus();
	const states: Array<{ owner: string }> = [];

	await loadExtensionFromFactory(
		(pi) => {
			states.push(sessionScopedExtensionState(pi.events, "shared:v1", () => ({ owner: "first" })));
		},
		process.cwd(),
		bus,
		createExtensionRuntime(),
	);
	await loadExtensionFromFactory(
		(pi) => {
			states.push(sessionScopedExtensionState(pi.events, "shared:v1", () => ({ owner: "second" })));
		},
		process.cwd(),
		bus,
		createExtensionRuntime(),
	);

	assert.equal(states.length, 2);
	assert.equal(states[1], states[0]);
	assert.equal(states[0]!.owner, "first");
});

test("sessionScopedExtensionState is exported from the package index", () => {
	const bus = createEventBus();
	const state = sessionScopedExtensionStateFromIndex(bus, "index-export:v1", () => ({ ok: true }));
	assert.equal(
		state,
		sessionScopedExtensionStateFromIndex(bus, "index-export:v1", () => ({ ok: false })),
	);
	assert.equal(state.ok, true);
});
