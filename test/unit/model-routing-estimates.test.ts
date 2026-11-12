import assert from "node:assert/strict";
import { test } from "vitest";
import { completeBenchmarks } from "../../packages/coding-agent/src/core/model-routing-estimates.js";

/** Thirty models whose six benchmark results follow two underlying skills. */
function catalog(): Map<string, Map<string, number>> {
	const loadings = [
		[8, 1],
		[7, 2],
		[6, 3],
		[2, 7],
		[1, 8],
		[4, 4],
	];
	const cohorts = new Map(loadings.map((_, index) => [`b${index}`, new Map<string, number>()]));
	for (let model = 0; model < 30; model++) {
		const skills = [(model * 7) % 10, (model * 3) % 10];
		loadings.forEach(([a, b], index) => {
			cohorts.get(`b${index}`)!.set(`m${model}`, a! * skills[0]! + b! * skills[1]! + ((model + index) % 3));
		});
	}
	return cohorts;
}

test("missing results are estimated from correlated benchmarks, with less uncertainty the more is measured (#4689)", () => {
	const cohorts = catalog();
	const completion = completeBenchmarks(cohorts, 4);
	const truth = cohorts.get("b4")!.get("m7")!;
	const own = (keys: readonly string[]) => new Map(keys.map((key) => [key, cohorts.get(key)!.get("m7")!]));
	const weights = new Map([["b4", 1]]);
	const sparse = completion.estimate(own(["b3"]), weights)!;
	const broad = completion.estimate(own(["b0", "b1", "b2", "b3", "b5"]), weights)!;
	for (const estimate of [sparse, broad]) {
		assert.deepEqual(estimate.measured, []);
		assert.equal(estimate.estimated[0]?.key, "b4");
		assert.ok(Math.abs(estimate.estimated[0]!.value - truth) <= 2 * estimate.estimated[0]!.error);
	}
	assert.ok(broad.error < sparse.error, "more measured results narrow the estimate");
	assert.deepEqual(completeBenchmarks(cohorts, 4).estimate(own(["b3"]), weights), sparse, "the fit is deterministic");
	const unknown = completion.estimate(new Map(), weights)!;
	assert.ok(unknown.error > sparse.error, "a model with no results is the most uncertain");
});
