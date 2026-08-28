import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type OpenAICodexResponsesOptions,
	type OpenAIResponsesOptions,
	type SimpleStreamOptions,
} from "@bastani/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	buildOpenAIResponsesCodexFastModeOptions,
	CODEX_FAST_MODE_SERVICE_TIER,
	type CodexFastModeStreamers,
	getCodexFastModeScope,
	hasSupportedCodexFastModeModel,
	isCodexFastModeCandidateModelId,
	isCodexFastModeEnabledForScope,
	isCodexFastModeEnabledForSession,
	isCodexFastModeSupportedProvider,
	isGitHubCopilotFastModeSupportedModel,
	shouldApplyCodexFastModeForScope,
	streamWithCodexFastMode,
	usesFirstPartyCodexRouting,
	withChatGptCodexTransportRouting,
	withCodexFastModeHeaders,
	withCodexFastModePayload,
	withCodexFastModeStreamOptions,
} from "../src/core/codex-fast-mode.ts";
import {
	CODEX_FAST_MODE_ORIGINATOR,
	CODEX_FAST_MODE_ROUTING_HEADER,
	forceCodexFastModeOriginator,
	wrapCodexFastModeFetch,
	wrapCodexFastModeWebSocket,
} from "../src/core/codex-fast-mode-transport.ts";
import type { OrchestrationContext } from "../src/core/extensions/index.ts";

function providerModel(provider: string): Pick<Model<Api>, "provider"> {
	return { provider };
}

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

interface CapturedStreamCall {
	name: keyof CodexFastModeStreamers;
	model: Model<Api>;
	options?: SimpleStreamOptions | OpenAIResponsesOptions | OpenAICodexResponsesOptions;
}

function doneStream(): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.end();
	return stream;
}

function makeStreamers(calls: CapturedStreamCall[]): CodexFastModeStreamers {
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

const workflowContext: OrchestrationContext = {
	kind: "workflow-stage",
	workflowRunId: "run-1",
	workflowStageId: "stage-1",
	workflowStageName: "Stage 1",
	constraints: {
		disableWorkflowTool: true,
	},
};

describe("codex fast mode helpers", () => {
	it("supports only OpenAI and OpenAI Codex providers", () => {
		expect(isCodexFastModeSupportedProvider("openai")).toBe(true);
		expect(isCodexFastModeSupportedProvider("openai-codex")).toBe(true);
		expect(isCodexFastModeSupportedProvider("github-copilot")).toBe(false);
		expect(isCodexFastModeSupportedProvider("azure-openai-responses")).toBe(false);
	});

	it("detects supported models from provider IDs and the shared Codex transport", () => {
		expect(hasSupportedCodexFastModeModel([providerModel("github-copilot")])).toBe(false);
		expect(hasSupportedCodexFastModeModel([providerModel("github-copilot"), providerModel("openai")])).toBe(true);
		expect(hasSupportedCodexFastModeModel([providerModel("openai-codex")])).toBe(true);
		expect(
			hasSupportedCodexFastModeModel([fullModel({ provider: "codex-proxy", api: "openai-codex-responses" })]),
		).toBe(true);
	});

	it("recognizes only the exact entitled Copilot fast sibling", () => {
		const model = fullModel({ provider: "github-copilot", id: "claude-opus-4.8", api: "anthropic-messages" });
		const entitledCredential = {
			type: "oauth" as const,
			access: "token",
			refresh: "refresh",
			expires: Number.MAX_SAFE_INTEGER,
			fastModelIds: ["claude-opus-4.8-fast"],
		};

		assert.equal(isGitHubCopilotFastModeSupportedModel(model, entitledCredential), true);
		assert.equal(hasSupportedCodexFastModeModel([model], entitledCredential), true);
		assert.equal(
			isGitHubCopilotFastModeSupportedModel(model, { ...entitledCredential, fastModelIds: ["other-fast"] }),
			false,
		);
		assert.equal(isGitHubCopilotFastModeSupportedModel(model, undefined), false);
		assert.equal(
			isGitHubCopilotFastModeSupportedModel(fullModel({ provider: "anthropic" }), entitledCredential),
			false,
		);
	});

	it("detects candidate model ids with the shared provider policy", () => {
		expect(isCodexFastModeCandidateModelId("openai/gpt-5.1-codex")).toBe(true);
		expect(isCodexFastModeCandidateModelId("openai-codex/gpt-5.1-codex")).toBe(true);
		expect(isCodexFastModeCandidateModelId("anthropic/claude-sonnet-4")).toBe(false);
		expect(isCodexFastModeCandidateModelId("gpt-5.1-codex")).toBe(false);
		expect(isCodexFastModeCandidateModelId(undefined)).toBe(false);
	});

	it("selects chat versus workflow scope from orchestration context", () => {
		expect(getCodexFastModeScope(undefined)).toBe("chat");
		expect(getCodexFastModeScope(workflowContext)).toBe("workflow");
		expect(isCodexFastModeEnabledForScope({ chat: true, workflow: false }, "chat")).toBe(true);
		expect(isCodexFastModeEnabledForScope({ chat: true, workflow: false }, "workflow")).toBe(false);
		expect(isCodexFastModeEnabledForSession({ chat: true, workflow: false }, undefined)).toBe(true);
		expect(isCodexFastModeEnabledForSession({ chat: true, workflow: false }, workflowContext)).toBe(false);
		expect(isCodexFastModeEnabledForSession({ chat: false, workflow: true }, workflowContext)).toBe(true);
		expect(
			shouldApplyCodexFastModeForScope(providerModel("openai"), { chat: false, workflow: true }, "workflow"),
		).toBe(true);
		expect(
			shouldApplyCodexFastModeForScope(providerModel("github-copilot"), { chat: false, workflow: true }, "workflow"),
		).toBe(false);
	});

	it("applies fast mode to renamed providers on the shared Codex transport", () => {
		expect(
			shouldApplyCodexFastModeForScope(
				fullModel({ provider: "codex-alias", api: "openai-codex-responses" }),
				{ chat: true, workflow: false },
				"chat",
			),
		).toBe(true);
	});

	it("adds serviceTier to stream options only when enabled", () => {
		const model = fullModel({});
		expect(withCodexFastModeStreamOptions(model, undefined, false)).toBeUndefined();
		expect(withCodexFastModeStreamOptions(model, { temperature: 0.2 }, false)).toEqual({ temperature: 0.2 });
		expect(withCodexFastModeStreamOptions(model, { temperature: 0.2 }, true)).toEqual({
			temperature: 0.2,
			headers: undefined,
			serviceTier: CODEX_FAST_MODE_SERVICE_TIER,
		});
	});

	it("preserves the configured stream deadline through native option reconstruction", () => {
		const model = fullModel({});
		expect(buildOpenAIResponsesCodexFastModeOptions(model, { streamDeadlineMs: 1234 }).streamDeadlineMs).toBe(1234);
		expect(buildOpenAIResponsesCodexFastModeOptions(model, { streamDeadlineMs: 0 }).streamDeadlineMs).toBe(0);
	});

	it("defers the Codex harness identity until the final provider payload", () => {
		const codexModel = fullModel({
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			id: "gpt-5.6-sol",
		});
		const enabled = withCodexFastModeStreamOptions(codexModel, { headers: { "x-test": "yes" } }, true);
		const enabledHeaders = new Headers(enabled?.headers as HeadersInit);

		expect(enabled?.serviceTier).toBe(CODEX_FAST_MODE_SERVICE_TIER);
		expect(enabledHeaders.get("originator")).toBeNull();
		expect(enabledHeaders.get(CODEX_FAST_MODE_ROUTING_HEADER)).toBeNull();
		expect(enabledHeaders.get("x-test")).toBe("yes");

		const disabled = withCodexFastModeStreamOptions(codexModel, { headers: { "x-test": "yes" } }, false);
		expect(new Headers(disabled?.headers as HeadersInit).get("originator")).toBeNull();
	});

	it("replaces a stale identity header and leaves other endpoints alone", () => {
		const firstParty = fullModel({
			provider: "openai-codex",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api/codex/responses",
		});
		const replaced = withCodexFastModeHeaders(
			firstParty,
			{ Originator: "pi", "X-Codex-Routing-Hint": "stale" },
			true,
		);
		const replacedHeaders = new Headers(replaced as HeadersInit);
		expect(replacedHeaders.get("originator")).toBe(CODEX_FAST_MODE_ORIGINATOR);
		expect(replacedHeaders.get(CODEX_FAST_MODE_ROUTING_HEADER)).toBe("model=gpt-5.1-codex;tier=priority");

		expect(usesFirstPartyCodexRouting(firstParty)).toBe(true);
		expect(usesFirstPartyCodexRouting(fullModel({ provider: "openai" }))).toBe(false);
		expect(
			usesFirstPartyCodexRouting(
				fullModel({ provider: "openai-codex", baseUrl: "https://proxy.example/backend-api" }),
			),
		).toBe(false);
		expect(withCodexFastModeHeaders(fullModel({ provider: "openai" }), { "x-test": "yes" }, true)).toEqual({
			"x-test": "yes",
		});
	});

	it("adds service_tier to object payloads without overwriting existing values", () => {
		expect(withCodexFastModePayload("not-object", true)).toBe("not-object");
		expect(withCodexFastModePayload(["array"], true)).toEqual(["array"]);
		expect(withCodexFastModePayload({ model: "gpt" }, false)).toEqual({ model: "gpt" });
		expect(withCodexFastModePayload({ model: "gpt" }, true)).toEqual({
			model: "gpt",
			service_tier: CODEX_FAST_MODE_SERVICE_TIER,
		});
		expect(withCodexFastModePayload({ service_tier: "default" }, true)).toEqual({ service_tier: "default" });
		expect(withCodexFastModePayload({ service_tier: undefined }, true)).toEqual({
			service_tier: CODEX_FAST_MODE_SERVICE_TIER,
		});
	});

	it("uses native OpenAI Responses streaming when fast mode is active", () => {
		const calls: CapturedStreamCall[] = [];
		const streamers = makeStreamers(calls);
		const options = withCodexFastModeStreamOptions(
			fullModel({}),
			{ apiKey: "key", reasoning: "medium", sessionId: "session-1", samplingParams: { top_p: 0.5 } },
			true,
		);

		streamWithCodexFastMode(
			fullModel({
				api: "openai-responses",
				provider: "openai",
				samplingParams: { top_p: 0.95, min_p: 0.1 },
			}),
			emptyContext,
			options,
			streamers,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("streamOpenAIResponses");
		const providerOptions = calls[0]?.options as OpenAIResponsesOptions | undefined;
		expect(providerOptions?.serviceTier).toBe(CODEX_FAST_MODE_SERVICE_TIER);
		expect(providerOptions?.reasoningEffort).toBe("medium");
		expect(providerOptions?.apiKey).toBe("key");
		expect(providerOptions?.sessionId).toBe("session-1");
		expect(providerOptions?.samplingParams).toEqual({ top_p: 0.5, min_p: 0.1 });
	});

	it("uses native OpenAI Codex Responses streaming when fast mode is active", () => {
		const calls: CapturedStreamCall[] = [];
		const streamers = makeStreamers(calls);
		const options = withCodexFastModeStreamOptions(
			fullModel({ api: "openai-codex-responses", provider: "openai-codex" }),
			{ apiKey: "key", env: { HTTPS_PROXY: "https://proxy.example" }, reasoning: "xhigh", transport: "sse" },
			true,
		);

		streamWithCodexFastMode(
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
		expect(providerOptions?.serviceTier).toBe(CODEX_FAST_MODE_SERVICE_TIER);
		expect(providerOptions?.reasoningEffort).toBe("xhigh");
		expect(providerOptions?.env).toEqual({ HTTPS_PROXY: "https://proxy.example" });
		expect(providerOptions?.transport).toBe("sse");
	});

	it("falls back to the normal simple streamer when native fast mode should not apply", () => {
		const calls: CapturedStreamCall[] = [];
		const streamers = makeStreamers(calls);

		streamWithCodexFastMode(
			fullModel({ api: "openai-responses", provider: "openai" }),
			emptyContext,
			withCodexFastModeStreamOptions(fullModel({}), { apiKey: "key" }, false),
			streamers,
		);
		streamWithCodexFastMode(
			fullModel({ api: "openai-responses", provider: "github-copilot" }),
			emptyContext,
			withCodexFastModeStreamOptions({ apiKey: "key" }, true),
			streamers,
		);

		expect(calls.map((call) => call.name)).toEqual(["streamSimple", "streamSimple"]);
	});
});

describe("codex fast mode first-party transport", () => {
	const codexModel = fullModel({
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		id: "gpt-5.6-sol",
	});
	const priorityHeaders = {
		originator: "pi",
		[CODEX_FAST_MODE_ROUTING_HEADER]: "model=gpt-5.6-sol;tier=priority",
		"x-atomic-codex-fast-mode": "priority",
	};

	it("repairs the HTTP originator pi-ai sets after its own header merge", async () => {
		const captured: Array<string | null> = [];
		const fastFetch = wrapCodexFastModeFetch(
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				captured.push(new Headers(init?.headers).get("originator"));
				return new Response(null, { status: 200 });
			}) as typeof globalThis.fetch,
		);

		await fastFetch("https://chatgpt.com/backend-api/codex/responses", { headers: priorityHeaders });
		await fastFetch("https://proxy.example/v1/responses", { headers: priorityHeaders });
		await fastFetch("https://chatgpt.com/backend-api/codex/responses", {
			headers: { originator: "pi", [CODEX_FAST_MODE_ROUTING_HEADER]: "model=stale;tier=priority" },
		});
		await fastFetch("https://chatgpt.com/backend-api/codex/responses", { headers: { originator: "pi" } });

		expect(captured).toEqual([CODEX_FAST_MODE_ORIGINATOR, CODEX_FAST_MODE_ORIGINATOR, "pi", "pi"]);
	});

	it("repairs the WebSocket handshake originator and wraps each constructor once", () => {
		const captured: Array<string | null> = [];
		class MockWebSocket {
			constructor(_url: string | URL, options?: { headers?: HeadersInit }) {
				captured.push(new Headers(options?.headers).get("originator"));
			}
		}
		const FastWebSocket = wrapCodexFastModeWebSocket(MockWebSocket as never);
		expect(wrapCodexFastModeWebSocket(MockWebSocket as never)).toBe(FastWebSocket);
		expect(wrapCodexFastModeWebSocket(FastWebSocket)).toBe(FastWebSocket);

		new FastWebSocket("wss://chatgpt.com/backend-api/codex/responses", { headers: priorityHeaders } as never);
		new FastWebSocket("wss://proxy.example/v1/responses", { headers: priorityHeaders } as never);
		new FastWebSocket("wss://chatgpt.com/backend-api/codex/responses", {
			headers: { originator: "pi", [CODEX_FAST_MODE_ROUTING_HEADER]: "model=stale;tier=priority" },
		} as never);

		expect(captured).toEqual([CODEX_FAST_MODE_ORIGINATOR, CODEX_FAST_MODE_ORIGINATOR, "pi"]);
	});

	it("repairs marked monitoring-proxy requests on HTTP retries and WebSocket reconnects", async () => {
		const markedHeaders = priorityHeaders;
		const httpCaptured: Array<{ originator: string | null; marker: string | null }> = [];
		const fastFetch = wrapCodexFastModeFetch(
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				httpCaptured.push({
					originator: headers.get("originator"),
					marker: headers.get("x-atomic-codex-fast-mode"),
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
					marker: headers.get("x-atomic-codex-fast-mode"),
				});
			}
		}
		const FastWebSocket = wrapCodexFastModeWebSocket(MockWebSocket as never);
		new FastWebSocket("wss://monitor.example/backend-api/codex/responses", { headers: markedHeaders } as never);
		new FastWebSocket("wss://monitor.example/backend-api/codex/responses", { headers: markedHeaders } as never);

		expect(httpCaptured).toEqual([
			{ originator: CODEX_FAST_MODE_ORIGINATOR, marker: null },
			{ originator: CODEX_FAST_MODE_ORIGINATOR, marker: null },
		]);
		expect(websocketCaptured).toEqual(httpCaptured);
	});

	it("drops cached WebSockets when the final routing identity changes", async () => {
		const closeSessions = vi.fn<(sessionId?: string) => void>();
		const sessionId = `fast-routing-${Date.now()}-${Math.random()}`;
		const priorityOptions = withChatGptCodexTransportRouting(codexModel, { sessionId }, true, closeSessions);
		await priorityOptions.onPayload?.(
			{ model: codexModel.id, service_tier: CODEX_FAST_MODE_SERVICE_TIER },
			codexModel,
		);
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
					originator: CODEX_FAST_MODE_ORIGINATOR,
					[CODEX_FAST_MODE_ROUTING_HEADER]: "model=stale;tier=priority",
				},
				onPayload: (payload) => ({
					...(payload as Record<string, unknown>),
					service_tier: CODEX_FAST_MODE_SERVICE_TIER,
				}),
			},
			false,
		);
		const payload = await options.onPayload?.({ model: codexModel.id }, codexModel);
		const preparedHeaders = new Headers(options.headers as HeadersInit);
		preparedHeaders.set("originator", "pi");
		preparedHeaders.set(CODEX_FAST_MODE_ROUTING_HEADER, "model=stale;tier=priority");
		const headers = forceCodexFastModeOriginator(
			"https://monitor.example/backend-api/codex/responses",
			preparedHeaders,
		);

		expect(payload).toMatchObject({ service_tier: CODEX_FAST_MODE_SERVICE_TIER });
		expect(headers.get("originator")).toBe("pi");
		expect(headers.get(CODEX_FAST_MODE_ROUTING_HEADER)).toBeNull();
		expect(headers.get("x-atomic-codex-fast-mode")).toBeNull();
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
					service_tier: CODEX_FAST_MODE_SERVICE_TIER,
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

		const stream = streamWithCodexFastMode(
			codexModel,
			emptyContext,
			withCodexFastModeStreamOptions(
				codexModel,
				{
					apiKey: `header.${tokenPayload}.signature`,
					fetch: fetchImplementation as typeof globalThis.fetch,
					transport: "sse",
				},
				true,
			),
		);
		await stream.result();

		expect(capturedPayload?.service_tier).toBe(CODEX_FAST_MODE_SERVICE_TIER);
		expect(capturedHeaders?.get("originator")).toBe(CODEX_FAST_MODE_ORIGINATOR);
		expect(capturedHeaders?.get(CODEX_FAST_MODE_ROUTING_HEADER)).toBe("model=gpt-5.6-sol;tier=priority");
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
					service_tier: CODEX_FAST_MODE_SERVICE_TIER,
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
		const stream = streamWithCodexFastMode(
			aliasModel,
			emptyContext,
			withCodexFastModeStreamOptions(
				aliasModel,
				{
					apiKey: `header.${tokenPayload}.signature`,
					fetch: fetchImplementation as typeof globalThis.fetch,
					transport: "sse",
				},
				true,
			),
		);
		await stream.result();

		expect(capturedUrl).toBe("https://monitor.example/backend-api/codex/responses");
		expect(capturedHeaders?.get("originator")).toBe(CODEX_FAST_MODE_ORIGINATOR);
		expect(capturedHeaders?.get(CODEX_FAST_MODE_ROUTING_HEADER)).toBe("model=gpt-5.6-sol;tier=priority");
		expect(capturedHeaders?.get("x-atomic-codex-fast-mode")).toBeNull();
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

		const stream = streamWithCodexFastMode(
			codexModel,
			emptyContext,
			withCodexFastModeStreamOptions(
				codexModel,
				{
					apiKey: `header.${tokenPayload}.signature`,
					fetch: fetchImplementation as typeof globalThis.fetch,
					transport: "sse",
					onPayload: (payload) => ({ ...(payload as Record<string, unknown>), service_tier: "default" }),
				},
				true,
			),
		);
		await stream.result();

		expect(capturedPayload?.service_tier).toBe("default");
		expect(capturedHeaders?.get("originator")).toBe("pi");
		expect(capturedHeaders?.get(CODEX_FAST_MODE_ROUTING_HEADER)).toBeNull();
		expect(capturedHeaders?.get("x-atomic-codex-fast-mode")).toBeNull();
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

		const stream = streamWithCodexFastMode(codexModel, emptyContext, {
			apiKey: `header.${tokenPayload}.signature`,
			fetch: fetchImplementation as typeof globalThis.fetch,
			transport: "sse",
		});
		await stream.result();

		expect(capturedHeaders?.get("originator")).toBe("pi");
		expect(capturedHeaders?.get(CODEX_FAST_MODE_ROUTING_HEADER)).toBeNull();
	});
});
