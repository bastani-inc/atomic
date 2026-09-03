import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[] | undefined> | undefined;

interface CapturedResponsesPayload {
	prompt_cache_key?: string;
	session_id?: string;
	tools?: Array<{ name?: string; strict?: boolean }>;
}

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);

	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		const match = headers.find((entry) => Array.isArray(entry) && entry[0]?.toLowerCase() === lowerName);
		if (!match || !Array.isArray(match)) return null;
		return match[1] ?? null;
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== lowerName) continue;
		if (value == null) return null;
		return typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : String(value);
	}
	return null;
}

async function captureOpenAIResponseHeaders(
	options: Parameters<typeof streamOpenAIResponses>[2],
	model: Model<"openai-responses"> = getModel("openai", "gpt-5.4"),
): Promise<{
	sessionId: string | null;
	clientRequestId: string | null;
	xSessionId: string | null;
}> {
	const captured = {
		sessionId: null as string | null,
		clientRequestId: null as string | null,
		xSessionId: null as string | null,
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		captured.sessionId = getHeader(init?.headers as CapturedHeaders, "session_id");
		captured.clientRequestId = getHeader(init?.headers as CapturedHeaders, "x-client-request-id");
		captured.xSessionId = getHeader(init?.headers as CapturedHeaders, "x-session-id");
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const stream = streamOpenAIResponses(
		model,
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key", ...options },
	);

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits reasoning when no reasoning is requested", async () => {
		const model = getModel("github-copilot", "gpt-5-mini");
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload).not.toMatchObject({
			reasoning: expect.anything(),
		});
	});

	it("forwards required tool choice", async () => {
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			{
				messages: [
					{
						role: "user",
						content: "Do not call ping. Respond with text instead.",
						timestamp: Date.now(),
					},
				],
				tools: [
					{
						name: "ping",
						description: "Ping",
						parameters: Type.Object({ value: Type.String() }),
					},
				],
			},
			{
				apiKey: "test-key",
				toolChoice: "required",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			tool_choice: "required",
			tools: [expect.objectContaining({ name: "ping" })],
		});
	});

	it("sets strict mode explicitly for Cloudflare OpenAI Responses tools", async () => {
		const model = getModel("cloudflare-ai-gateway", "gpt-5.6-sol");
		let capturedPayload: CapturedResponsesPayload | undefined;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				messages: [{ role: "user", content: "Use a tool.", timestamp: Date.now() }],
				tools: [
					{
						name: "ordinary",
						description: "An ordinary tool",
						parameters: Type.Object({
							path: Type.String(),
							offset: Type.Optional(Type.Number()),
						}),
					},
					{
						name: "constrained",
						description: "A constrained tool",
						parameters: Type.Object({ value: Type.String() }),
						constrainedSampling: { type: "json_schema", strict: "prefer" },
					},
				],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(model.compat?.supportsStrictMode).toBe(true);
		expect(capturedPayload?.tools).toEqual([
			expect.objectContaining({ name: "ordinary", strict: false }),
			expect.objectContaining({ name: "constrained", strict: true }),
		]);
	});

	it.each([
		"gpt-5.1",
		"gpt-5.2",
		"gpt-5.3-codex",
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.4-nano",
		"gpt-5.5",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
	] as const)("sends none reasoning effort for OpenAI %s when no reasoning is requested", async (modelId) => {
		const model = getModel("openai", modelId);
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			reasoning: { effort: "none" },
		});
	});

	it.each(["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"] as const)(
		"omits reasoning effort for OpenAI %s when off is unsupported",
		async (modelId) => {
			const model = getModel("openai", modelId);
			let capturedPayload: unknown;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				{
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test-key",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}

			expect(capturedPayload).not.toMatchObject({
				reasoning: expect.anything(),
			});
		},
	);

	it("sets cache-affinity headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("clamps prompt_cache_key to OpenAI's 64-character limit", async () => {
		const sessionId = "x".repeat(67);
		let capturedPayload: Pick<CapturedResponsesPayload, "prompt_cache_key"> | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				sessionId,
				onPayload: (payload) => {
					capturedPayload = payload as Pick<CapturedResponsesPayload, "prompt_cache_key">;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload?.prompt_cache_key).toBe("x".repeat(64));
	});

	it("sets cache-affinity headers for proxy OpenAI Responses requests with a sessionId", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
		};
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, proxyModel);

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("uses OpenRouter session-affinity header when configured", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "proxy",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openrouter" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-proxy",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.xSessionId).toBe("session-proxy");
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-proxy");
	});

	it("auto-detects OpenRouter session-affinity header for OpenRouter Responses endpoints", async () => {
		const openRouterModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-openrouter",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			openRouterModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.xSessionId).toBe("session-openrouter");
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-openrouter");
	});

	it("uses OpenAI no-session format when configured", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "proxy",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-proxy",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-proxy");
		expect(captured.xSessionId).toBeNull();
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-proxy");
	});

	it("uses OpenAI no-session format for OpenCode Responses models", async () => {
		const model = getModel("opencode", "gpt-5.4");
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-opencode",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			model,
		);

		expect(model.compat?.sessionAffinityFormat).toBe("openai-nosession");
		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-opencode");
		expect(captured.xSessionId).toBeNull();
		expect(capturedPayload?.prompt_cache_key).toBe("session-opencode");
	});

	it("can omit OpenAI session_id header while preserving other affinity data", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-123",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-123");
		expect(capturedPayload?.prompt_cache_key).toBe("session-123");
	});

	it("lets explicit headers override the default OpenAI cache-affinity headers", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			headers: {
				session_id: "override-session",
				"x-client-request-id": "override-request",
			},
		});

		expect(captured.sessionId).toBe("override-session");
		expect(captured.clientRequestId).toBe("override-request");
	});

	it("omits OpenAI cache-affinity headers when cacheRetention is none", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});

	it.each([
		["gpt-5.4", "priority", 2],
		["gpt-5.5", "priority", 2.5],
		["gpt-5.5", "flex", 0.5],
	] as const)("applies %s %s service-tier cost multiplier", async (modelId, serviceTier, multiplier) => {
		const model = getModel("openai", modelId);
		const tokenCount = 100_000;
		const tokenScale = tokenCount / 1_000_000;
		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					service_tier: serviceTier,
					usage: {
						input_tokens: tokenCount,
						output_tokens: tokenCount,
						total_tokens: tokenCount * 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key", serviceTier },
		);

		const result = await stream.result();

		expect(result.usage.cost.input).toBe(model.cost.input * multiplier * tokenScale);
		expect(result.usage.cost.output).toBe(model.cost.output * multiplier * tokenScale);
		expect(result.usage.cost.total).toBe((model.cost.input + model.cost.output) * multiplier * tokenScale);
	});

	it("routes a fast variant to its base upstream model and prices it against that base", async () => {
		const base = getModel("openai", "gpt-5.5");
		// A fast variant keeps its canonical `-fast` id; `fastRoute` names the upstream model.
		const fast: Model<"openai-responses"> = {
			...base,
			id: "gpt-5.5-fast",
			fastRoute: { baseModelId: "gpt-5.5", upstreamModelId: "gpt-5.5", serviceTier: "priority" },
		};
		const tokenCount = 100_000;
		const tokenScale = tokenCount / 1_000_000;
		let capturedPayload: { model?: string; service_tier?: string } | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedPayload = JSON.parse(String(init?.body)) as { model?: string; service_tier?: string };
			const sse = `data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					service_tier: "priority",
					usage: {
						input_tokens: tokenCount,
						output_tokens: tokenCount,
						total_tokens: tokenCount * 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}\n\n`;
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		// No `serviceTier` option: the tier comes from the model, which is what a standalone
		// `Models`/`ModelRuntime` caller relies on (the `*Simple` whitelist drops the option).
		const stream = streamOpenAIResponses(
			fast,
			{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key" },
		);
		const result = await stream.result();

		// The wire carries the base upstream model plus the tier.
		expect(capturedPayload?.model).toBe("gpt-5.5");
		expect(capturedPayload?.service_tier).toBe("priority");
		// The recorded assistant message keeps the canonical `-fast` identity.
		expect(result.model).toBe("gpt-5.5-fast");
		// Pricing keys on the base model, so gpt-5.5's 2.5x rate survives the rename.
		expect(result.usage.cost.input).toBe(base.cost.input * 2.5 * tokenScale);
		expect(result.usage.cost.total).toBe((base.cost.input + base.cost.output) * 2.5 * tokenScale);
	});

	/**
	 * The route is the authority: a per-request option cannot downgrade a fast variant, because fast
	 * versus normal is model identity and the request is still recorded and billed as the fast one.
	 * A normal model, which declares no tier, keeps honoring the option exactly as before.
	 */
	/**
	 * A GitHub Copilot fast variant declares no tier: it sends its own advertised `-fast` model ID and
	 * must carry no OpenAI service-tier field at all. Route *presence*, not just its declared value,
	 * has to be the discriminator — otherwise a caller's option leaks a tier onto a Copilot request and
	 * the priority cost multiplier with it.
	 */
	it.each(["priority", "flex", "default"] as const)(
		"emits no service tier for a Copilot fast route even when a request asks for %s",
		async (requested) => {
			const base = getModel("openai", "gpt-5.5");
			const copilotFast: Model<"openai-responses"> = {
				...base,
				id: "gpt-5.2-fast",
				provider: "github-copilot",
				// No `serviceTier`: Copilot routes by its own advertised model ID.
				fastRoute: { baseModelId: "gpt-5.2", upstreamModelId: "gpt-5.2-fast" },
			};
			const tokenCount = 100_000;
			const tokenScale = tokenCount / 1_000_000;
			let capturedPayload: { model?: string; service_tier?: string } | undefined;
			vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
				capturedPayload = JSON.parse(String(init?.body)) as { model?: string; service_tier?: string };
				const sse = `data: ${JSON.stringify({
					type: "response.completed",
					response: {
						status: "completed",
						usage: {
							input_tokens: tokenCount,
							output_tokens: tokenCount,
							total_tokens: tokenCount * 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}\n\n`;
				return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
			});

			const result = await streamOpenAIResponses(
				copilotFast,
				{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{ apiKey: "test-key", serviceTier: requested },
			).result();

			expect(capturedPayload?.model).toBe("gpt-5.2-fast");
			expect(capturedPayload?.service_tier).toBeUndefined();
			// No tier means no tier multiplier either.
			expect(result.usage.cost.input).toBe(base.cost.input * tokenScale);
		},
	);

	it.each([
		["null", null],
		["an array", []],
		["a primitive", "invalid"],
	] as const)("rejects %s returned by a payload hook for a fast route", async (_label, replacement) => {
		const base = getModel("openai", "gpt-5.5");
		const fast: Model<"openai-responses"> = {
			...base,
			id: "gpt-5.5-fast",
			fastRoute: { baseModelId: "gpt-5.5", upstreamModelId: "gpt-5.5", serviceTier: "priority" },
		};
		const fetchMock = vi.spyOn(globalThis, "fetch");

		const result = await streamOpenAIResponses(
			fast,
			{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key", onPayload: () => replacement as never },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('A request hook changed payload for fast model "openai/gpt-5.5-fast"');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		["gpt-5.5-fast", "default", "priority", 2.5],
		["gpt-5.5-fast", "flex", "priority", 2.5],
		["gpt-5.5", "default", "default", 1],
		["gpt-5.5", "flex", "flex", 0.5],
	] as const)("%s asked for %s serializes %s", async (modelId, requested, expectedTier, multiplier) => {
		const base = getModel("openai", "gpt-5.5");
		const model: Model<"openai-responses"> =
			modelId === "gpt-5.5"
				? base
				: {
						...base,
						id: modelId,
						fastRoute: { baseModelId: "gpt-5.5", upstreamModelId: "gpt-5.5", serviceTier: "priority" },
					};
		const tokenCount = 100_000;
		const tokenScale = tokenCount / 1_000_000;
		let capturedPayload: { service_tier?: string } | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedPayload = JSON.parse(String(init?.body)) as { service_tier?: string };
			const sse = `data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: tokenCount,
						output_tokens: tokenCount,
						total_tokens: tokenCount * 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}\n\n`;
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		const result = await streamOpenAIResponses(
			model,
			{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key", serviceTier: requested },
		).result();

		expect(capturedPayload?.service_tier).toBe(expectedTier);
		// Pricing follows the resolved tier, so a fast variant cannot be billed at the requested rate.
		expect(result.usage.cost.input).toBe(base.cost.input * multiplier * tokenScale);
	});
});

describe("openai-responses max_output_tokens compat", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends max_output_tokens by default", async () => {
		let capturedPayload: { max_output_tokens?: number } | undefined;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				maxTokens: 1024,
				onPayload: (payload) => {
					capturedPayload = payload as { max_output_tokens?: number };
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload?.max_output_tokens).toBe(1024);
	});

	it("omits max_output_tokens when supportsMaxOutputTokens is false", async () => {
		const baseModel = getModel("openai", "gpt-5.4");
		const model: Model<"openai-responses"> = {
			...baseModel,
			compat: { ...baseModel.compat, supportsMaxOutputTokens: false },
		};
		let capturedPayload: { max_output_tokens?: number } | undefined;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				maxTokens: 1024,
				onPayload: (payload) => {
					capturedPayload = payload as { max_output_tokens?: number };
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload?.max_output_tokens).toBeUndefined();
	});
});
