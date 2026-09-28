import assert from "node:assert/strict";
import { test } from "vitest";
import {
	candidateReleaseDate,
	catalogEvidence,
	filterModelSelectionEvals,
	MODEL_SELECTION_EVALS_JSON_BYTES,
	modelEvidenceTokens,
	parseEvalsCatalog,
} from "../../packages/coding-agent/src/core/model-routing-evals.js";

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
	assert.deepEqual(rowsFor(["vercel-ai-gateway/openai/gpt-5.4-fast"]), ["gpt-5-4"]);
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
