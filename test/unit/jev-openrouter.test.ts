import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import {
	inferRouterDecision,
	inferStructuredOutput,
} from "../../packages/coding-agent/src/core/structured-output/index.js";
import { jevFixtureResponse } from "../helpers/jev-tournament.js";
import { decisionRequest, jevResponse } from "../helpers/structured-output.js";

const fullId = "openrouter/~typesafe/jev-latest" as const;
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

for (const method of ["api_key", "oauth", "environment", "interpolated"] as const) {
	test(`OpenRouter Jev uses existing ${method} auth and the Decisions API`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "synthetic-wrong-provider");
		vi.stubEnv("OPENROUTER_API_KEY", "synthetic-env");
		vi.stubEnv("JEV_OPENROUTER_TEST_KEY", "synthetic-interpolated");
		const credentials = AuthStorage.inMemory({
			"typesafe-ai": { type: "api_key", key: "synthetic-wrong-stored" },
			...(method === "environment"
				? {}
				: {
						openrouter:
							method === "oauth"
								? {
										type: "oauth" as const,
										access: "synthetic-oauth",
										refresh: "",
										expires: Date.now() + 3600000,
									}
								: {
										type: "api_key" as const,
										key: method === "interpolated" ? "$JEV_OPENROUTER_TEST_KEY" : "synthetic-api_key",
									},
					}),
		});
		const runtime = await ModelRuntime.create({ modelsPath: null, credentials, allowModelNetwork: false });
		const registry = new ModelRegistry(runtime);
		const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
			assert.equal(init?.redirect, "error");
			assert.equal(
				new Headers(init?.headers).get("Authorization"),
				`Bearer synthetic-${method === "environment" ? "env" : method}`,
			);
			const body = JSON.parse(String(init?.body));
			assert.equal(body.model, "~typesafe/jev-latest");
			assert.deepEqual(body.state, decisionRequest().state);
			assert.equal(body.questions.route.type, "choice");
			assert.equal(body.messages, undefined);
			assert.equal(body.tools, undefined);
			assert.doesNotMatch(String(init?.body), /synthetic-/);
			// Official https://openrouter.ai/openapi.json DecisionsResponse envelope.
			return Response.json({
				...jevResponse(),
				id: "gen-dec-fixture",
				provider: "TypeSafe",
				model: "typesafe/jev-1.13-20260917",
			});
		});
		vi.stubGlobal("fetch", transport);
		const request = { ...decisionRequest(), modelRegistry: registry, settings: { getRouterModel: () => fullId } };
		const routed = await inferRouterDecision(request);
		assert.equal(routed.model, fullId);
		assert.equal(routed.responseModel, "typesafe/jev-1.13-20260917");
		assert.deepEqual(routed.value, { route: "review", limit: 1.23456789 });
		assert.equal((await inferStructuredOutput({ ...request, model: { kind: "jev", fullId } })).model, fullId);
		assert.equal(transport.mock.calls.length, 2);
	});
}

test("OpenRouter Jev does not use TypeSafe credentials when OpenRouter auth is missing", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-wrong-provider");
	vi.stubEnv("OPENROUTER_API_KEY", "");
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		credentials: AuthStorage.inMemory({ "typesafe-ai": { type: "api_key", key: "synthetic-wrong-stored" } }),
		allowModelNetwork: false,
	});
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);
	await assert.rejects(
		inferRouterDecision({
			...decisionRequest(),
			currentModel: undefined,
			modelRegistry: new ModelRegistry(runtime),
			settings: { getRouterModel: () => fullId },
		}),
		/openrouter\/.*requires an API key.*\/login openrouter.*OPENROUTER_API_KEY/,
	);
	assert.equal(transport.mock.calls.length, 0);
});

test("minimal adapters use only OpenRouter environment auth", async () => {
	vi.stubEnv("OPENROUTER_API_KEY", "synthetic-openrouter");
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-typesafe");
	const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-openrouter");
		return Response.json(jevResponse());
	});
	vi.stubGlobal("fetch", transport);
	await inferStructuredOutput({ ...decisionRequest(), model: { kind: "jev", fullId } });
	assert.equal(transport.mock.calls.length, 1);
});

test("OpenRouter logout falls back to its environment key, not TypeSafe", async () => {
	vi.stubEnv("OPENROUTER_API_KEY", "synthetic-env");
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-wrong-provider");
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		credentials: AuthStorage.inMemory({ openrouter: { type: "api_key", key: "synthetic-stored" } }),
		allowModelNetwork: false,
	});
	await runtime.logout("openrouter");
	const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-env");
		return Response.json(jevResponse());
	});
	vi.stubGlobal("fetch", transport);
	await inferRouterDecision({
		...decisionRequest(),
		modelRegistry: new ModelRegistry(runtime),
		settings: { getRouterModel: () => fullId },
	});
	assert.equal(transport.mock.calls.length, 1);
});

for (const [status, calls] of [
	[401, 1],
	[429, 4],
	[529, 4],
] as const) {
	test(`OpenRouter HTTP ${status} is redacted and ${calls === 1 ? "fails once" : "retried as transient"} (#3206)`, async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "synthetic-key");
		const transport = vi.fn(async () => new Response("private-upstream-material", { status }));
		vi.stubGlobal("fetch", transport);
		await assert.rejects(
			inferRouterDecision({
				...decisionRequest(),
				currentModel: undefined,
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
				settings: { getRouterModel: () => fullId },
			}),
			(error: Error) => {
				assert.match(error.message, new RegExp(`Jev HTTP ${status}`));
				assert.doesNotMatch(error.message, /private-upstream-material|typesafe-ai|TYPESAFE_API_KEY/);
				if (status === 401) assert.match(error.message, /\/login openrouter.*OPENROUTER_API_KEY/);
				return true;
			},
		);
		assert.equal(transport.mock.calls.length, calls);
	});
}

test("OpenRouter malformed decisions have bounded router repairs but generic calls remain one-shot", async () => {
	vi.stubEnv("OPENROUTER_API_KEY", "synthetic-key");
	const transport = vi.fn(async () => Response.json({ ...jevResponse(), answers: {} }));
	vi.stubGlobal("fetch", transport);
	await assert.rejects(
		inferRouterDecision({
			...decisionRequest(),
			currentModel: undefined,
			settings: { getRouterModel: () => fullId },
		}),
		/choice_key/,
	);
	assert.equal(transport.mock.calls.length, 4);
	transport.mockClear();
	await assert.rejects(inferStructuredOutput({ ...decisionRequest(), model: { kind: "jev", fullId } }), /choice_key/);
	assert.equal(transport.mock.calls.length, 1);
});

test("OpenRouter cancellation during auth cannot dispatch or decode a late result", async () => {
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const request = decisionRequest();
	const decode = vi.fn(request.jev.decode);
	let authSignal: AbortSignal | undefined;
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);
	const result = inferRouterDecision({
		...request,
		settings: { getRouterModel: () => fullId },
		signal: controller.signal,
		jev: { ...request.jev, decode },
		modelRegistry: {
			...request.modelRegistry,
			getProviderAuth: async (provider, options) => {
				assert.equal(provider, "openrouter");
				authSignal = options?.signal;
				entered.resolve();
				await release.promise;
				return undefined;
			},
		},
	});
	await entered.promise;
	controller.abort();
	await assert.rejects(result, /cancelled/);
	release.resolve();
	assert.equal(authSignal?.aborted, true);
	assert.equal(transport.mock.calls.length, 0);
	assert.equal(decode.mock.calls.length, 0);
});

test("OpenRouter auth errors are redacted without bypassing the resolver through environment fallback", async () => {
	vi.stubEnv("OPENROUTER_API_KEY", "synthetic-env");
	const request = decisionRequest();
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);
	await assert.rejects(
		inferRouterDecision({
			...request,
			currentModel: undefined,
			settings: { getRouterModel: () => fullId },
			modelRegistry: {
				...request.modelRegistry,
				getProviderAuth: async () => {
					throw new Error("private-auth-material");
				},
			},
		}),
		(error: Error) => {
			assert.match(error.message, /Jev credential resolution failed.*\/login openrouter/);
			assert.doesNotMatch(String(error.stack), /private-auth-material/);
			return true;
		},
	);
	assert.equal(transport.mock.calls.length, 0);
});

// #3118: Jev may return rounded probabilities that do not sum to one.
for (const selected of ["typesafe-ai/jev-latest", fullId] as const) {
	test(`${selected} preserves non-normalized probability acceptance and provider isolation`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "synthetic-typesafe");
		vi.stubEnv("OPENROUTER_API_KEY", "synthetic-openrouter");
		const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const direct = selected === "typesafe-ai/jev-latest";
			assert.equal(
				url,
				direct ? "https://api.typesafe.ai/v1/systemone" : "https://openrouter.ai/api/alpha/decisions",
			);
			assert.equal(
				new Headers(init?.headers).get("Authorization"),
				direct ? "Bearer synthetic-typesafe" : "Bearer synthetic-openrouter",
			);
			assert.equal(JSON.parse(String(init?.body)).model, direct ? "jev-latest" : "~typesafe/jev-latest");
			const response = jevResponse();
			response.answers.route.probabilities = { none: 0.2, review: 0.7 };
			return Response.json(response);
		});
		vi.stubGlobal("fetch", transport);
		const result = await inferStructuredOutput({ ...decisionRequest(), model: { kind: "jev", fullId: selected } });
		assert.equal(result.model, selected);
		assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
		assert.equal(transport.mock.calls.length, 1);
	});
}

test("OpenRouter auth receives caller cancellation", async () => {
	const request = decisionRequest();
	const controller = new AbortController();
	let signal: AbortSignal | undefined;
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);
	const pending = assert.rejects(
		inferStructuredOutput({
			...request,
			model: { kind: "jev", fullId },
			signal: controller.signal,
			modelRegistry: {
				...request.modelRegistry,
				getProviderAuth: async (_provider, options) => {
					signal = options?.signal;
					return new Promise(() => {});
				},
			},
		}),
		/cancelled/,
	);
	controller.abort();
	await pending;
	assert.equal(signal?.aborted, true);
	assert.equal(transport.mock.calls.length, 0);
});

for (const initialId of [fullId, "typesafe-ai/jev-latest"] as const) {
	for (const count of [2, 256]) {
		test(`${initialId} preserves selection during delayed auth with ${count} choices`, async () => {
			const runtime = await ModelRuntime.create({
				modelsPath: null,
				credentials: AuthStorage.inMemory({
					openrouter: { type: "api_key", key: "synthetic-openrouter" },
					"typesafe-ai": { type: "api_key", key: "synthetic-typesafe" },
				}),
				allowModelNetwork: false,
			});
			const registry = new ModelRegistry(runtime);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const authIds: string[] = [];
			const destinations: { url: string; authorization: string | null; model: string }[] = [];
			const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body));
				destinations.push({
					url: String(url),
					authorization: new Headers(init?.headers).get("Authorization"),
					model: body.model,
				});
				return Response.json(
					jevFixtureResponse(body, (keys) =>
						keys.includes("review") ? "review" : keys.includes("exact") ? "exact" : keys[0]!,
					),
				);
			});
			vi.stubGlobal("fetch", transport);
			const request = decisionRequest();
			const model: { kind: "jev"; fullId: typeof fullId | "typesafe-ai/jev-latest" } = {
				kind: "jev",
				fullId: initialId,
			};
			const pending = inferStructuredOutput({
				...request,
				model,
				jev: {
					...request.jev,
					questions: {
						...request.jev.questions,
						route: {
							...request.jev.questions.route,
							criteria: {
								...request.jev.questions.route.criteria,
								...Object.fromEntries(Array.from({ length: count - 2 }, (_, i) => [`other${i}`, `Other ${i}`])),
							},
						},
					},
				},
				modelRegistry: {
					...request.modelRegistry,
					getProviderAuth: async (provider, options) => {
						authIds.push(provider);
						if (authIds.length === 1) {
							entered.resolve();
							await release.promise;
						}
						return registry.getProviderAuth(provider, options);
					},
				},
			});
			await entered.promise;
			model.fullId = initialId === fullId ? "typesafe-ai/jev-latest" : fullId;
			release.resolve();
			const result = await pending;
			const calls = count === 2 ? 1 : 2;
			const direct = initialId === "typesafe-ai/jev-latest";
			assert.deepEqual(authIds, Array(calls).fill(direct ? "typesafe-ai" : "openrouter"));
			assert.deepEqual(
				destinations,
				Array(calls).fill({
					url: direct ? "https://api.typesafe.ai/v1/systemone" : "https://openrouter.ai/api/alpha/decisions",
					authorization: `Bearer synthetic-${direct ? "typesafe" : "openrouter"}`,
					model: direct ? "jev-latest" : "~typesafe/jev-latest",
				}),
			);
			assert.equal(result.model, initialId);
			assert.equal(result.responseModel, "jev-fixture");
			assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
			assert.deepEqual(result.usage, { inputTokens: 20 * calls, outputTokens: 10 * calls });
			assert.equal(transport.mock.calls.length, calls);
		});
	}
}
