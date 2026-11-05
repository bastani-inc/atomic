import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	createProvider,
	type DeferredFetchOptions,
	type DeferredHandle,
	type Model,
	type ProviderStreams,
} from "@bastani/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

// Issue #3085

const REQUEST_AUTH_PREPARATION_TIMEOUT_MS = 15_000;

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

function expiredStore(providerId: string) {
	return AuthStorage.inMemory({
		[providerId]: { type: "oauth", access: "expired-access", refresh: "refresh-token", expires: 1 },
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("ModelRuntime request-auth deadline", () => {
	it.each(["streamSimple", "stream"] as const)(
		"%s settles a signal-ignoring OAuth refresh at 15_000ms",
		async (method) => {
			vi.useFakeTimers();
			const runtime = await ModelRuntime.create({
				credentials: expiredStore("oauth-deadline"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			runtime.registerProvider("oauth-deadline", {
				baseUrl: "https://example.test/v1",
				api: "openai-completions",
				oauth: {
					name: "OAuth Deadline",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async () => new Promise(() => {}),
					getApiKey: (credential) => credential.access,
				},
				models: [testModel("deadline-model")],
			});
			const model = runtime.getModel("oauth-deadline", "deadline-model");
			expect(model).toBeDefined();

			const pending =
				method === "streamSimple"
					? runtime.completeSimple(model!, { messages: [] })
					: runtime.complete(model!, { messages: [] });
			let settled: { stopReason?: string; errorMessage?: string } | undefined;
			void pending.then((message) => {
				settled = message;
			});

			await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS - 1);
			expect(settled).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1);
			expect(settled?.stopReason).toBe("error");
			expect(settled?.errorMessage).toMatch(/authentication timed out/i);
			expect(settled?.errorMessage).not.toMatch(/log in/i);
		},
	);

	it("forwards caller cancellation during request auth without falling through to the provider", async () => {
		const runtime = await ModelRuntime.create({
			credentials: expiredStore("oauth-cancel"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		let providerCalls = 0;
		let markEntered: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		runtime.registerProvider("oauth-cancel", {
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "OAuth Cancel",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
				refreshToken: async (_credential, signal) => {
					markEntered();
					await new Promise<void>((resolve) => {
						if (signal.aborted) return resolve();
						signal.addEventListener("abort", () => resolve(), { once: true });
					});
					throw new Error("refresh aborted");
				},
				getApiKey: (credential) => credential.access,
			},
			streamSimple: () => {
				providerCalls++;
				throw new Error("provider must not run");
			},
			models: [testModel("cancel-model")],
		});
		const model = runtime.getModel("oauth-cancel", "cancel-model");
		expect(model).toBeDefined();

		const controller = new AbortController();
		const pending = runtime.completeSimple(model!, { messages: [] }, { signal: controller.signal });
		await entered;
		controller.abort();
		const result = await pending;

		expect(result.stopReason).toBe("aborted");
		expect(providerCalls).toBe(0);
	});

	it("reuses prepared request auth and still honors abort before dispatch (#3087)", async () => {
		let resolveCalls = 0;
		let providerCalls = 0;
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				"oauth-reuse": {
					type: "oauth",
					access: "valid-access",
					refresh: "refresh-token",
					expires: Number.MAX_SAFE_INTEGER,
				},
			}),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const original = runtime.getRequestAuth.bind(runtime);
		runtime.getRequestAuth = (async (model, overrides) => {
			resolveCalls++;
			return original(model, overrides);
		}) as typeof runtime.getRequestAuth;
		runtime.registerProvider("oauth-reuse", {
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "OAuth Reuse",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
			streamSimple: () => {
				providerCalls++;
				throw new Error("provider must not run");
			},
			models: [testModel("reuse-model")],
		});
		const model = runtime.getModel("oauth-reuse", "reuse-model");
		expect(model).toBeDefined();
		const resolution = await original(model!);
		expect(resolution).toBeDefined();
		resolveCalls = 0;

		const controller = new AbortController();
		controller.abort();
		const result = await runtime.completeSimple(
			model!,
			{ messages: [] },
			{
				preparedRequestAuth: { resolution },
				signal: controller.signal,
			},
		);
		expect(result.stopReason).toBe("aborted");
		expect(resolveCalls).toBe(0);
		expect(providerCalls).toBe(0);
	});

	it("dispatches with prepared request auth without a second credential resolution (#3087)", async () => {
		let resolveCalls = 0;
		let providerCalls = 0;
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				"oauth-prepared": {
					type: "oauth",
					access: "valid-access",
					refresh: "refresh-token",
					expires: Number.MAX_SAFE_INTEGER,
				},
			}),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const original = runtime.getRequestAuth.bind(runtime);
		runtime.getRequestAuth = (async (model, overrides) => {
			resolveCalls++;
			return original(model, overrides);
		}) as typeof runtime.getRequestAuth;
		runtime.registerProvider("oauth-prepared", {
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "OAuth Prepared",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
			streamSimple: (model) => {
				providerCalls++;
				const stream = new AssistantMessageEventStream();
				const msg = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "ok" }],
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
					stopReason: "stop" as const,
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
				stream.end(msg);
				return stream;
			},
			models: [testModel("prepared-model")],
		});
		const model = runtime.getModel("oauth-prepared", "prepared-model");
		expect(model).toBeDefined();
		const resolution = await original(model!);
		resolveCalls = 0;
		const result = await runtime.completeSimple(
			model!,
			{ messages: [] },
			{
				preparedRequestAuth: { resolution },
			},
		);
		expect(result.stopReason).toBe("stop");
		expect(resolveCalls).toBe(0);
		expect(providerCalls).toBe(1);
	});
});

describe("ModelRuntime deferred responses", () => {
	const DEFERRED_API = "deferred-test-api";

	function deferredModel(provider: string): Model<typeof DEFERRED_API> {
		return {
			id: "deferred-model",
			name: "Deferred Model",
			api: DEFERRED_API,
			provider,
			baseUrl: "https://deferred.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
	}

	function completedStream(model: Model<Api>, text: string): AssistantMessageEventStream {
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
			timestamp: 0,
		};
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	}

	async function runtimeWith(providerId: string, fetchDeferred?: ProviderStreams["fetchDeferred"]) {
		const unused = (): never => {
			throw new Error("unused");
		};
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerNativeProvider(
			createProvider({
				id: providerId,
				auth: {
					apiKey: {
						name: providerId,
						resolve: async ({ credential }) =>
							credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
					},
				},
				models: [deferredModel(providerId)],
				api: { stream: unused, streamSimple: unused, ...(fetchDeferred ? { fetchDeferred } : {}) },
			}),
		);
		await runtime.setRuntimeApiKey(providerId, "sk-deferred", {});
		return runtime;
	}

	function handleFor(providerId: string): DeferredHandle {
		return { provider: providerId, modelId: "deferred-model", api: DEFERRED_API, id: "response-1" };
	}

	it("resumes a deferred response through the provider with the resolved credentials", async () => {
		const requests: Array<{ model: string; handleId: string; apiKey: string | undefined }> = [];
		const runtime = await runtimeWith(
			"deferred-capable",
			(model: Model<Api>, handle: DeferredHandle, options?: DeferredFetchOptions) => {
				requests.push({ model: model.id, handleId: handle.id, apiKey: options?.apiKey });
				return completedStream(model, "resumed");
			},
		);
		const model = runtime.getModel("deferred-capable", "deferred-model");
		expect(model).toBeDefined();

		const result = await runtime.fetchDeferred(model!, handleFor("deferred-capable"));

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "resumed" }]);
		expect(requests).toEqual([{ model: "deferred-model", handleId: "response-1", apiKey: "sk-deferred" }]);
	});

	it("reports a provider without deferred responses as an error result", async () => {
		const runtime = await runtimeWith("deferred-missing");
		const model = runtime.getModel("deferred-missing", "deferred-model");
		expect(model).toBeDefined();

		const result = await runtime.fetchDeferred(model!, handleFor("deferred-missing"));

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider deferred-missing does not support deferred responses");
	});
});
