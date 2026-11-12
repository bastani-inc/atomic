import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@bastani/pi-ai";
import { getBuiltinModels } from "@bastani/pi-ai/providers/all";
import { test } from "vitest";
import { routingCandidate } from "../../packages/coding-agent/src/core/execution-model-router.js";
import { deriveFastModelVariants } from "../../packages/coding-agent/src/core/fast-model-variants.js";
import { distinctTop, rankCandidates } from "../../packages/coding-agent/src/core/model-routing-candidates.js";
import { parseEvalsCatalog } from "../../packages/coding-agent/src/core/model-routing-evals.js";
import type { ResolvedTaskNeeds } from "../../packages/coding-agent/src/core/model-routing-needs.js";
import { readText } from "../helpers/runtime.js";

/**
 * A user's routed candidates from a recorded `routerSelection.candidates`: four
 * configured providers, each an alias of a builtin one, priced from the
 * builtin model data with derived fast routes.
 */
const CONFIGURED: Readonly<
	Record<string, { builtin: "anthropic" | "github-copilot" | "openai"; ids: readonly string[] }>
> = {
	"anthropic-api": {
		builtin: "anthropic",
		ids: [
			"claude-fable-5",
			"claude-fable-5-1",
			"claude-fable-5-2",
			"claude-haiku-4-5",
			"claude-haiku-5-5",
			"claude-opus-4-5",
			"claude-opus-4-6",
			"claude-opus-4-7",
			"claude-opus-4-8",
			"claude-opus-4-8-fast",
			"claude-opus-5",
			"claude-opus-5-fast",
			"claude-opus-5-5",
			"claude-opus-5-5-fast",
			"claude-sonnet-4-5",
			"claude-sonnet-4-6",
			"claude-sonnet-5",
			"claude-sonnet-5-5",
		],
	},
	"github-copilot": {
		builtin: "github-copilot",
		ids: [
			"claude-haiku-4.5",
			"claude-haiku-5.5",
			"claude-opus-5",
			"claude-opus-5.5",
			"claude-sonnet-4.6",
			"claude-sonnet-5",
			"claude-sonnet-5.5",
			"gemini-3.8-flash",
			"gemini-4-argon",
			"gemini-4-carbon",
			"gpt-5.3-codex",
			"gpt-5.6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-6-astra",
			"gpt-6-luna",
			"gpt-6-sol",
			"gpt-6.1-sol",
			"gpt-6.1-terra",
			"grok-4.6",
			"grok-4.7",
			"claude-opus-4.6",
			"gpt-5.6-sol-fast",
			"gpt-6.1-sol-fast",
		],
	},
	"github-copilot-2": {
		builtin: "github-copilot",
		ids: [
			"claude-haiku-4.5",
			"claude-haiku-5.5",
			"claude-opus-5.5",
			"claude-sonnet-5",
			"claude-sonnet-5.5",
			"gemini-3.8-flash",
			"gemini-4-argon",
			"gemini-4-carbon",
			"gpt-5.3-codex",
			"gpt-5.6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-6-astra",
			"gpt-6-luna",
			"gpt-6-sol",
			"gpt-6.1-sol",
			"gpt-6.1-terra",
			"grok-4.6",
			"grok-4.7",
			"gpt-5.6-sol-fast",
		],
	},
	"openai-api": {
		builtin: "openai",
		ids: [
			"gpt-4",
			"gpt-4-turbo",
			"gpt-4.1",
			"gpt-4.1-fast",
			"gpt-4.1-mini",
			"gpt-4.1-mini-fast",
			"gpt-4.1-nano",
			"gpt-4.1-nano-fast",
			"gpt-4o",
			"gpt-4o-fast",
			"gpt-4o-mini",
			"gpt-4o-mini-fast",
			"gpt-5",
			"gpt-5-fast",
			"gpt-5-mini",
			"gpt-5-mini-fast",
			"gpt-5-nano",
			"gpt-5-pro",
			"gpt-5.1",
			"gpt-5.1-fast",
			"gpt-5.2",
			"gpt-5.2-fast",
			"gpt-5.2-pro",
			"gpt-5.3-codex",
			"gpt-5.4",
			"gpt-5.4-fast",
			"gpt-5.4-mini",
			"gpt-5.4-mini-fast",
			"gpt-5.4-nano",
			"gpt-5.4-pro",
			"gpt-5.5",
			"gpt-5.5-fast",
			"gpt-5.5-pro",
			"gpt-5.6-luna",
			"gpt-5.6-luna-fast",
			"gpt-5.6-sol",
			"gpt-5.6-sol-fast",
			"gpt-5.6-terra",
			"gpt-5.6-terra-fast",
			"gpt-6-astra",
			"gpt-6-astra-fast",
			"gpt-6-luna",
			"gpt-6-luna-fast",
			"gpt-6-sol",
			"gpt-6-sol-fast",
			"gpt-6.1-sol",
			"gpt-6.1-sol-fast",
			"gpt-6.1-terra",
			"gpt-6.1-terra-fast",
			"o1",
			"o1-pro",
			"o3",
			"o3-fast",
			"o3-mini",
			"o3-pro",
			"o4-mini",
			"o4-mini-fast",
		],
	},
};

function configuredCandidates() {
	return Object.entries(CONFIGURED).flatMap(([alias, { builtin, ids }]) => {
		const builtins = getBuiltinModels(builtin) as Model<Api>[];
		const copilotFast = ids.filter((id) => id.endsWith("-fast"));
		const { models } = deriveFastModelVariants(builtin, builtins, { copilotFastModelIds: copilotFast });
		const wanted = new Set(ids);
		const found = models.filter((model) => wanted.has(model.id));
		return found.map((model) =>
			routingCandidate({
				...model,
				provider: alias,
				...(model.fastRoute ? { fastRoute: model.fastRoute } : {}),
			} as Model<Api>),
		);
	});
}

const task = (
	work: ResolvedTaskNeeds["work"],
	difficulty: ResolvedTaskNeeds["difficulty"],
	mistakeCost: ResolvedTaskNeeds["mistakeCost"],
	latencySensitive = false,
): ResolvedTaskNeeds => ({ work, difficulty, mistakeCost, needsImages: false, longContext: false, latencySensitive });

const evals = async () =>
	parseEvalsCatalog(
		await readText(fileURLToPath(new URL("../../packages/coding-agent/docs/models/evals.md", import.meta.url))),
	);

const base = (model: string) => model.slice(model.indexOf("/") + 1).replace(/[.]/gu, "-");

test("with a user's real catalog prices, models with long-task evidence lead hard coding and review (#4689)", async () => {
	const catalog = await evals();
	const candidates = configuredCandidates();
	assert.ok(candidates.length > 100, "every configured candidate resolves from the builtin model data");
	for (const needs of [
		task("coding", "hard", "high"),
		task("coding", "very_hard", "high"),
		task("code_review", "hard", "high"),
	]) {
		const ranked = rankCandidates(catalog, candidates, needs);
		const firstWithout = ranked.findIndex((candidate) => !candidate.longTaskEvidence);
		assert.ok(firstWithout > 0, "some candidates have long-task evidence and some do not");
		assert.ok(
			ranked.slice(firstWithout).every((candidate) => !candidate.longTaskEvidence),
			`${needs.difficulty} ${needs.work}: every model with long-task evidence ranks ahead of every model without`,
		);
		assert.ok(ranked.slice(firstWithout).some((candidate) => base(candidate.model) === "gemini-4-carbon"));
	}
});

test("with a user's real catalog prices, very hard coding's top four are Opus 5.5, Fable 5.2, GPT-6.1 Sol and GPT-6 Astra (#4689)", async () => {
	const top = distinctTop(
		rankCandidates(await evals(), configuredCandidates(), task("coding", "very_hard", "high")),
		4,
	);
	assert.deepEqual(top.map((candidate) => base(candidate.model)).sort(), [
		"claude-fable-5-2",
		"claude-opus-5-5",
		"gpt-6-1-sol",
		"gpt-6-astra",
	]);
});

test("with a user's real catalog prices, easy and latency-sensitive tasks still prefer cheaper models (#4689)", async () => {
	const catalog = await evals();
	const candidates = configuredCandidates();
	const price = (model: string) => {
		const candidate = candidates.find((entry) => entry.model === model)!;
		return (3 * candidate.cost.input + candidate.cost.output) / 4;
	};
	const hard = distinctTop(rankCandidates(catalog, candidates, task("coding", "hard", "high")), 1)[0]!;
	for (const needs of [task("coding", "easy", "low"), task("codebase_lookup", "trivial", "negligible", true)]) {
		const first = distinctTop(rankCandidates(catalog, candidates, needs), 1)[0]!;
		assert.ok(price(first.model) < price(hard.model), `${needs.work} ${needs.difficulty} prefers ${first.model}`);
	}
});
