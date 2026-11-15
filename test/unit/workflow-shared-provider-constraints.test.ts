import assert from "node:assert/strict";
import type { Api, Model } from "@bastani/atomic-ai";
import { test } from "vitest";
import { workflowModelCatalogFromContext } from "../../packages/workflows/src/extension/workflow-model-catalog.js";
import type { StageOptions } from "../../packages/workflows/src/shared/types.js";
import { createStore, run, workflow } from "./executor-shared.js";
import { makeMockSession } from "./stage-runner-helpers.js";

const NEEDS = {
	work: "coding",
	difficulty: "moderate",
	mistakeCost: "low",
	needsImages: false,
	longContext: false,
	latencySensitive: false,
} as const;

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
	};
}

/** A user whose settings exclude openrouter, with one anthropic and one openrouter model available. */
function excludingOpenRouter() {
	const models = [model("anthropic", "claude-x"), model("openrouter", "or-model")];
	const registry = {
		getAll: () => models,
		getAvailable: () => models,
		streamSimple: () => {
			throw new Error("routing makes no inference in this test");
		},
		containsConfiguredCredential: async () => false,
		getClassifierModel: () => undefined,
	};
	const catalog = workflowModelCatalogFromContext({
		model: models[0],
		modelRegistry: registry,
		getDecisionModel: () => "",
		getModelRouting: () => ({ excludedProviders: ["openrouter"] }),
	} as never);
	const admitted: string[] = [];
	const adapters = {
		agentSession: {
			async create(options: { model?: Model<Api> }) {
				admitted.push(`${options.model?.provider}/${options.model?.id}`);
				return makeMockSession({
					model: options.model,
					async prompt() {
						return "done";
					},
					getLastAssistantText: () => "done",
				}).session;
			},
		},
	};
	return { models: catalog, store: createStore(), adapters, admitted };
}

for (const kind of ["parallel", "chain"] as const) {
	for (const own of [undefined, { maxInputCost: 100 }]) {
		test(`${kind}-level provider lists never lift the user's settings, with task constraints ${JSON.stringify(own)} (#5046)`, async () => {
			const f = excludingOpenRouter();
			const shared = {
				model: "auto",
				taskNeeds: NEEDS,
				modelConstraints: { allowedProviders: ["openrouter"] },
			} satisfies Partial<StageOptions>;
			const def = workflow({
				name: "shared-providers",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const tasks = [{ name: "t", prompt: "Task", ...(own ? { modelConstraints: own } : {}) }];
					if (kind === "parallel") await ctx.parallel(tasks, shared);
					else await ctx.chain(tasks, shared);
					return {};
				},
			});
			const result = await run(def, {}, f as never);
			assert.deepEqual(f.admitted, [], "the excluded provider's model never runs");
			assert.match(String(result.error), /no eligible model\/effort pairs/);
		});
	}
}
