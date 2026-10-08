import assert from "node:assert/strict";
import type { Api, ClassifierContext, ClassifierModel, ClassifierResult, Model } from "@bastani/pi-ai";
import { getBuiltinClassifierModel } from "@bastani/pi-ai/providers/all";
import { afterEach, test, vi } from "vitest";
import {
	AutoRoutingInferenceError,
	type ModelRoutingContext,
	routeExecutionModel,
} from "../../packages/coding-agent/src/core/execution-model-router.js";
import type {
	ModelConstraints,
	ModelRouterOutput,
} from "../../packages/coding-agent/src/core/model-routing-constraints.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { deepMergeSettings } from "../../packages/coding-agent/src/core/settings-merge.js";
import type { ModelRoutingSettings } from "../../packages/coding-agent/src/core/settings-types.js";
import { workflowModelCatalogFromContext } from "../../packages/workflows/src/extension/workflow-model-catalog.js";
import { chatRouter, classifierOptions, defaultClassifierChoice } from "../helpers/model-routing.js";

const jev = getBuiltinClassifierModel("typesafe", "jev-latest") as ClassifierModel<Api>;

afterEach(() => {
	vi.restoreAllMocks();
});

function chatModel(provider: string, id: string): Model<Api> {
	return {
		type: "chat",
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
	} as Model<Api>;
}

const models = [
	chatModel("github-copilot", "claude-opus-5.5"),
	chatModel("anthropic", "claude-fable-5-1"),
	chatModel("openrouter", "openai/gpt-6-astra"),
];

/** Every model a route can run: its primary plus ranked fallbacks. */
const routed = (result: Awaited<ReturnType<typeof routeExecutionModel>>) =>
	[result.routerSelection.model, ...(result.routerSelection.fallbacks ?? []).map((pair) => pair.model)].sort();

function routingContext(modelRouting?: ModelRoutingSettings) {
	const offered: string[][] = [];
	const ctx: ModelRoutingContext = {
		model: models[0],
		getRouterModel: () => "typesafe/jev-latest",
		...(modelRouting ? { getModelRouting: () => modelRouting } : {}),
		modelRegistry: {
			getAvailable: () => models,
			getAll: () => models,
			streamSimple: (model, context) => chatRouter()(model, context),
			containsConfiguredCredential: async () => false,
			getClassifierModel: (provider: string, id: string) =>
				`${provider}/${id}` === `${jev.provider}/${jev.id}` ? jev : undefined,
			classify: async (_model: ClassifierModel<Api>, context: ClassifierContext) => {
				const answers: ClassifierResult["answers"] = {};
				for (const [id, question] of Object.entries(context.questions)) {
					assert.ok(question.type === "choice");
					const keys = Object.keys(question.criteria);
					if (id === "model") offered.push(Object.values(classifierOptions(context)));
					answers[id] = {
						type: "choice",
						choice: defaultClassifierChoice(keys, id, context),
						probabilities: {},
						confidence: 1,
					};
				}
				return { api: jev.api, provider: jev.provider, model: jev.id, stopReason: "stop", timestamp: 0, answers };
			},
		},
	};
	return { ctx, offered };
}

const route = (ctx: ModelRoutingContext, constraints: ModelConstraints[] = [], overrideProviderSettings = false) =>
	routeExecutionModel({
		ctx,
		task: "Review the change",
		agent: { name: "reviewer", description: "Reviews code" },
		constraints,
		overrideProviderSettings,
	});

test("settings expose validated, de-duplicated modelRouting provider lists", () => {
	assert.deepEqual(SettingsManager.inMemory().getModelRouting(), {});
	assert.deepEqual(
		SettingsManager.inMemory({
			modelRouting: { allowedProviders: ["github-copilot", "github-copilot"], excludedProviders: ["openrouter"] },
		}).getModelRouting(),
		{ allowedProviders: ["github-copilot"], excludedProviders: ["openrouter"] },
	);
	for (const modelRouting of [
		{ allowedProviders: "github-copilot" },
		{ excludedProviders: [" openrouter"] },
		{ excludedProviders: [""] },
		["github-copilot"],
	])
		assert.throws(
			() => SettingsManager.inMemory({ modelRouting } as never).getModelRouting(),
			/Invalid modelRouting/u,
		);
});

test("a project list replaces the global list of the same name and keeps the other", () => {
	const merged = deepMergeSettings(
		{ modelRouting: { allowedProviders: ["github-copilot", "anthropic"], excludedProviders: ["openrouter"] } },
		{ modelRouting: { allowedProviders: ["anthropic"] } },
	);
	assert.deepEqual(merged.modelRouting, { allowedProviders: ["anthropic"], excludedProviders: ["openrouter"] });
});

test("without modelRouting every available provider is a candidate", async () => {
	const { ctx, offered } = routingContext();
	const result = await route(ctx);
	assert.deepEqual(offered[0]?.sort(), models.map((model) => `${model.provider}/${model.id}`).sort());
	assert.deepEqual(routed(result), models.map((model) => `${model.provider}/${model.id}`).sort());
});

test("excluded providers are never offered, even when they are allowed", async () => {
	const excluded = routingContext({ excludedProviders: ["openrouter", "anthropic"] });
	const result = await route(excluded.ctx);
	assert.deepEqual(routed(result), ["github-copilot/claude-opus-5.5"]);
	assert.deepEqual(excluded.offered, [], "a single eligible model needs no choice request");

	const both = routingContext({ allowedProviders: ["github-copilot", "anthropic"], excludedProviders: ["anthropic"] });
	assert.deepEqual(routed(await route(both.ctx)), ["github-copilot/claude-opus-5.5"]);
});

test("allowed providers restrict candidates to that list", async () => {
	const { ctx, offered } = routingContext({ allowedProviders: ["anthropic", "openrouter"] });
	const result = await route(ctx);
	assert.deepEqual(offered[0]?.sort(), ["anthropic/claude-fable-5-1", "openrouter/openai/gpt-6-astra"]);
	assert.deepEqual(routed(result), ["anthropic/claude-fable-5-1", "openrouter/openai/gpt-6-astra"]);
});

test("filters that leave no candidate name the modelRouting setting", async () => {
	const { ctx } = routingContext({ allowedProviders: ["openai-codex"] });
	await assert.rejects(route(ctx), /modelRouting allowedProviders\/excludedProviders/u);
});

test("a recorded decision from a provider excluded since then is no longer eligible on resume", async () => {
	const { ctx } = routingContext({ excludedProviders: ["anthropic"] });
	await assert.rejects(
		routeExecutionModel({
			ctx,
			task: "Review the change",
			agent: { name: "reviewer", description: "Reviews code" },
			selection: { model: "anthropic/claude-fable-5-1", effort: null },
		}),
		/no longer eligible/u,
	);
});

test("workflow stage routing applies the host's modelRouting providers", async () => {
	const { ctx } = routingContext();
	const catalog = workflowModelCatalogFromContext({
		...ctx,
		getModelRouting: () => ({ allowedProviders: ["github-copilot"] }),
	} as never);
	assert.ok(catalog?.routeModel);
	const result = await catalog.routeModel({ task: "Review the change", stageName: "review" } as never);
	assert.deepEqual(routed(result), ["github-copilot/claude-opus-5.5"]);
});

test("a call that sets provider lists replaces the settings lists for that call", async () => {
	const settings = { allowedProviders: ["anthropic"], excludedProviders: ["openrouter"] };
	const allowOverride = routingContext(settings);
	assert.deepEqual(
		routed(await route(allowOverride.ctx, [{ allowedProviders: ["openrouter", "github-copilot"] }], true)),
		["github-copilot/claude-opus-5.5", "openrouter/openai/gpt-6-astra"],
	);

	const excludeOverride = routingContext({
		allowedProviders: ["anthropic", "openrouter"],
		excludedProviders: ["openrouter"],
	});
	assert.deepEqual(
		routed(await route(excludeOverride.ctx, [{ excludedProviders: ["anthropic"] }], true)),
		["github-copilot/claude-opus-5.5", "openrouter/openai/gpt-6-astra"],
		"a call that sets any provider list replaces both settings lists",
	);
});

test("provider lists in modelConstraints work without any modelRouting setting", async () => {
	const { ctx } = routingContext();
	assert.deepEqual(routed(await route(ctx, [{ excludedProviders: ["openrouter", "github-copilot"] }])), [
		"anthropic/claude-fable-5-1",
	]);
	assert.deepEqual(routed(await route(ctx, [{ allowedProviders: ["github-copilot"] }])), [
		"github-copilot/claude-opus-5.5",
	]);
});

test("provider lists from an agent definition or workflow never lift the user's settings", async () => {
	const { ctx } = routingContext({ excludedProviders: ["openrouter"] });
	assert.deepEqual(
		routed(await route(ctx, [{ allowedProviders: ["openrouter", "anthropic"] }])),
		["anthropic/claude-fable-5-1"],
		"a definition-level allow list only narrows; the user's exclusion still applies",
	);
});

test("modelRouting.allowedModels limits the primary, fallbacks and offered models to matching full IDs and globs (#3528)", async () => {
	const { ctx, offered } = routingContext({
		allowedModels: ["*claude-fable*", "openrouter/openai/gpt-6-astra"],
	});
	const result = await route(ctx);
	assert.deepEqual(offered[0]?.sort(), ["anthropic/claude-fable-5-1", "openrouter/openai/gpt-6-astra"]);
	assert.deepEqual(routed(result), ["anthropic/claude-fable-5-1", "openrouter/openai/gpt-6-astra"]);
	assert.equal(result.allowsModel(models[0]!), false, "a gated-out model is never an execution fallback");
	assert.equal(result.allowsModel(models[1]!), true);
});

test("settings validate the modelRouting model lists, and a project list replaces the global list of the same name (#3528)", () => {
	assert.deepEqual(
		SettingsManager.inMemory({
			modelRouting: { allowedModels: ["anthropic/*", "anthropic/*"], excludedModels: ["*opus*:high"] },
		}).getModelRouting(),
		{ allowedModels: ["anthropic/*"], excludedModels: ["*opus*:high"] },
	);
	for (const modelRouting of [
		{ allowedModels: "anthropic/*" },
		{ allowedModels: [1] },
		{ excludedModels: [""] },
		{ excludedModels: [" anthropic/*"] },
	])
		assert.throws(
			() => SettingsManager.inMemory({ modelRouting } as never).getModelRouting(),
			/Invalid modelRouting: .*allowedModels and excludedModels must be arrays/u,
		);
	const merged = deepMergeSettings(
		{ modelRouting: { allowedModels: ["anthropic/*", "openrouter/*"], excludedModels: ["*opus*"] } },
		{ modelRouting: { allowedModels: ["openrouter/*"] } },
	);
	assert.deepEqual(merged.modelRouting, { allowedModels: ["openrouter/*"], excludedModels: ["*opus*"] });
});

test("modelRouting.excludedModels removes matches even when allowed, and neither a call's provider lists nor a recorded decision lifts it (#3528)", async () => {
	const both = routingContext({ allowedModels: ["*/claude-*"], excludedModels: ["github-copilot/claude-opus-5.5"] });
	assert.deepEqual(routed(await route(both.ctx)), ["anthropic/claude-fable-5-1"]);

	const override = routingContext({ excludedProviders: ["openrouter"], excludedModels: ["anthropic/*"] });
	assert.deepEqual(
		routed(await route(override.ctx, [{ allowedProviders: ["openrouter", "anthropic"] }], true)),
		["openrouter/openai/gpt-6-astra"],
		"a call's provider lists replace only the provider settings",
	);
	await assert.rejects(
		routeExecutionModel({
			ctx: override.ctx,
			task: "Review the change",
			agent: { name: "reviewer", description: "Reviews code" },
			selection: { model: "anthropic/claude-fable-5-1", effort: null },
		}),
		/no longer eligible/u,
	);
});

test("a model gate that leaves no candidate fails before routing and names the setting (#3528)", async () => {
	const allowed = routingContext({ allowedModels: ["openai-codex/*"] });
	const classify = vi.spyOn(allowed.ctx.modelRegistry, "classify");
	await assert.rejects(route(allowed.ctx), (error: Error) => {
		assert.equal(error instanceof AutoRoutingInferenceError, false, "an empty pool never degrades");
		assert.match(error.message, /and the modelRouting\.allowedModels setting\.$/u);
		return true;
	});
	assert.equal(classify.mock.calls.length, 0);

	const excluded = routingContext({ allowedProviders: ["anthropic"], excludedModels: ["*claude*"] });
	await assert.rejects(
		route(excluded.ctx),
		/modelRouting allowedProviders\/excludedProviders and modelRouting\.excludedModels settings\.$/u,
	);
	const lists = routingContext({ allowedModels: ["anthropic/*"], excludedModels: ["anthropic/*"] });
	await assert.rejects(route(lists.ctx), /modelRouting\.allowedModels and modelRouting\.excludedModels settings\.$/u);
});

test("routerSelection echoes the post-filter candidates, and a restored decision keeps its recorded list (#3528)", async () => {
	const ids = models.map((model) => `${model.provider}/${model.id}`);
	assert.deepEqual((await route(routingContext().ctx)).routerSelection.candidates, ids);

	const { ctx } = routingContext({ excludedModels: ["github-copilot/claude-opus-5.5"] });
	const fresh = await route(ctx);
	assert.deepEqual(fresh.routerSelection.candidates, ids.slice(1));
	const restore = (selection: ModelRouterOutput) =>
		routeExecutionModel({
			ctx,
			task: "Review the change",
			agent: { name: "reviewer", description: "Reviews code" },
			selection,
		});
	assert.deepEqual((await restore(fresh.routerSelection)).routerSelection, fresh.routerSelection);
	assert.equal(
		Object.hasOwn((await restore({ model: ids[1]!, effort: null })).routerSelection, "candidates"),
		false,
		"a legacy decision without candidates stays valid and unchanged",
	);
});
