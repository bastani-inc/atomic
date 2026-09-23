import assert from "node:assert/strict";
import { builtinProviders } from "@bastani/pi-ai/providers/all";
import { afterEach, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	inferRouterDecision,
	inferStructuredOutput,
	resolveRouterModel,
} from "../../packages/coding-agent/src/core/structured-output/index.js";
import {
	decisionMessage,
	decisionModel,
	decisionRequest,
	jevResponse,
	messageStream,
} from "../helpers/structured-output.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function storedRuntime(key = "mock-stored-jev-key") {
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		credentials: AuthStorage.inMemory({ typesafe: { type: "api_key", key } }),
		allowModelNetwork: false,
	});
	return { runtime, registry: new ModelRegistry(runtime) };
}

for (const nextAuth of ["stored", "deleted", "environment"] as const) {
	test(`saved Jev auth survives overlapping registration and subsequent ${nextAuth} auth`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "");
		const runtime = await ModelRuntime.create({
			modelsPath: null,
			credentials: AuthStorage.inMemory(),
			allowModelNetwork: false,
		});
		const provider = builtinProviders().find((candidate) => candidate.id === "typesafe")!;
		const apiKey = provider.auth.apiKey!;
		const saveEntered = Promise.withResolvers<void>();
		const releaseSave = Promise.withResolvers<void>();
		const registrationEntered = Promise.withResolvers<void>();
		const releaseRegistration = Promise.withResolvers<void>();
		let phase: "idle" | "save" | "registration" = "idle";
		const gatedProvider = {
			...provider,
			auth: {
				...provider.auth,
				apiKey: {
					...apiKey,
					check: async (options: Parameters<NonNullable<typeof apiKey.check>>[0]) => {
						const resolved = await apiKey.resolve(options);
						const result = resolved ? { type: "api_key" as const, source: resolved.source } : undefined;
						if (phase === "save") {
							saveEntered.resolve();
							await releaseSave.promise;
						} else if (phase === "registration") {
							registrationEntered.resolve();
							await releaseRegistration.promise;
						}
						return result;
					},
				},
			},
		};
		const setup = runtime.createExtensionProviderTransaction();
		setup.registerNativeProvider(gatedProvider);
		await setup.commit();
		phase = "save";
		const save = runtime.saveCredential("typesafe", { type: "api_key", key: "mock-saved-jev-key" });
		await saveEntered.promise;
		phase = "registration";
		const registration = runtime.createExtensionProviderTransaction();
		registration.registerNativeProvider(gatedProvider);
		const refresh = registration.commit();
		await registrationEntered.promise;
		releaseSave.resolve();
		try {
			await save;
			assert.deepEqual(runtime.getProviderAuthStatus("typesafe"), { configured: true, source: "stored" });
			const request = {
				...decisionRequest(),
				settings: SettingsManager.inMemory(),
				modelRegistry: new ModelRegistry(runtime),
			};
			assert.equal(resolveRouterModel(request).kind, "jev");
			phase = "idle";
			if (nextAuth !== "stored") {
				if (nextAuth === "environment") vi.stubEnv("TYPESAFE_API_KEY", "mock-next-env-key");
				await runtime.logout("typesafe");
				assert.equal(runtime.getStoredCredentialType("typesafe"), undefined);
				assert.equal(resolveRouterModel(request).kind, nextAuth === "deleted" ? "chat" : "jev");
			}
		} finally {
			phase = "idle";
			releaseRegistration.resolve();
			await refresh;
		}
		assert.equal(runtime.getProviderAuthStatus("typesafe").configured, nextAuth !== "deleted");
		assert.equal(runtime.getProviderAuthStatus("typesafe").source, nextAuth === "deleted" ? undefined : nextAuth);
		assert.equal(runtime.getStoredCredentialType("typesafe"), nextAuth === "stored" ? "api_key" : undefined);
	});
}

for (const environmentKey of ["", "mock-env-jev-key"]) {
	test(`stored Jev credentials route and authenticate without chat exposure, env=${Boolean(environmentKey)}`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", environmentKey);
		const { runtime, registry } = await storedRuntime();
		const transport = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
			assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer mock-stored-jev-key");
			assert.doesNotMatch(String(options?.body), /mock-stored-jev-key|mock-env-jev-key/);
			return Response.json(jevResponse());
		});
		vi.stubGlobal("fetch", transport);
		const request = { ...decisionRequest(), settings: SettingsManager.inMemory(), modelRegistry: registry };
		assert.equal(resolveRouterModel(request).kind, "jev");
		assert.equal((await inferRouterDecision(request)).model, "typesafe/jev-latest");
		assert.equal(
			(await inferStructuredOutput({ ...request, model: { kind: "jev", fullId: "typesafe/jev-latest" } })).model,
			"typesafe/jev-latest",
		);
		assert.equal(transport.mock.calls.length, 2);
		assert.equal(
			registry.getAll().some((model) => model.provider === "typesafe"),
			false,
		);
		assert.equal(
			registry.getAvailable().some((model) => model.provider === "typesafe"),
			false,
		);
		assert.equal(runtime.canRestoreUnknownModel("typesafe-ai", "jev"), false);
		assert.equal(request.currentModel?.id, "chat");
	});
}

test("explicit chat router wins over saved Jev without resolving its key", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "");
	const { registry } = await storedRuntime();
	const getProviderAuth = vi.spyOn(registry, "getProviderAuth");
	vi.spyOn(registry, "getAll").mockReturnValue([decisionModel]);
	assert.equal(resolveRouterModel({ ...decisionRequest(), modelRegistry: registry }).kind, "chat");
	assert.equal(getProviderAuth.mock.calls.length, 0);
});

test("Jev logout removes stored routing preference and falls back to environment when present", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "");
	const { runtime, registry } = await storedRuntime();
	const request = { ...decisionRequest(), settings: SettingsManager.inMemory(), modelRegistry: registry };
	assert.equal(resolveRouterModel(request).kind, "jev");
	await runtime.logout("typesafe");
	assert.equal(resolveRouterModel(request).kind, "chat");
	const transport = vi.fn(async () => Response.json(jevResponse()));
	vi.stubGlobal("fetch", transport);
	await assert.rejects(
		inferStructuredOutput({ ...request, model: { kind: "jev", fullId: "typesafe/jev-latest" } }),
		/requires an API key/,
	);
	assert.equal(transport.mock.calls.length, 0);

	vi.stubEnv("TYPESAFE_API_KEY", "mock-env-remaining");
	const next = await storedRuntime();
	await next.runtime.logout("typesafe");
	assert.equal(resolveRouterModel({ ...request, modelRegistry: next.registry }).kind, "jev");
	assert.equal((await next.registry.getProviderAuth("typesafe"))?.auth.apiKey, "mock-env-remaining");
});

test("saved Jev key interpolation uses ordinary auth resolution", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "");
	vi.stubEnv("JEV_TEST_KEY", "mock-interpolated-key");
	const { registry } = await storedRuntime("$JEV_TEST_KEY");
	const transport = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
		assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer mock-interpolated-key");
		return Response.json(jevResponse());
	});
	vi.stubGlobal("fetch", transport);
	await inferStructuredOutput({
		...decisionRequest(),
		modelRegistry: registry,
		model: { kind: "jev", fullId: "typesafe/jev-latest" },
	});
	assert.equal(transport.mock.calls.length, 1);
});

test("Jev auth failures are redacted and cannot fall back to environment credentials", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-env-key");
	const request = decisionRequest();
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);
	await assert.rejects(
		inferStructuredOutput({
			...request,
			modelRegistry: {
				...request.modelRegistry,
				getProviderAuth: async () => {
					throw new Error("private-key-material");
				},
			},
			model: { kind: "jev", fullId: "typesafe/jev-latest" },
		}),
		(error: Error) => {
			assert.match(error.message, /Jev credential resolution failed/);
			assert.doesNotMatch(String(error.stack), /private-key-material/);
			assert.equal(error.cause, undefined);
			return true;
		},
	);
	assert.equal(transport.mock.calls.length, 0);
});

test("Jev credential resolution receives caller cancellation", async () => {
	const request = decisionRequest();
	const controller = new AbortController();
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);
	let authSignal: AbortSignal | undefined;
	const pending = assert.rejects(
		inferStructuredOutput({
			...request,
			modelRegistry: {
				...request.modelRegistry,
				getProviderAuth: async (_provider, options) => {
					authSignal = options?.signal;
					return new Promise(() => {});
				},
			},
			model: { kind: "jev", fullId: "typesafe/jev-latest" },
			signal: controller.signal,
		}),
		/cancelled/,
	);
	controller.abort();
	await pending;
	assert.equal(authSignal?.aborted, true);
	assert.equal(transport.mock.calls.length, 0);
});

test("direct Jev decisions resolve the classifier model and auth from the unified registry", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "");
	const { runtime, registry } = await storedRuntime();
	assert.equal(runtime.getProvider("typesafe-ai"), undefined);
	const classifier = registry.getClassifierModel("typesafe", "jev-latest");
	assert.equal(classifier?.api, "typesafe-system-one");
	assert.ok(classifier);
	const lookup = vi.spyOn(registry, "getClassifierModel").mockReturnValue({
		...classifier,
		baseUrl: "https://registry.example/v1/",
	});
	const transport = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
		assert.equal(String(url), "https://registry.example/v1/systemone");
		assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer mock-stored-jev-key");
		return Response.json(jevResponse());
	});
	vi.stubGlobal("fetch", transport);
	const request = {
		...decisionRequest(),
		settings: SettingsManager.inMemory({ routerModel: "typesafe/jev-latest" }),
		modelRegistry: registry,
	};
	assert.deepEqual(resolveRouterModel(request), { kind: "jev", fullId: "typesafe/jev-latest" });
	assert.equal((await inferRouterDecision(request)).model, "typesafe/jev-latest");
	assert.ok(lookup.mock.calls.length >= 2);
	assert.equal(transport.mock.calls.length, 1);
});

test("structured decisions accept classifier and multimodal chat, but reject image at both selection boundaries", async () => {
	const { runtime, registry } = await storedRuntime();
	const image = runtime.getAllModels("openrouter").find((model) => model.type === "image");
	assert.ok(image);
	const multimodalChat = { ...decisionModel, input: ["text", "image"] as Array<"text" | "image"> };
	const request = decisionRequest();
	const router = { ...request, modelRegistry: registry };
	assert.deepEqual(
		resolveRouterModel({ ...router, settings: SettingsManager.inMemory({ routerModel: "typesafe/jev-latest" }) }),
		{ kind: "jev", fullId: "typesafe/jev-latest" },
	);
	assert.equal(
		resolveRouterModel({
			...router,
			settings: SettingsManager.inMemory({ routerModel: "" }),
			currentModel: multimodalChat,
		}).kind,
		"jev",
	);
	assert.equal(
		resolveRouterModel({
			...router,
			settings: SettingsManager.inMemory({ routerModel: "decision-test/chat" }),
			modelRegistry: { ...registry, getAll: () => [multimodalChat] },
		}).kind,
		"chat",
	);
	const chatResult = await inferStructuredOutput({
		...request,
		model: { kind: "chat", fullId: "decision-test/chat", model: multimodalChat },
		modelRegistry: {
			...request.modelRegistry,
			streamSimple: () => messageStream(decisionMessage()),
		},
	});
	assert.equal(chatResult.model, "decision-test/chat");
	assert.throws(
		() =>
			resolveRouterModel({
				...router,
				settings: SettingsManager.inMemory({ routerModel: `${image.provider}/${image.id}` }),
				modelRegistry: { ...registry, getAll: () => [image as unknown as typeof decisionModel] },
			}),
		/Invalid routerModel.*chat catalog/,
	);
	await assert.rejects(
		inferStructuredOutput({
			...request,
			model: {
				kind: "chat",
				fullId: `${image.provider}/${image.id}`,
				model: image as unknown as typeof decisionModel,
			},
		}),
		/image models cannot decide/,
	);
	const classifier = registry.getClassifierModel("typesafe", "jev-latest");
	assert.ok(classifier);
	await assert.rejects(
		inferStructuredOutput({
			...request,
			model: { kind: "chat", fullId: "typesafe/jev-latest", model: classifier as unknown as typeof decisionModel },
		}),
		/chat model or Jev classifier/,
	);
});
