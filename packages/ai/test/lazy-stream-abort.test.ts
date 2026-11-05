import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { lazyApi, lazyStream } from "../src/api/lazy.ts";
import { normalizeContext } from "../src/compat.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { Api, AssistantMessageEvent, Context, DeferredHandle, Model, ProviderStreams } from "../src/types.ts";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const transcript = normalizeContext(context);

function testModel(api: Api = "test-api"): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function errorEvent(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent | undefined> {
	for await (const event of stream) {
		if (event.type === "error") return event;
	}
	return undefined;
}

const failingStreams: ProviderStreams = {
	stream: () => {
		throw new Error("setup failed");
	},
	streamSimple: () => {
		throw new Error("setup failed");
	},
	fetchDeferred: () => {
		throw new Error("setup failed");
	},
};

describe("lazy stream setup abort (#8409)", () => {
	it("reports a setup failure as an error without an aborted signal", async () => {
		const stream = lazyStream(testModel(), async () => {
			throw new Error("setup failed");
		});
		const event = await errorEvent(stream);
		assert.ok(event?.type === "error");
		assert.equal(event.reason, "error");
		const result = await stream.result();
		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, "setup failed");
	});

	it("reports a setup failure as aborted when the request signal is aborted", async () => {
		const stream = lazyStream(
			testModel(),
			async () => {
				throw new Error("setup failed");
			},
			abortedSignal(),
		);
		const event = await errorEvent(stream);
		assert.ok(event?.type === "error");
		assert.equal(event.reason, "aborted");
		assert.equal(event.error.stopReason, "aborted");
		const result = await stream.result();
		assert.equal(result.stopReason, "aborted");
		assert.equal(result.errorMessage, "setup failed");
	});

	it("keeps an unaborted signal's setup failure an error", async () => {
		const result = await lazyStream(
			testModel(),
			async () => {
				throw new Error("setup failed");
			},
			new AbortController().signal,
		).result();
		assert.equal(result.stopReason, "error");
	});

	it("passes the request signal through lazyApi stream, streamSimple and fetchDeferred", async () => {
		const api = lazyApi(async () => failingStreams, { fetchDeferred: true });
		const model = testModel();
		const handle: DeferredHandle = { provider: model.provider, modelId: model.id, api: model.api, id: "r-1" };
		const signal = abortedSignal();

		assert.equal((await api.stream(model, transcript, { signal }).result()).stopReason, "aborted");
		assert.equal((await api.streamSimple(model, transcript, { signal }).result()).stopReason, "aborted");
		assert.equal((await api.fetchDeferred!(model, handle, { signal }).result()).stopReason, "aborted");
		assert.equal((await api.stream(model, transcript).result()).stopReason, "error");
	});

	it("passes the request signal through provider dispatch", async () => {
		const model = testModel();
		const provider = createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: { "other-api": failingStreams },
		});
		const handle: DeferredHandle = { provider: model.provider, modelId: model.id, api: model.api, id: "r-1" };
		const signal = abortedSignal();

		assert.equal((await provider.stream(model, transcript, { signal }).result()).stopReason, "aborted");
		assert.equal((await provider.streamSimple(model, transcript, { signal }).result()).stopReason, "aborted");
		assert.equal((await provider.fetchDeferred!(model, handle, { signal }).result()).stopReason, "aborted");
		assert.equal((await provider.stream(model, transcript).result()).stopReason, "error");
	});

	it("runs lazyApi and provider dispatch without request options", async () => {
		const { fetchDeferred: _fetchDeferred, ...streamsWithoutDeferred } = failingStreams;
		const api = lazyApi(async () => streamsWithoutDeferred, { fetchDeferred: true });
		const model = testModel();
		const handle: DeferredHandle = { provider: model.provider, modelId: model.id, api: model.api, id: "r-1" };

		assert.equal((await api.streamSimple(model, transcript).result()).errorMessage, "setup failed");
		const deferred = await api.fetchDeferred!(model, handle).result();
		assert.equal(deferred.stopReason, "error");
		assert.equal(deferred.errorMessage, "API does not support deferred responses");

		const provider = createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: { "other-api": failingStreams },
		});
		const unserved = await provider.streamSimple(model, transcript).result();
		assert.equal(unserved.stopReason, "error");
		assert.equal(unserved.errorMessage, 'Provider test-provider has no API implementation for "test-api"');
		const unservedDeferred = await provider.fetchDeferred!(model, handle).result();
		assert.equal(unservedDeferred.errorMessage, 'Provider test-provider does not support deferred responses for "test-api"');
	});

	it("reports an auth setup failure in Models as aborted when the request signal is aborted", async () => {
		const model = testModel();
		const provider = createProvider({
			id: "test-provider",
			auth: {
				apiKey: {
					name: "Test",
					resolve: async () => {
						throw new Error("auth setup failed");
					},
				},
			},
			models: [model],
			api: { "test-api": failingStreams },
		});
		const models = createModels();
		models.setProvider(provider);
		const handle: DeferredHandle = { provider: model.provider, modelId: model.id, api: model.api, id: "r-1" };
		const signal = abortedSignal();

		assert.equal((await models.stream(model, context, { signal }).result()).stopReason, "aborted");
		assert.equal((await models.streamSimple(model, context, { signal }).result()).stopReason, "aborted");
		assert.equal((await models.fetchDeferred(model, handle, { signal })).stopReason, "aborted");
		const unaborted = await models.streamSimple(model, context).result();
		assert.equal(unaborted.stopReason, "error");
		assert.equal(unaborted.errorMessage, "API key auth failed for provider test-provider: auth setup failed");
		const unabortedStream = await models.stream(model, context).result();
		assert.equal(unabortedStream.errorMessage, "API key auth failed for provider test-provider: auth setup failed");
	});
});
