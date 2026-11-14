import assert from "node:assert/strict";
import { test } from "vitest";
import {
	BOOT_BACKOFF,
	type FleetHostView,
	type FleetObservation,
	type FleetPlan,
	type FleetPolicy,
	type FleetPolicyState,
	type FleetRootDemand,
	INITIAL_FLEET_STATE,
	planFleet,
	resolveFleetPolicy,
} from "../../packages/workflows/src/workers/autoscaler.js";

/** A deterministic generator (mulberry32), so a failing case is reproducible from its seed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const POLICY: FleetPolicy = resolveFleetPolicy({
	minHosts: 0,
	maxHosts: 4,
	workersPerHost: 2,
	scaleUpQueueDepth: 2,
	scaleUpDelayMs: 20_000,
	idleDrainMs: 300_000,
	bootTimeoutMs: 600_000,
});

function host(id: string, overrides: Partial<FleetHostView> = {}): FleetHostView {
	return { id, state: "running", since: 0, registered: true, leased: 0, draining: false, ...overrides };
}

function observe(now: number, roots: readonly FleetRootDemand[], hosts: readonly FleetHostView[]): FleetObservation {
	return { now, roots, hosts };
}

function root(ready: number, leased = 0, overrides: Partial<FleetRootDemand> = {}): FleetRootDemand {
	return { ready, leased, blocked: false, ...overrides };
}

/** Plans tick after tick, each from the previous tick's state. */
function ticks(
	policy: FleetPolicy,
	observations: readonly FleetObservation[],
	state: FleetPolicyState = INITIAL_FLEET_STATE,
): FleetPlan[] {
	const plans: FleetPlan[] = [];
	for (const observation of observations) {
		const plan = planFleet(policy, observation, state);
		plans.push(plan);
		state = plan.state;
	}
	return plans;
}

function scaleTargets(plan: FleetPlan): number[] {
	return plan.actions.flatMap((action) => (action.kind === "scale-up" ? [action.desired] : []));
}

function marked(plan: FleetPlan): string[] {
	return plan.actions.flatMap((action) => (action.kind === "mark-draining" ? [action.id] : []));
}

function removed(plan: FleetPlan): string[] {
	return plan.actions.flatMap((action) => (action.kind === "remove" ? [action.id] : []));
}

/** A random fleet: up to 6 hosts in any state, busy or idle, and up to 3 roots, some blocked or session-limited. */
function randomObservation(next: () => number, now: number): FleetObservation {
	const int = (below: number) => Math.floor(next() * below);
	const states = ["pending", "running", "draining", "stopped", "failed"] as const;
	const hosts = Array.from({ length: int(7) }, (_, index) =>
		host(`h${index}`, {
			state: states[int(states.length)]!,
			since: now - int(1_000_000),
			registered: next() < 0.6,
			leased: next() < 0.5 ? 0 : 1 + int(3),
			draining: next() < 0.2,
		}),
	);
	const roots = Array.from({ length: int(4) }, () =>
		root(int(30), int(10), {
			blocked: next() < 0.2,
			...(next() < 0.3 ? { sessionLimit: 1 + int(8) } : {}),
		}),
	);
	return observe(now, roots, hosts);
}

function randomPolicy(next: () => number): FleetPolicy {
	const minHosts = Math.floor(next() * 3);
	return resolveFleetPolicy({
		minHosts,
		maxHosts: minHosts + Math.floor(next() * 6),
		workersPerHost: 1 + Math.floor(next() * 4),
		scaleUpQueueDepth: Math.floor(next() * 5),
		scaleUpDelayMs: Math.floor(next() * 40_000),
		idleDrainMs: Math.floor(next() * 400_000),
		bootTimeoutMs: 1 + Math.floor(next() * 700_000),
	});
}

test("the fleet target never leaves minHosts..maxHosts, and a scale-up never asks for more than maxHosts plus the hosts draining (#4768)", () => {
	for (let seed = 1; seed <= 400; seed++) {
		const next = random(seed);
		const policy = randomPolicy(next);
		let state = INITIAL_FLEET_STATE;
		for (let tick = 0; tick < 12; tick++) {
			const observation = randomObservation(next, 1_000_000 + tick * 10_000);
			const plan = planFleet(policy, observation, state);
			state = plan.state;
			assert.ok(plan.target >= policy.minHosts && plan.target <= policy.maxHosts, `seed ${seed}: ${plan.target}`);
			const draining = observation.hosts.filter(
				(entry) => (entry.draining || entry.state === "draining") && !removed(plan).includes(entry.id),
			).length;
			for (const desired of scaleTargets(plan))
				assert.ok(desired <= policy.maxHosts + draining, `seed ${seed}: scaleTo(${desired})`);
		}
	}
});

test("the controller never drains or removes a host that holds a lease (#4768)", () => {
	for (let seed = 1; seed <= 400; seed++) {
		const next = random(seed);
		const policy = randomPolicy(next);
		let state = INITIAL_FLEET_STATE;
		for (let tick = 0; tick < 12; tick++) {
			const observation = randomObservation(next, 1_000_000 + tick * 50_000);
			const plan = planFleet(policy, observation, state);
			state = plan.state;
			const busy = new Set(observation.hosts.filter((entry) => entry.leased > 0).map((entry) => entry.id));
			for (const id of [...marked(plan), ...removed(plan)])
				assert.ok(!busy.has(id), `seed ${seed}: host ${id} holds a lease`);
		}
	}
});

test("a scale-up never lowers the provider's count below the hosts it runs, so the provider never picks a host to remove (#4768)", () => {
	for (let seed = 1; seed <= 400; seed++) {
		const next = random(seed);
		const policy = randomPolicy(next);
		let state = INITIAL_FLEET_STATE;
		for (let tick = 0; tick < 12; tick++) {
			const observation = randomObservation(next, 1_000_000 + tick * 30_000);
			const plan = planFleet(policy, observation, state);
			state = plan.state;
			const kept = observation.hosts.filter(
				(entry) => entry.state !== "stopped" && entry.state !== "failed" && !removed(plan).includes(entry.id),
			).length;
			for (const desired of scaleTargets(plan)) assert.ok(desired > kept, `seed ${seed}: ${desired} <= ${kept}`);
		}
	}
});

test("queue depth above scaleUpQueueDepth for scaleUpDelayMs scales up to the demand, not before (#4768)", () => {
	const busy = [host("a", { leased: 2 })];
	const plans = ticks(POLICY, [
		observe(0, [root(5, 2)], busy),
		observe(10_000, [root(5, 2)], busy),
		observe(20_000, [root(5, 2)], busy),
	]);
	assert.deepEqual(plans.map(scaleTargets), [[], [], [4]]);
	// Demand 7 at 2 workers a host is 4 hosts.
	assert.equal(plans[2]!.target, 4);
});

test("queue depth that drops back to scaleUpQueueDepth restarts the scale-up delay (#4768)", () => {
	const busy = [host("a", { leased: 2 })];
	const plans = ticks(POLICY, [
		observe(0, [root(5, 2)], busy),
		observe(10_000, [root(2, 2)], busy),
		observe(20_000, [root(5, 2)], busy),
		observe(30_000, [root(5, 2)], busy),
		observe(40_000, [root(5, 2)], busy),
	]);
	assert.deepEqual(plans.map(scaleTargets), [[], [], [], [], [4]]);
});

test("ready work and no host at all scales up from zero even below scaleUpQueueDepth (#4768)", () => {
	const plans = ticks(POLICY, [observe(0, [root(1)], []), observe(20_000, [root(1)], [])]);
	assert.deepEqual(plans.map(scaleTargets), [[], [1]]);
});

test("pending hosts count toward the target: a booting fleet is not scaled up again (#4768)", () => {
	const booting = [host("a", { leased: 2 }), host("b", { registered: false, state: "pending", since: 15_000 })];
	const plans = ticks(POLICY, [observe(0, [root(5, 2)], booting), observe(20_000, [root(1, 2)], booting)]);
	// Demand 3 is 2 hosts, which the live and the pending host already are.
	assert.deepEqual(plans.map(scaleTargets), [[], []]);
	assert.equal(plans[1]!.pending, 1);
});

test("hosts below minHosts are started at once, with no ready work (#4768)", () => {
	const plan = planFleet({ ...POLICY, minHosts: 2 }, observe(0, [], [host("a")]), INITIAL_FLEET_STATE);
	assert.deepEqual(scaleTargets(plan), [2]);
});

test("a root's session limit caps its demand: admission bounds the hosts it gets (#4768)", () => {
	const plans = ticks(POLICY, [
		observe(0, [root(20, 0, { sessionLimit: 3 })], []),
		observe(20_000, [root(20, 0, { sessionLimit: 3 })], []),
	]);
	assert.equal(plans[1]!.target, 2);
	assert.deepEqual(scaleTargets(plans[1]!), [2]);
});

test("a budget-blocked root counts only its running children, and its ready work starts no host (#4768)", () => {
	const blocked = [root(9, 2, { blocked: true })];
	const plans = ticks(POLICY, [
		observe(0, blocked, [host("a", { leased: 2 })]),
		observe(20_000, blocked, [host("a", { leased: 2 })]),
	]);
	assert.equal(plans[1]!.target, 1);
	assert.deepEqual(scaleTargets(plans[1]!), []);
});

test("a rate cap bounds the target below the demand (#4768)", () => {
	const plans = ticks(POLICY, [
		{ ...observe(0, [root(8)], []), rateCapHosts: 1 },
		{ ...observe(20_000, [root(8)], []), rateCapHosts: 1 },
	]);
	assert.equal(plans[1]!.target, 1);
	assert.deepEqual(scaleTargets(plans[1]!), [1]);
});

test("an idle host is marked draining only after idleDrainMs idle, oldest idle first, and never below the target (#4768)", () => {
	const hosts = [host("a", { leased: 1 }), host("b"), host("c")];
	const plans = ticks(POLICY, [
		observe(0, [root(0, 1)], [hosts[0]!, hosts[1]!, host("c", { leased: 1 })]),
		observe(100_000, [root(0, 1)], hosts),
		observe(299_999, [root(0, 1)], hosts),
		observe(300_000, [root(0, 1)], hosts),
	]);
	assert.deepEqual(plans.map(marked), [[], [], [], ["b"]]);
	// c went idle 100 s later than b, which drains now; demand 1 keeps one host, which is a, busy.
	const later = planFleet(
		POLICY,
		observe(400_000, [root(0, 1)], [hosts[0]!, host("b", { draining: true }), hosts[2]!]),
		plans[3]!.state,
	);
	assert.deepEqual(marked(later), ["c"]);
});

test("a host that takes a child resets its idle time (#4768)", () => {
	const plans = ticks(POLICY, [
		observe(0, [], [host("a")]),
		observe(200_000, [root(0, 1)], [host("a", { leased: 1 })]),
		observe(300_000, [], [host("a")]),
		observe(599_999, [], [host("a")]),
		observe(600_000, [], [host("a")]),
	]);
	assert.deepEqual(plans.map(marked), [[], [], [], [], ["a"]]);
});

test("a drained host that left the registry is removed from the provider (#4768)", () => {
	const plan = planFleet(
		POLICY,
		observe(0, [], [host("a", { draining: true, registered: false }), host("b", { draining: true })]),
		INITIAL_FLEET_STATE,
	);
	assert.deepEqual(
		plan.actions.filter((action) => action.kind === "remove"),
		[{ kind: "remove", id: "a", reason: "drained" }],
	);
});

test("a host that never registers within bootTimeoutMs is removed and replaced once, then repeated failures back off (#4768)", () => {
	const policy = { ...POLICY, minHosts: 1, maxHosts: 1, bootTimeoutMs: 60_000 };
	let state = INITIAL_FLEET_STATE;
	const step = (now: number, hosts: readonly FleetHostView[]) => {
		const plan = planFleet(policy, observe(now, [], hosts), state);
		state = plan.state;
		return plan;
	};
	assert.deepEqual(scaleTargets(step(0, [])), [1]);
	assert.deepEqual(removed(step(10_000, [host("p1", { registered: false, state: "pending", since: 10_000 })])), []);
	// First failure: removed and replaced at once.
	const first = step(70_000, [host("p1", { registered: false, state: "pending", since: 10_000 })]);
	assert.deepEqual(removed(first), ["p1"]);
	assert.deepEqual(scaleTargets(first), [1]);
	step(80_000, [host("p2", { registered: false, state: "pending", since: 80_000 })]);
	// Second failure in a row: removed, and the replacement waits the first backoff.
	const second = step(140_000, [host("p2", { registered: false, state: "pending", since: 80_000 })]);
	assert.deepEqual(removed(second), ["p2"]);
	assert.deepEqual(scaleTargets(second), []);
	assert.deepEqual(scaleTargets(step(140_000 + BOOT_BACKOFF.firstMs - 1, [])), []);
	assert.deepEqual(scaleTargets(step(140_000 + BOOT_BACKOFF.firstMs, [])), [1]);
	step(150_000 + BOOT_BACKOFF.firstMs, [host("p3", { registered: false, state: "pending", since: 150_000 })]);
	// A host that registers forgets the failures.
	step(160_000 + BOOT_BACKOFF.firstMs, [host("p3")]);
	assert.equal(state.bootFailures, 0);
});

test("boot backoff doubles with each failure in a row and stops at BOOT_BACKOFF.maxMs (#4768)", () => {
	const policy = { ...POLICY, minHosts: 1, maxHosts: 1, bootTimeoutMs: 1 };
	let state = INITIAL_FLEET_STATE;
	let now = 0;
	const holds: number[] = [];
	for (let failure = 1; failure <= 8; failure++) {
		const id = `p${failure}`;
		state = planFleet(
			policy,
			observe(now, [], [host(id, { registered: false, state: "pending", since: now })]),
			state,
		).state;
		now += 1;
		const plan = planFleet(
			policy,
			observe(now, [], [host(id, { registered: false, state: "pending", since: now - 1 })]),
			state,
		);
		assert.deepEqual(removed(plan), [id]);
		state = plan.state;
		holds.push(state.holdUntil - now);
		now = Math.max(now, state.holdUntil);
	}
	assert.deepEqual(holds, [0, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
});

test("a busy host that stopped reporting is never removed, however long it is silent (#4768)", () => {
	const plans = ticks(POLICY, [
		observe(0, [root(0, 1)], [host("a", { registered: false, leased: 1 })]),
		observe(10_000_000, [root(0, 1)], [host("a", { registered: false, leased: 1 })]),
	]);
	assert.deepEqual(plans.map(removed), [[], []]);
});

test("a host the provider reports failed or stopped is removed (#4768)", () => {
	const plan = planFleet(
		POLICY,
		observe(
			0,
			[],
			[host("a", { state: "failed", registered: false }), host("b", { state: "stopped", registered: false })],
		),
		INITIAL_FLEET_STATE,
	);
	assert.deepEqual(removed(plan), ["a", "b"]);
});

test("resolveFleetPolicy applies the defaults and refuses caps that cannot hold (#4768)", () => {
	assert.deepEqual(resolveFleetPolicy({}), {
		minHosts: 0,
		maxHosts: 10,
		workersPerHost: 4,
		scaleUpQueueDepth: 4,
		scaleUpDelayMs: 20_000,
		idleDrainMs: 300_000,
		bootTimeoutMs: 600_000,
	});
	assert.equal(resolveFleetPolicy({ workersPerHost: 8 }).scaleUpQueueDepth, 8);
	assert.throws(() => resolveFleetPolicy({ minHosts: 3, maxHosts: 2 }), /minHosts/);
	assert.throws(() => resolveFleetPolicy({ workersPerHost: 0 }), /workersPerHost/);
	assert.throws(() => resolveFleetPolicy({ maxHosts: 1.5 }), /maxHosts/);
	assert.throws(() => resolveFleetPolicy({ scaleUpQueueDepth: -1 }), /scaleUpQueueDepth/);
	assert.throws(() => resolveFleetPolicy({ bootTimeoutMs: 0 }), /bootTimeoutMs/);
});
