import assert from "node:assert/strict";
import {
	type AssistantMessage,
	AssistantMessageEventStream,
	InMemoryCredentialStore,
	normalizeContext,
	type Provider,
} from "@bastani/pi-ai";
import { openaiProvider } from "@bastani/pi-ai/providers/openai";
import { test } from "vitest";
import { CODEX_FAST_ROUTE_HEADER } from "../src/core/fast-model-routing-transport.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createProviderAlias } from "../src/core/provider-alias.js";

function message(provider: string): AssistantMessage {
	return {
		role: "assistant",
		provider,
		api: "openai-responses",
		model: "gpt-6.1-sol",
		content: [{ type: "text", text: "hello" }],
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 1,
			output: 1,
			totalTokens: 2,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
		},
	};
}

for (const method of ["stream", "streamSimple"] as const) {
	test(`alias ${method} preserves transcript and callback identity without mutating source messages`, async () => {
		const source = openaiProvider();
		const original = message("account");
		const history = normalizeContext({
			messages: [original, { ...original, provider: "another-account" }, message("openai")],
		});
		const completion = message("openai");
		const callbackProviders: string[] = [];
		const implementation: Provider["streamSimple"] = (model, context, options) => {
			assert.equal(model.provider, "openai");
			const [own, other, sourceAccount] = context.messages;
			assert.equal(own.role === "assistant" && own.provider, "openai");
			assert.equal(other.role === "assistant" && other.provider, "another-account");
			assert.notEqual(sourceAccount.role === "assistant" && sourceAccount.provider, "openai");
			options?.onPayload?.({}, model);
			options?.onResponse?.({ status: 200, headers: {} }, model);
			options?.onProviderStreamEvent?.({}, model);
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "start", partial: completion });
			stream.push({ type: "done", reason: "stop", message: completion });
			stream.end(completion);
			return stream;
		};
		const provider: Provider = { ...source, stream: implementation, streamSimple: implementation };
		const alias = createProviderAlias({ id: "account", provider: "openai" }, () => provider);
		const model = alias.getModels().find((entry) => entry.id === "gpt-6.1-sol");
		assert.ok(model);
		const stream = alias[method](model, history, {
			onPayload: (_payload, current) => {
				callbackProviders.push(current.provider);
			},
			onResponse: (_response, current) => {
				callbackProviders.push(current.provider);
			},
			onProviderStreamEvent: (_event, current) => {
				callbackProviders.push(current.provider);
			},
		});
		const providers: string[] = [];
		for await (const event of stream) {
			providers.push(
				event.type === "done"
					? event.message.provider
					: event.type === "error"
						? event.error.provider
						: event.partial.provider,
			);
		}
		assert.deepEqual(providers, ["account", "account"]);
		assert.deepEqual(callbackProviders, ["account", "account", "account"]);
		assert.equal((await stream.result()).provider, "account");
		assert.equal(original.provider, "account");
		assert.equal(completion.provider, "openai");
	});
}

test("alias stream terminates if source dispatch throws", async () => {
	const source: Provider = {
		...openaiProvider(),
		streamSimple: () => {
			throw new Error("source unavailable");
		},
	};
	const alias = createProviderAlias({ id: "account", provider: "openai" }, () => source);
	const result = await alias.streamSimple(alias.getModels()[0], normalizeContext({ messages: [] })).result();
	assert.equal(result.stopReason, "error");
	assert.equal(result.provider, "account");
	assert.equal(result.errorMessage, "source unavailable");
});

test("Codex aliases retain first-party fast routing without changing account identity", async () => {
	const credentials = new InMemoryCredentialStore();
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } }),
	).toString("base64url");
	await credentials.modify("codex-account", async () => ({
		type: "oauth",
		access: `header.${payload}.signature`,
		refresh: "fake-refresh",
		expires: Number.MAX_SAFE_INTEGER,
	}));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	runtime.registerProvider("codex-account", { aliasOf: "openai-codex" });
	const model = runtime.getModel("codex-account", "gpt-6-astra-fast");
	assert.ok(model);
	let headers: Headers | undefined;
	const result = await runtime
		.streamSimple(
			model,
			{ messages: [] },
			{
				transport: "sse",
				fetch: async (_input, init) => {
					headers = new Headers(init?.headers);
					return new Response(
						`data: ${JSON.stringify({ type: "response.completed", response: { id: "test", status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } })}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			},
		)
		.result();
	assert.equal(result.stopReason, "stop");
	assert.equal(result.provider, "codex-account");
	assert.equal(headers?.get(CODEX_FAST_ROUTE_HEADER), "model=gpt-6-astra;tier=priority");
	assert.equal(headers?.get("chatgpt-account-id"), "fake-account");
});

test("aliases retain results from providers that end without terminal events", async () => {
	const completion = message("openai");
	const source: Provider = {
		...openaiProvider(),
		streamSimple: () => {
			const stream = new AssistantMessageEventStream();
			stream.end(completion);
			return stream;
		},
	};
	const alias = createProviderAlias({ id: "account", provider: "openai" }, () => source);
	const result = await alias.streamSimple(alias.getModels()[0], normalizeContext({ messages: [] })).result();
	assert.equal(result.provider, "account");
	assert.deepEqual(result.content, completion.content);
	assert.equal(completion.provider, "openai");
});
