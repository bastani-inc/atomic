import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	type CandidateModel,
	describeOption,
	distinctTop,
	rankCandidates,
} from "../../packages/coding-agent/src/core/model-routing-candidates.js";
import { parseEvalsCatalog } from "../../packages/coding-agent/src/core/model-routing-evals.js";
import type { ResolvedTaskNeeds } from "../../packages/coding-agent/src/core/model-routing-needs.js";
import { readText } from "../helpers/runtime.js";

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

test("ultrafast inherits measured base evidence only through route metadata, without displacing Fast", () => {
	const sol = parseEvalsCatalog(
		[
			"## Artificial Analysis Intelligence Index v4.3.2",
			"| slug | Model | Release date | idx | TB4 |",
			"| --- | --- | --- | ---: | ---: |",
			"| gpt-6-1-sol-high | GPT-6.1 Sol high | 2026-09-29 | 50.2 | 48.6 |",
		].join("\n"),
	);
	const base = { ...model("gpt-6.1-sol", 2), model: "openai-codex/gpt-6.1-sol" };
	const fast = {
		...base,
		model: `${base.model}-fast`,
		fastRouteOf: base.model,
		fastRouteServiceTier: "priority" as const,
	};
	const ultra = {
		...base,
		model: `${base.model}-ultrafast`,
		fastRouteOf: base.model,
		fastRouteServiceTier: "ultrafast" as const,
	};
	const latencyNeeds = { ...needs("moderate", "high"), latencySensitive: true };
	const ranked = rankCandidates(sol, [base, fast, ultra], latencyNeeds);
	assert.equal(distinctTop(ranked, 3).length, 1);
	assert.equal(distinctTop(ranked, 3)[0]?.model, fast.model);
	const selected = rankCandidates(sol, [ultra], latencyNeeds)[0]!;
	const description = JSON.parse(describeOption(selected, latencyNeeds, [selected]));
	assert.match(description.coding, /Terminal-Bench 4\.0 48\.6%/);
	assert.match(description.route, /base-model evidence/);
	assert.match(description.route, /account access/);
	assert.doesNotMatch(description.route, /pricing/);
	assert.doesNotMatch(description.price, /provisional|not published/);
	const owned = rankCandidates(sol, [{ ...base, model: "proxy/gpt-6.1-sol-ultrafast" }], latencyNeeds)[0]!;
	assert.equal(owned.values.size, 0);
});

test("an ultrafast route without published rates says so in its price", () => {
	const base = { ...model("gpt-5.6-sol", 4), model: "openai-codex/gpt-5.6-sol" };
	const ultra = {
		...base,
		model: `${base.model}-ultrafast`,
		fastRouteOf: base.model,
		fastRouteServiceTier: "ultrafast" as const,
		ultrafastPriceUnpublished: true,
	};
	const latencyNeeds = { ...needs("moderate", "high"), latencySensitive: true };
	const selected = rankCandidates(catalog, [ultra], latencyNeeds)[0]!;
	const description = JSON.parse(describeOption(selected, latencyNeeds, [selected]));
	assert.match(description.price, /\$4 \/ \$20 per million tokens/);
	assert.match(description.price, /Ultrafast pricing is not published; this is the standard rate/);
});

test("an owned Sol Fast ID has no base metrics or ranking credit without route metadata", async () => {
	const sol = parseEvalsCatalog(
		await readText(fileURLToPath(new URL("../../packages/coding-agent/docs/models/evals.md", import.meta.url))),
	);
	const base = { ...model("gpt-6.1-sol", 2), model: "openai-codex/gpt-6.1-sol" };
	const derived = { ...base, model: `${base.model}-fast`, fastRouteOf: base.model };
	const independent = { ...base, model: "user-proxy/gpt-6.1-sol-fast" };
	const task = needs("hard", "high");
	const ranked = rankCandidates(sol, [base, derived, independent], task);
	const owned = ranked.find((candidate) => candidate.model === independent.model)!;
	const standard = ranked.find((candidate) => candidate.model === base.model)!;
	const fast = ranked.find((candidate) => candidate.model === derived.model)!;
	assert.equal(owned.values.size, 0);
	assert.equal(owned.conditions.size, 0);
	assert.equal(owned.released, undefined);
	assert.equal(owned.workStanding, undefined);
	assert.equal(owned.overallStanding, undefined);
	assert.ok(owned.score < standard.score);
	assert.equal(standard.values.get("aa:idx"), 51.8);
	assert.deepEqual(fast.values, standard.values);
	assert.deepEqual(fast.conditions, standard.conditions);
	assert.equal(fast.score, standard.score);
	assert.equal(distinctTop(ranked, 6).length, 2);
	const exact = rankCandidates(sol, [model("grok-4-fast", 2), model("grok-4", 2)], task);
	assert.equal(exact.find((candidate) => candidate.model === "p/grok-4-fast")!.values.get("aa:idx"), 17.9);
	assert.equal(exact.find((candidate) => candidate.model === "p/grok-4")!.values.get("aa:idx"), 22.5);
	const description = JSON.parse(describeOption(owned, task, ranked));
	assert.equal(description.route, undefined);
});

test("each option describes itself with this kind of work's results, standings among benchmarked models, price and release", () => {
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
		coding: "top 10% of models with the same benchmark and source (Terminal-Bench 4.0 60%)",
		overall: "top 10% of models with the same benchmark and source (AA Intelligence Index 60)",
	});
	const old = JSON.parse(describeOption(ranked.find((c) => c.model === "p/old")!, needs("hard", "high"), ranked));
	assert.equal(old.released, "2025-09-01, 13 months older than the newest");
	assert.equal(old.coding, "bottom quarter of models with the same benchmark and source (Terminal-Bench 4.0 10%)");
});

test("a model's standing is the same however few other models are eligible", () => {
	const standings = (eligible: readonly CandidateModel[]) =>
		rankCandidates(catalog, eligible, needs("hard", "high"))
			.map((candidate) => [candidate.model, candidate.workStanding, candidate.overallStanding])
			.sort();
	const all = standings(models);
	for (const subset of [models.slice(0, 3), [models[0]!, models[2]!], [models[2]!]])
		assert.deepEqual(
			standings(subset),
			all.filter(([id]) => subset.some((candidate) => candidate.model === id)),
		);
});

test("with two eligible models a demanding task still ranks the better-benchmarked model first", () => {
	const ranked = rankCandidates(catalog, [model("strong", 10), model("cheap", 0.1)], needs("very_hard", "severe"));
	assert.equal(ranked[0]?.model, "p/strong");
	const option = JSON.parse(describeOption(ranked[1]!, needs("very_hard", "severe"), ranked));
	assert.equal(option.coding, "below median of models with the same benchmark and source (Terminal-Bench 4.0 12%)");
});

test("results shared by fewer than four benchmarked models are quoted without a standing", () => {
	const sparse = parseEvalsCatalog(
		[
			"# Evals",
			"",
			"## Artificial Analysis Intelligence Index",
			"",
			"| slug | Model | Release date | idx | TB4 |",
			"| --- | --- | --- | ---: | ---: |",
			"| strong | Strong | 2026-09-20 | 60 | 60 |",
			"| middle | Middle | 2026-09-01 | 50 | 40 |",
			"| cheap | Cheap | 2026-09-20 | 35 | 12 |",
		].join("\n"),
	);
	const ranked = rankCandidates(sparse, models.slice(0, 3), needs("hard", "high"));
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

test("provider copies, fast routes and effort rows of one model count once in standings and the minimum", () => {
	const efforts = parseEvalsCatalog(
		[
			"# Evals",
			"",
			"## Artificial Analysis Intelligence Index",
			"",
			"| slug | Model | Release date | idx | TB4 |",
			"| --- | --- | --- | ---: | ---: |",
			"| strong-high | Strong (high) | 2026-09-20 | 58 | 55 |",
			"| strong | Strong (max) | 2026-09-20 | 60 | 60 |",
			"| middle | Middle | 2026-09-01 | 50 | 40 |",
			"| cheap | Cheap | 2026-09-20 | 35 | 12 |",
		].join("\n"),
	);
	const three = [model("strong", 10), model("middle", 2), model("cheap", 0.1)];
	const duplicated = [
		...three,
		{ ...model("strong", 10), model: "q/strong" },
		{ ...model("strong-fast", 10), fastRouteOf: "p/strong" },
	];
	const ranked = rankCandidates(efforts, duplicated, needs("hard", "high"));
	const cheap = JSON.parse(describeOption(ranked.find((c) => c.model === "p/cheap")!, needs("hard", "high"), ranked));
	assert.match(cheap.coding, /^measured \(/u, "three distinct catalog models are too few for a standing");
	const withFourth = rankCandidates(catalog, duplicated, needs("hard", "high"));
	assert.deepEqual(
		withFourth.filter((c) => c.baseKey === "strong").map((c) => c.workStanding),
		[1, 1, 1],
		"every route of one model shares its standing",
	);
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
	const d = JSON.parse(describeOption(ranked.find((candidate) => candidate.model === "p/d")!, science, ranked));
	assert.match(d.math_science, /^top 10% of models with the same benchmark and source \(/u);
});

test("vendor DeepSWE evidence informs coding choices without borrowing another reporter's standing", () => {
	const measured = parseEvalsCatalog(
		[
			"# Evals",
			"",
			"## Published benchmark results",
			"",
			"| slug | Model | Benchmark | Score | Setting | Source |",
			"| --- | --- | --- | ---: | --- | --- |",
			"| gpt-6-1-sol-high | GPT-6.1 Sol | DSWE | 75.2 | high effort; v1.1; harness not stated | OpenAI |",
			...["a", "b", "c", "d"].map(
				(id, index) => `| ${id} | ${id} | DSWE | ${80 + index} | independent harness | Datacurve |`,
			),
		].join("\n"),
	);
	const ranked = rankCandidates(measured, [model("gpt-6.1-sol", 2)], needs("hard", "high"));
	const option = JSON.parse(describeOption(ranked[0]!, needs("hard", "high"), ranked));
	assert.equal(
		option.coding,
		"measured (DeepSWE 75.2% measured with high effort, v1.1, harness not stated, reported by OpenAI)",
	);
	assert.equal(ranked[0]!.workStanding, undefined);
});

test("shipped Sol 6.1 rankings retain effort, unknown metrics and independent science reporters", async () => {
	const document = await readText(
		fileURLToPath(new URL("../../packages/coding-agent/docs/models/evals.md", import.meta.url)),
	);
	const ranked = rankCandidates(parseEvalsCatalog(document), [model("gpt-6.1-sol", 2)], needs("hard", "high"));
	const sol = ranked[0]!;
	assert.equal(sol.values.get("aa:idx"), 51.8);
	assert.equal(sol.conditions.get("aa:idx"), "max effort");
	assert.equal(sol.values.get("fc:Main"), 50.2);
	assert.equal(sol.conditions.get("fc:Main"), "medium effort");
	assert.equal(sol.values.get("pub:DSWE@OpenAI"), 75.2);
	assert.match(sol.conditions.get("pub:DSWE@OpenAI")!, /high effort.*reported by OpenAI/u);
	assert.equal(sol.values.get("pub:TBSci@Artificial Analysis"), 58.1);
	assert.match(
		sol.conditions.get("pub:TBSci@Artificial Analysis")!,
		/mini-swe-agent.*reported by Artificial Analysis/u,
	);
	assert.equal(sol.values.get("pub:TBSci@OpenAI"), 57);
	assert.equal(sol.values.has("aa:GPQA"), false);
	assert.equal(sol.values.has("dswe:Pass@1"), false);
	assert.equal(sol.values.has("pub:ARC3@ARC Prize"), false);
});
