import assert from "node:assert/strict";
import { test } from "vitest";
import { prometheusText } from "../../packages/coding-agent/src/cli/worker-metrics.js";
import type { RateBucketUsage } from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
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
	return { scope, acquired, intervalMs: MINUTE / requestsPerMinute, now: START + at };
}

function limited(leased: number, ...scopes: string[]) {
	return { leased, rateScopes: scopes };
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
		/^rate limit anthropic \(600\/min\) granted 150\/min to 8 busy workers over the last 10 minutes: it feeds at most 8 hosts, while the queue wants 12$/,
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
		unlimited.observe([bucket("anthropic", 600, at / 100, at)], [{ leased: 4 }]);
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
	assert.ok(acquired > 3);
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
