import assert from "node:assert/strict";
import type { ClassifierContext, ClassifierResult } from "@bastani/pi-ai";
import { test } from "vitest";
import { buildClassifierUnits, planClassifierRanges } from "../src/core/compaction/classifier-compaction.js";
import { buildStructuredCompactionInput } from "../src/core/compaction/structured-compaction-input.js";
import { createNumberedRegion } from "../src/core/compaction/transcript-serialization.js";

const parameters = { query: "fix login", compression_ratio: 0.5, preserve_recent: 2 };
function result(score = 0, confidence = 1): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: "typesafe",
		model: "jev-latest",
		answers: { score: { type: "score", score, confidence } },
		stopReason: "stop",
		timestamp: 0,
	};
}

test("classifier splits bounded consecutive units around protected lines (#3470)", () => {
	const region = createNumberedRegion(
		["[User]: task", ...Array.from({ length: 70 }, (_, i) => `line ${i}`)].join("\n"),
	);
	region.protectedLineNumbers = new Set([3, 35]);
	const input = buildStructuredCompactionInput(region, parameters);
	const units = buildClassifierUnits(input);
	assert.ok(units.every((unit) => unit.message.lines.length <= 32));
	assert.equal(units.flatMap((unit) => unit.message.lines).length, 69);
	assert.ok(units.every((unit) => !(unit.start <= 3 && unit.end >= 3) && !(unit.start <= 35 && unit.end >= 35)));
	assert.throws(
		() =>
			buildClassifierUnits({
				...input,
				messages: [{ id: 1, role: "tool", lines: ["x".repeat(5000)] }],
				protected: [],
			}),
		/unit token limit/,
	);
	assert.throws(
		() =>
			buildClassifierUnits({
				...input,
				messages: [{ id: 1, role: "tool", lines: ["\t".repeat(4095)] }],
				protected: [],
			}),
		/unit token limit/,
	);
	const tokenSplit = buildClassifierUnits({
		...input,
		messages: [{ id: 1, role: "tool", lines: Array.from({ length: 6 }, () => "x".repeat(1000)) }],
		protected: [],
	});
	assert.deepEqual(
		tokenSplit.map((unit) => unit.message.lines.length),
		[4, 2],
	);
});

test("classifier ranks score then confidence then age and applies keep target (#3470)", async () => {
	const region = createNumberedRegion("[User]: old\na\n[Assistant]: useful\nb\n[Tool result]: recent\nc");
	const calls: ClassifierContext[] = [];
	const ranges = await planClassifierRanges(region, parameters, async (context) => {
		calls.push(context);
		return result(calls.length === 2 ? 4 : 0, calls.length === 1 ? 0.5 : 1);
	});
	assert.deepEqual(ranges, [
		{ start: 5, end: 6 },
		{ start: 1, end: 2 },
	]);
	assert.equal(calls.length, 3);
	assert.deepEqual(Object.keys(calls[0].questions), ["score"]);
	assert.deepEqual(calls[0].state, {
		query: "fix login",
		message: { id: 1, role: "user", lines: ["[User]: old", "a"] },
		position: "lines 1-2 of 2",
	});
});

test("classifier caps concurrency at four and rejects failed or invalid scoring without partial results (#3470)", async () => {
	const region = createNumberedRegion(Array.from({ length: 12 }, (_, i) => `[User]: ${i}`).join("\n"));
	let active = 0;
	let peak = 0;
	await planClassifierRanges(region, parameters, async () => {
		peak = Math.max(peak, ++active);
		await new Promise((resolve) => setTimeout(resolve, 2));
		active--;
		return result();
	});
	assert.equal(peak, 4);
	await assert.rejects(
		planClassifierRanges(region, parameters, async () => ({
			...result(),
			stopReason: "error",
			errorMessage: "broken",
		})),
		/broken/,
	);
	await assert.rejects(
		planClassifierRanges(region, parameters, async () => result(Number.NaN)),
		/score/,
	);
});

test("classifier failure settles all in-flight calls before ladder handoff (#3470)", async () => {
	const region = createNumberedRegion(Array.from({ length: 12 }, (_, i) => `[User]: ${i}`).join("\n"));
	let calls = 0;
	let settled = 0;
	await assert.rejects(
		planClassifierRanges(region, parameters, async () => {
			const index = calls++;
			if (index !== 0) await new Promise((resolve) => setTimeout(resolve, 10));
			settled++;
			if (index === 0) throw new Error("failed first unit");
			return result();
		}),
		/failed first unit/,
	);
	assert.equal(calls, 4);
	assert.equal(settled, calls);
});

test("classifier rejects scores outside the five-criterion scale (#3470)", async () => {
	const region = createNumberedRegion("[User]: task\nline");
	for (const score of [-1, 5])
		await assert.rejects(
			planClassifierRanges(region, parameters, async () => result(score)),
			/score/,
		);
});
