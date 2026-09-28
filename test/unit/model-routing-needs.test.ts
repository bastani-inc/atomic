import assert from "node:assert/strict";
import { test } from "vitest";
import {
	effortForDifficulty,
	missingNeedsQuestions,
	parseTaskNeeds,
	resolveTaskNeeds,
	taskDemand,
} from "../../packages/coding-agent/src/core/model-routing-needs.js";

test("only the needs a caller did not state are asked, in a fixed order", () => {
	assert.deepEqual(
		missingNeedsQuestions(undefined).map((question) => question.id),
		["work", "difficulty", "mistake_cost", "needs_images", "long_context", "latency_sensitive"],
	);
	assert.deepEqual(
		missingNeedsQuestions({ work: "coding", needsImages: false, latencySensitive: true }).map(
			(question) => question.id,
		),
		["difficulty", "mistake_cost", "long_context"],
	);
	assert.deepEqual(
		missingNeedsQuestions({
			work: "coding",
			difficulty: "hard",
			mistakeCost: "low",
			needsImages: true,
			longContext: false,
			latencySensitive: false,
		}),
		[],
	);
});

test("stated needs win over router answers, and computer use always needs images unless the caller says otherwise", () => {
	const answers = { work: "computer_use", difficulty: "easy", mistake_cost: "low", needs_images: "no" };
	assert.deepEqual(resolveTaskNeeds(undefined, answers), {
		work: "computer_use",
		difficulty: "easy",
		mistakeCost: "low",
		needsImages: true,
		longContext: false,
		latencySensitive: false,
	});
	assert.equal(resolveTaskNeeds(undefined, { ...answers, long_context: "yes" }).longContext, true);
	assert.equal(resolveTaskNeeds({ latencySensitive: true }, answers).latencySensitive, true);
	assert.equal(resolveTaskNeeds({ needsImages: false }, answers).needsImages, false);
	assert.equal(resolveTaskNeeds({ difficulty: "very_hard" }, answers).difficulty, "very_hard");
	assert.equal(resolveTaskNeeds(undefined, { ...answers, work: "coding" }).needsImages, false);
	assert.throws(
		() => resolveTaskNeeds(undefined, { ...answers, difficulty: "extreme" }),
		/Invalid taskNeeds\.difficulty/u,
	);
});

test("caller task needs are validated strictly", () => {
	assert.equal(parseTaskNeeds(undefined), undefined);
	assert.deepEqual(parseTaskNeeds({ work: "research", needsImages: true }), { work: "research", needsImages: true });
	assert.deepEqual(parseTaskNeeds({ longContext: true, latencySensitive: false }), {
		longContext: true,
		latencySensitive: false,
	});
	for (const invalid of [
		[],
		"coding",
		{ work: "painting" },
		{ speed: "fast" },
		{ needsImages: "yes" },
		{ longContext: 1 },
		{ latencySensitive: "no" },
	])
		assert.throws(() => parseTaskNeeds(invalid), /Invalid taskNeeds/u);
});

test("demand rises with difficulty or mistake cost, whichever is higher", () => {
	const needs = { work: "coding", needsImages: false, longContext: false, latencySensitive: false } as const;
	assert.equal(taskDemand({ ...needs, difficulty: "trivial", mistakeCost: "negligible" }), 0);
	assert.equal(taskDemand({ ...needs, difficulty: "easy", mistakeCost: "severe" }), 1);
	assert.equal(taskDemand({ ...needs, difficulty: "moderate", mistakeCost: "low" }), 0.5);
});

test("effort follows difficulty, taking the nearest supported level and the lower one on a tie", () => {
	assert.equal(effortForDifficulty(["low", "medium", "high", "xhigh"], "hard"), "high");
	assert.equal(effortForDifficulty(["off", "low", "high"], "trivial"), "off");
	assert.equal(effortForDifficulty(["low", "high"], "moderate"), "low");
	assert.equal(effortForDifficulty([null], "very_hard"), null);
	assert.equal(effortForDifficulty(["max"], "trivial"), "max");
});

test("when speed matters, effort drops one level but never below minimal", () => {
	assert.equal(effortForDifficulty(["minimal", "low", "medium", "high"], "hard", true), "medium");
	assert.equal(effortForDifficulty(["off", "minimal", "low"], "trivial", true), "minimal");
});
