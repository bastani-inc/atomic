import assert from "node:assert/strict";
import type { Model } from "@bastani/atomic-ai";
import { test } from "vitest";
import { workflowModelCatalogFromContext } from "../../packages/workflows/src/extension/workflow-model-catalog.js";
import { createStageContext, type StageRunnerOpts } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { makeMockSession } from "./stage-runner-helpers.js";

const REVOKED = Object.assign(new Error("401 Incorrect API key provided"), { status: 401 });

function stageOptions(chain: readonly string[], calls: string[]): StageRunnerOpts {
	const [model, ...fallbackModels] = chain;
	return {
		stageId: "url-provider-credentials",
		stageName: "Reviewer",
		runId: "url-provider-credentials",
		stageOptions: { model, fallbackModels },
		adapters: {
			agentSession: {
				async create(options) {
					const selected =
						typeof options.model === "object" && options.model !== null
							? `${options.model.provider}/${options.model.id}`
							: String(options.model);
					calls.push(selected);
					return makeMockSession({
						async prompt() {
							if (selected === chain[0]) throw REVOKED;
							return "ok";
						},
					}).session;
				},
			},
		},
	};
}

test("unknown URL-shaped model references do not share credentials merely because their schemes match (#5353)", async () => {
	const calls: string[] = [];
	const chain = ["https://first.example/provider/model-a", "https://second.example/provider/model-b"];
	const ctx = createStageContext(stageOptions(chain, calls));
	try {
		assert.equal(await ctx.prompt("review"), "ok");
		assert.deepEqual(calls, chain);
	} finally {
		await ctx.__dispose();
	}
});

test("catalog provider identities keep rejected URL providers separate from their nested accounts (#5353)", async () => {
	const calls: string[] = [];
	const provider = "https://api.example/tenant";
	const otherProvider = `${provider}/other-account`;
	const chain = [`${provider}/model-a`, `${provider}/model-b`, `${otherProvider}/model-c`];
	const options = stageOptions(chain, calls);
	options.models = {
		async listModels() {
			return [
				{ provider, id: "model-a", fullId: chain[0]! },
				{ provider, id: "model-b", fullId: chain[1]! },
				{ provider: otherProvider, id: "model-c", fullId: chain[2]! },
			];
		},
	};
	const ctx = createStageContext(options);
	try {
		assert.equal(await ctx.prompt("review"), "ok");
		assert.deepEqual(calls, [chain[0], chain[2]]);
		assert.match(
			ctx.__modelFallbackMeta().modelAttempts?.[1]?.error ?? "",
			/https:\/\/api\.example\/tenant' rejected/,
		);
	} finally {
		await ctx.__dispose();
	}
});

function chatModel(provider: string, id: string): Model<"openai-completions"> {
	return {
		type: "chat",
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1_000,
	};
}

test("a URL provider omitted from the available catalog is screened through its exact registry identity (#5353)", async () => {
	const missing = chatModel("https://api.example/tenant", "model-a");
	const working = chatModel(`${missing.provider}/other-account`, "model-b");
	const chain = [missing, working].map((model) => `${model.provider}/${model.id}`);
	const calls: string[] = [];
	const catalog = workflowModelCatalogFromContext({
		modelRegistry: {
			getAll: () => [missing, working],
			getAvailable: () => [working],
			hasConfiguredAuth: ({ provider }) => provider === working.provider,
		},
	});
	assert.ok(catalog);
	const ctx = createStageContext({ ...stageOptions(chain, calls), models: catalog });
	try {
		assert.equal(await ctx.prompt("review"), "ok");
		assert.deepEqual(calls, [chain[1]]);
		assert.deepEqual(
			(await catalog.listModels()).map((model) => model.fullId),
			[chain[1]],
		);
		assert.match(
			ctx.__modelFallbackMeta().modelAttempts?.[0]?.error ?? "",
			/https:\/\/api\.example\/tenant' has no credentials/,
		);
	} finally {
		await ctx.__dispose();
	}
});
