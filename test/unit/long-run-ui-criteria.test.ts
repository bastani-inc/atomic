import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	evaluateCriteria,
	HEAP_BYTES_PER_FINISHED_STAGE_MAX,
	LONG_RUN_STAGES,
	type MeasuredCheckpoint,
	NOISE_FLOOR_MS,
} from "../../scripts/perf/long-run-ui/criteria.js";

interface Overrides extends Partial<MeasuredCheckpoint["sample"]> {
	widget?: number;
	pane?: number;
	idleKey?: number;
	busyKey?: number;
}

function checkpoint(finished: number, overrides: Overrides = {}): MeasuredCheckpoint {
	return {
		finished,
		sample: {
			heapUsedBytes: overrides.heapUsedBytes ?? 50_000_000 + finished * 4_000,
			liveSessions: overrides.liveSessions ?? 0,
			registryEntries: overrides.registryEntries ?? 0,
		},
		idle: {
			engineRenderMs: { widget: { p50: overrides.widget ?? 1 }, pane: { p50: overrides.pane ?? 2 } },
			keyLatencyMs: { p50: overrides.idleKey ?? 3 },
		},
		busy: { keyLatencyMs: { p50: overrides.busyKey ?? 4 } },
	};
}

const flat = [checkpoint(10), checkpoint(50), checkpoint(100), checkpoint(200), checkpoint(300)];

describe("the long-run UI benchmark criteria (#4642)", () => {
	test("a run whose frames, sessions and heap stay flat passes, and reports its heap growth per stage", () => {
		const report = evaluateCriteria(flat);
		assert.deepEqual(report.failures, []);
		assert.equal(report.passed, true);
		assert.equal(report.baselineFinished, 10);
		assert.equal(report.heapBytesPerFinishedStage, 4_000);
	});

	test("each metric at 200 or more finished stages is held to 20% of the baseline plus the noise floor", () => {
		const allowed = (baseline: number) => baseline * 1.2 + NOISE_FLOOR_MS;
		const metrics = [
			["widget", 1, "widget frame p50"],
			["pane", 2, "graph overlay frame p50"],
			["idleKey", 3, "key latency p50, idle"],
			["busyKey", 4, "key latency p50, with stages starting and reopening"],
		] as const;
		for (const [field, baseline, name] of metrics) {
			const atLimit = evaluateCriteria([
				...flat.slice(0, 3),
				checkpoint(LONG_RUN_STAGES, { [field]: allowed(baseline) }),
				checkpoint(300),
			]);
			assert.deepEqual(atLimit.failures, [], `${name} at the limit passes`);

			const over = evaluateCriteria([
				...flat.slice(0, 3),
				checkpoint(LONG_RUN_STAGES, { [field]: allowed(baseline) + 0.001 }),
				checkpoint(300),
			]);
			assert.equal(over.passed, false);
			assert.equal(over.failures.length, 1);
			assert.match(over.failures[0]!, new RegExp(`^${name} is `));
			assert.match(over.failures[0]!, /at 200 finished stages; the 10-stage baseline/);
		}
	});

	test("checkpoints below 200 finished stages are not compared with the baseline", () => {
		const report = evaluateCriteria([
			checkpoint(10),
			checkpoint(50, { pane: 40 }),
			checkpoint(199, { pane: 40 }),
			checkpoint(250),
			checkpoint(300),
		]);
		assert.deepEqual(report.failures, []);
	});

	test("a NaN measurement fails instead of passing by comparison", () => {
		const report = evaluateCriteria([...flat.slice(0, 3), checkpoint(300, { pane: Number.NaN })]);
		assert.equal(report.passed, false);
		assert.match(report.failures[0]!, /^graph overlay frame p50 is NaN/);
	});

	test("a live session or a registry entry at any checkpoint fails, naming the count and the stage count", () => {
		const report = evaluateCriteria([
			checkpoint(10, { liveSessions: 8 }),
			...flat.slice(1, 4),
			checkpoint(300, { registryEntries: 2 }),
		]);
		assert.deepEqual(report.failures, [
			"8 live sessions at 10 finished stages",
			"2 registry entries at 300 finished stages",
		]);
	});

	test("heap growth beyond the per-stage bound fails, measured from the first checkpoint at 200 finished stages to the last", () => {
		const growing = (perStage: number) =>
			flat.map((point) =>
				checkpoint(point.finished, {
					heapUsedBytes: 40_000_000 + (point.finished === 10 ? 9_999_999 : point.finished * perStage),
				}),
			);
		assert.equal(evaluateCriteria(growing(HEAP_BYTES_PER_FINISHED_STAGE_MAX)).passed, true);
		const report = evaluateCriteria(growing(HEAP_BYTES_PER_FINISHED_STAGE_MAX + 1));
		assert.equal(report.passed, false);
		assert.equal(report.failures.length, 1);
		assert.match(
			report.failures[0]!,
			new RegExp(
				`^heap grows ${HEAP_BYTES_PER_FINISHED_STAGE_MAX + 1} bytes per finished stage from 200 to 300; at most ${HEAP_BYTES_PER_FINISHED_STAGE_MAX} is allowed$`,
			),
		);
		assert.equal(report.heapBytesPerFinishedStage, HEAP_BYTES_PER_FINISHED_STAGE_MAX + 1);
	});

	test("a run too short to compare, or to measure growth, fails rather than passes", () => {
		assert.deepEqual(evaluateCriteria([checkpoint(10), checkpoint(50), checkpoint(100)]).failures, [
			"no checkpoint reached 200 finished stages, so nothing can be compared",
			"fewer than two checkpoints from 200 finished stages on, so heap growth per stage cannot be measured",
		]);
		assert.deepEqual(evaluateCriteria([checkpoint(10), checkpoint(300)]).failures, [
			"fewer than two checkpoints from 200 finished stages on, so heap growth per stage cannot be measured",
		]);
		assert.throws(() => evaluateCriteria([]), /measured no checkpoint/);
	});
});
