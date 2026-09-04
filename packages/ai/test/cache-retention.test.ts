import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel, stream } from "../src/compat.ts";
import { MODELS } from "../src/models.generated.ts";
import type { CacheRetention, Context, Model, OpenAIResponsesCompat } from "../src/types.ts";

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

interface OpenAICompletionsCachePayload {
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
}

interface OpenAIResponsesCachePayload extends OpenAICompletionsCachePayload {
	prompt_cache_options?: { mode?: "explicit"; ttl?: "30m" };
}

function stopAfterPayload<TPayload>(capture: (payload: TPayload) => void): (payload: unknown) => never {
	return (payload: unknown): never => {
		capture(payload as TPayload);
		throw new PayloadCaptured();
	};
}

describe("Cache Retention (PI_CACHE_RETENTION)", () => {
	const originalEnv = process.env.PI_CACHE_RETENTION;

	beforeEach(() => {
		delete process.env.PI_CACHE_RETENTION;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.PI_CACHE_RETENTION = originalEnv;
		} else {
			delete process.env.PI_CACHE_RETENTION;
		}
	});

	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	describe("Anthropic Provider", () => {
		it.skipIf(!process.env.ANTHROPIC_API_KEY)(
			"should use default cache TTL (no ttl field) when PI_CACHE_RETENTION is not set",
			async () => {
				const model = getModel("anthropic", "claude-haiku-4-5");
				let capturedPayload: any = null;

				const s = stream(model, context, {
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// Consume the stream to trigger the request
				for await (const _ of s) {
					// Just consume
				}

				expect(capturedPayload).not.toBeNull();
				// System prompt should have cache_control without ttl
				expect(capturedPayload.system).toBeDefined();
				expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral" });
			},
		);

		it.skipIf(!process.env.ANTHROPIC_API_KEY)("should use 1h cache TTL when PI_CACHE_RETENTION=long", async () => {
			process.env.PI_CACHE_RETENTION = "long";
			const model = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: any = null;

			const s = stream(model, context, {
				onPayload: stopAfterPayload((payload) => {
					capturedPayload = payload;
				}),
			});

			// Consume the stream to trigger the request
			for await (const _ of s) {
				// Just consume
			}

			expect(capturedPayload).not.toBeNull();
			// System prompt should have cache_control with ttl: "1h"
			expect(capturedPayload.system).toBeDefined();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});

		it("should add ttl for non-api.anthropic.com baseUrl by default", async () => {
			process.env.PI_CACHE_RETENTION = "long";

			// Create a model with a different baseUrl (simulating a proxy)
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			const proxyModel = {
				...baseModel,
				baseUrl: "https://my-proxy.example.com/v1",
			};

			let capturedPayload: any = null;

			// We can't actually make the request (no proxy), but we can verify the payload
			// by using a mock or checking the logic directly
			// For this test, we'll import the helper directly

			// Since we can't easily test this without mocking, we'll skip the actual API call
			// and just verify the helper logic works correctly

			try {
				const s = streamAnthropic(proxyModel, context, {
					apiKey: "fake-key",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// This will fail since we're using a fake key and fake proxy, but the payload should be captured
				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});

		it("should omit ttl when supportsLongCacheRetention is false", async () => {
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			const proxyModel = {
				...baseModel,
				baseUrl: "https://my-proxy.example.com/v1",
				compat: { supportsLongCacheRetention: false },
			};
			let capturedPayload: any = null;

			try {
				const s = streamAnthropic(proxyModel, context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral" });
		});

		it("should omit cache_control when cacheRetention is none", async () => {
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: any = null;

			try {
				const s = streamAnthropic(baseModel, context, {
					apiKey: "fake-key",
					cacheRetention: "none",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system[0].cache_control).toBeUndefined();
		});

		it("should add cache_control to string user messages", async () => {
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: any = null;

			try {
				const s = streamAnthropic(baseModel, context, {
					apiKey: "fake-key",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			const lastMessage = capturedPayload.messages[capturedPayload.messages.length - 1];
			expect(Array.isArray(lastMessage.content)).toBe(true);
			const lastBlock = lastMessage.content[lastMessage.content.length - 1];
			expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
		});

		it("should set 1h cache TTL when cacheRetention is long", async () => {
			const baseModel = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: any = null;

			try {
				const s = streamAnthropic(baseModel, context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});
	});

	describe("OpenAI Responses Provider", () => {
		it.skipIf(!process.env.OPENAI_API_KEY)(
			"should not set prompt_cache_retention when PI_CACHE_RETENTION is not set",
			async () => {
				const model = getModel("openai", "gpt-4o-mini");
				let capturedPayload: any = null;

				const s = stream(model, context, {
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// Consume the stream to trigger the request
				for await (const _ of s) {
					// Just consume
				}

				expect(capturedPayload).not.toBeNull();
				expect(capturedPayload.prompt_cache_retention).toBeUndefined();
			},
		);

		it.skipIf(!process.env.OPENAI_API_KEY)(
			"should set prompt_cache_retention to 24h when PI_CACHE_RETENTION=long",
			async () => {
				process.env.PI_CACHE_RETENTION = "long";
				const model = getModel("openai", "gpt-4o-mini");
				let capturedPayload: any = null;

				const s = stream(model, context, {
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// Consume the stream to trigger the request
				for await (const _ of s) {
					// Just consume
				}

				expect(capturedPayload).not.toBeNull();
				expect(capturedPayload.prompt_cache_retention).toBe("24h");
			},
		);

		it("should set prompt_cache_retention for non-api.openai.com baseUrl by default", async () => {
			process.env.PI_CACHE_RETENTION = "long";

			// Create a model with a different baseUrl (simulating a proxy)
			const baseModel = getModel("openai", "gpt-4o-mini");
			const proxyModel = {
				...baseModel,
				baseUrl: "https://my-proxy.example.com/v1",
			};

			let capturedPayload: any = null;

			try {
				const s = streamOpenAIResponses(proxyModel, context, {
					apiKey: "fake-key",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// This will fail since we're using a fake key and fake proxy, but the payload should be captured
				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_retention).toBe("24h");
		});

		async function captureResponsesCachePayload(
			model: Model<"openai-responses">,
			cacheRetention: CacheRetention,
			compat?: OpenAIResponsesCompat,
		): Promise<OpenAIResponsesCachePayload> {
			let capturedPayload: OpenAIResponsesCachePayload | undefined;
			const configuredModel = compat ? { ...model, compat: { ...model.compat, ...compat } } : model;

			try {
				const response = streamOpenAIResponses(configuredModel, context, {
					apiKey: "fake-key",
					cacheRetention,
					sessionId: "session-cache-test",
					onPayload: stopAfterPayload<OpenAIResponsesCachePayload>((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of response) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected after the payload hook stops the request.
			}

			if (!capturedPayload) throw new Error("OpenAI Responses payload was not captured");
			return capturedPayload;
		}

		it.each([
			["gpt-4o-mini", "none", undefined, undefined, undefined],
			["gpt-4o-mini", "short", "session-cache-test", undefined, undefined],
			["gpt-4o-mini", "long", "session-cache-test", "24h", undefined],
			["gpt-5.6-sol", "none", undefined, undefined, { mode: "explicit" }],
			["gpt-6-astra", "none", undefined, undefined, { mode: "explicit" }],
			["gpt-6-astra", "short", "session-cache-test", undefined, undefined],
			["gpt-6-astra", "long", "session-cache-test", undefined, { ttl: "30m" }],
		] as const)(
			"uses the supported cache payload for %s with %s retention",
			async (modelId, cacheRetention, cacheKey, retention, cacheOptions) => {
				const payload = await captureResponsesCachePayload(getModel("openai", modelId), cacheRetention);

				expect(payload.prompt_cache_key).toBe(cacheKey);
				expect(payload.prompt_cache_retention).toBe(retention);
				expect(payload.prompt_cache_options).toEqual(cacheOptions);
			},
		);

		it.each([
			["gpt-4o-mini", { supportsLongCacheRetention: false }, undefined, undefined],
			["gpt-4o-mini", { supportsExplicitPromptCacheMode: true }, undefined, { ttl: "30m" }],
			["gpt-6-astra", { supportsExplicitPromptCacheMode: false }, "24h", undefined],
			["gpt-6-astra", { supportsLongCacheRetention: false }, undefined, undefined],
		] as const)(
			"honors cache capability overrides for %s with %j",
			async (modelId, compat, retention, cacheOptions) => {
				const payload = await captureResponsesCachePayload(getModel("openai", modelId), "long", compat);

				expect(payload.prompt_cache_key).toBe("session-cache-test");
				expect(payload.prompt_cache_retention).toBe(retention);
				expect(payload.prompt_cache_options).toEqual(cacheOptions);
			},
		);
	});

	describe("OpenAI Completions Provider", () => {
		function createCompletionsModel(compat?: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
			return {
				id: "test-model",
				name: "Test Model",
				api: "openai-completions",
				provider: "test-openai-completions",
				baseUrl: "https://my-proxy.example.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
				compat,
			};
		}

		it("should set prompt_cache_retention for non-api.openai.com baseUrl by default", async () => {
			let capturedPayload: any = null;

			try {
				const s = streamOpenAICompletions(createCompletionsModel(), context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-completions",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_key).toBe("session-completions");
			expect(capturedPayload.prompt_cache_retention).toBe("24h");
		});

		it("should omit prompt_cache_retention when supportsLongCacheRetention is false", async () => {
			let capturedPayload: any = null;

			try {
				const s = streamOpenAICompletions(createCompletionsModel({ supportsLongCacheRetention: false }), context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-completions-false",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_key).toBeUndefined();
			expect(capturedPayload.prompt_cache_retention).toBeUndefined();
		});

		it.each([
			MODELS.opencode["deepseek-v4-flash"],
			MODELS.opencode["deepseek-v4-pro"],
			MODELS.opencode["kimi-k2.5"],
			MODELS.opencode["kimi-k2.6"],
			MODELS.opencode["minimax-m2.7"],
			MODELS["opencode-go"]["kimi-k2.6"],
		] as const)("should omit long cache retention for $provider/$id", async (metadata) => {
			const model = metadata as Model<"openai-completions">;
			let capturedPayload: OpenAICompletionsCachePayload | undefined;

			try {
				const s = streamOpenAICompletions(model, context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-opencode-long-cache-unsupported",
					onPayload: stopAfterPayload<OpenAICompletionsCachePayload>((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(model.compat?.supportsLongCacheRetention).toBe(false);
			expect(capturedPayload).toBeDefined();
			expect(capturedPayload?.prompt_cache_key).toBeUndefined();
			expect(capturedPayload?.prompt_cache_retention).toBeUndefined();
		});
	});
});
