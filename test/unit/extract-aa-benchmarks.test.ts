import assert from "node:assert/strict";
import { test } from "vitest";
import { maintainedSections, renderCatalog } from "../../scripts/extract-aa-benchmarks.ts";

const leaderboard = [
	'1:{"models":[{"slug":"claude-opus-4-6","name":"Claude Opus 4.6","deprecated":false,"releaseDate":"2026-01-02"},{"slug":"gpt-test","name":"GPT Test","releaseDate":"2026-01-03"}]}',
	'2:{"host":{"model":{"slug":"claude-opus-4-6","intelligenceIndex":42.36,"omniscience":-12.34,"omniscienceAccuracy":0.8765,"briefcase":{"elo":520},"gdpvalNormalized":0.673085,"gpqa":"$fe","tau2":"$undefined"}}}',
	"fe:0.75",
].join("\n");
const index =
	'3:{"rows":[{"slug":"claude-opus-4-6","gdpPdfAllPass":0.262,"opennessIndex":33.3333,"enterpriseOpsGym":null}]}';

function cells(catalog: string, slug: string): Record<string, string> {
	const lines = catalog.split("\n");
	const header = lines
		.find((line) => line.startsWith("| slug |"))!
		.split("|")
		.map((cell) => cell.trim());
	const row = lines
		.find((line) => line.startsWith(`| ${slug} |`))!
		.split("|")
		.map((cell) => cell.trim());
	return Object.fromEntries(header.map((name, i) => [name, row[i]!]));
}

test("renders every listed model with explicit units and ∅ for absent values", () => {
	const catalog = renderCatalog({ leaderboard, index, accessed: "2026-09-25" });
	assert.equal(renderCatalog({ leaderboard, index, accessed: "2026-09-25" }), catalog);
	assert.match(catalog, /^Last Accessed: 2026-09-25\.$/mu);
	assert.match(catalog, /all 2 models on the Artificial Analysis leaderboard/u);

	const claude = cells(catalog, "claude-opus-4-6");
	assert.equal(claude["Release date"], "2026-01-02");
	assert.equal(claude.idx, "42.4");
	assert.equal(claude.Omni, "-12.3");
	assert.equal(claude.OA, "87.7");
	assert.equal(claude.GPQA, "75");
	assert.equal(claude.Brief, "1", "Elo 520 normalizes to 1, not 100");
	assert.equal(claude.Gn, "67.3");
	assert.equal(claude.PDF, "26.2");
	assert.equal(claude.Open, "33.3");
	assert.equal(claude.Ent, "∅");
	assert.equal(claude.tau2, "∅");

	assert.equal(cells(catalog, "gpt-test").idx, "∅");
	assert.ok(!catalog.includes("$undefined"));
});

test("names columns with no source values instead of implying zero", () => {
	const catalog = renderCatalog({ leaderboard, accessed: "2026-09-25" });
	assert.match(catalog, /`PDF`.*have no values in the public payloads/u);
	assert.equal(cells(catalog, "claude-opus-4-6").PDF, "∅");
});

test("fails loudly when the leaderboard stream has no models array", () => {
	assert.throws(() => renderCatalog({ leaderboard: '1:{"host":{}}', accessed: "2026-09-25" }), /models array/u);
});

test("regenerating the Artificial Analysis table keeps the maintained sections below it", () => {
	const existing = [
		"# Evals",
		"",
		"## Artificial Analysis Intelligence Index v4.3.2",
		"",
		"| slug | Model |",
		"| --- | --- |",
		"| old | Old |",
		"",
		"## DeepSWE v1.1",
		"",
		"| slug | Model | Pass@1 |",
		"",
	].join("\n");
	assert.equal(maintainedSections(existing), "## DeepSWE v1.1\n\n| slug | Model | Pass@1 |\n");
	assert.equal(maintainedSections("# Evals\n\n## Artificial Analysis Intelligence Index v4.3.2\n| slug |"), "");
});
