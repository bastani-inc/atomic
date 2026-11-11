import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { type CandidateModel, rankCandidates } from "../../packages/coding-agent/src/core/model-routing-candidates.js";
import {
	candidateEvidenceRows,
	candidateReleaseDate,
	catalogEvidence,
	filterModelSelectionEvals,
	MODEL_SELECTION_EVALS_JSON_BYTES,
	modelEvidenceTokens,
	parseEvalsCatalog,
} from "../../packages/coding-agent/src/core/model-routing-evals.js";
import type { ResolvedTaskNeeds } from "../../packages/coding-agent/src/core/model-routing-needs.js";
import { readText } from "../helpers/runtime.js";

const slugs = [
	"claude-opus-4-6",
	"claude-opus-4-6-adaptive",
	"claude-opus-5-5",
	"claude-opus-5-5-xhigh",
	"claude-opus-5",
	"claude-4-5-sonnet",
	"claude-4-5-sonnet-thinking",
	"claude-sonnet-4-6-non-reasoning-low-effort",
	"gpt-5-5",
	"gpt-5-5-high",
	"gpt-5-5-pro",
	"gpt-5-5-mini",
	"gpt-5-4",
	"grok-4-1",
	"grok-4-1-fast",
	"grok-4-6",
	"gemini-3-1-flash-lite-preview",
	"gemini-3-5-flash-lite",
	"qwen3-8-max",
	"qwen3-8-max-0803",
	"gpt-oss-120b",
	"qwen3-32b-instruct",
	"qwen3-next-80b-a3b-reasoning",
	"minimax-m2-7",
	"gemma-3-27b",
	"glm-5-3",
];
const evals = [
	"# Evals",
	"",
	"| slug | Model |",
	"| --- | --- |",
	...slugs.map((slug) => `| ${slug} | ${slug} |`),
].join("\n");

function rowsFor(candidates: readonly string[]): string[] {
	return filterModelSelectionEvals(evals, candidates)
		.split("\n")
		.slice(4)
		.map((line) => line.split("|")[1]!.trim());
}

test("provider catalog IDs normalize to the same model tokens", () => {
	const expected = ["claude", "4", "6", "opus"];
	for (const id of [
		"anthropic/claude-opus-4-6",
		"claude-opus-4.6",
		"openrouter/anthropic/claude-opus-4.6:batch",
		"amazon-bedrock/global.anthropic.claude-opus-4-6-v1",
		"amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
		"eu.anthropic.claude-opus-4-6-v1",
	])
		assert.deepEqual(modelEvidenceTokens(id), expected, id);
	assert.deepEqual(modelEvidenceTokens("anthropic.claude-opus-4-5-20251101-v1:0"), ["claude", "4", "5", "opus"]);
});

test("a candidate receives its own row and every effort variant of it", () => {
	assert.deepEqual(rowsFor(["anthropic/claude-opus-4-6"]), ["claude-opus-4-6", "claude-opus-4-6-adaptive"]);
	assert.deepEqual(rowsFor(["github-copilot/claude-opus-5.5"]), ["claude-opus-5-5", "claude-opus-5-5-xhigh"]);
	assert.deepEqual(rowsFor(["openai/gpt-5.5"]), ["gpt-5-5", "gpt-5-5-high"]);
});

test("Artificial Analysis version-first Claude slugs match catalog family-first IDs", () => {
	assert.deepEqual(rowsFor(["anthropic/claude-sonnet-4-5"]), ["claude-4-5-sonnet", "claude-4-5-sonnet-thinking"]);
	assert.deepEqual(rowsFor(["anthropic/claude-sonnet-4-6"]), ["claude-sonnet-4-6-non-reasoning-low-effort"]);
});

test("deployment and snapshot suffixes fall back to the base model only when the exact model has no row", () => {
	assert.deepEqual(rowsFor(["vercel-ai-gateway/openai/gpt-5.4-fast"]), []);
	assert.deepEqual(rowsFor(["spacexai/grok-4.1-fast"]), ["grok-4-1-fast"]);
	assert.deepEqual(rowsFor(["vercel-ai-gateway/alibaba/qwen3.8-max-0902"]), ["qwen3-8-max", "qwen3-8-max-0803"]);
	assert.deepEqual(rowsFor(["google/gemini-3.1-flash-lite"]), ["gemini-3-1-flash-lite-preview"]);
});

test("any Bedrock vendor or region prefix is removed", () => {
	assert.deepEqual(rowsFor(["amazon-bedrock/us.xai.grok-4.6"]), ["grok-4-6"]);
	assert.deepEqual(rowsFor(["amazon-bedrock/in.openai.gpt-5.4"]), ["gpt-5-4"]);
	assert.deepEqual(rowsFor(["amazon-bedrock/openai.gpt-oss-120b-1:0"]), ["gpt-oss-120b"]);
});

test("catalog naming conventions resolve to Artificial Analysis rows", () => {
	assert.deepEqual(rowsFor(["vercel-ai-gateway/alibaba/qwen3-next-80b-a3b-thinking"]), [
		"qwen3-next-80b-a3b-reasoning",
	]);
	assert.deepEqual(rowsFor(["amazon-bedrock/qwen.qwen3-32b-v1:0"]), ["qwen3-32b-instruct"]);
	assert.deepEqual(rowsFor(["minimax/minimax-m2.7-highspeed"]), ["minimax-m2-7"]);
	assert.deepEqual(rowsFor(["google/gemma-3-27b-it"]), ["gemma-3-27b"]);
});

test("a shorter version or a different product line never borrows another model's evidence", () => {
	assert.deepEqual(rowsFor(["anthropic/claude-opus-5"]), ["claude-opus-5"]);
	assert.deepEqual(rowsFor(["openai/gpt-5.5-pro"]), ["gpt-5-5-pro"]);
	assert.deepEqual(rowsFor(["anthropic/claude-haiku-4-5"]), []);
	assert.deepEqual(rowsFor(["anthropic/claude-opus-4-8"]), [], "a neighbouring version is not evidence");
	assert.deepEqual(rowsFor(["google/gemini-3.1-flash-lite"]).includes("gemini-3-5-flash-lite"), false);
	assert.deepEqual(rowsFor(["zai/glm-5.3-flashx"]), [], "a differently named sibling is not a suffix variant");
});

test("filtered evidence keeps the preamble and stays within the routing budget", () => {
	const filtered = filterModelSelectionEvals(evals, ["anthropic/claude-opus-4-6"]);
	assert.ok(filtered.startsWith("# Evals\n\n| slug | Model |\n| --- | --- |\n"));
	const oversized = `${"legend ".repeat(5_000)}\n| slug | Model |\n| --- | --- |\n| claude-opus-4-6 | x |`;
	assert.ok(
		Buffer.byteLength(JSON.stringify(filterModelSelectionEvals(oversized, ["claude-opus-4-6"])), "utf8") <=
			MODEL_SELECTION_EVALS_JSON_BYTES,
	);
});

test("each section contributes its own key and only the rows of the requested candidates", () => {
	const document = [
		"# Evals",
		"",
		"## Artificial Analysis",
		"",
		"| slug | Model | Release date |",
		"| --- | --- | --- |",
		"| claude-opus-5-5 | Claude Opus 5.5 | 2026-09-22 |",
		"| gpt-6-astra | GPT-6 Astra | 2026-09-03 |",
		"",
		"## DeepSWE v1.1",
		"",
		"Key:",
		"",
		"- DeepSWE: long-horizon software engineering.",
		"",
		"| slug | Model | Pass@1 |",
		"| --- | --- | ---: |",
		"| gpt-6-astra | gpt-6-astra | 74 |",
		"",
		"## FrontierCode 1.1",
		"",
		"| slug | Model | Main |",
		"| --- | --- | ---: |",
		"| gemini-3-8-flash | Gemini 3.8 Flash | 41.2 |",
	].join("\n");
	const catalog = parseEvalsCatalog(document);
	const astra = catalogEvidence(catalog, ["openai/gpt-6-astra"]);
	assert.match(astra, /^\| gpt-6-astra \| GPT-6 Astra \| 2026-09-03 \|$/mu);
	assert.match(
		astra,
		/## DeepSWE v1\.1\n\nKey:\n\n- DeepSWE: long-horizon software engineering\.\n\n\| slug \| Model \| Pass@1 \|/u,
	);
	assert.match(astra, /^\| gpt-6-astra \| gpt-6-astra \| 74 \|$/mu);
	assert.doesNotMatch(astra, /FrontierCode|claude-opus-5-5/u);
	assert.equal(candidateReleaseDate(catalog, "github-copilot/claude-opus-5.5"), "2026-09-22");
	assert.equal(candidateReleaseDate(catalog, "google/gemini-3.8-flash"), undefined);
});

test("an exact snapshot row in one section does not hide the base model's rows in another", () => {
	const catalog = parseEvalsCatalog(
		[
			"# Evals",
			"",
			"## Artificial Analysis",
			"",
			"| slug | Model | Release date |",
			"| --- | --- | --- |",
			"| deepseek-v4-pro | DeepSeek V4 Pro | 2026-08-13 |",
			"",
			"## FrontierCode 1.1",
			"",
			"| slug | Model | Main |",
			"| --- | --- | ---: |",
			"| deepseek-v4-pro-0813 | DeepSeek V4 Pro 0813 | 40.1 |",
		].join("\n"),
	);
	const evidence = catalogEvidence(catalog, ["deepseek/deepseek-v4-pro-0813"]);
	assert.match(evidence, /^\| deepseek-v4-pro \| DeepSeek V4 Pro \| 2026-08-13 \|$/mu);
	assert.match(evidence, /^\| deepseek-v4-pro-0813 \| DeepSeek V4 Pro 0813 \| 40\.1 \|$/mu);
	assert.equal(candidateReleaseDate(catalog, "deepseek/deepseek-v4-pro-0813"), "2026-08-13");
});

test("shipped Sol 6.1 evidence preserves measured efforts and isolates neighboring identities", async () => {
	const document = await readText(
		fileURLToPath(new URL("../../packages/coding-agent/docs/models/evals.md", import.meta.url)),
	);
	const catalog = parseEvalsCatalog(document);
	for (const id of ["openai/gpt-6.1-sol", "openai-codex/gpt-6.1-sol", "openrouter/openai/gpt-6.1-sol"]) {
		const evidence = catalogEvidence(catalog, [id]);
		assert.equal(candidateReleaseDate(catalog, id), "2026-09-29");
		for (const effort of ["low", "medium", "high", "xhigh", "max"])
			assert.match(evidence, new RegExp(`GPT-6\\.1 Sol \\(${effort}\\)`));
		assert.match(evidence, /GPT-6\.1 Sol \| medium \| 50\.2 \| 55\.8 \| 60\.4/u);
		assert.doesNotMatch(evidence, /^\| (?:gpt-6-sol|gpt-5-6-sol|gpt-6-luna|gpt-6-mini)(?:[- |])/mu);
		assert.doesNotMatch(evidence, /^\|[^\n]*(?:minimal|Sol-fast)/mu);
		const bounded = filterModelSelectionEvals(document, [id]);
		assert.match(bounded, /GPT-6\.1 Sol/u);
		assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= MODEL_SELECTION_EVALS_JSON_BYTES);
	}
	for (const id of [
		"openai/gpt-6-sol",
		"openai/gpt-5.6-sol",
		"openai/gpt-6-luna",
		"openai/gpt-6-mini",
		"user-proxy/gpt-6.1-sol-fast",
		"openai-codex/gpt-6.1-sol-fast",
	]) {
		assert.doesNotMatch(catalogEvidence(catalog, [id]), /^\| gpt-6-1-sol/mu, id);
		if (id.endsWith("-fast")) assert.equal(candidateReleaseDate(catalog, id), undefined, id);
	}
});

test("shipped Gemini 4 Argon evidence reaches Copilot routing without Gemini 3.x rows", async () => {
	const document = await readText(
		fileURLToPath(new URL("../../packages/coding-agent/docs/models/evals.md", import.meta.url)),
	);
	const catalog = parseEvalsCatalog(document);
	const id = "github-copilot/gemini-4-argon";
	const bounded = filterModelSelectionEvals(document, [id]);
	const full = catalogEvidence(catalog, [id]);
	for (const evidence of [bounded, full]) {
		assert.match(evidence, /^\| gemini-4-argon \| Gemini 4 Argon \(high\) \| 2026-09-30 \|/mu);
		assert.match(evidence, /^\| gemini-4-argon \| Gemini 4 Argon \| medium \| 47\.6 \| 52\.8 \| 60\.5 \| 66\.1 \|/mu);
		assert.doesNotMatch(evidence, /^\| gemini-(?!4-argon(?:-medium|-low)? \|)/mu);
	}
	assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= MODEL_SELECTION_EVALS_JSON_BYTES);
	assert.match(
		full,
		/^\| gemini-4-argon \| Gemini 4 Argon \| DSWE \| 77\.9 \|[^\n]*Google-reported[^\n]*\| Google \|$/mu,
	);
	assert.match(full, /^\| gemini-4-argon-medium \| Gemini 4 Argon \| ABench \| 50\.1 \|/mu);
	assert.equal(candidateReleaseDate(catalog, id), "2026-09-30");
});

const geminiNeeds = (work: ResolvedTaskNeeds["work"]): ResolvedTaskNeeds => ({
	work,
	difficulty: "hard",
	mistakeCost: "high",
	needsImages: false,
	longContext: false,
	latencySensitive: false,
});

const copilotCandidate = (id: string): CandidateModel => ({
	model: id,
	name: id,
	cost: { input: 4, output: 20 },
	input: ["text", "image"],
});

test("shipped Gemini 4 Carbon evidence reaches Copilot routing without Argon or Gemini 3.x rows", async () => {
	const document = await readText(
		fileURLToPath(new URL("../../packages/coding-agent/docs/models/evals.md", import.meta.url)),
	);
	const catalog = parseEvalsCatalog(document);
	const id = "github-copilot/gemini-4-carbon";
	const slugsOf = (candidate: string) =>
		new Set(candidateEvidenceRows(catalog, candidate).map((row) => row.line.split(" | ")[0]!.slice(2)));
	assert.deepEqual(
		[...slugsOf(id)].sort(),
		["gemini-4-carbon", "gemini-4-carbon-low", "gemini-4-carbon-medium"],
		"the AA and published tables both resolve to Carbon slugs only",
	);
	assert.deepEqual(
		[...slugsOf("github-copilot/gemini-4-argon")].sort(),
		["gemini-4-argon", "gemini-4-argon-low", "gemini-4-argon-medium"],
		"Argon evidence never borrows Carbon rows",
	);
	const bounded = filterModelSelectionEvals(document, [id]);
	const full = catalogEvidence(catalog, [id]);
	for (const effort of ["high", "medium", "low"])
		for (const evidence of [bounded, full])
			assert.match(
				evidence,
				new RegExp(
					`^\\| gemini-4-carbon(?:-${effort})? \\| Gemini 4 Carbon \\(${effort}\\) \\| 2026-10-28 \\|`,
					"mu",
				),
				`${effort} AA row`,
			);
	assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= MODEL_SELECTION_EVALS_JSON_BYTES);
	assert.match(full, /^\| gemini-4-carbon \| Gemini 4 Carbon \| VALS \| 70\.4 \| v2\.2[^\n]*\| Google \|$/mu);
	assert.match(full, /^\| gemini-4-carbon-low \| Gemini 4 Carbon \| ABench \| 31\.5 \|/mu);
	assert.match(full, /^\| gemini-4-carbon-medium \| Gemini 4 Carbon \| ARC3 \| 99\.1 \|/mu);
	assert.doesNotMatch(full, /^\| gemini-(?!4-carbon(?:-medium|-low)? \|)/mu);
	assert.equal(candidateReleaseDate(catalog, id), "2026-10-28");

	const [carbon] = rankCandidates(catalog, [copilotCandidate(id)], geminiNeeds("coding"));
	assert.equal(carbon?.released, "2026-10-28");
	assert.equal(carbon?.values.get("aa:TB4"), 65.2);
	assert.equal(carbon?.values.get("aa:Brief"), 55.5);
	assert.equal(carbon?.values.get("pub:ABench@Zapier"), 53.9);
	assert.equal(carbon?.values.get("pub:TBSci@Artificial Analysis"), 64.8);
	assert.equal(carbon?.values.get("pub:SECPro@Google"), 88.2);
	assert.equal(carbon?.conditions.get("aa:TB4"), "high effort");
});

test("shipped Gemini 4 Argon evidence carries the recheck, the newer Google-reported versions and ARC Prize rows", async () => {
	const document = await readText(
		fileURLToPath(new URL("../../packages/coding-agent/docs/models/evals.md", import.meta.url)),
	);
	const catalog = parseEvalsCatalog(document);
	const id = "github-copilot/gemini-4-argon";
	const full = catalogEvidence(catalog, [id]);
	assert.match(
		full,
		/^\| gemini-4-argon \| Gemini 4 Argon \(high\) \| 2026-09-30 \| ∅ \| 49\.2 \| 56\.5 \| 77\.5 \| 57\.1 \| 61\.8 \| 57\.1 \| 21\.8 \| 27\.1 \|/mu,
	);
	assert.match(full, /^\| gemini-4-argon \| Gemini 4 Argon \| VALS \| 69\.2 \| v2\.2[^\n]*\| Google \|$/mu);
	assert.match(full, /^\| gemini-4-argon \| Gemini 4 Argon \| OSW21 \| 74\.7 \|/mu);
	assert.match(
		full,
		/^\| gemini-4-argon-low \| Gemini 4 Argon \| ARC2 \| 42\.1 \| semi-private, low \| ARC Prize \|$/mu,
	);
	assert.doesNotMatch(full, /^\| gemini-4-carbon/mu);
	const [argon] = rankCandidates(catalog, [copilotCandidate(id)], geminiNeeds("coding"));
	assert.equal(argon?.values.get("aa:TB4"), 57.1);
	assert.equal(argon?.values.get("pub:SECPro@Google"), 83.4);
	assert.equal(argon?.values.get("pub:XGym@Google"), 42);
	assert.equal(argon?.values.get("pub:ALE@Google"), 69);
});

test("shipped Claude Fable 5.2 evidence reaches every catalog route without Fable 5.1 rows", async () => {
	const document = await readText(
		fileURLToPath(new URL("../../packages/coding-agent/docs/models/evals.md", import.meta.url)),
	);
	const catalog = parseEvalsCatalog(document);
	for (const id of [
		"anthropic/claude-fable-5-2",
		"openrouter/anthropic/claude-fable-5.2",
		"vercel-ai-gateway/anthropic/claude-fable-5.2",
	]) {
		const evidence = catalogEvidence(catalog, [id]);
		for (const effort of ["Max", "Xhigh", "High", "Medium", "Low"])
			assert.match(
				evidence,
				new RegExp(
					`^\\| claude-fable-5-2[a-z-]* \\| Claude Fable 5\\.2 \\(${effort}, Default Fallback\\) \\| 2026-11-09 \\|`,
					"mu",
				),
				`${id} ${effort}`,
			);
		assert.match(evidence, /^\| claude-fable-5-2 \| Claude Fable 5\.2 \| TB4 \| 67\.6 \|[^\n]*\| Anthropic \|$/mu);
		assert.doesNotMatch(evidence, /^\| claude-fable-5-1/mu, id);
		assert.equal(candidateReleaseDate(catalog, id), "2026-11-09", id);
	}
	assert.doesNotMatch(catalogEvidence(catalog, ["anthropic/claude-fable-5-1"]), /^\| claude-fable-5-2/mu);
});

test("shipped new-family AA evidence reaches the catalog routes that name each model", async () => {
	const document = await readText(
		fileURLToPath(new URL("../../packages/coding-agent/docs/models/evals.md", import.meta.url)),
	);
	const catalog = parseEvalsCatalog(document);
	const routes: ReadonlyArray<readonly [id: string, slug: string, releaseDate: string]> = [
		["moonshotai/kimi-k3.1-pro", "kimi-k3-1-pro", "2026-10-23"],
		["openrouter/meta/muse-wonder", "muse-wonder", "2026-10-12"],
		["openrouter/meta/muse-ember", "muse-ember", "2026-11-09"],
		["openrouter/meta/muse-spark-open", "muse-spark-open", "2026-10-15"],
		["minimax/MiniMax-M3.1-Flash", "minimax-m3-1-flash", "2026-10-19"],
		["xiaomi/mimo-v2.6-flash", "mimo-v2-6-flash", "2026-09-21"],
		["openrouter/inclusionai/ling-3.1-flash", "ling-3-1-flash", "2026-10-22"],
		["opencode/inkling-2-small-free", "inkling-2-small", "2026-11-05"],
		["mistral/mistral-large-4", "mistral-large-4", "2026-10-29"],
		["openrouter/nvidia/nemotron-3.5-super-vl", "nemotron-3-5-super-vl", "2026-10-15"],
		["openrouter/upstage/solar-mini4", "solar-mini4", "2026-09-22"],
		["openrouter/deepseek/deepseek-v4.1-flash-1017", "deepseek-v4-1-flash-1017", "2026-10-17"],
	];
	for (const [id, slug, releaseDate] of routes) {
		assert.match(catalogEvidence(catalog, [id]), new RegExp(`^\\| ${slug} \\|`, "mu"), id);
		assert.equal(candidateReleaseDate(catalog, id), releaseDate, id);
	}
});

test("DeepSeek V4.1 Flash 1017 IDs resolve to the 1017 rows, not the earlier V4.1 Flash rows", async () => {
	const document = await readText(
		fileURLToPath(new URL("../../packages/coding-agent/docs/models/evals.md", import.meta.url)),
	);
	const catalog = parseEvalsCatalog(document);
	for (const id of [
		"openrouter/deepseek/deepseek-v4.1-flash-1017",
		"vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017",
		"baseten/deepseek-ai/DeepSeek-V4.1-Flash-1017",
		"mistral/deepseek-v4-1-flash-1017",
	]) {
		const evidence = catalogEvidence(catalog, [id]);
		for (const slug of [
			"deepseek-v4-1-flash-1017",
			"deepseek-v4-1-flash-1017-high",
			"deepseek-v4-1-flash-1017-non-reasoning",
		])
			assert.match(evidence, new RegExp(`^\\| ${slug} \\|[^\\n]*\\| 2026-10-17 \\|`, "mu"), `${id} ${slug}`);
		assert.doesNotMatch(evidence, /^\| deepseek-v4-1-flash(?:-non-reasoning)? \|/mu, id);
		assert.equal(candidateReleaseDate(catalog, id), "2026-10-17", id);
	}
});
