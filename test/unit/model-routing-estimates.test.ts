import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { completeBenchmarks, type Observation } from "../../packages/coding-agent/src/core/model-routing-estimates.js";
import { readText } from "../helpers/runtime.js";

/** Thirty models whose six benchmark results follow two underlying skills; results rise with effort. */
function catalog(): Map<string, Observation[]> {
	const loadings = [
		[8, 1],
		[7, 2],
		[6, 3],
		[2, 7],
		[1, 8],
		[4, 4],
	];
	const models = new Map<string, Observation[]>();
	for (let model = 0; model < 30; model++) {
		const skills = [(model * 7) % 10, (model * 3) % 10];
		const observations: Observation[] = [];
		for (const effort of [-1, 0, 1])
			loadings.forEach(([a, b], index) => {
				observations.push({
					key: `b${index}`,
					value: a! * skills[0]! + b! * skills[1]! + 6 * effort + ((model + index) % 3),
					effort,
				});
			});
		models.set(`m${model}`, observations);
	}
	return models;
}

test("missing results are estimated from correlated benchmarks, with less uncertainty the more is measured (#4689)", () => {
	const models = catalog();
	const completion = completeBenchmarks(models, 4);
	const truth = models.get("m7")!.find((o) => o.key === "b4" && o.effort === 0)!.value;
	const own = (keys: readonly string[]) => models.get("m7")!.filter((o) => o.effort === 0 && keys.includes(o.key));
	const weights = new Map([["b4", 1]]);
	const sparse = completion.estimate(own(["b3"]), weights, 0)!;
	const broad = completion.estimate(own(["b0", "b1", "b2", "b3", "b5"]), weights, 0)!;
	for (const estimate of [sparse, broad]) {
		assert.deepEqual(estimate.measured, []);
		assert.equal(estimate.estimated[0]?.key, "b4");
		assert.ok(Math.abs(estimate.estimated[0]!.value - truth) <= 2 * estimate.estimated[0]!.error);
	}
	assert.ok(broad.error < sparse.error, "more measured results narrow the estimate");
	assert.deepEqual(
		completeBenchmarks(models, 4).estimate(own(["b3"]), weights, 0),
		sparse,
		"the fit is deterministic",
	);
	const unknown = completion.estimate([], weights, 0)!;
	assert.ok(unknown.error > sparse.error, "a model with no results is the most uncertain");
});

test("an effort a model was never measured at is interpolated from its other efforts (#4689)", () => {
	const models = catalog();
	const completion = completeBenchmarks(models, 4);
	const rows = models.get("m4")!;
	const truth = rows.find((o) => o.key === "b0" && o.effort === 0)!.value;
	const around = rows.filter((o) => o.effort !== 0);
	const estimate = completion.estimate(around, new Map([["b0", 1]]), 0)!;
	assert.ok(Math.abs(estimate.estimated[0]!.value - truth) <= 2 * estimate.estimated[0]!.error);
	const low = completion.estimate(around, new Map([["b0", 1]]), -1)!;
	assert.ok(low.mean < estimate.mean, "the same model scores lower at a lower effort");
});

/** Artificial Analysis rows of the shipped evals.md, one observation set per model with each row at its effort. */
async function shippedEffortRows(): Promise<Map<string, Observation[]>> {
	const text = await readText(
		fileURLToPath(new URL("../../packages/coding-agent/docs/models/evals.md", import.meta.url)),
	);
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.startsWith("| slug | Model | Release date |"));
	const header = lines[start]!.split("|").map((cell) => cell.trim());
	const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
	const models = new Map<string, Observation[]>();
	for (const line of lines.slice(start + 2)) {
		if (!line.startsWith("|")) break;
		const cells = line.split("|").map((cell) => cell.trim());
		const level = /\b(minimal|low|medium|high|xhigh|max)\b/iu.exec(
			/\(([^)]*)\)\s*$/u.exec(cells[2]!)?.[1] ?? "",
		)?.[1];
		if (!level) continue;
		const base = cells[1]!.replace(/-(?:minimal|low|medium|high|xhigh)$/u, "");
		const effort = (order.indexOf(level.toLowerCase()) - order.indexOf("high")) / 2;
		const observations = models.get(base) ?? [];
		header.forEach((name, index) => {
			const value = Number.parseFloat(cells[index]!);
			if (index > 3 && name && Number.isFinite(value)) observations.push({ key: name, value, effort });
		});
		models.set(base, observations);
	}
	return models;
}

test("held-out high-effort rows of Sonnet 5.5 and GPT-6.1 Sol are predicted within the stated uncertainty (#4689)", async () => {
	const models = await shippedEffortRows();
	for (const model of ["claude-sonnet-5-5", "gpt-6-1-sol"]) {
		const rows = models.get(model)!;
		const heldOut = rows.filter((o) => o.effort === 0);
		assert.ok(heldOut.length >= 10, `${model} has a measured high row`);
		const training = new Map(models);
		training.set(
			model,
			rows.filter((o) => o.effort !== 0),
		);
		const completion = completeBenchmarks(training, 4);
		let within = 0;
		const checked = heldOut.filter((o) => completion.keys.has(o.key));
		for (const { key, value } of checked) {
			const result = completion.estimate(training.get(model)!, new Map([[key, 1]]), 0)!.estimated[0]!;
			if (Math.abs(result.value - value) <= 2 * result.error) within++;
		}
		assert.ok(within >= 0.8 * checked.length, `${model}: ${within} of ${checked.length} within two standard errors`);
	}
});
