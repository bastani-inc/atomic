/**
 * `assertIdleInvariants` rejects each way an idle agent can still cost something per agent (#4309).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
	ABORT_LISTENERS_PER_RUN_MAX,
	assertIdleInvariants,
	IDLE_RESOURCE_GROWTH_PER_RUN,
	type IdleInvariantReport,
} from "../../scripts/perf/waiting-stages/benchmark.js";

function report(patch: {
	idle?: Partial<IdleInvariantReport["idle"]>;
	options?: Partial<IdleInvariantReport["options"]>;
	baselineResources?: Record<string, number>;
}): IdleInvariantReport {
	return {
		options: { agents: 1_000, wave: 500, expectRelease: true, evict: false, ...patch.options },
		idle: {
			liveSessions: 0,
			sessionsRetained: 0,
			waitingStages: 1_000,
			residentEntries: 0,
			ciCallsPending: 1_000,
			abortListenersPerRun: { max: 1 },
			resources: { Timeout: 3, PipeWrap: 2 },
			...patch.idle,
		},
		baselineResources: patch.baselineResources ?? { Timeout: 2, PipeWrap: 2 },
	};
}

test("a report with every agent released and run-wide handles only passes (#4309)", () => {
	assertIdleInvariants(report({}));
});

test("live sessions while every agent idles are rejected (#4309)", () => {
	assert.throws(() => assertIdleInvariants(report({ idle: { liveSessions: 40 } })), /40 sessions still live/);
});

test("disposed sessions that stay referenced are rejected (#4309)", () => {
	assert.throws(
		() => assertIdleInvariants(report({ idle: { sessionsRetained: 7 } })),
		/7 disposed sessions were not garbage collected/,
	);
});

test("an abort listener per agent on a run's signal is rejected (#4309)", () => {
	assert.throws(
		() => assertIdleInvariants(report({ idle: { abortListenersPerRun: { max: ABORT_LISTENERS_PER_RUN_MAX + 1 } } })),
		/abort listeners on one run/,
	);
	assertIdleInvariants(report({ idle: { abortListenersPerRun: { max: ABORT_LISTENERS_PER_RUN_MAX } } }));
});

test("timers, sockets, pipes and process handles that grow with the agents are rejected (#4309)", () => {
	for (const kind of ["Timeout", "TCPSocketWrap", "PipeWrap", "ProcessWrap"]) {
		const grown = 2 * IDLE_RESOURCE_GROWTH_PER_RUN + 1;
		assert.throws(
			() => assertIdleInvariants(report({ idle: { resources: { [kind]: grown + 2 } } })),
			new RegExp(`${kind} handles grew by`),
			kind,
		);
	}
});

test("handle growth up to the per-run constant passes and transient kinds are ignored (#4309)", () => {
	const allowed = 2 * IDLE_RESOURCE_GROWTH_PER_RUN;
	assertIdleInvariants(report({ idle: { resources: { Timeout: 2 + allowed, PromiseResolve: 5_000 } } }));
});

test("a build that cannot release is not held to the idle invariants (#4309)", () => {
	assertIdleInvariants(report({ options: { expectRelease: false }, idle: { liveSessions: 1_000 } }));
});

test("an evicted wave passes only when every idle agent is only its index entry (#4373)", () => {
	assertIdleInvariants(report({ options: { evict: true }, idle: { residentEntries: 1_000 } }));
	assert.throws(
		() => assertIdleInvariants(report({ options: { evict: true }, idle: { residentEntries: 999 } })),
		/999 of 1000 idle agents are only their index entry/,
	);
	assertIdleInvariants(report({ options: { evict: false }, idle: { residentEntries: 0 } }));
});
