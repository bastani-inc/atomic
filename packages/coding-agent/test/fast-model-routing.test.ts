import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type ModelFastRoute,
	type OpenAICodexResponsesOptions,
	type OpenAIResponsesOptions,
	type SimpleStreamOptions,
} from "@bastani/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	buildOpenAIResponsesFastRouteOptions,
	type FastRouteStreamers,
	getModelFastRoute,
	resolveUpstreamModelId,
	streamWithFastRoute,
	usesChatGptCodexTransport,
	usesFirstPartyCodexRouting,
	withChatGptCodexTransportRouting,
	withCodexFastRouteHeaders,
	withFastRouteStreamOptions,
} from "../src/core/fast-model-routing.ts";
import {
	CODEX_FAST_ROUTE_HEADER,
	CODEX_FAST_ROUTE_ORIGINATOR,
	forceCodexFastRouteOriginator,
	wrapCodexFastRouteFetch,
	wrapCodexFastRouteWebSocket,
} from "../src/core/fast-model-routing-transport.ts";
import { FAST_MODEL_SERVICE_TIER } from "../src/core/fast-model-variants.ts";

function fullModel(partial: Partial<Model<Api>>): Model<Api> {
	return {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...partial,
	};
}

const serviceTierRoute: ModelFastRoute = {
	baseModelId: "gpt-5.1-codex",
	upstreamModelId: "gpt-5.1-codex",
	serviceTier: FAST_MODEL_SERVICE_TIER,
};

interface CapturedStreamCall {
	name: keyof FastRouteStreamers;
	model: Model<Api>;
	options?: SimpleStreamOptions | OpenAIResponsesOptions | OpenAICodexResponsesOptions;
}

function doneStream(): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.end();
	return stream;
}

function makeStreamers(calls: CapturedStreamCall[]): FastRouteStreamers {
	return {
		streamSimple: (streamModel, _context, options) => {
			calls.push({ name: "streamSimple", model: streamModel, options });
			return doneStream();
		},
		streamOpenAIResponses: (streamModel, _context, options) => {
			calls.push({ name: "streamOpenAIResponses", model: streamModel, options });
			return doneStream();
		},
		streamOpenAICodexResponses: (streamModel, _context, options) => {
			calls.push({ name: "streamOpenAICodexResponses", model: streamModel, options });
			return doneStream();
		},
	};
}

const emptyContext: Context = { messages: [] };

describe("fast model route resolution", () => {
	it("reads fast semantics only from explicit route metadata", () => {
		const derived = fullModel({ id: "gpt-5.1-codex-fast", fastRoute: serviceTierRoute });
		assert.deepEqual(getModelFastRoute(derived), serviceTierRoute);
		// An exact provider/models.json/extension-owned `-fast` ID with no metadata is an ordinary model.
		assert.equal(getModelFastRoute(fullModel({ id: "gpt-5.1-codex-fast" })), undefined);
		assert.equal(getModelFastRoute(fullModel({})), undefined);
	});

	it("names the base upstream model ID for an OpenAI-style service-tier route", () => {
		const selected = fullModel({ id: "gpt-5.1-codex-fast", fastRoute: serviceTierRoute });
		assert.equal(resolveUpstreamModelId(selected), "gpt-5.1-codex");
		// Only the serialized request differs; the selected model object is untouched, so everything
		// Atomic records keeps the canonical `-fast` identity.
		assert.equal(selected.id, "gpt-5.1-codex-fast");
	});

	it("names the provider's own advertised fast ID when the route names one", () => {
		const copilotFast = fullModel({
			provider: "github-copilot",
			api: "anthropic-messages",
			id: "claude-opus-4.8-fast",
			fastRoute: { baseModelId: "claude-opus-4.8", upstreamModelId: "claude-opus-4.8-fast" },
		});
		assert.equal(resolveUpstreamModelId(copilotFast), "claude-opus-4.8-fast");
	});

	it("names a normal model's own ID", () => {
		assert.equal(resolveUpstreamModelId(fullModel({})), "gpt-5.1-codex");
	});

	it("identifies the shared ChatGPT Codex transport by API, including renamed providers", () => {
		assert.equal(usesChatGptCodexTransport(fullModel({ api: "openai-codex-responses" })), true);
		assert.equal(
			usesChatGptCodexTransport(fullModel({ provider: "codex-proxy", api: "openai-codex-responses" })),
			true,
		);
		assert.equal(usesChatGptCodexTransport(fullModel({ api: "openai-responses" })), false);
		assert.equal(usesChatGptCodexTransport(fullModel({ api: "azure-openai-responses" })), false);
	});

	it("adds serviceTier to stream options only for a service-tier route", () => {
		assert.equal(withFastRouteStreamOptions(undefined, undefined), undefined);
		assert.deepEqual(withFastRouteStreamOptions(undefined, { temperature: 0.2 }), { temperature: 0.2 });
		assert.deepEqual(
			withFastRouteStreamOptions({ baseModelId: "m", upstreamModelId: "m-fast" }, { temperature: 0.2 }),
			{ temperature: 0.2 },
		);
		assert.deepEqual(withFastRouteStreamOptions(serviceTierRoute, { temperature: 0.2 }), {
			temperature: 0.2,
			headers: undefined,
			serviceTier: FAST_MODEL_SERVICE_TIER,
		});
	});

	it("preserves the configured stream deadline through native option reconstruction", () => {
		const model = fullModel({});
		expect(buildOpenAIResponsesFastRouteOptions(model, { streamDeadlineMs: 1234 }).streamDeadlineMs).toBe(1234);
		expect(buildOpenAIResponsesFastRouteOptions(model, { streamDeadlineMs: 0 }).streamDeadlineMs).toBe(0);
	});

	it("defers the Codex harness identity until the final provider payload", () => {
		const codexModel = fullModel({
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			id: "gpt-5.6-sol",
		});
		const enabled = withFastRouteStreamOptions(serviceTierRoute, { headers: { "x-test": "yes" } });
		const enabledHeaders = new Headers(enabled?.headers as HeadersInit);

		expect(enabled?.serviceTier).toBe(FAST_MODEL_SERVICE_TIER);
		expect(enabledHeaders.get("originator")).toBeNull();
		expect(enabledHeaders.get(CODEX_FAST_ROUTE_HEADER)).toBeNull();
		expect(enabledHeaders.get("x-test")).toBe("yes");
		expect(usesFirstPartyCodexRouting(codexModel)).toBe(true);
	});

	it("replaces a stale identity header and leaves other endpoints alone", () => {
		const firstParty = fullModel({
			provider: "openai-codex",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api/codex/responses",
		});
		const replaced = withCodexFastRouteHeaders(
			firstParty,
			{ Originator: "pi", "X-Codex-Routing-Hint": "stale" },
			true,
		);
		const replacedHeaders = new Headers(replaced as HeadersInit);
		expect(replacedHeaders.get("originator")).toBe(CODEX_FAST_ROUTE_ORIGINATOR);
		expect(replacedHeaders.get(CODEX_FAST_ROUTE_HEADER)).toBe("model=gpt-5.1-codex;tier=priority");

		expect(usesFirstPartyCodexRouting(firstParty)).toBe(true);
		expect(usesFirstPartyCodexRouting(fullModel({ provider: "openai" }))).toBe(false);
		expect(
			usesFirstPartyCodexRouting(
				fullModel({ provider: "openai-codex", baseUrl: "https://proxy.example/backend-api" }),
			),
		).toBe(false);
		expect(withCodexFastRouteHeaders(fullModel({ provider: "openai" }), { "x-test": "yes" }, true)).toEqual({
			"x-test": "yes",
		});
	});

	it("uses native OpenAI Responses streaming for a service-tier route", () => {
		const calls: CapturedStreamCall[] = [];
		const streamers = makeStreamers(calls);
		const options = withFastRouteStreamOptions(serviceTierRoute, {
			apiKey: "key",
			reasoning: "medium",
			sessionId: "session-1",
			samplingParams: { top_p: 0.5 },
		});

		streamWithFastRoute(
			fullModel({ api: "openai-responses", provider: "openai", samplingParams: { top_p: 0.95, min_p: 0.1 } }),
			emptyContext,
			options,
			streamers,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("streamOpenAIResponses");
		const providerOptions = calls[0]?.options as OpenAIResponsesOptions | undefined;
		expect(providerOptions?.serviceTier).toBe(FAST_MODEL_SERVICE_TIER);
		expect(providerOptions?.reasoningEffort).toBe("medium");
		expect(providerOptions?.apiKey).toBe("key");
		expect(providerOptions?.sessionId).toBe("session-1");
		expect(providerOptions?.samplingParams).toEqual({ top_p: 0.5, min_p: 0.1 });
	});

	it("uses native OpenAI Codex Responses streaming for a service-tier route", () => {
		const calls: CapturedStreamCall[] = [];
		const streamers = makeStreamers(calls);
		const options = withFastRouteStreamOptions(serviceTierRoute, {
			apiKey: "key",
			env: { HTTPS_PROXY: "https://proxy.example" },
			reasoning: "xhigh",
			transport: "sse",
		});

		streamWithFastRoute(
			fullModel({
				api: "openai-codex-responses",
				provider: "openai-codex",
				id: "gpt-5.5",
				thinkingLevelMap: { xhigh: "xhigh" },
			}),
			emptyContext,
			options,
			streamers,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("streamOpenAICodexResponses");
		const providerOptions = calls[0]?.options as OpenAICodexResponsesOptions | undefined;
		expect(providerOptions?.serviceTier).toBe(FAST_MODEL_SERVICE_TIER);
		expect(providerOptions?.reasoningEffort).toBe("xhigh");
		expect(providerOptions?.env).toEqual({ HTTPS_PROXY: "https://proxy.example" });
		expect(providerOptions?.transport).toBe("sse");
	});

	it("falls back to the simple streamer without a service-tier route", () => {
		const calls: CapturedStreamCall[] = [];
		const streamers = makeStreamers(calls);

		streamWithFastRoute(
			fullModel({ api: "openai-responses", provider: "openai" }),
			emptyContext,
			{ apiKey: "key" },
			streamers,
		);
		// A Copilot fast route names its own upstream ID and never carries a service tier.
		streamWithFastRoute(
			fullModel({ api: "openai-responses", provider: "github-copilot", id: "gpt-5.4-fast" }),
			emptyContext,
			withFastRouteStreamOptions({ baseModelId: "gpt-5.4", upstreamModelId: "gpt-5.4-fast" }, { apiKey: "key" }),
			streamers,
		);

		expect(calls.map((call) => call.name)).toEqual(["streamSimple", "streamSimple"]);
		expect(calls[1]?.model.id).toBe("gpt-5.4-fast");
		expect((calls[1]?.options as { serviceTier?: string } | undefined)?.serviceTier).toBeUndefined();
	});
});

describe("codex fast-route first-party transport", () => {
	const codexModel = fullModel({
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		id: "gpt-5.6-sol",
	});
	const priorityHeaders = {
		originator: "pi",
		[CODEX_FAST_ROUTE_HEADER]: "model=gpt-5.6-sol;tier=priority",
		"x-atomic-codex-fast-route": "priority",
	};

	it("repairs the HTTP originator pi-ai sets after its own header merge", async () => {
		const captured: Array<string | null> = [];
		const fastFetch = wrapCodexFastRouteFetch(
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				captured.push(new Headers(init?.headers).get("originator"));
				return new Response(null, { status: 200 });
			}) as typeof globalThis.fetch,
		);

		await fastFetch("https://chatgpt.com/backend-api/codex/responses", { headers: priorityHeaders });
		await fastFetch("https://proxy.example/v1/responses", { headers: priorityHeaders });
		await fastFetch("https://chatgpt.com/backend-api/codex/responses", {
			headers: { originator: "pi", [CODEX_FAST_ROUTE_HEADER]: "model=stale;tier=priority" },
		});
		await fastFetch("https://chatgpt.com/backend-api/codex/responses", { headers: { originator: "pi" } });

		expect(captured).toEqual([CODEX_FAST_ROUTE_ORIGINATOR, CODEX_FAST_ROUTE_ORIGINATOR, "pi", "pi"]);
	});

	it("repairs the WebSocket handshake originator and wraps each constructor once", () => {
		const captured: Array<string | null> = [];
		class MockWebSocket {
			constructor(_url: string | URL, options?: { headers?: HeadersInit }) {
				captured.push(new Headers(options?.headers).get("originator"));
			}
		}
		const FastWebSocket = wrapCodexFastRouteWebSocket(MockWebSocket as never);
		expect(wrapCodexFastRouteWebSocket(MockWebSocket as never)).toBe(FastWebSocket);
		expect(wrapCodexFastRouteWebSocket(FastWebSocket)).toBe(FastWebSocket);

		new FastWebSocket("wss://chatgpt.com/backend-api/codex/responses", { headers: priorityHeaders } as never);
		new FastWebSocket("wss://proxy.example/v1/responses", { headers: priorityHeaders } as never);
		new FastWebSocket("wss://chatgpt.com/backend-api/codex/responses", {
			headers: { originator: "pi", [CODEX_FAST_ROUTE_HEADER]: "model=stale;tier=priority" },
		} as never);

		expect(captured).toEqual([CODEX_FAST_ROUTE_ORIGINATOR, CODEX_FAST_ROUTE_ORIGINATOR, "pi"]);
	});

	it("repairs marked monitoring-proxy requests on HTTP retries and WebSocket reconnects", async () => {
		const markedHeaders = priorityHeaders;
		const httpCaptured: Array<{ originator: string | null; marker: string | null }> = [];
		const fastFetch = wrapCodexFastRouteFetch(
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				httpCaptured.push({
					originator: headers.get("originator"),
					marker: headers.get("x-atomic-codex-fast-route"),
				});
				return new Response(null, { status: 200 });
			}) as typeof globalThis.fetch,
		);

		await fastFetch("https://monitor.example/backend-api/codex/responses", { headers: markedHeaders });
		await fastFetch("https://monitor.example/backend-api/codex/responses", { headers: markedHeaders });

		const websocketCaptured: Array<{ originator: string | null; marker: string | null }> = [];
		class MockWebSocket {
			constructor(_url: string | URL, options?: { headers?: HeadersInit }) {
				const headers = new Headers(options?.headers);
				websocketCaptured.push({
					originator: headers.get("originator"),
					marker: headers.get("x-atomic-codex-fast-route"),
				});
			}
		}
		const FastWebSocket = wrapCodexFastRouteWebSocket(MockWebSocket as never);
		new FastWebSocket("wss://monitor.example/backend-api/codex/responses", { headers: markedHeaders } as never);
		new FastWebSocket("wss://monitor.example/backend-api/codex/responses", { headers: markedHeaders } as never);

		expect(httpCaptured).toEqual([
			{ originator: CODEX_FAST_ROUTE_ORIGINATOR, marker: null },
			{ originator: CODEX_FAST_ROUTE_ORIGINATOR, marker: null },
		]);
		expect(websocketCaptured).toEqual(httpCaptured);
	});

	it("drops cached WebSockets when the final routing identity changes", async () => {
		const closeSessions = vi.fn<(sessionId?: string) => void>();
		const sessionId = `fast-routing-${Date.now()}-${Math.random()}`;
		const priorityOptions = withChatGptCodexTransportRouting(codexModel, { sessionId }, true, closeSessions);
		await priorityOptions.onPayload?.({ model: codexModel.id, service_tier: FAST_MODEL_SERVICE_TIER }, codexModel);
		expect(closeSessions).not.toHaveBeenCalled();
		const normalOptions = withChatGptCodexTransportRouting(codexModel, { sessionId }, true, closeSessions);
		await normalOptions.onPayload?.({ model: codexModel.id }, codexModel);

		expect(closeSessions).toHaveBeenCalledOnce();
		expect(closeSessions).toHaveBeenCalledWith(sessionId);
	});

	it("does not activate the Codex harness identity while Fast Mode is off", async () => {
		const options = withChatGptCodexTransportRouting(
			codexModel,
			{
				headers: {
					originator: CODEX_FAST_ROUTE_ORIGINATOR,
					[CODEX_FAST_ROUTE_HEADER]: "model=stale;tier=priority",
				},
				onPayload: (payload) => ({
					...(payload as Record<string, unknown>),
					service_tier: FAST_MODEL_SERVICE_TIER,
				}),
			},
			false,
		);
		const payload = await options.onPayload?.({ model: codexModel.id }, codexModel);
		const preparedHeaders = new Headers(options.headers as HeadersInit);
		preparedHeaders.set("originator", "pi");
		preparedHeaders.set(CODEX_FAST_ROUTE_HEADER, "model=stale;tier=priority");
		const headers = forceCodexFastRouteOriginator(
			"https://monitor.example/backend-api/codex/responses",
			preparedHeaders,
		);

		expect(payload).toMatchObject({ service_tier: FAST_MODEL_SERVICE_TIER });
		expect(headers.get("originator")).toBe("pi");
		expect(headers.get(CODEX_FAST_ROUTE_HEADER)).toBeNull();
		expect(headers.get("x-atomic-codex-fast-route")).toBeNull();
	});

	it("sends tier, identity, and routing hint through the real Codex SSE transport", async () => {
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } }),
		).toString("base64url");
		let capturedHeaders: Headers | undefined;
		let capturedPayload: Record<string, unknown> | undefined;
		const fetchImplementation = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = new Headers(init?.headers);
			const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
			const body =
				capturedHeaders.get("content-encoding") === "zstd"
					? zstdDecompressSync(bytes).toString("utf8")
					: new TextDecoder().decode(bytes);
			capturedPayload = JSON.parse(body) as Record<string, unknown>;
			const completed = {
				type: "response.completed",
				response: {
					id: "resp_fast",
					status: "completed",
					service_tier: FAST_MODEL_SERVICE_TIER,
					usage: {
						input_tokens: 0,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens: 0,
						total_tokens: 0,
					},
				},
			};
			return new Response(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const stream = streamWithFastRoute(
			codexModel,
			emptyContext,
			withFastRouteStreamOptions(
				{ baseModelId: codexModel.id, upstreamModelId: codexModel.id, serviceTier: FAST_MODEL_SERVICE_TIER },
				{
					apiKey: `header.${tokenPayload}.signature`,
					fetch: fetchImplementation as typeof globalThis.fetch,
					transport: "sse",
				},
			),
		);
		await stream.result();

		expect(capturedPayload?.service_tier).toBe(FAST_MODEL_SERVICE_TIER);
		expect(capturedHeaders?.get("originator")).toBe(CODEX_FAST_ROUTE_ORIGINATOR);
		expect(capturedHeaders?.get(CODEX_FAST_ROUTE_HEADER)).toBe("model=gpt-5.6-sol;tier=priority");
	});

	it("routes a renamed provider through a monitoring proxy", async () => {
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } }),
		).toString("base64url");
		const aliasModel = fullModel({
			api: "openai-codex-responses",
			provider: "codex-proxy",
			baseUrl: "https://monitor.example/backend-api",
			id: "gpt-5.6-sol",
		});
		let capturedUrl: string | undefined;
		let capturedHeaders: Headers | undefined;
		const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			capturedHeaders = new Headers(init?.headers);
			const completed = {
				type: "response.completed",
				response: {
					id: "resp_alias_fast",
					status: "completed",
					service_tier: FAST_MODEL_SERVICE_TIER,
					usage: {
						input_tokens: 0,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens: 0,
						total_tokens: 0,
					},
				},
			};
			return new Response(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		const stream = streamWithFastRoute(
			aliasModel,
			emptyContext,
			withFastRouteStreamOptions(
				{ baseModelId: aliasModel.id, upstreamModelId: aliasModel.id, serviceTier: FAST_MODEL_SERVICE_TIER },
				{
					apiKey: `header.${tokenPayload}.signature`,
					fetch: fetchImplementation as typeof globalThis.fetch,
					transport: "sse",
				},
			),
		);
		await stream.result();

		expect(capturedUrl).toBe("https://monitor.example/backend-api/codex/responses");
		expect(capturedHeaders?.get("originator")).toBe(CODEX_FAST_ROUTE_ORIGINATOR);
		expect(capturedHeaders?.get(CODEX_FAST_ROUTE_HEADER)).toBe("model=gpt-5.6-sol;tier=priority");
		expect(capturedHeaders?.get("x-atomic-codex-fast-route")).toBeNull();
	});

	it("keeps normal identity when the final request payload is not priority", async () => {
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-default" } }),
		).toString("base64url");
		let capturedHeaders: Headers | undefined;
		let capturedPayload: Record<string, unknown> | undefined;
		const fetchImplementation = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = new Headers(init?.headers);
			const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
			const body =
				capturedHeaders.get("content-encoding") === "zstd"
					? zstdDecompressSync(bytes).toString("utf8")
					: new TextDecoder().decode(bytes);
			capturedPayload = JSON.parse(body) as Record<string, unknown>;
			const completed = {
				type: "response.completed",
				response: {
					id: "resp_default",
					status: "completed",
					service_tier: "default",
					usage: {
						input_tokens: 0,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens: 0,
						total_tokens: 0,
					},
				},
			};
			return new Response(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const stream = streamWithFastRoute(
			codexModel,
			emptyContext,
			withFastRouteStreamOptions(
				{ baseModelId: codexModel.id, upstreamModelId: codexModel.id, serviceTier: FAST_MODEL_SERVICE_TIER },
				{
					apiKey: `header.${tokenPayload}.signature`,
					fetch: fetchImplementation as typeof globalThis.fetch,
					transport: "sse",
					onPayload: (payload) => ({ ...(payload as Record<string, unknown>), service_tier: "default" }),
				},
			),
		);
		await stream.result();

		expect(capturedPayload?.service_tier).toBe("default");
		expect(capturedHeaders?.get("originator")).toBe("pi");
		expect(capturedHeaders?.get(CODEX_FAST_ROUTE_HEADER)).toBeNull();
		expect(capturedHeaders?.get("x-atomic-codex-fast-route")).toBeNull();
	});

	it("keeps pi's identity on the same transport when fast mode is disabled", async () => {
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } }),
		).toString("base64url");
		let capturedHeaders: Headers | undefined;
		const fetchImplementation = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = new Headers(init?.headers);
			const completed = {
				type: "response.completed",
				response: {
					id: "resp_normal",
					status: "completed",
					usage: {
						input_tokens: 0,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens: 0,
						total_tokens: 0,
					},
				},
			};
			return new Response(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const stream = streamWithFastRoute(codexModel, emptyContext, {
			apiKey: `header.${tokenPayload}.signature`,
			fetch: fetchImplementation as typeof globalThis.fetch,
			transport: "sse",
		});
		await stream.result();

		expect(capturedHeaders?.get("originator")).toBe("pi");
		expect(capturedHeaders?.get(CODEX_FAST_ROUTE_HEADER)).toBeNull();
	});
});
