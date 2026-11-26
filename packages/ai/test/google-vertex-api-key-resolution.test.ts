import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";

const googleGenAiMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				yield {
					responseId: "vertex-response-id",
					candidates: [
						{
							content: { parts: [{ text: "ok" }] },
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 1,
						candidatesTokenCount: 1,
						totalTokenCount: 2,
					},
				};
			},
		};

		constructor(config: Record<string, unknown>) {
			googleGenAiMock.constructorCalls.push(config);
		}
	}

	return {
		GoogleGenAI,
		ResourceScope: {
			COLLECTION: "COLLECTION",
		},
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { normalizeContext } from "../src/compat.ts";
import type { FetchFunction, Model } from "../src/types.ts";
import { formatUserAgent } from "../src/utils/identity.ts";

const PI_USER_AGENT = formatUserAgent();

/**
 * The URLs the global fetch was asked for while `fetch` sent one request. The adapter wraps the fetch it hands the
 * client, to tell its own connection's failures apart, and reads the global one when the request is sent (#6114).
 */
async function globalFetchCalls(fetch: FetchFunction): Promise<string[]> {
	const calls: string[] = [];
	const spy = Object.assign(async (input: Parameters<FetchFunction>[0]) => {
		calls.push(String(input));
		return new Response("{}");
	}, globalThis.fetch);
	vi.stubGlobal("fetch", spy);
	try {
		await fetch("https://vertex.test/v1");
	} finally {
		vi.unstubAllGlobals();
	}
	return calls;
}

const model = getFixtureModel("google-vertex", "gemini-3-flash-preview");
const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

const originalGoogleCloudApiKey = process.env.GOOGLE_CLOUD_API_KEY;

beforeEach(() => {
	googleGenAiMock.constructorCalls.length = 0;
	delete process.env.GOOGLE_CLOUD_API_KEY;
});

afterEach(() => {
	if (originalGoogleCloudApiKey === undefined) {
		delete process.env.GOOGLE_CLOUD_API_KEY;
	} else {
		process.env.GOOGLE_CLOUD_API_KEY = originalGoogleCloudApiKey;
	}
});

describe("google-vertex api key resolution", () => {
	it("falls back to ADC when options.apiKey is a placeholder marker", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "<authenticated>",
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("falls back to ADC when options.apiKey is the gcp-vertex-credentials marker", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "gcp-vertex-credentials",
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("falls back to ADC when GOOGLE_CLOUD_API_KEY is a placeholder marker", async () => {
		process.env.GOOGLE_CLOUD_API_KEY = "<authenticated>";

		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("still uses the API key client for real API keys", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("project");
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("location");
	});

	it("does not forward generated Vertex base URL placeholders", async () => {
		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		const { fetch, ...rest } = googleGenAiMock.constructorCalls[0]?.httpOptions as { fetch: FetchFunction };
		expect(rest).toEqual({ headers: { "User-Agent": PI_USER_AGENT } });
		assert.deepEqual(await globalFetchCalls(fetch), ["https://vertex.test/v1"]);
	});

	it("lets explicit headers override the default User-Agent", async () => {
		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
			headers: { "User-Agent": "custom-agent" },
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		const { fetch, ...rest } = googleGenAiMock.constructorCalls[0]?.httpOptions as { fetch: FetchFunction };
		expect(rest).toEqual({ headers: { "User-Agent": "custom-agent" } });
		assert.deepEqual(await globalFetchCalls(fetch), ["https://vertex.test/v1"]);
	});

	it("forwards custom fetch to the ADC client (#12097)", async () => {
		const customCalls: string[] = [];
		const customFetch: FetchFunction = Object.assign(async (input: Parameters<FetchFunction>[0]) => {
			customCalls.push(String(input));
			return new Response("{}");
		}, globalThis.fetch);
		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
			fetch: customFetch,
		});

		await stream.result();

		assert.equal(googleGenAiMock.constructorCalls.length, 1);
		const { fetch, ...rest } = googleGenAiMock.constructorCalls[0]?.httpOptions as { fetch: FetchFunction };
		assert.deepEqual(rest, { headers: { "User-Agent": PI_USER_AGENT } });
		const before = customCalls.length;
		await fetch("https://vertex.test/v1");
		assert.deepEqual(customCalls.slice(before), ["https://vertex.test/v1"]);
	});

	it("uses globalThis.fetch when options are omitted on the ADC client (#12097)", async () => {
		const previousProject = process.env.GOOGLE_CLOUD_PROJECT;
		const previousLocation = process.env.GOOGLE_CLOUD_LOCATION;
		process.env.GOOGLE_CLOUD_PROJECT = "test-project";
		process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
		try {
			await streamGoogleVertex(model, context).result();

			assert.equal(googleGenAiMock.constructorCalls.length, 1);
			const { fetch, ...rest } = googleGenAiMock.constructorCalls[0]?.httpOptions as { fetch: FetchFunction };
			assert.deepEqual(rest, { headers: { "User-Agent": PI_USER_AGENT } });
			assert.deepEqual(await globalFetchCalls(fetch), ["https://vertex.test/v1"]);
		} finally {
			if (previousProject === undefined) {
				delete process.env.GOOGLE_CLOUD_PROJECT;
			} else {
				process.env.GOOGLE_CLOUD_PROJECT = previousProject;
			}
			if (previousLocation === undefined) {
				delete process.env.GOOGLE_CLOUD_LOCATION;
			} else {
				process.env.GOOGLE_CLOUD_LOCATION = previousLocation;
			}
		}
	});

	it("forwards custom baseUrl to the ADC client", async () => {
		const customModel: Model<"google-vertex"> = { ...model, baseUrl: "https://proxy.example.com" };
		const stream = streamGoogleVertex(customModel, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
			httpOptions: {
				baseUrl: "https://proxy.example.com",
				baseUrlResourceScope: "COLLECTION",
			},
		});
	});

	it("forwards custom baseUrl to the API key client", async () => {
		const customModel: Model<"google-vertex"> = { ...model, baseUrl: "https://proxy.example.com" };
		const stream = streamGoogleVertex(customModel, context, {
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
			apiVersion: "v1",
			httpOptions: {
				baseUrl: "https://proxy.example.com",
				baseUrlResourceScope: "COLLECTION",
			},
		});
	});

	it("does not append apiVersion when custom baseUrl already includes one", async () => {
		const customModel: Model<"google-vertex"> = {
			...model,
			baseUrl: "https://proxy.example.com/v1/projects/test-project/locations/global",
		};
		const stream = streamGoogleVertex(customModel, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			httpOptions: {
				baseUrl: "https://proxy.example.com/v1/projects/test-project/locations/global",
				baseUrlResourceScope: "COLLECTION",
				apiVersion: "",
			},
		});
	});
});
