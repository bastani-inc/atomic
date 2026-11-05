import assert from "node:assert/strict";
import { test } from "vitest";
import {
	countHandles,
	handleTotals,
	type IdleAgentSample,
	leastSquaresSlope,
	perAgentHandles,
	perAgentKb,
	perAgentListeners,
	percentile,
	REPORT_HEADER,
	reportRow,
} from "../../scripts/perf/idle-agents/summary.js";

function sample(agents: number, rssKb: number, heapKb: number, extra: Partial<IdleAgentSample> = {}): IdleAgentSample {
	return {
		agents,
		rssBytes: rssKb * 1024,
		heapUsedBytes: heapKb * 1024,
		arrayBuffersBytes: 0,
		handles: {},
		listeners: 11,
		...extra,
	};
}

test("the KB per idle agent is the least-squares slope over the samples (#4326)", () => {
	const samples = [sample(0, 300_000, 50_000), sample(500, 350_000, 52_000), sample(1000, 400_000, 54_000)];
	assert.deepEqual(perAgentKb(samples), { rssKb: 100, heapKb: 4, heapAndBuffersKb: 4 });
	const buffered = samples.map((entry) => ({ ...entry, arrayBuffersBytes: entry.agents * 96 * 1024 }));
	assert.deepEqual(perAgentKb(buffered), { rssKb: 100, heapKb: 4, heapAndBuffersKb: 100 });
	assert.equal(leastSquaresSlope([{ x: 1, y: 5 }]), 0);
	assert.equal(leastSquaresSlope([]), 0);
	assert.equal(
		leastSquaresSlope([
			{ x: 2, y: 1 },
			{ x: 2, y: 9 },
		]),
		0,
	);
	assert.equal(
		leastSquaresSlope([
			{ x: 0, y: 1 },
			{ x: 2, y: 5 },
			{ x: 4, y: 9 },
		]),
		2,
	);
});

test("percentiles use the nearest rank (#4326)", () => {
	const values = [5, 1, 4, 2, 3];
	assert.equal(percentile(values, 50), 3);
	assert.equal(percentile(values, 99), 5);
	assert.equal(percentile(values, 0), 1);
	assert.equal(percentile(values, 100), 5);
	assert.equal(percentile([], 50), 0);
	assert.equal(percentile([7], 10), 7);
});

test("handles are counted by kind and summed into timers, sockets and processes (#4326)", () => {
	const handles = countHandles([
		"Timeout",
		"Timeout",
		"Immediate",
		"TCPSocketWrap",
		"PipeWrap",
		"ProcessWrap",
		"FSReqCallback",
	]);
	assert.deepEqual(handles, {
		Timeout: 2,
		Immediate: 1,
		TCPSocketWrap: 1,
		PipeWrap: 1,
		ProcessWrap: 1,
		FSReqCallback: 1,
	});
	assert.deepEqual(handleTotals(handles), { timers: 3, sockets: 2, processes: 1 });
	assert.deepEqual(handleTotals({}), { timers: 0, sockets: 0, processes: 0 });
});

test("per-agent handle and listener counts are slopes, zero when nothing grows with the agents (#4326)", () => {
	const flat = [
		sample(0, 1, 1, { handles: { Timeout: 2, PipeWrap: 3 } }),
		sample(1000, 1, 1, { handles: { Timeout: 2, PipeWrap: 3 } }),
	];
	assert.deepEqual(perAgentHandles(flat), { timers: 0, sockets: 0, processes: 0 });
	assert.equal(perAgentListeners(flat), 0);
	const growing = [
		sample(0, 1, 1, { handles: {}, listeners: 11 }),
		sample(10, 1, 1, { handles: { TCPSocketWrap: 10, ProcessWrap: 20, Timeout: 5 }, listeners: 121 }),
	];
	assert.deepEqual(perAgentHandles(growing), { timers: 0.5, sockets: 1, processes: 2 });
	assert.equal(perAgentListeners(growing), 11);
});

test("a report row has one cell per header column (#4326)", () => {
	const row = reportRow({
		label: "release-sqlite",
		store: "sqlite",
		mode: "release",
		agents: 1000,
		turns: 20,
		wave: 500,
		storedBytesPerAgent: 100 * 1024,
		samples: [sample(0, 300_000, 50_000), sample(1000, 302_000, 50_500)],
		wakeLatencyMs: [10, 20, 30],
		eventLoopDelayP99Ms: 12.34,
		eventLoopDelayMaxMs: 56.78,
		elapsedMs: 1,
	});
	assert.equal(
		row,
		"| release-sqlite | sqlite | release | 1000 | 2.0 | 0.5 | 100.0 | 0.000 / 0.000 / 0.000 / 0.000 | 20.0 / 30.0 | 12.3 / 56.8 |",
	);
	const columns = (line: string) => line.split("|").length;
	assert.equal(columns(row), columns(REPORT_HEADER.split("\n")[0] ?? ""));
});
