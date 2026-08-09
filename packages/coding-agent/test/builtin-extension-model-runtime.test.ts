import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import { generateSummaryDraft, type SummaryGenerationContext } from "../../web-access/summary-review.js";
import { rewriteSearchQuery } from "../../web-access/web-search-summary.js";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { fakeModelRuntime } from "./model-runtime-test-utils.ts";

const RUNTIME_ENDPOINT = "https://runtime.example.test";
const RUNTIME_HEADERS: ProviderHeaders = { Authorization: null, "x-runtime": "enabled" };

type RuntimeCall = {
	model: Model<Api>;
	apiKey: string | undefined;
	headers: ProviderHeaders | undefined;
};

function response(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function customModel(): Model<Api> {
	return {
		id: "summary-model",
		name: "Runtime-only summary model",
		api: "runtime-summary-probe" as Api,
		provider: "runtime-summary",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

test("web-access summary calls use the coding-agent model runtime", async () => {
	const summaryModel = customModel();
	const rewriteModel = getModel("anthropic", "claude-haiku-4-5");
	assert.ok(rewriteModel, "expected the bundled Anthropic rewrite model");
	const calls: RuntimeCall[] = [];
	const registry = new ModelRegistry(
		fakeModelRuntime({
			getModel: (provider, id) =>
				provider === summaryModel.provider && id === summaryModel.id ? summaryModel : undefined,
			getAuth: async () => ({
				auth: {
					apiKey: "runtime-key",
					baseUrl: RUNTIME_ENDPOINT,
					headers: RUNTIME_HEADERS,
				},
			}),
			complete: async (model, _context, options) => {
				calls.push({ model, apiKey: options?.apiKey, headers: options?.headers });
				return response(model, "Runtime-routed response");
			},
		}),
	);
	const context: SummaryGenerationContext = { model: undefined, modelRegistry: registry };

	const summary = await generateSummaryDraft(
		[{ query: "runtime routing", answer: "model runtime", results: [], error: null }],
		context,
		undefined,
		"runtime-summary/summary-model",
	);
	const rewrite = await rewriteSearchQuery("model runtime", context, new AbortController().signal);

	assert.equal(summary.summary, "Runtime-routed response");
	assert.equal(rewrite, "Runtime-routed response");
	assert.equal(calls.length, 2);
	assert.equal(calls[0]?.model.provider, "runtime-summary");
	assert.equal(calls[0]?.model.id, "summary-model");
	assert.equal(calls[1]?.model.provider, rewriteModel.provider);
	assert.equal(calls[1]?.model.id, rewriteModel.id);
	for (const call of calls) {
		assert.equal(call.model.baseUrl, RUNTIME_ENDPOINT);
		assert.equal(call.apiKey, "runtime-key");
		assert.deepEqual(call.headers, RUNTIME_HEADERS);
	}
});
