import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	type AiGatewayBinding,
	type AiGatewayUniversalRequestLike,
	CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
	createGatewayBindingFetch,
} from "../src/api/cloudflare-gateway-binding.ts";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";

const BASE_URL = "https://gateway.ai.cloudflare.com/v1/account-id/my-gateway";

interface CapturedRun {
	gatewayId: string;
	data: AiGatewayUniversalRequestLike;
	options: { signal?: AbortSignal } | undefined;
}

function fakeLegacyBinding(response?: Response) {
	const runs: CapturedRun[] = [];
	const binding = {
		gateway: (gatewayId: string) => ({
			run: (data: AiGatewayUniversalRequestLike, options?: { signal?: AbortSignal }) => {
				runs.push({ gatewayId, data, options });
				return Promise.resolve(response ?? new Response("{}"));
			},
		}),
	};
	return { binding, runs };
}

describe("createGatewayBindingFetch legacy gateway().run() fallback", () => {
	it("derives provider and endpoint from gateway passthrough URLs", async () => {
		const { binding, runs } = fakeLegacyBinding();
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

		await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
			method: "POST",
			body: JSON.stringify({ model: "claude" }),
		});
		await fetchFn(`${BASE_URL}/openai/responses`, {
			method: "POST",
			body: JSON.stringify({ model: "gpt" }),
		});
		await fetchFn(`${BASE_URL}/workers-ai/v1/chat/completions`, {
			method: "POST",
			body: JSON.stringify({ model: "@cf/meta/llama" }),
		});

		assert.deepEqual(
			runs.map((run) => [run.data.provider, run.data.endpoint]),
			[
				["anthropic", "v1/messages"],
				["openai", "responses"],
				["workers-ai", "v1/chat/completions"],
			],
		);
		assert.deepEqual(
			runs.map((run) => run.gatewayId),
			["my-gateway", "my-gateway", "my-gateway"],
		);
		assert.deepEqual(runs[0].data.query, { model: "claude" });
	});

	it("keeps the query string in the endpoint", async () => {
		const { binding, runs } = fakeLegacyBinding();
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

		await fetchFn(`${BASE_URL}/openai/responses?beta=true`, {
			method: "POST",
			body: "{}",
		});

		assert.equal(runs[0].data.endpoint, "responses?beta=true");
	});

	it("lowercases header names so case-variant duplicates collapse", async () => {
		const { binding, runs } = fakeLegacyBinding();
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

		await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
			method: "POST",
			headers: { "Anthropic-Version": "2023-06-01" },
			body: "{}",
		});

		assert.deepEqual(runs[0].data.headers, { "anthropic-version": "2023-06-01" });
	});

	it("lets init headers replace a Request input's headers, per the fetch spec", async () => {
		const { binding, runs } = fakeLegacyBinding();
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

		await fetchFn(
			new Request(`${BASE_URL}/anthropic/v1/messages`, {
				method: "POST",
				headers: { "x-from-request": "yes" },
				body: "{}",
			}),
			{ headers: { "x-from-init": "yes" } },
		);

		assert.equal(runs[0].data.headers["x-from-init"], "yes");
		assert.equal(runs[0].data.headers["x-from-request"], undefined);
	});

	it("strips gateway auth and derived headers, forwards the rest", async () => {
		const { binding, runs } = fakeLegacyBinding();
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

		await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": "17",
				"CF-AIG-Authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
				"cf-aig-metadata": '{"user":"42"}',
				"anthropic-version": "2023-06-01",
				"x-api-key": "provider-key",
			},
			body: "{}",
		});

		const headers = Object.fromEntries(
			Object.entries(runs[0].data.headers).map(([key, value]) => [key.toLowerCase(), value]),
		);
		assert.equal(headers["cf-aig-authorization"], undefined);
		assert.equal(headers["content-length"], undefined);
		assert.equal(headers["cf-aig-metadata"], '{"user":"42"}');
		assert.equal(headers["anthropic-version"], "2023-06-01");
		// Provider auth headers pass through: that is how request-supplied (BYOK) keys ride.
		assert.equal(headers["x-api-key"], "provider-key");
	});

	it("accepts Request inputs and forwards their headers and body", async () => {
		const { binding, runs } = fakeLegacyBinding();
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

		await fetchFn(
			new Request(`${BASE_URL}/openai/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ stream: true }),
			}),
		);

		assert.equal(runs.length, 1);
		assert.equal(runs[0].data.provider, "openai");
		assert.equal(runs[0].data.endpoint, "chat/completions");
		assert.deepEqual(runs[0].data.query, { stream: true });
		assert.equal(runs[0].data.headers["content-type"], "application/json");
	});

	it("forwards the abort signal", async () => {
		const { binding, runs } = fakeLegacyBinding();
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });
		const controller = new AbortController();

		await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
			method: "POST",
			body: "{}",
			signal: controller.signal,
		});

		assert.equal(runs[0].options?.signal, controller.signal);
	});

	it("lets an explicit `signal: null` in init clear a Request input's signal, per the fetch spec", async () => {
		const { binding, runs } = fakeLegacyBinding();
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });
		const controller = new AbortController();

		await fetchFn(
			new Request(`${BASE_URL}/anthropic/v1/messages`, {
				method: "POST",
				body: "{}",
				signal: controller.signal,
			}),
			{ signal: null },
		);

		assert.equal(runs.length, 1);
		assert.equal(runs[0].options?.signal, undefined);
	});

	it("returns the binding response untouched, including streaming bodies", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
				controller.close();
			},
		});
		const bindingResponse = new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1" },
		});
		const { binding } = fakeLegacyBinding(bindingResponse);
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

		const response = await fetchFn(`${BASE_URL}/workers-ai/v1/chat/completions`, {
			method: "POST",
			body: "{}",
		});

		assert.equal(response, bindingResponse);
		assert.equal(response.headers.get("cf-aig-log-id"), "log-1");
		assert.equal(await response.text(), "data: {}\n\n");
	});

	it("rejects in-prefix requests the universal endpoint cannot express", async () => {
		const { binding, runs } = fakeLegacyBinding();
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

		await assert.rejects(fetchFn(`${BASE_URL}/anthropic/v1/messages`, { method: "GET" }), /cannot express GET/);
		await assert.rejects(
			fetchFn(`${BASE_URL}/anthropic/v1/messages`, { method: "POST", body: "not json" }),
			/non-JSON body/,
		);
		await assert.rejects(
			fetchFn(`${BASE_URL}/anthropic`, { method: "POST", body: "{}" }),
			/missing provider\/endpoint path/,
		);
		assert.equal(runs.length, 0);
	});

	it("rejects URLs outside the gateway prefix: transport selection is the caller's", async () => {
		// Silent passthrough would ship the auth sentinel to whatever host the URL names; a
		// misconfigured baseUrl must fail loudly instead.
		const { binding, runs } = fakeLegacyBinding();
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

		await assert.rejects(
			fetchFn("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" }),
			/outside the configured gateway prefix/,
		);
		// Same origin, different path (another account's gateway) is just as out-of-prefix.
		await assert.rejects(
			fetchFn("https://gateway.ai.cloudflare.com/v1/other-account/my-gateway/anthropic/v1/messages", {
				method: "POST",
				body: "{}",
			}),
			/outside the configured gateway prefix/,
		);
		assert.equal(runs.length, 0);
	});

	it("matches and splits on the URL-normalized path, as real fetch would send it", async () => {
		const { binding, runs } = fakeLegacyBinding();
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

		// Dot segments normalize away before the provider/endpoint split, so a lexical variant
		// routes exactly like its normal form (raw string prefixing would split it differently).
		await fetchFn(`${BASE_URL}/anthropic/../anthropic/v1/./messages`, {
			method: "POST",
			body: JSON.stringify({ model: "claude" }),
		});
		assert.deepEqual(
			runs.map((run) => [run.data.provider, run.data.endpoint]),
			[["anthropic", "v1/messages"]],
		);

		// A dot-segment URL that resolves outside the prefix is rejected even though it starts
		// with the prefix as a raw string.
		await assert.rejects(
			fetchFn(`${BASE_URL}/../other-gateway/anthropic/v1/messages`, { method: "POST", body: "{}" }),
			/outside the configured gateway prefix/,
		);
		assert.equal(runs.length, 1);
	});

	it("consumes a one-shot stream body for the JSON probe", async () => {
		const { binding, runs } = fakeLegacyBinding();
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });
		const streamOf = (text: string) =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(text));
					controller.close();
				},
			});

		// JSON stream body: consumed once, reaches the binding as the parsed query.
		await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
			method: "POST",
			body: streamOf('{"model":"claude"}'),
			duplex: "half",
		} as RequestInit);
		assert.equal(runs.length, 1);
		assert.deepEqual(runs[0].data.query, { model: "claude" });

		// Non-JSON stream body: rejects like any other non-JSON body (never replayed).
		await assert.rejects(
			fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
				method: "POST",
				body: streamOf("not json"),
				duplex: "half",
			} as RequestInit),
			/non-JSON body/,
		);
		assert.equal(runs.length, 1);
	});

	it("keeps SDK placeholder auth out of entries when paired with null auth headers", async () => {
		// The full header contract from the module docs: the sentinel satisfies pi's request-auth
		// check, and the explicit nulls make the OpenAI SDK delete its own `Authorization: Bearer
		// unused` placeholder before the request reaches the shim.
		const { binding, runs } = fakeLegacyBinding(
			Response.json({ error: { type: "bad_request", message: "stubbed" } }, { status: 400 }),
		);
		const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test Model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: `${BASE_URL}/openai`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};

		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				headers: {
					"cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
					Authorization: null,
					"x-api-key": null,
				},
				fetch: fetchFn,
				maxRetries: 0,
			},
		).result();

		assert.equal(result.stopReason, "error");
		assert.equal(runs.length, 1);
		assert.equal(runs[0].data.provider, "openai");
		const headerNames = Object.keys(runs[0].data.headers);
		assert.equal(headerNames.includes("authorization"), false);
		assert.equal(headerNames.includes("x-api-key"), false);
		assert.equal(headerNames.includes("cf-aig-authorization"), false);
	});
});

const BINDING_PREFIX = "https://workers-binding.ai/ai-gateway/gateways/my-gateway";
const PASSTHROUGH_OPTIONS = { baseUrl: BINDING_PREFIX, gateway: "my-gateway" };

function fakeFetchBinding(response?: Response) {
	const calls: Array<{ input: Request | string | URL; init?: RequestInit }> = [];
	const binding: AiGatewayBinding = {
		aiGatewayLogId: null,
		fetch: (input: Request | string | URL, init?: RequestInit) => {
			calls.push({ input, init });
			return Promise.resolve(response ?? new Response("{}"));
		},
	};
	return { binding, calls };
}

describe("createGatewayBindingFetch binding.fetch() passthrough", () => {
	it("passes input, init, and the streaming response through by identity", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
				controller.close();
			},
		});
		const bindingResponse = new Response(stream, {
			headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1" },
		});
		const { binding, calls } = fakeFetchBinding(bindingResponse);
		const fetchFn = createGatewayBindingFetch({ binding, ...PASSTHROUGH_OPTIONS });
		const request = new Request(`${BINDING_PREFIX}/anthropic/v1/messages?beta=true`, {
			method: "PATCH",
			headers: { "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}` },
			body: "unparsed body",
		});
		const init: RequestInit = { headers: { "x-init": "yes" } };

		const response = await fetchFn(request, init);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].input, request);
		assert.equal(calls[0].init, init);
		assert.equal(response, bindingResponse);
		assert.equal(await response.text(), "data: {}\n\n");
	});

	it("ignores legacy baseUrl and gateway translation options", async () => {
		const { binding, calls } = fakeFetchBinding();
		const fetchFn = createGatewayBindingFetch({
			binding,
			baseUrl: "https://gateway.ai.cloudflare.com/v1/wrong-account/wrong-gateway",
			gateway: "wrong-gateway",
		});
		const url = "https://workers-binding.ai/ai-gateway/gateways/real-gateway/openai/responses";

		await fetchFn(url, { method: "GET" });

		assert.equal(calls.length, 1);
		assert.equal(calls[0].input, url);
		assert.deepEqual(calls[0].init, { method: "GET" });
	});

	it("rejects a binding with neither fetch() nor gateway() at construction", () => {
		assert.throws(
			() => createGatewayBindingFetch({ binding: { aiGatewayLogId: null }, ...PASSTHROUGH_OPTIONS }),
			/does not expose fetch\(\)/,
		);
	});

	it("keeps SDK-generated provider auth headers off the passthrough when explicitly nulled", async () => {
		const { binding, calls } = fakeFetchBinding(
			Response.json({ error: { type: "bad_request", message: "stubbed" } }, { status: 400 }),
		);
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test Model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: `${BINDING_PREFIX}/openai`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};

		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				headers: {
					"cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
					Authorization: null,
					"x-api-key": null,
				},
				fetch: createGatewayBindingFetch({ binding, ...PASSTHROUGH_OPTIONS }),
				maxRetries: 0,
			},
		).result();

		assert.equal(result.stopReason, "error");
		assert.equal(calls.length, 1);
		const initHeaders = new Headers(calls[0].init?.headers);
		assert.equal(initHeaders.has("authorization"), false);
		assert.equal(initHeaders.has("x-api-key"), false);
		assert.equal(initHeaders.get("cf-aig-authorization"), `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`);
	});
});
