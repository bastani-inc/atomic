import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	evaluateCriteria as evaluateWith,
	heapBytesPerFinishedStageMax,
	LONG_RUN_STAGES,
	type MeasuredCheckpoint,
	NOISE_FLOOR_MS,
	RESULT_COPIES_PER_FINISHED_STAGE_MAX,
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

const RESULT_BYTES = 1_100;
const HELD_STAGES = 2;

function evaluateCriteria(
	points: readonly MeasuredCheckpoint[],
	options: { resultBytes?: number; heldStagesMax?: number } = {},
) {
	return evaluateWith(points, {
		resultBytes: options.resultBytes ?? RESULT_BYTES,
		heldStagesMax: options.heldStagesMax ?? HELD_STAGES,
	});
}

const heapMax = heapBytesPerFinishedStageMax(RESULT_BYTES);

const flat = [checkpoint(10), checkpoint(50), checkpoint(100), checkpoint(200), checkpoint(300)];

describe("the long-run UI benchmark criteria (#4642)", () => {
	test("a run whose frames, sessions and heap stay flat passes, and reports its heap growth per stage", () => {
		const report = evaluateCriteria(flat);
		assert.deepEqual(report.failures, []);
		assert.equal(report.passed, true);
		assert.equal(report.baselineFinished, 10);
		assert.equal(report.heapBytesPerFinishedStage, 4_000);
	});

	test("each metric's median from 200 finished stages on, and its last value, are held to 20% of the baseline plus the noise floor", () => {
		const allowed = (baseline: number) => baseline * 1.2 + NOISE_FLOOR_MS;
		const metrics = [
			["widget", 1, "widget frame p50"],
			["pane", 2, "graph overlay frame p50"],
			["idleKey", 3, "key latency p50, idle"],
			["busyKey", 4, "key latency p50, with stages starting and reopening"],
		] as const;
		const longRun = (value: Overrides) => [
			...flat.slice(0, 3),
			checkpoint(LONG_RUN_STAGES, value),
			checkpoint(300, value),
			checkpoint(600, value),
		];
		for (const [field, baseline, name] of metrics) {
			const atLimit = evaluateCriteria(longRun({ [field]: allowed(baseline) }));
			assert.deepEqual(atLimit.failures, [], `${name} at the limit passes`);

			const over = evaluateCriteria(longRun({ [field]: allowed(baseline) + 0.001 }));
			assert.equal(over.passed, false);
			assert.equal(over.failures.length, 2);
			assert.match(over.failures[0]!, new RegExp(`^${name} is `));
			assert.match(over.failures[0]!, /the median from 200 to 600 finished stages; the 10-stage baseline/);
			assert.match(over.failures[1]!, /at 600 finished stages; the 10-stage baseline/);
		}
	});

	test("growth that follows the stage count fails, and one disturbed checkpoint does not", () => {
		const grows = evaluateCriteria([
			checkpoint(10),
			checkpoint(200, { pane: 2.5 }),
			checkpoint(400, { pane: 5 }),
			checkpoint(600, { pane: 7.5 }),
		]);
		assert.equal(grows.passed, false);
		assert.match(grows.failures[0]!, /^graph overlay frame p50 is 5 ms, the median from 200 to 600/);
		assert.match(grows.failures[1]!, /^graph overlay frame p50 is 7.5 ms, at 600 finished stages/);

		const onlyAtTheEnd = evaluateCriteria([
			checkpoint(10),
			checkpoint(200),
			checkpoint(400),
			checkpoint(600, { pane: 2.5 }),
		]);
		assert.equal(onlyAtTheEnd.failures.length, 1, "the median hides it, the last checkpoint does not");
		assert.match(onlyAtTheEnd.failures[0]!, /^graph overlay frame p50 is 2.5 ms, at 600 finished stages/);

		const spike = evaluateCriteria([
			checkpoint(10),
			checkpoint(200),
			checkpoint(400, { pane: 9, widget: 9, idleKey: 9, busyKey: 9 }),
			checkpoint(600),
		]);
		assert.deepEqual(spike.failures, []);
		const even = evaluateCriteria([checkpoint(10), checkpoint(200, { pane: 1 }), checkpoint(300, { pane: 9 })]);
		assert.match(even.failures[0]!, /^graph overlay frame p50 is 5 ms, the median from 200 to 300/);

		const single = evaluateCriteria([checkpoint(10), checkpoint(200, { pane: 9 })]);
		assert.equal(single.failures.filter((failure) => failure.startsWith("graph overlay")).length, 1);
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

	test("live sessions and registry entries beyond the stages a workflow body holds fail, naming the count and the stage count", () => {
		const atLimit = evaluateCriteria([
			checkpoint(10, { liveSessions: HELD_STAGES, registryEntries: HELD_STAGES }),
			...flat.slice(1),
		]);
		assert.deepEqual(atLimit.failures, [], "the stages a workflow body holds keep their sessions");

		const report = evaluateCriteria([
			checkpoint(10, { liveSessions: HELD_STAGES + 1 }),
			...flat.slice(1, 4),
			checkpoint(300, { registryEntries: HELD_STAGES + 2 }),
		]);
		assert.deepEqual(report.failures, [
			`${HELD_STAGES + 1} live sessions at 10 finished stages; at most ${HELD_STAGES} are held`,
			`${HELD_STAGES + 2} registry entries at 300 finished stages; at most ${HELD_STAGES} are held`,
		]);
	});

	test("heap growth beyond the per-stage bound fails, measured from the first checkpoint at 200 finished stages to the last", () => {
		const growing = (perStage: number) =>
			flat.map((point) =>
				checkpoint(point.finished, {
					heapUsedBytes: 40_000_000 + (point.finished === 10 ? 9_999_999 : point.finished * perStage),
				}),
			);
		assert.equal(evaluateCriteria(growing(heapMax)).passed, true);
		const report = evaluateCriteria(growing(heapMax + 1));
		assert.equal(report.passed, false);
		assert.equal(report.failures.length, 1);
		assert.match(
			report.failures[0]!,
			new RegExp(
				`^heap grows ${heapMax + 1} bytes per finished stage from 200 to 300; at most ${heapMax} is allowed for results of ${RESULT_BYTES} bytes$`,
			),
		);
		assert.equal(report.heapBytesPerFinishedStage, heapMax + 1);
	});

	test("the heap a stage may add is a fixed part plus its result kept the allowed number of times", () => {
		assert.equal(
			heapBytesPerFinishedStageMax(10_000) - heapBytesPerFinishedStageMax(1_000),
			RESULT_COPIES_PER_FINISHED_STAGE_MAX * 9_000,
		);
		const large = 100_000;
		const growing = (perStage: number) =>
			flat.map((point) => checkpoint(point.finished, { heapUsedBytes: 40_000_000 + point.finished * perStage }));
		assert.equal(
			evaluateCriteria(growing(heapBytesPerFinishedStageMax(large)), { resultBytes: large }).passed,
			true,
			"a larger result is allowed its copies",
		);
		assert.equal(
			evaluateCriteria(growing(heapBytesPerFinishedStageMax(large) + 1), { resultBytes: large }).passed,
			false,
		);
		assert.equal(
			evaluateCriteria(growing(heapBytesPerFinishedStageMax(large)), { resultBytes: RESULT_BYTES }).passed,
			false,
			"the same growth fails for a small result: a third copy of a large text would be caught",
		);
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
