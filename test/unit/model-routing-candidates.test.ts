import assert from "node:assert/strict";
import { test } from "vitest";
import {
	type CandidateModel,
	describeOption,
	distinctTop,
	rankCandidates,
} from "../../packages/coding-agent/src/core/model-routing-candidates.js";
import { parseEvalsCatalog } from "../../packages/coding-agent/src/core/model-routing-evals.js";
import type { ResolvedTaskNeeds } from "../../packages/coding-agent/src/core/model-routing-needs.js";

const catalog = parseEvalsCatalog(
	[
		"# Evals",
		"",
		"## Artificial Analysis Intelligence Index v4.3.2",
		"",
		"| slug | Model | Release date | idx | TB4 | MMMU |",
		"| --- | --- | --- | ---: | ---: | ---: |",
		"| strong | Strong | 2026-09-20 | 60 | 60 | 90 |",
		"| middle | Middle | 2026-09-01 | 50 | 40 | 80 |",
		"| cheap | Cheap | 2026-09-20 | 35 | 12 | 75 |",
		"| old | Old | 2025-09-01 | 30 | 10 | 70 |",
	].join("\n"),
);

const model = (id: string, input: number, image = true): CandidateModel => ({
	model: `p/${id}`,
	name: id,
	cost: { input, output: input * 5 },
	input: image ? ["text", "image"] : ["text"],
});
const models = [model("strong", 10), model("middle", 2), model("cheap", 0.1), model("old", 1)];
const needs = (
	difficulty: ResolvedTaskNeeds["difficulty"],
	mistakeCost: ResolvedTaskNeeds["mistakeCost"],
): ResolvedTaskNeeds => ({
	work: "coding",
	difficulty,
	mistakeCost,
	needsImages: false,
	longContext: false,
	latencySensitive: false,
});

test("a demanding task ranks the best-proven model first; an easy one the adequate cheap one", () => {
	assert.equal(rankCandidates(catalog, models, needs("hard", "severe"))[0]?.model, "p/strong");
	assert.equal(rankCandidates(catalog, models, needs("trivial", "negligible"))[0]?.model, "p/cheap");
});

test("the shortlist keeps one slot per base model across derived fast routes and providers", () => {
	const ranked = rankCandidates(
		catalog,
		[
			...models,
			{ ...model("strong-fast", 10), fastRouteOf: "p/strong" },
			{ ...model("strong", 10), model: "q/strong" },
		],
		needs("hard", "high"),
	);
	const top = distinctTop(ranked, 6);
	assert.deepEqual(
		top.map((candidate) => candidate.model).slice(0, 2),
		["p/strong", "p/middle"],
		"the standard route wins the slot over its derived fast route",
	);
});

test("a model whose own ID ends in -fast is its own model unless its fastRoute metadata says otherwise", () => {
	const ranked = rankCandidates(
		catalog,
		[model("strong", 10), { ...model("strong-fast", 10), model: "vercel/strong-fast" }],
		needs("hard", "high"),
	);
	assert.equal(distinctTop(ranked, 6).length, 2);
	const owned = JSON.parse(
		describeOption(ranked.find((c) => c.model === "vercel/strong-fast")!, needs("hard", "high"), ranked),
	);
	assert.equal(owned.route, undefined);
});

test("each option describes itself with this kind of work's results, standings among eligible models, price and release", () => {
	const ranked = rankCandidates(catalog, models, needs("hard", "high"));
	const strong = JSON.parse(
		describeOption(ranked.find((c) => c.model === "p/strong")!, needs("hard", "high"), ranked),
	);
	assert.deepEqual(strong, {
		model: "strong",
		id: "p/strong",
		released: "2026-09-20, among the newest",
		price: "high: $10 / $50 per million tokens",
		reads_images: true,
		coding: "top 10% (Terminal-Bench 4.0 60%)",
		overall: "top 10% (AA Intelligence Index 60)",
	});
	const old = JSON.parse(describeOption(ranked.find((c) => c.model === "p/old")!, needs("hard", "high"), ranked));
	assert.equal(old.released, "2025-09-01, 13 months older than the newest");
	assert.equal(old.coding, "bottom quarter (Terminal-Bench 4.0 10%)");
});

test("results shared by fewer than four eligible models are quoted without a standing", () => {
	const three = models.slice(0, 3);
	const ranked = rankCandidates(catalog, three, needs("hard", "high"));
	const option = JSON.parse(describeOption(ranked[0]!, needs("hard", "high"), ranked));
	assert.match(option.coding, /^measured \(/u);
});

test("an unbenchmarked model is described as unknown, and a fast route names its standard route", () => {
	const eligible = rankCandidates(
		catalog,
		[...models, model("mystery", 3), { ...model("strong-fast", 10), fastRouteOf: "p/strong" }],
		needs("moderate", "low"),
	);
	const mystery = JSON.parse(
		describeOption(eligible.find((c) => c.model === "p/mystery")!, needs("moderate", "low"), eligible),
	);
	assert.equal(mystery.coding, "no published results");
	assert.equal(mystery.released, "unknown");
	const fast = JSON.parse(
		describeOption(eligible.find((c) => c.model === "p/strong-fast")!, needs("moderate", "low"), eligible),
	);
	assert.equal(
		fast.route,
		"faster route of strong with the same results; billed above the listed prices",
		"catalog prices of a derived fast route are its base model's, not what the fast tier bills",
	);
});

test("quoted results name the effort, harness and reporter they were measured under", () => {
	const measured = parseEvalsCatalog(
		[
			"# Evals",
			"",
			"## Artificial Analysis Intelligence Index",
			"",
			"| slug | Model | Release date | idx | TB4 |",
			"| --- | --- | --- | ---: | ---: |",
			"| astra | Astra (max) | 2026-09-03 | 52 | 59.6 |",
			"| astra-high | Astra (high) | 2026-09-03 | 50 | 56.6 |",
			"",
			"## Published benchmark results",
			"",
			"| slug | Model | Benchmark | Score | Setting | Source |",
			"| --- | --- | --- | --- | --- | --- |",
			"| astra | Astra | OSW2 | 72.6 | official settings; Fable values are Mythos | OpenAI |",
			"| fable | Fable | OSW2 | 77.9 | Anthropic grading; Fable values are Mythos | Anthropic |",
		].join("\n"),
	);
	const use: ResolvedTaskNeeds = {
		work: "computer_use",
		difficulty: "hard",
		mistakeCost: "high",
		needsImages: true,
		longContext: false,
		latencySensitive: false,
	};
	const ranked = rankCandidates(measured, [model("astra", 10), model("fable", 10)], use);
	const describe = (id: string) => JSON.parse(describeOption(ranked.find((c) => c.model === `p/${id}`)!, use, ranked));
	assert.equal(describe("astra").overall, "measured (AA Intelligence Index 52 measured with max effort)");
	assert.equal(
		describe("astra").computer_use,
		"measured (OSWorld 2.0 72.6% measured with official settings, reported by OpenAI)",
		"a footnote about other models is not attached to this one",
	);
	assert.equal(
		describe("fable").computer_use,
		"measured (OSWorld 2.0 77.9% measured with Anthropic grading, Fable values are Mythos, reported by Anthropic)",
	);
});

test("provider copies and fast routes of one model count once in standings and the minimum", () => {
	const three = [model("strong", 10), model("middle", 2), model("cheap", 0.1)];
	const duplicated = [
		...three,
		{ ...model("strong", 10), model: "q/strong" },
		{ ...model("strong-fast", 10), fastRouteOf: "p/strong" },
	];
	const ranked = rankCandidates(catalog, duplicated, needs("hard", "high"));
	const cheap = JSON.parse(describeOption(ranked.find((c) => c.model === "p/cheap")!, needs("hard", "high"), ranked));
	assert.match(cheap.coding, /^measured \(/u, "three distinct models are too few for a standing");
});

test("published results are ranked only against results from the same source", () => {
	const published = parseEvalsCatalog(
		[
			"# Evals",
			"",
			"## Published benchmark results",
			"",
			"| slug | Model | Benchmark | Score | Setting | Source |",
			"| --- | --- | --- | --- | --- | --- |",
			"| a | A | TBSci | 40 | vendor harness | Vendor |",
			"| b | B | TBSci | 45 | vendor harness | Vendor |",
			"| c | C | TBSci | 50 | vendor harness | Vendor |",
			"| d | D | TBSci | 55 | vendor harness | Vendor |",
			"| a | A | TBSci | 60 | own setup | Lab |",
		].join("\n"),
	);
	const science: ResolvedTaskNeeds = {
		work: "math_science",
		difficulty: "hard",
		mistakeCost: "high",
		needsImages: false,
		longContext: false,
		latencySensitive: false,
	};
	const ranked = rankCandidates(
		published,
		["a", "b", "c", "d"].map((id) => model(id, 1)),
		science,
	);
	const a = ranked.find((candidate) => candidate.model === "p/a")!;
	assert.equal(a.workStanding, 0, "A's 60% from another setup does not lift it above the vendor-harness results");
});
