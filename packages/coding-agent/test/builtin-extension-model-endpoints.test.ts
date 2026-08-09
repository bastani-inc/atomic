import assert from "node:assert/strict";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { complete, getModel, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { CreateMessageRequest } from "@modelcontextprotocol/sdk/types.js";
import { test } from "vitest";
import { handleSamplingRequest } from "../../mcp/sampling-handler.js";
import { generateSummaryDraft, type SummaryGenerationContext } from "../../web-access/summary-review.js";
import { rewriteSearchQuery } from "../../web-access/web-search-summary.js";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { fakeModelRuntime } from "./model-runtime-test-utils.ts";

/**
 * MCP dispatches direct pi-ai calls; web-access dispatches through ModelRuntime.
 * Both retain resolved auth, while Intercom has no model-request path.
 */

const INDIVIDUAL_ENDPOINT = "https://api.individual.githubcopilot.com";
const ENTERPRISE_ENDPOINT = "https://api.enterprise.githubcopilot.com";
const SUPPRESSION_HEADERS: ProviderHeaders = { Authorization: null, "x-copilot": "enterprise" };

type CapturedRequest = {
	baseUrl: string | undefined;
	headers: ProviderHeaders | undefined;
};

function responseStream(model: Model<Api>, text: string) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
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
	stream.end(message);
	return stream;
}

function model(api: Api, provider = "github-copilot", id = "gpt-5.5"): Model<Api> {
	return {
		id,
		name: "Credential endpoint probe",
		api,
		provider,
		baseUrl: INDIVIDUAL_ENDPOINT,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

function registryFor(requestModel: Model<Api>): ModelRegistry {
	return new ModelRegistry(
		fakeModelRuntime({
			getAvailableSnapshot: () => [requestModel],
			getModel: (provider, modelId) =>
				provider === requestModel.provider && modelId === requestModel.id ? requestModel : undefined,
			getAuth: async () => ({
				auth: {
					apiKey: "copilot-token",
					baseUrl: ENTERPRISE_ENDPOINT,
					headers: SUPPRESSION_HEADERS,
				},
			}),
			complete: async (model, context, options) => await complete(model, context, options),
		}),
	);
}

function assertCredentialRequest(captured: CapturedRequest | undefined): void {
	assert.ok(captured, "expected a model request");
	assert.equal(captured.baseUrl, ENTERPRISE_ENDPOINT);
	assert.deepEqual(captured.headers, SUPPRESSION_HEADERS);
}

const queryResult = {
	query: "Copilot endpoints",
	answer: "GitHub Copilot has a credential-specific endpoint.",
	results: [],
	error: null,
};

test("MCP sampling applies credential endpoints without dropping null headers", async () => {
	const api = "mcp-sampling-endpoint-probe" as Api;
	const requestModel = model(api, "github-copilot", "mcp-endpoint-probe");
	const registry = registryFor(requestModel);
	const captured: CapturedRequest[] = [];
	const source = "mcp-sampling-endpoint-probe";
	const stream = (dispatchedModel: Model<Api>, _context: object, options?: { headers?: ProviderHeaders }) => {
		captured.push({ baseUrl: dispatchedModel.baseUrl, headers: options?.headers });
		return responseStream(dispatchedModel, "MCP response");
	};
	registerApiProvider({ api, stream, streamSimple: stream }, source);
	try {
		const request: CreateMessageRequest = {
			method: "sampling/createMessage",
			params: {
				messages: [{ role: "user", content: { type: "text", text: "Summarize the endpoint." } }],
				maxTokens: 1_024,
			},
		};
		const result = await handleSamplingRequest(
			{
				serverName: "endpoint-probe",
				autoApprove: true,
				modelRegistry: registry,
				getCurrentModel: () => undefined,
				getSignal: () => undefined,
			},
			request,
		);

		assert.equal(result.content.type, "text");
		assert.equal(result.content.text, "MCP response");
	} finally {
		unregisterApiProviders(source);
	}
	assertCredentialRequest(captured[0]);
});

test("web summary model overrides apply credential endpoints without dropping null headers", async () => {
	const api = "web-summary-endpoint-probe" as Api;
	const requestModel = model(api, "github-copilot", "web-summary-endpoint-probe");
	const context: SummaryGenerationContext = { model: undefined, modelRegistry: registryFor(requestModel) };
	const captured: CapturedRequest[] = [];
	const source = "web-summary-endpoint-probe";
	const stream = (dispatchedModel: Model<Api>, _context: object, options?: { headers?: ProviderHeaders }) => {
		captured.push({ baseUrl: dispatchedModel.baseUrl, headers: options?.headers });
		return responseStream(dispatchedModel, "Web summary");
	};
	registerApiProvider({ api, stream, streamSimple: stream }, source);
	try {
		const result = await generateSummaryDraft(
			[queryResult],
			context,
			undefined,
			"github-copilot/web-summary-endpoint-probe",
		);
		assert.equal(result.summary, "Web summary");
	} finally {
		unregisterApiProviders(source);
	}
	assertCredentialRequest(captured[0]);
});

test("web preferred summaries and query rewrites apply credential endpoints without dropping null headers", async () => {
	const requestModel = getModel("anthropic", "claude-haiku-4-5");
	assert.ok(requestModel, "expected the bundled Anthropic summary model");
	const context: SummaryGenerationContext = { model: undefined, modelRegistry: registryFor(requestModel) };
	const captured: CapturedRequest[] = [];
	const source = "web-preferred-endpoint-probe";
	const stream = (dispatchedModel: Model<Api>, _context: object, options?: { headers?: ProviderHeaders }) => {
		captured.push({ baseUrl: dispatchedModel.baseUrl, headers: options?.headers });
		return responseStream(dispatchedModel, "Credential-routed response");
	};
	registerApiProvider({ api: requestModel.api, stream, streamSimple: stream }, source);
	try {
		const summary = await generateSummaryDraft([queryResult], context);
		const rewrite = await rewriteSearchQuery("Copilot endpoint", context, new AbortController().signal);
		assert.equal(summary.summary, "Credential-routed response");
		assert.equal(rewrite, "Credential-routed response");
	} finally {
		unregisterApiProviders(source);
	}
	assert.equal(captured.length, 2);
	for (const request of captured) assertCredentialRequest(request);
});
