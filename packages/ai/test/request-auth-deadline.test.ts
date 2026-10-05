import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { ApiKeyAuth, OAuthAuth, OAuthCredential, ProviderAuth } from "../src/auth/types.ts";
import {
	createModels,
	type Provider,
	REQUEST_AUTH_PREPARATION_TIMEOUT_MS,
	requestAuthTimeoutMessage,
} from "../src/models.ts";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, StreamOptions } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

// Issue #3085

function testModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "test-api",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

function doneMessage(model: Model<Api>, text: string): AssistantMessage {
	return {
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
		timestamp: Date.now(),
	};
}

interface ProviderCall {
	model: Model<Api>;
	options: StreamOptions | undefined;
}

const ambientAuth: ApiKeyAuth = {
	name: "Ambient",
	resolve: async () => ({ auth: {} }),
};

function testProvider(input: {
	id: string;
	models?: Model<Api>[];
	auth?: ProviderAuth;
	calls?: ProviderCall[];
}): Provider {
	const models = input.models ?? [testModel(input.id, "model-a")];
	const respond = (model: Model<Api>, options: StreamOptions | undefined) => {
		input.calls?.push({ model, options });
		const stream = new AssistantMessageEventStream();
		const message = doneMessage(model, "ok");
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
	return {
		id: input.id,
		name: input.id,
		auth: input.auth ?? { apiKey: ambientAuth },
		getModels: () => models,
		stream: (model, _context, options) => respond(model, options as StreamOptions | undefined),
		streamSimple: (model, _context, options) => respond(model, options as SimpleStreamOptions | undefined),
	};
}

function testOAuth(overrides?: Partial<OAuthAuth>): OAuthAuth {
	return {
		name: "Test OAuth",
		login: async () => {
			throw new Error("not used");
		},
		refresh: async (credential) => credential,
		toAuth: async (credential) => ({ apiKey: credential.access }),
		...overrides,
	};
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

const expiredOAuth: OAuthCredential = { type: "oauth", access: "old", refresh: "r", expires: 0 };

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function expectAuthTimeoutError(error: unknown, providerId = "p1"): void {
	expect(error).toMatchObject({ name: "ModelsError", code: "auth" });
	expect((error as Error).message).toBe(requestAuthTimeoutMessage(providerId));
	expect((error as Error).message).not.toMatch(/log in/i);
}

describe("request-auth preparation deadline", () => {
	it("settles a signal-ignoring OAuth refresh at 15_000ms, not 14_999ms", async () => {
		vi.useFakeTimers();
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("p1", async () => expiredOAuth);
		const models = createModels({ credentials });
		models.setProvider(
			testProvider({
				id: "p1",
				auth: {
					oauth: testOAuth({
						refresh: async () => new Promise(() => {}),
					}),
				},
			}),
		);

		const pending = models.getAuth("p1");
		let settled: unknown;
		void pending.then(
			(value) => {
				settled = value;
			},
			(error: unknown) => {
				settled = error;
			},
		);

		await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS - 1);
		expect(settled).toBeUndefined();

		await vi.advanceTimersByTimeAsync(1);
		expectAuthTimeoutError(settled);
		expect(await credentials.read("p1")).toEqual(expiredOAuth);
	});

	it("does not start a provider request after auth preparation times out", async () => {
		vi.useFakeTimers();
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("p1", async () => expiredOAuth);
		const calls: ProviderCall[] = [];
		const models = createModels({ credentials });
		models.setProvider(
			testProvider({
				id: "p1",
				auth: {
					oauth: testOAuth({
						refresh: async () => new Promise(() => {}),
					}),
				},
				calls,
			}),
		);

		const pending = models.completeSimple(testModel("p1", "model-a"), context);
		let settled: AssistantMessage | undefined;
		void pending.then((message) => {
			settled = message;
		});

		await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS - 1);
		expect(settled).toBeUndefined();
		expect(calls).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(settled?.stopReason).toBe("error");
		expect(settled?.errorMessage).toBe(requestAuthTimeoutMessage("p1"));
		expect(settled?.errorMessage).not.toMatch(/log in/i);
		expect(calls).toHaveLength(0);
	});

	it("persists rotation after the request-auth waiting deadline (#3429)", async () => {
		vi.useFakeTimers();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
			return controller.signal;
		});
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("p1", async () => expiredOAuth);
		let refreshSignal: AbortSignal | undefined;
		const models = createModels({ credentials });
		models.setProvider(
			testProvider({
				id: "p1",
				auth: {
					oauth: testOAuth({
						refresh: async (credential, signal) => {
							refreshSignal = signal;
							await new Promise((resolve) => setTimeout(resolve, REQUEST_AUTH_PREPARATION_TIMEOUT_MS + 1000));
							return { ...credential, access: "fresh", refresh: "r2", expires: Number.MAX_SAFE_INTEGER };
						},
					}),
				},
			}),
		);

		const pending = models.getAuth("p1");
		let settled: unknown;
		void pending.then(
			(value) => {
				settled = value;
			},
			(error: unknown) => {
				settled = error;
			},
		);

		await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS);
		expectAuthTimeoutError(settled);

		assert.equal(refreshSignal?.aborted, false);
		await vi.advanceTimersByTimeAsync(1000);
		assert.deepEqual(await credentials.read("p1"), {
			type: "oauth",
			access: "fresh",
			refresh: "r2",
			expires: Number.MAX_SAFE_INTEGER,
		});
	});

	it("settles a hung toAuth derivation at the request-auth deadline", async () => {
		vi.useFakeTimers();
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("p1", async () => ({
			type: "oauth",
			access: "valid",
			refresh: "r",
			expires: Number.MAX_SAFE_INTEGER,
		}));
		const models = createModels({ credentials });
		models.setProvider(
			testProvider({
				id: "p1",
				auth: {
					oauth: testOAuth({
						toAuth: async () => new Promise(() => {}),
					}),
				},
			}),
		);

		const pending = models.getAuth("p1");
		let settled: unknown;
		void pending.then(
			(value) => {
				settled = value;
			},
			(error: unknown) => {
				settled = error;
			},
		);

		await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS - 1);
		expect(settled).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expectAuthTimeoutError(settled);
	});

	it("rejects already-aborted request auth without starting refresh", async () => {
		let refreshes = 0;
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("p1", async () => expiredOAuth);
		const models = createModels({ credentials });
		models.setProvider(
			testProvider({
				id: "p1",
				auth: {
					oauth: testOAuth({
						refresh: async (credential) => {
							refreshes++;
							return credential;
						},
					}),
				},
			}),
		);
		const controller = new AbortController();
		controller.abort();

		await expect(models.getAuth("p1", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
		expect(refreshes).toBe(0);
	});

	it("does not carry the auth-preparation timer into a successful stream", async () => {
		vi.useFakeTimers();
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("p1", async () => ({
			type: "oauth",
			access: "valid",
			refresh: "r",
			expires: Number.MAX_SAFE_INTEGER,
		}));
		const calls: ProviderCall[] = [];
		const models = createModels({ credentials });
		models.setProvider(testProvider({ id: "p1", auth: { oauth: testOAuth() }, calls }));

		const pending = models.completeSimple(testModel("p1", "model-a"), context);
		await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS + 1_000);
		const result = await pending;

		expect(result.stopReason).toBe("stop");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.options?.signal?.aborted).not.toBe(true);
	});

	it("times out a hung credential-store read with a source-neutral diagnostic (#3087)", async () => {
		vi.useFakeTimers();
		const credentials = new InMemoryCredentialStore();
		credentials.read = async () => new Promise(() => {});
		const calls: ProviderCall[] = [];
		const models = createModels({ credentials });
		models.setProvider(testProvider({ id: "p1", calls }));

		const pending = models.getAuth("p1");
		let settled: unknown;
		void pending.then(
			(value) => {
				settled = value;
			},
			(error: unknown) => {
				settled = error;
			},
		);

		await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS - 1);
		expect(settled).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expectAuthTimeoutError(settled);
		expect(calls).toHaveLength(0);
	});

	it("times out a hung ambient resolver with a source-neutral diagnostic (#3087)", async () => {
		vi.useFakeTimers();
		const calls: ProviderCall[] = [];
		const models = createModels();
		models.setProvider(
			testProvider({
				id: "p1",
				auth: {
					apiKey: {
						name: "Ambient",
						resolve: async () => new Promise(() => {}),
					},
				},
				calls,
			}),
		);

		const pending = models.completeSimple(testModel("p1", "model-a"), context);
		let settled: AssistantMessage | undefined;
		void pending.then((message) => {
			settled = message;
		});

		await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS - 1);
		expect(settled).toBeUndefined();
		expect(calls).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(settled?.stopReason).toBe("error");
		expect(settled?.errorMessage).toBe(requestAuthTimeoutMessage("p1"));
		expect(settled?.errorMessage).not.toMatch(/log in/i);
		expect(calls).toHaveLength(0);
	});

	it("times out a hung explicit API-key resolver without login guidance (#3087)", async () => {
		vi.useFakeTimers();
		const models = createModels();
		models.setProvider(
			testProvider({
				id: "p1",
				auth: {
					apiKey: {
						name: "Key",
						resolve: async () => new Promise(() => {}),
					},
				},
			}),
		);

		const pending = models.getAuth("p1", { apiKey: "explicit" });
		let settled: unknown;
		void pending.then(
			(value) => {
				settled = value;
			},
			(error: unknown) => {
				settled = error;
			},
		);

		await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS);
		expectAuthTimeoutError(settled);
	});

	it("times out a hung stored API-key resolver without dispatch (#3087)", async () => {
		vi.useFakeTimers();
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("p1", async () => ({ type: "api_key", key: "stored" }));
		const calls: ProviderCall[] = [];
		const models = createModels({ credentials });
		models.setProvider(
			testProvider({
				id: "p1",
				auth: {
					apiKey: {
						name: "Key",
						resolve: async () => new Promise(() => {}),
					},
				},
				calls,
			}),
		);

		const pending = models.completeSimple(testModel("p1", "model-a"), context);
		let settled: AssistantMessage | undefined;
		void pending.then((message) => {
			settled = message;
		});
		await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS);
		expect(settled?.stopReason).toBe("error");
		expect(settled?.errorMessage).toBe(requestAuthTimeoutMessage("p1"));
		expect(calls).toHaveLength(0);
	});
});
