import assert from "node:assert/strict";
import type { Api, ClassifierContext, ClassifierModel, ClassifierResult, Model } from "@bastani/atomic-ai";
import { getBuiltinClassifierModel } from "@bastani/atomic-ai/providers/all";
import { test } from "vitest";
import {
	AutoRoutingInferenceError,
	type ModelRoutingContext,
	routeExecutionModel,
} from "../../packages/coding-agent/src/core/execution-model-router.js";
import type { ModelConstraints } from "../../packages/coding-agent/src/core/model-routing-constraints.js";
import type { ModelRoutingSettings } from "../../packages/coding-agent/src/core/settings-types.js";
import { workflowModelCatalogFromContext } from "../../packages/workflows/src/extension/workflow-model-catalog.js";
import { chatRouter, classifierOptions, defaultClassifierChoice } from "../helpers/model-routing.js";

const jev = getBuiltinClassifierModel("typesafe", "jev-latest") as ClassifierModel<Api>;

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

const CURRENT = chatModel("github-copilot", "claude-opus-5.5");
const LOGGED_OUT = chatModel("anthropic", "claude-fable-5-1");
const OTHER = chatModel("openrouter", "openai/gpt-6-astra");
const STALE_AVAILABLE = [CURRENT, LOGGED_OUT, OTHER];

function routingContext(options: { decisionModel?: string; modelRouting?: ModelRoutingSettings } = {}) {
	const offered: string[][] = [];
	const requested: string[] = [];
	const ctx: ModelRoutingContext = {
		model: CURRENT,
		getDecisionModel: () => options.decisionModel ?? "typesafe/jev-latest",
		...(options.modelRouting ? { getModelRouting: () => options.modelRouting! } : {}),
		modelRegistry: {
			getAvailable: () => STALE_AVAILABLE,
			getAll: () => STALE_AVAILABLE,
			hasConfiguredAuth: (model: { readonly provider: string }) => model.provider !== LOGGED_OUT.provider,
			streamSimple: (model, context) => {
				requested.push(`${model.provider}/${model.id}`);
				return chatRouter()(model, context);
			},
			containsConfiguredCredential: async () => false,
			getClassifierModel: (provider: string, id: string) =>
				`${provider}/${id}` === `${jev.provider}/${jev.id}` ? jev : undefined,
			classify: async (_model: ClassifierModel<Api>, context: ClassifierContext) => {
				requested.push(`${jev.provider}/${jev.id}`);
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
	return { ctx, offered, requested };
}

const route = (ctx: ModelRoutingContext, constraints: ModelConstraints[] = []) =>
	routeExecutionModel({
		ctx,
		task: "Review the change",
		agent: { name: "reviewer", description: "Reviews code" },
		constraints,
		taskNeeds: {
			work: "coding",
			difficulty: "moderate",
			mistakeCost: "low",
			needsImages: false,
			longContext: false,
			latencySensitive: false,
		},
	});

const routed = (result: Awaited<ReturnType<typeof routeExecutionModel>>) => [
	result.routerSelection.model,
	...(result.routerSelection.fallbacks ?? []).map((pair) => pair.model),
];

test("the router is offered, and picks, only models whose provider has credentials, even from a stale availability list", async () => {
	const { ctx, offered } = routingContext();

	const result = await route(ctx);

	const loggedOut = `${LOGGED_OUT.provider}/${LOGGED_OUT.id}`;
	assert.ok(!(result.routerSelection.candidates ?? []).includes(loggedOut), "candidates list the logged-out model");
	assert.ok(!offered.flat().includes(loggedOut), "the routing call was spent on the logged-out model");
	assert.ok(!routed(result).includes(loggedOut));
	assert.equal(result.allowsModel(LOGGED_OUT), false);
});

test("allowedModels naming a model without credentials routes among the others and never widens past the list", async () => {
	const { ctx } = routingContext();

	const result = await route(ctx, [
		{ allowedModels: ["anthropic/claude-fable-5-1", "openrouter/openai/gpt-6-astra"] },
	]);

	assert.deepEqual(result.routerSelection.candidates, ["openrouter/openai/gpt-6-astra"]);
	assert.deepEqual(routed(result), ["openrouter/openai/gpt-6-astra"]);
});

test("allowedModels naming only models without credentials fails at once, without a routing call", async () => {
	const { ctx, requested } = routingContext();

	await assert.rejects(
		route(ctx, [{ allowedModels: ["anthropic/claude-fable-5-1"] }]),
		/no eligible model.*anthropic\/claude-fable-5-1 \(no credentials for anthropic\)/s,
	);
	assert.deepEqual(requested, []);
});

test("missing-credential diagnostics name allowed models omitted from the available catalog", async () => {
	const { ctx, requested } = routingContext();
	await assert.rejects(
		route({ ...ctx, modelRegistry: { ...ctx.modelRegistry, getAvailable: () => [CURRENT, OTHER] } }, [
			{ allowedModels: ["anthropic/claude-fable-5-1"] },
		]),
		/no eligible model.*anthropic\/claude-fable-5-1 \(no credentials for anthropic\)/s,
	);
	assert.deepEqual(requested, []);
});

test("missing-credential diagnostics stay bounded for a large image-model catalog", async () => {
	const { ctx, requested } = routingContext();
	const models = Array.from({ length: 2_000 }, (_, index) => ({
		...chatModel("logged-out", `image-model-${index}`),
		input: ["text", "image"] as Model<Api>["input"],
	}));
	const error = await route(
		{
			...ctx,
			modelRegistry: {
				...ctx.modelRegistry,
				getAvailable: () => [],
				getAll: () => models,
				hasConfiguredAuth: () => false,
			},
		},
		[{ requiredInputs: ["image"] }],
	).catch((caught: Error) => caught);

	assert.ok(error instanceof Error);
	assert.ok(error.message.length < 2_000, `diagnostic has ${error.message.length} characters`);
	assert.match(error.message, /logged-out\/image-model-0/);
	assert.match(error.message, /and 1992 more/);
	assert.deepEqual(requested, []);
});

test("a decision model without credentials fails routing at once naming it and its provider, and no request is sent", async () => {
	const { ctx, requested } = routingContext({ decisionModel: "anthropic/claude-fable-5-1" });

	const error = await route(ctx).then(
		() => undefined,
		(caught: unknown) => caught,
	);

	assert.ok(error instanceof AutoRoutingInferenceError);
	assert.match(error.message, /anthropic\/claude-fable-5-1/);
	assert.match(error.message, /no credentials for anthropic/);
	assert.deepEqual(requested, []);
	assert.equal(error.currentModelRoute?.routerSelection.model, "github-copilot/claude-opus-5.5");
});

test("a failed classifier never sends its chat fallback to a logged-out current provider", async () => {
	const { ctx, requested } = routingContext();
	await assert.rejects(
		route({
			...ctx,
			model: LOGGED_OUT,
			modelRegistry: {
				...ctx.modelRegistry,
				classify: async () => {
					throw new Error("classifier unavailable");
				},
			},
		}),
		AutoRoutingInferenceError,
	);
	assert.deepEqual(requested, []);
});

test("a workflow stage's routing reads credentials through the same registry check", async () => {
	const { ctx } = routingContext();
	const catalog = workflowModelCatalogFromContext({
		model: CURRENT,
		getDecisionModel: () => "typesafe/jev-latest",
		modelRegistry: ctx.modelRegistry as never,
	});
	assert.ok(catalog?.routeModel);

	const result = await catalog.routeModel({
		task: "Review the change",
		stageName: "review",
		constraints: [],
		taskNeeds: {
			work: "coding",
			difficulty: "moderate",
			mistakeCost: "low",
			needsImages: false,
			longContext: false,
			latencySensitive: false,
		},
	});

	assert.ok(!(result.routerSelection.candidates ?? []).includes("anthropic/claude-fable-5-1"));
	assert.equal(catalog.hasCredentials?.("anthropic"), false);
	assert.equal(catalog.hasCredentials?.("github-copilot"), true);
});
