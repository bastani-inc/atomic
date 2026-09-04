import { zstdDecompressSync } from "node:zlib";
import {
	type Api,
	type AuthOperationOptions,
	type AuthType,
	type Context,
	type CredentialStore,
	InMemoryCredentialStore,
	type Model,
	type SimpleStreamOptions,
} from "@bastani/pi-ai";
import { createAssistantMessageEventStream } from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function authOptions(runtime: ModelRuntime, type?: AuthType) {
	return runtime
		.getProviders()
		.flatMap((provider) => [
			...(!type || type === "oauth"
				? provider.auth.oauth
					? [{ type: "oauth" as const, provider, method: provider.auth.oauth }]
					: []
				: []),
			...(!type || type === "api_key"
				? provider.auth.apiKey
					? [{ type: "api_key" as const, provider, method: provider.auth.apiKey }]
					: []
				: []),
		]);
}

function testModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

describe("ModelRuntime auth options", () => {
	it("accepts a pi-ai CredentialStore", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "stored-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("stored-key");
	});

	it("scopes provider availability reads and records refresh failures", async () => {
		const base = new InMemoryCredentialStore();
		const reads: string[] = [];
		let failReads = false;
		const credentials: CredentialStore = {
			read: async (providerId) => {
				reads.push(providerId);
				if (failReads) throw new Error(`read failed for ${providerId}`);
				return base.read(providerId);
			},
			list: () => base.list(),
			modify: (providerId, fn) => base.modify(providerId, fn),
			delete: (providerId) => base.delete(providerId),
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		reads.length = 0;
		await runtime.getAvailable("anthropic");
		expect(new Set(reads)).toEqual(new Set(["anthropic"]));

		failReads = true;
		await expect(runtime.getAvailable("anthropic")).rejects.toThrow("Credential store read failed for anthropic");
		expect(runtime.getError()).toContain("Availability refresh: Credential store read failed for anthropic");

		failReads = false;
		await runtime.getAvailable();
		expect(runtime.getError()).toBeUndefined();
	});

	it("projects provider-owned methods, names, and status", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const options = authOptions(runtime);

		expect(options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "amazon-bedrock", name: "Amazon Bedrock" }),
					method: expect.objectContaining({ name: "AWS credentials or bearer token" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "google-vertex", name: "Google Vertex AI" }),
					method: expect.objectContaining({ name: "Google Cloud credentials" }),
				}),
				expect.objectContaining({
					type: "oauth",
					provider: expect.objectContaining({ id: "anthropic", name: "Anthropic" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "cloudflare-workers-ai", name: "Cloudflare Workers AI" }),
				}),
			]),
		);
		expect(authOptions(runtime, "api_key").every((option) => option.type === "api_key")).toBe(true);
		expect(authOptions(runtime, "oauth").every((option) => option.type === "oauth")).toBe(true);
		expect(options.some((option) => option.provider.id === "openai-codex" && option.type === "api_key")).toBe(false);
	});

	it("attaches the provider's active auth status to every method option", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				anthropic: {
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
				},
			}),
			modelsPath: null,
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "anthropic");
		expect(options).toHaveLength(2);
		expect(await runtime.checkAuth("anthropic")).toMatchObject({ type: "oauth" });
	});

	it("constructs an API key method for an extension API-key provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-api-key", {
			name: "Extension API Key",
			baseUrl: "https://example.test/v1",
			apiKey: "$EXTENSION_TEST_API_KEY",
			api: "openai-completions",
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-api-key");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "api_key",
			provider: { id: "extension-api-key", name: "Extension API Key" },
			method: { name: "API key" },
		});
		expect(options[0]?.method.login).toBeTypeOf("function");
	});

	it("resolves configured auth from request-scoped environment overrides", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("request-env-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "$REQUEST_SCOPED_API_KEY",
			headers: { "x-request-value": "$REQUEST_SCOPED_HEADER" },
			api: "openai-completions",
			models: [testModel("request-env-model")],
		});

		const auth = await runtime.getAuth("request-env-provider", {
			env: { REQUEST_SCOPED_API_KEY: "request-key", REQUEST_SCOPED_HEADER: "request-header" },
		});

		expect(auth?.auth).toEqual({ apiKey: "request-key", headers: { "x-request-value": "request-header" } });
	});

	it("lets an explicit Authorization header override authHeader case-insensitively", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		runtime.registerProvider("auth-header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [testModel("auth-header-model")],
		});
		const model = runtime.getModel("auth-header-provider", "auth-header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(model!, { messages: [] }, { headers: { authorization: "Explicit token" } });

		expect(capturedHeaders).toEqual({ authorization: "Explicit token" });
	});

	it("transforms fully assembled headers once without forwarding the transform", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		let transforms = 0;
		runtime.registerProvider("header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			headers: { "x-provider": "provider" },
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				expect(options).not.toHaveProperty("transformHeaders");
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [{ ...testModel("header-model"), headers: { "x-model": "model" } }],
		});
		const model = runtime.getModel("header-provider", "header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(
			model!,
			{ messages: [] },
			{
				headers: { "x-explicit": "explicit" },
				transformHeaders: async (headers) => {
					transforms++;
					expect(headers).toEqual({
						Authorization: "Bearer generated-key",
						"x-provider": "provider",
						"x-model": "model",
						"x-explicit": "explicit",
					});
					return { ...headers, "x-transformed": "yes" };
				},
			},
		);

		expect(transforms).toBe(1);
		expect(capturedHeaders).toEqual({
			Authorization: "Bearer generated-key",
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-transformed": "yes",
		});
	});

	it("does not fabricate an API key method for an extension OAuth-only provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-oauth", {
			name: "Extension OAuth",
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Extension subscription",
				login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
			},
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-oauth");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "oauth",
			provider: { id: "extension-oauth", name: "Extension OAuth" },
			method: { name: "Extension subscription" },
		});
	});

	it("applies a runtime API key without refreshing the catalog, and honors an abort signal", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});

		// setRuntimeApiKey is a credential mutation, not a catalog refresh. Catalog
		// freshness is the caller's separate refresh() call, so this must not trigger one.
		let refreshes = 0;
		const trackedRefresh = runtime.refresh.bind(runtime);
		runtime.refresh = async (options) => {
			refreshes += 1;
			return trackedRefresh(options);
		};

		await runtime.setRuntimeApiKey("anthropic", "runtime-secret", {});

		expect(refreshes).toBe(0);
		// The credential is applied and published against the current snapshot.
		expect(runtime.getProviderAuthStatus("anthropic")).toMatchObject({ configured: true, source: "runtime" });
		expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);

		// Compile-time contract: the third argument is required, not the old optional
		// compatibility parameter.
		type HasRequiredAuthOptions =
			Parameters<ModelRuntime["setRuntimeApiKey"]> extends [string, string, AuthOperationOptions] ? true : false;
		const hasRequiredAuthOptions: HasRequiredAuthOptions = true;
		expect(hasRequiredAuthOptions).toBe(true);

		// Cancellation is the point of the options bag it now takes.
		const controller = new AbortController();
		controller.abort();
		await expect(
			runtime.setRuntimeApiKey("openai", "never-applied", { signal: controller.signal }),
		).rejects.toThrow();
		expect(runtime.hasConfiguredAuth("openai")).toBe(false);
		expect(refreshes).toBe(0);
	});
});

/**
 * `docs/sdk.md` points standalone integrations at `modelRuntime.complete()`. That path never passed
 * through `sdk.ts`, so before the tier was defaulted from the model it silently sent a fast model's
 * request at normal tier: right upstream model ID, no `service_tier`, normal-rate billing, no warning.
 */
describe("ModelRuntime standalone requests honor a selected fast model", () => {
	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

	function completedResponse(): Response {
		const completed = {
			type: "response.completed",
			response: {
				id: "resp_probe",
				status: "completed",
				service_tier: "priority",
				usage: {
					input_tokens: 1,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 1,
					total_tokens: 2,
				},
			},
		};
		return new Response(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	async function fastRuntime(providerId: "openai"): Promise<ModelRuntime> {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(providerId, async () => ({ type: "api_key", key: "test-api-key" }));
		return ModelRuntime.create({ credentials, modelsPath: null });
	}

	async function capturePayload(
		run: (runtime: ModelRuntime, model: Model<Api>) => Promise<unknown>,
		providerId: "openai",
		modelId: string,
	): Promise<Record<string, unknown> | undefined> {
		const runtime = await fastRuntime(providerId);
		const model = runtime.getModel(providerId, modelId);
		expect(model).toBeDefined();
		if (!model) throw new Error(`missing model ${providerId}/${modelId}`);
		let payload: Record<string, unknown> | undefined;
		const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
			const encoding = new Headers(init?.headers).get("content-encoding");
			payload = JSON.parse(
				encoding === "zstd" ? zstdDecompressSync(bytes).toString("utf8") : new TextDecoder().decode(bytes),
			) as Record<string, unknown>;
			return completedResponse();
		});
		vi.stubGlobal("fetch", fetchImplementation);
		try {
			await run(runtime, model);
		} finally {
			vi.unstubAllGlobals();
		}
		return payload;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each([
		["completeSimple", (runtime: ModelRuntime, model: Model<Api>) => runtime.completeSimple(model, context)],
		["complete", (runtime: ModelRuntime, model: Model<Api>) => runtime.complete(model, context)],
		["streamSimple", (runtime: ModelRuntime, model: Model<Api>) => runtime.streamSimple(model, context).result()],
	] as const)("%s sends the base model plus the priority tier for openai/gpt-5.6-sol-fast", async (_name, run) => {
		const payload = await capturePayload(run, "openai", "gpt-5.6-sol-fast");

		expect(payload?.model).toBe("gpt-5.6-sol");
		expect(payload?.service_tier).toBe("priority");
	});

	it("sends no service tier for the normal sibling", async () => {
		const payload = await capturePayload(
			(runtime, model) => runtime.completeSimple(model, context),
			"openai",
			"gpt-5.6-sol",
		);

		expect(payload?.model).toBe("gpt-5.6-sol");
		expect(payload?.service_tier).toBeUndefined();
	});

	it("keeps the fast route's tier even when an API-typed request asks for another", async () => {
		// The route is the authority: fast versus normal is model identity, so a caller who wants a
		// different tier selects the normal sibling. Downgrading here would let a model recorded,
		// persisted, and billed as `-fast` route as an ordinary request — and would silently drop the
		// Codex routing identity, which keys on the final payload's tier.
		const payload = await capturePayload(
			(runtime, model) => runtime.complete(model as Model<"openai-responses">, context, { serviceTier: "default" }),
			"openai",
			"gpt-5.6-sol-fast",
		);

		expect(payload?.model).toBe("gpt-5.6-sol");
		expect(payload?.service_tier).toBe("priority");
	});

	it("still honors an explicit tier on a normal model", async () => {
		// `serviceTier` keeps working exactly as it did before fast variants existed, wherever the model
		// declares no tier of its own.
		const payload = await capturePayload(
			(runtime, model) => runtime.complete(model as Model<"openai-responses">, context, { serviceTier: "flex" }),
			"openai",
			"gpt-5.6-sol",
		);

		expect(payload?.model).toBe("gpt-5.6-sol");
		expect(payload?.service_tier).toBe("flex");
	});
});

/**
 * The first-party ChatGPT Codex routing identity — `originator: codex_cli_rs` plus
 * `x-codex-routing-hint` — used to be attached only by the agent session, so a standalone
 * `modelRuntime.complete*()` sent the right model and tier under pi's identity. It is attached by
 * `ModelRuntimeStreaming` now, which has to happen after auth headers are merged: the wrapper mutates
 * a header object it captures, and `mergeHeaders` copies, so anything applied upstream is inert.
 */
describe("ModelRuntime standalone Codex requests carry the first-party routing identity", () => {
	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
	// The Codex backend reads its account id from the bearer token.
	const codexToken = `header.${Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } }),
	).toString("base64url")}.signature`;

	interface CodexCapture {
		model?: string;
		serviceTier?: string;
		originator: string | null;
		routingHint: string | null;
		marker: string | null;
		/** pi-ai surfaces a stream failure as an error-stopReason assistant message, not a rejection. */
		stopReason?: string;
		errorMessage?: string;
	}

	function codexResponse(): Response {
		const completed = {
			type: "response.completed",
			response: {
				id: "resp_codex",
				status: "completed",
				service_tier: "priority",
				usage: {
					input_tokens: 1,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 1,
					total_tokens: 2,
				},
			},
		};
		return new Response(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	async function codexRuntime(): Promise<ModelRuntime> {
		// openai-codex is OAuth-only, so an api_key credential leaves the provider unconfigured.
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai-codex", async () => ({
			type: "oauth",
			access: codexToken,
			refresh: "refresh-token",
			expires: Number.MAX_SAFE_INTEGER,
		}));
		return ModelRuntime.create({ credentials, modelsPath: null });
	}

	async function captureCodex(
		modelId: string,
		options?: { onPayload?: (payload: unknown) => unknown; serviceTier?: "default" | "flex" },
	): Promise<CodexCapture> {
		const runtime = await codexRuntime();
		const model = runtime.getModel("openai-codex", modelId);
		expect(model).toBeDefined();
		if (!model) throw new Error(`missing model openai-codex/${modelId}`);
		const captured: CodexCapture = { originator: null, routingHint: null, marker: null };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const headers = new Headers(init?.headers);
				const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
				const body = JSON.parse(
					headers.get("content-encoding") === "zstd"
						? zstdDecompressSync(bytes).toString("utf8")
						: new TextDecoder().decode(bytes),
				) as { model?: string; service_tier?: string };
				captured.model = body.model;
				captured.serviceTier = body.service_tier;
				captured.originator = headers.get("originator");
				captured.routingHint = headers.get("x-codex-routing-hint");
				// The internal marker is stripped before dispatch; assert it never leaves the process.
				captured.marker = headers.get("x-atomic-codex-fast-route");
				return codexResponse();
			}),
		);
		try {
			// `serviceTier` only reaches the adapter through the API-typed option: pi-ai's
			// `buildBaseOptions` whitelist drops it on the `*Simple` path, so asserting precedence there
			// would pass no matter which side won.
			const result =
				options?.serviceTier !== undefined
					? await runtime.complete(model as Model<"openai-codex-responses">, context, {
							transport: "sse",
							...options,
						})
					: await runtime.completeSimple(model, context, { transport: "sse", ...options });
			captured.stopReason = result.stopReason;
			captured.errorMessage = result.errorMessage;
		} finally {
			vi.unstubAllGlobals();
		}
		return captured;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends the Codex harness identity and a base-model routing hint for a fast model", async () => {
		const captured = await captureCodex("gpt-5.6-sol-fast");

		expect(captured.model).toBe("gpt-5.6-sol");
		expect(captured.serviceTier).toBe("priority");
		expect(captured.originator).toBe("codex_cli_rs");
		expect(captured.routingHint).toBe("model=gpt-5.6-sol;tier=priority");
		expect(captured.marker).toBeNull();
	});

	it("preserves the GPT-6-Astra Codex transport identity and routing hint", async () => {
		const captured = await captureCodex("gpt-6-astra-fast");

		expect(captured.model).toBe("gpt-6-astra");
		expect(captured.serviceTier).toBe("priority");
		expect(captured.originator).toBe("codex_cli_rs");
		expect(captured.routingHint).toBe("model=gpt-6-astra;tier=priority");
		expect(captured.marker).toBeNull();
	});

	it("keeps pi's identity and sends no routing hint for the normal sibling", async () => {
		const captured = await captureCodex("gpt-5.6-sol");

		expect(captured.model).toBe("gpt-5.6-sol");
		expect(captured.serviceTier).toBeUndefined();
		expect(captured.originator).toBe("pi");
		expect(captured.routingHint).toBeNull();
		expect(captured.marker).toBeNull();
	});

	it("keeps the Codex identity when a request asks for a lower tier", async () => {
		// The route wins over the option, so the only channel that can suppress the identity is a
		// payload hook rewriting the built body — asserted by the next case.
		const captured = await captureCodex("gpt-5.6-sol-fast", { serviceTier: "default" });

		expect(captured.serviceTier).toBe("priority");
		expect(captured.originator).toBe("codex_cli_rs");
		expect(captured.routingHint).toBe("model=gpt-5.6-sol;tier=priority");
	});

	it("rejects a payload hook that drops the tier a fast route owns", async () => {
		// A hook used to be able to send an ordinary-tier request under the `-fast` identity Atomic
		// records, persists, and bills. Route-owned fields are now enforced, loudly, before dispatch.
		const captured = await captureCodex("gpt-5.6-sol-fast", {
			onPayload: (payload) => {
				const record = { ...(payload as Record<string, unknown>) };
				delete record.service_tier;
				return record;
			},
		});

		expect(captured.stopReason).toBe("error");
		expect(captured.errorMessage).toContain('service_tier (expected "priority", got undefined)');
		expect(captured.errorMessage).toContain('fast model "openai-codex/gpt-5.6-sol-fast"');
		// Nothing reached the wire.
		expect(captured.model).toBeUndefined();
	});

	it("rejects a payload hook that rewrites the model a fast route owns", async () => {
		const captured = await captureCodex("gpt-5.6-sol-fast", {
			onPayload: (payload) => ({ ...(payload as Record<string, unknown>), model: "some-other-model" }),
		});

		expect(captured.stopReason).toBe("error");
		expect(captured.errorMessage).toContain('model (expected "gpt-5.6-sol", got "some-other-model")');
		// The remedy names the normal sibling.
		expect(captured.errorMessage).toContain('"openai-codex/gpt-5.6-sol"');
		expect(captured.model).toBeUndefined();
	});

	it("leaves a hook free to rewrite anything the route does not own", async () => {
		const captured = await captureCodex("gpt-5.6-sol-fast", {
			onPayload: (payload) => ({ ...(payload as Record<string, unknown>), text: { verbosity: "high" } }),
		});

		expect(captured.serviceTier).toBe("priority");
		expect(captured.originator).toBe("codex_cli_rs");
	});

	it.each(["gpt-5.6-sol-fast", "gpt-6-astra-fast"] as const)(
		"installs the WebSocket handshake identity for %s when the transport is not forced to SSE",
		async (modelId) => {
			const runtime = await codexRuntime();
			const model = runtime.getModel("openai-codex", modelId);
			expect(model).toBeDefined();
			if (!model) throw new Error("missing fast model");
			class UnwrappedWebSocket {
				close(): void {}
			}
			vi.stubGlobal("WebSocket", UnwrappedWebSocket);
			// CLI entrypoints install this through the HTTP dispatcher; a pure SDK embedder never does, so
			// without the runtime installing it the WebSocket half of the contract stays unrepaired.
			expect(globalThis.WebSocket).toBe(UnwrappedWebSocket as unknown as typeof globalThis.WebSocket);
			try {
				// The socket cannot connect in-process; installation happens before dispatch, which is the
				// assertion. Failure of the request itself is irrelevant here.
				await runtime.completeSimple(model, context).catch(() => undefined);
				expect(globalThis.WebSocket).not.toBe(UnwrappedWebSocket as unknown as typeof globalThis.WebSocket);
			} finally {
				vi.unstubAllGlobals();
			}
		},
	);

	it("leaves an extension-owned transport unwrapped", async () => {
		const runtime = await codexRuntime();
		const model = runtime.getModel("openai-codex", "gpt-5.6-sol-fast");
		expect(model).toBeDefined();
		if (!model) throw new Error("missing fast model");
		let capturedOptions: SimpleStreamOptions | undefined;
		runtime.registerProvider("openai-codex", {
			api: "openai-codex-responses",
			streamSimple: (streamModel, _streamContext, streamOptions) => {
				capturedOptions = streamOptions;
				const stream = createAssistantMessageEventStream();
				stream.end({
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: streamModel.api,
					provider: streamModel.provider,
					model: streamModel.id,
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
				});
				return stream;
			},
		});
		try {
			await runtime.completeSimple(model, context, { transport: "sse" });
		} finally {
			runtime.unregisterProvider("openai-codex");
		}

		// An extension that owns the transport owns its serialization; Atomic must not proxy its fetch
		// or inject provider routing headers into it.
		expect(capturedOptions?.fetch).toBeUndefined();
		expect(new Headers(capturedOptions?.headers as HeadersInit).get("x-codex-routing-hint")).toBeNull();
	});
});
