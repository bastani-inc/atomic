import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { prometheusText } from "../../packages/coding-agent/src/cli/worker-metrics.js";
import type { RateBucketUsage } from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
import { INITIAL_FLEET_STATE, planFleet, resolveFleetPolicy } from "../../packages/workflows/src/workers/autoscaler.js";
import {
	FleetRateCap,
	RATE_CAP_MIN_SPAN_MS,
	RATE_CAP_SATURATED,
	RATE_CAP_WINDOW_MS,
	rateCapReason,
} from "../../packages/workflows/src/workers/fleet-rate-cap.js";
import { fleetScaling } from "../../packages/workflows/src/workers/fleet-scaling.js";

const MINUTE = 60_000;
const START = 1_800_000_000_000;

function bucket(scope: string, requestsPerMinute: number, acquired: number, at: number): RateBucketUsage {
	return { scope, acquired, waitingMs: 0, intervalMs: MINUTE / requestsPerMinute, now: START + at };
}

function limited(leased: number, ...scopes: string[]) {
	return { leased, ready: 1_000, blocked: false, rateScopes: scopes };
}

function observeSteady(
	cap: FleetRateCap,
	scope: string,
	requestsPerMinute: number,
	perMinute: number,
	busy: number,
	from: number,
	to: number,
	acquiredAtFrom = 0,
): number {
	let acquired = acquiredAtFrom;
	for (let at = from; at <= to; at += 10_000) {
		acquired = acquiredAtFrom + Math.round(((at - from) / MINUTE) * perMinute);
		cap.observe([bucket(scope, requestsPerMinute, acquired, at)], [limited(busy, scope)]);
	}
	return acquired;
}

test("a fleet that draws a quarter of a rate limit keeps at most the hosts four times its busy workers fill (#4768)", () => {
	const cap = new FleetRateCap();
	observeSteady(cap, "anthropic", 600, 150, 8, 0, 10 * MINUTE);
	const estimate = cap.estimate(4);
	assert.equal(estimate?.hosts, 8);
	assert.deepEqual(
		estimate && {
			scope: estimate.scope.scope,
			requestsPerMinute: Math.round(estimate.scope.requestsPerMinute),
			usedPerMinute: Math.round(estimate.scope.usedPerMinute),
			busyWorkers: estimate.scope.busyWorkers,
		},
		{ scope: "anthropic", requestsPerMinute: 600, usedPerMinute: 150, busyWorkers: 8 },
	);
	assert.match(
		rateCapReason(estimate!, 12),
		/^rate limit anthropic \(600\/min\) granted 150\/min with 8 nonwaiting workers out of 8 busy over the last 600 seconds: the fleet can use at most 8 hosts including other scopes, while the queue wants 12$/,
	);
});

test("a saturated rate limit caps the fleet at the hosts its busy workers fill now (#4768)", () => {
	const cap = new FleetRateCap();
	observeSteady(cap, "anthropic/opus", 120, 120 * RATE_CAP_SATURATED + 1, 12, 0, 5 * MINUTE);
	assert.equal(cap.estimate(4)?.hosts, 3);
	assert.equal(cap.estimate(5)?.hosts, 3);
	assert.equal(cap.estimate(16)?.hosts, 1, "a saturated limit still feeds one host");
});

test("no rate cap before a minute of history, while no token is granted, or for a scope no running root limits (#4768)", () => {
	const cap = new FleetRateCap();
	observeSteady(cap, "anthropic", 600, 300, 4, 0, RATE_CAP_MIN_SPAN_MS - 10_000);
	assert.equal(cap.estimate(4), undefined, "less than a minute of history");
	observeSteady(cap, "anthropic", 600, 300, 4, RATE_CAP_MIN_SPAN_MS, RATE_CAP_MIN_SPAN_MS, 300);
	assert.equal(cap.estimate(4)?.hosts, 2);

	const idle = new FleetRateCap();
	observeSteady(idle, "openai", 600, 0, 4, 0, 5 * MINUTE);
	assert.equal(idle.estimate(4), undefined, "a scope that granted nothing holds nothing back");

	const unlimited = new FleetRateCap();
	for (let at = 0; at <= 5 * MINUTE; at += 10_000)
		unlimited.observe([bucket("anthropic", 600, at / 100, at)], [{ leased: 4, ready: 0, blocked: false }]);
	assert.equal(unlimited.estimate(4), undefined, "no running root limits the scope");

	const stopped = new FleetRateCap();
	observeSteady(stopped, "anthropic", 600, 150, 4, 0, 5 * MINUTE);
	assert.ok(stopped.estimate(4));
	stopped.observe([bucket("anthropic", 600, 750, 5 * MINUTE + 10_000)], []);
	assert.equal(stopped.estimate(4), undefined, "a scope whose roots stopped is forgotten");
});

test("the tightest limited scope sets the rate cap, by the last 10 minutes only, and a bucket created again starts over (#4768)", () => {
	const cap = new FleetRateCap();
	const at = (minute: number) => minute * MINUTE;
	const busyBoth = [limited(8, "anthropic", "openai")];
	for (let minute = 0; minute <= 10; minute += 0.5)
		cap.observe(
			[
				bucket("anthropic", 600, Math.round(minute * 150), at(minute)),
				bucket("openai", 100, Math.round(minute * 90), at(minute)),
			],
			busyBoth,
		);
	assert.equal(cap.estimate(4)?.scope.scope, "openai");
	assert.equal(cap.estimate(4)?.hosts, 3);

	const shifting = new FleetRateCap();
	let acquired = observeSteady(shifting, "anthropic", 600, 600, 8, 0, 10 * MINUTE);
	assert.equal(shifting.estimate(4)?.hosts, 2, "saturated for 10 minutes");
	acquired = observeSteady(shifting, "anthropic", 600, 60, 8, 10 * MINUTE, 20 * MINUTE, acquired);
	assert.equal(
		shifting.estimate(4)?.hosts,
		Math.ceil(8 / (60 / 600) / 4),
		`only the last ${RATE_CAP_WINDOW_MS / MINUTE} minutes count`,
	);
	shifting.observe([bucket("anthropic", 600, 3, 20 * MINUTE + 10_000)], [limited(8, "anthropic")]);
	assert.equal(shifting.estimate(4), undefined, "a count that went back starts the history over");
	assert.equal(shifting.limit(4, 2), 2, "a counter reset holds new growth until its fresh history warms");
	assert.ok(acquired > 3);
});

test("a saturated quota caps productive worker time instead of pinning token-blocked leases (#4768)", () => {
	for (const busy of [12, 32, 36, 80]) {
		const cap = new FleetRateCap();
		for (let at = 0; at <= 5 * MINUTE; at += 10_000)
			cap.observe([{ ...bucket("p", 600, at / 100, at), waitingMs: (busy - 10) * at }], [limited(busy, "p")]);
		assert.equal(cap.estimate(4)?.hosts, 3, `${busy} leased children include workers waiting on tokens`);
		assert.equal(cap.estimate(4)?.scope.activeWorkers, 10);
	}
});

test("rate observations start over after a gap, a clock reversal or a limit change (#4768)", () => {
	for (const change of ["gap", "clock", "limit"] as const) {
		const cap = new FleetRateCap();
		const acquired = observeSteady(cap, "p", 600, 600, 32, 0, 2 * MINUTE);
		const at = change === "gap" ? 62 * MINUTE : change === "clock" ? MINUTE : 2 * MINUTE + 10_000;
		cap.observe([bucket("p", change === "limit" ? 1200 : 600, acquired + 1, at)], [limited(4, "p")]);
		assert.equal(cap.estimate(4), undefined, change);
		assert.equal(cap.limit(4, 3), 3, "a new observation window cannot add hosts");
		observeSteady(cap, "p", change === "limit" ? 1200 : 600, 60, 4, at, at + MINUTE, acquired + 1);
		assert.equal(cap.estimate(4)?.hosts, change === "limit" ? 20 : 10);
	}
});

test("a reset or retired root cannot carry an old uncounted-draw allowance into a new warm-up (#4768)", () => {
	for (const reset of ["gap", "clock", "counter", "limit", "retired"] as const) {
		const cap = new FleetRateCap();
		const roots = [limited(4, "p")];
		cap.observe([{ ...bucket("p", 600, 100, 0), scheduledAt: START + 1_000 }], roots);
		cap.observe([{ ...bucket("p", 600, 100, 10_000), scheduledAt: START + 11_000 }], roots);
		assert.equal(cap.limit(4, 2), 251, "uncounted draws do not restrict demand");
		if (reset === "retired") cap.observe([], []);
		const at = reset === "gap" ? MINUTE : reset === "clock" ? 5_000 : 20_000;
		cap.observe(
			[
				{
					...bucket("p", reset === "limit" ? 300 : 600, reset === "counter" ? 0 : 101, at),
					scheduledAt: START + at + 100,
				},
			],
			roots,
		);
		assert.equal(cap.limit(4, 2), 2, reset);
	}
});

test("rate estimates weight each busy count by its observed time and report the actual span (#4768)", () => {
	const cap = new FleetRateCap();
	for (let at = 0; at <= MINUTE; at += 10_000)
		cap.observe([bucket("p", 600, at / 200, at)], [limited(at < 20_000 ? 4 : 12, "p")]);
	const estimate = cap.estimate(4)!;
	assert.equal(estimate.hosts, 5);
	assert.equal(estimate.scope.busyWorkers, (4 * 20_000 + 12 * 40_000) / MINUTE);
	assert.match(rateCapReason(estimate, 8), /over the last 60 seconds/);
});

test("a rate-limited fleet holds growth while warming every scope, bootstraps and forgets stopped scopes (#4768)", () => {
	const cap = new FleetRateCap();
	cap.observe([bucket("p", 600, 0, 0)], [limited(4, "p")]);
	assert.equal(cap.limit(4, 0), 1);
	assert.equal(cap.limit(4, 3), 3);
	observeSteady(cap, "p", 600, 150, 4, 0, MINUTE);
	assert.equal(cap.limit(4, 1), 4);
	cap.observe([bucket("p", 600, 300, MINUTE + 10_000)], [limited(4, "p", "q")]);
	assert.equal(cap.limit(4, 1), 1, "a scope without readings holds growth too");
	const idle = new FleetRateCap();
	observeSteady(idle, "p", 600, 0, 4, 0, MINUTE);
	assert.equal(idle.limit(4, 1), 251, "an unused scope supplies no restriction on the root's full demand");
	idle.observe([], []);
	assert.equal(idle.limit(4, 1), undefined, "a scope no running root limits is forgotten");
});

test("a configured scope without bucket observations releases its startup hold after a minute without draws (#4768)", () => {
	const cap = new FleetRateCap();
	const now = vi.spyOn(Date, "now");
	try {
		for (let at = 0; at <= 5 * MINUTE; at += 10_000) {
			now.mockReturnValue(START + at);
			cap.observe([], [limited(4, "p")]);
			assert.equal(cap.limit(4, 1), at < MINUTE ? 1 : 251, `unused scope observed for ${at}ms`);
		}
		observeSteady(cap, "p", 600, 300, 4, 5 * MINUTE, 6 * MINUTE);
		assert.equal(cap.limit(4, 1), 2);
	} finally {
		now.mockRestore();
	}
});

test("an existing but idle bucket cannot make setup-only samples look like a minute of rate usage (#4768)", () => {
	const cap = new FleetRateCap();
	for (let at = 0; at <= 5 * MINUTE; at += 10_000) {
		cap.observe([bucket("p", 600, 100, at)], [limited(4, "p")]);
		assert.equal(cap.limit(4, 1), at < MINUTE ? 1 : 251, `the previous run's counter is idle at ${at}ms`);
	}
	observeSteady(cap, "p", 600, 300, 4, 5 * MINUTE, 6 * MINUTE, 100);
	assert.equal(cap.limit(4, 1), 2);
});

test("new hosts for unrelated work do not expand the warming quota allowance again (#4768)", () => {
	const cap = new FleetRateCap();
	const roots = [
		{ ...limited(4, "p"), ready: 100 },
		{ leased: 0, ready: 8, blocked: false },
	];
	const policy = resolveFleetPolicy({ maxHosts: 20, workersPerHost: 4 });
	let state = INITIAL_FLEET_STATE;
	let serving = 1;
	for (let at = 0; at < MINUTE; at += 10_000) {
		cap.observe([bucket("p", 60, at / 1000, at)], roots);
		const plan = planFleet(
			policy,
			{
				now: at,
				roots,
				rateCapHosts: cap.limit(4, serving),
				hosts: Array.from({ length: serving }, (_, index) => ({
					id: String(index),
					state: "running" as const,
					since: 0,
					registered: true,
					leased: 0,
					draining: false,
					drained: false,
				})),
			},
			state,
		);
		state = plan.state;
		const scale = plan.actions.find((action) => action.kind === "scale-up");
		if (scale?.kind === "scale-up") serving = scale.desired;
		assert.ok(serving <= 3, `${serving} hosts after ${at}ms counts the unrelated hosts twice`);
	}
	assert.equal(serving, 3);
});

test("fractional capacity for unrelated scopes cannot round warming hosts upward on each read (#4768)", () => {
	const cap = new FleetRateCap();
	const roots = [
		...[
			[10, 497],
			[2, 35],
			[2, 957],
			[6, 999],
			[4, 897],
		].map(([leased, ready]) => ({ leased: leased!, ready: ready!, blocked: false, rateScopes: ["p"] })),
		{ leased: 2, ready: 10_000, blocked: false, rateScopes: ["q"] },
	];
	for (let at = 0; at <= MINUTE; at += 10_000)
		cap.observe([bucket("q", 414, (at / 10_000) * 21, at)], [roots.at(-1)!]);
	cap.observe([bucket("q", 414, 147, MINUTE + 10_000)], roots);
	let serving = 30;
	for (let tick = 0; tick < 5; tick++) {
		serving = cap.limit(8, serving)!;
		assert.equal(serving, 30, "rounding worker allocations must not create another host");
	}
});

test("a scope limits only its own roots, leaving capacity for unlimited and disjoint-scope demand (#4768)", () => {
	const cap = new FleetRateCap();
	for (let at = 0; at <= MINUTE; at += 10_000)
		cap.observe(
			[bucket("p", 60, at / 1000, at), bucket("q", 120, at / 500, at)],
			[
				{ ...limited(4, "p"), ready: 20, blocked: false },
				{ ...limited(8, "q"), ready: 40, blocked: false },
				{ leased: 0, ready: 400, blocked: false },
			],
		);
	assert.equal(
		cap.estimate(4)?.hosts,
		103,
		"p feeds four workers, q feeds eight, and 400 unlimited children keep their capacity",
	);
	assert.equal(cap.limit(4, 3), 103);
});

test("a rate-cap explanation names a scope that actually constrains the current roots (#4768)", () => {
	const cap = new FleetRateCap();
	for (let at = 0; at <= MINUTE; at += 10_000)
		cap.observe(
			[bucket("p", 60, at / 1000, at), bucket("q", 120, at / 1000, at)],
			[limited(1, "p"), limited(8, "q")],
		);
	cap.observe(
		[bucket("p", 60, 70, 70_000), bucket("q", 120, 70, 70_000)],
		[{ leased: 0, ready: 0, blocked: false, rateScopes: ["p"] }, limited(8, "q")],
	);
	const estimate = cap.estimate(4)!;
	assert.equal(estimate.hosts, 4);
	assert.equal(estimate.scope.scope, "q", "the smaller quota with no current work is not the reason for the cap");
	assert.match(rateCapReason(estimate, 20), /^rate limit q /);
	const earlierBinding = new FleetRateCap();
	for (let at = 0; at <= MINUTE; at += 10_000)
		earlierBinding.observe([bucket("a", 60, at / 1000, at), bucket("z", 600, at / 1000, at)], [limited(4, "a", "z")]);
	assert.equal(
		earlierBinding.estimate(4)?.scope.scope,
		"a",
		"a later looser scope cannot replace an actual binding scope",
	);
});

test("the scaling signal never wants more hosts than the rate limits keep busy, and reports that cap (#4768)", () => {
	const roots = [{ ready: 40, leased: 8, blocked: false }];
	const capped = fleetScaling(roots, [], { workersPerHost: 4, maxHosts: 20 }, 3);
	assert.equal(capped.desiredHosts, 3);
	assert.equal(capped.desiredWorkers, 12);
	assert.equal(capped.rateCapHosts, 3);
	assert.equal(fleetScaling(roots, [], { workersPerHost: 4, maxHosts: 20, minHosts: 5 }, 3).desiredHosts, 5);
	const uncapped = fleetScaling(roots, [], { workersPerHost: 4, maxHosts: 20 });
	assert.equal(uncapped.desiredHosts, 12);
	assert.equal("rateCapHosts" in uncapped, false);
	const store = { store: { state: "ok" as const } };
	assert.match(
		prometheusText({ fleet: store, scaling: capped }),
		/# TYPE atomic_fleet_rate_cap_hosts gauge\natomic_fleet_rate_cap_hosts 3\n/,
	);
	assert.doesNotMatch(prometheusText({ fleet: store, scaling: uncapped }), /atomic_fleet_rate_cap_hosts/);
});

test("rounded-up schedules on fractional intervals stay counted instead of bypassing the rate cap (#4768)", () => {
	const actual = ([47, 23] as const).map((requestsPerMinute) => {
		const cap = new FleetRateCap();
		const roots = [{ ...limited(8, "p"), ready: 80 }];
		let scheduledAt = START;
		for (let step = 0; step <= 6; step++) {
			const at = step * 10_000;
			if (step > 0) scheduledAt = Math.ceil(Math.max(scheduledAt, START + at) + MINUTE / requestsPerMinute);
			cap.observe([{ ...bucket("p", requestsPerMinute, step, at), scheduledAt }], roots);
		}
		return [cap.limit(4, 2), cap.estimate(4)?.hosts];
	});
	assert.deepEqual(actual, [
		[16, 16],
		[8, 8],
	]);
});

test("an uncounted schedule advance before the sample timestamp or alongside saturated counted draws bypasses the cap until the window expires (#4768)", () => {
	const roots = [{ ...limited(8, "p"), ready: 80 }];
	const flatCounter = new FleetRateCap();
	flatCounter.observe([{ ...bucket("p", 60, 100, 0), scheduledAt: START + 1_000 }], roots);
	assert.equal(flatCounter.limit(4, 2), 2);
	flatCounter.observe([{ ...bucket("p", 60, 100, 10_000), scheduledAt: START + 5_000 }], roots);
	assert.equal(flatCounter.limit(4, 2), 22);

	const expiring = new FleetRateCap();
	expiring.observe([{ ...bucket("p", 60, 100, 0), scheduledAt: START }], roots);
	expiring.observe([{ ...bucket("p", 60, 110, 10_000), scheduledAt: START + 110_000 }], roots);
	for (let at = 20_000; at <= 10_000 + RATE_CAP_WINDOW_MS; at += 10_000) {
		expiring.observe([{ ...bucket("p", 60, 100 + at / 1_000, at), scheduledAt: START + 100_000 + at }], roots);
		assert.equal(expiring.limit(4, 2), 22, `uncounted draw still within window at ${at}ms`);
		assert.equal(expiring.estimate(4), undefined);
	}
	const afterWindow = 20_000 + RATE_CAP_WINDOW_MS;
	expiring.observe(
		[{ ...bucket("p", 60, 100 + afterWindow / 1_000, afterWindow), scheduledAt: START + 100_000 + afterWindow }],
		roots,
	);
	assert.equal(expiring.limit(4, 2), 2);
	assert.equal(expiring.estimate(4)?.hosts, 2);
});

test("a scope that starts waiting after an idle period holds growth until its waiting span matures (#4768)", () => {
	const cap = new FleetRateCap();
	const roots = [{ ...limited(8, "p"), ready: 80 }];
	for (let at = 0; at < RATE_CAP_MIN_SPAN_MS; at += 10_000) {
		cap.observe([bucket("p", 60, 100, at)], roots);
		assert.equal(cap.limit(4, 2), 2);
	}
	for (let at = RATE_CAP_MIN_SPAN_MS; at < 2 * RATE_CAP_MIN_SPAN_MS - 10_000; at += 10_000) {
		cap.observe([{ ...bucket("p", 60, 100, at), waitingMs: 8 * (at - (RATE_CAP_MIN_SPAN_MS - 10_000)) }], roots);
		assert.equal(cap.limit(4, 2), 2, `waiting span still warming at ${at}ms`);
	}
	const matureAt = 2 * RATE_CAP_MIN_SPAN_MS - 10_000;
	cap.observe([{ ...bucket("p", 60, 100, matureAt), waitingMs: 8 * RATE_CAP_MIN_SPAN_MS }], roots);
	assert.equal(cap.limit(4, 2), 1);
});
