import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, ApiStreamOptions, Model, Provider, SimpleStreamOptions, TranscriptContext } from "@bastani/pi-ai";
import { test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { resolveCliModel } from "../src/core/model-resolver-cli.js";
import { ModelRuntime } from "../src/core/model-runtime.js";

const legacy = "azure-openai-responses";

test("legacy Azure extension and native providers share lookup, authentication and lifecycle identity", async () => {
	for (const transactional of [false, true]) {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ [legacy]: { type: "api_key", key: "legacy-key" } }),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const model = runtime.getModel("azure", "deepseek-v4-pro");
		assert.ok(model);
		const config = { models: [{ ...model, baseUrl: "https://azure.test", id: "deployment", name: "Deployment" }] };
		const registration = transactional ? runtime.createExtensionProviderTransaction() : runtime;
		registration.registerProvider(legacy, config);
		if ("commit" in registration) await registration.commit();
		for (const id of [legacy, "azure"]) {
			assert.equal(runtime.getModel(id, "deployment")?.provider, "azure");
			assert.ok(runtime.getRegisteredProviderConfig(id));
			assert.equal((await runtime.getAuth(id))?.auth.apiKey, "legacy-key");
			assert.ok((await runtime.getAvailable(id)).some((entry) => entry.id === "deployment"));
		}
		assert.deepEqual(runtime.getRegisteredProviderIds(), ["azure"]);
		const removal = transactional ? runtime.createExtensionProviderTransaction() : runtime;
		removal.unregisterProvider(legacy);
		if ("commit" in removal) await removal.commit();
		assert.equal(runtime.getModel("azure", "deployment"), undefined);
		assert.deepEqual(runtime.getRegisteredProviderIds(), []);
		assert.ok(runtime.getModel(legacy, "deepseek-v4-pro"));

		const azure = runtime.getProvider("azure");
		assert.ok(azure);
		class LegacyNativeProvider {
			readonly id = legacy;
			readonly name = "Legacy native Azure";
			readonly auth = azure!.auth;
			#source: Provider = azure!;
			getModels() {
				return [{ ...model!, id: "native-deployment", provider: legacy, baseUrl: "https://azure.test" }];
			}
			stream<T extends Api>(request: Model<T>, context: TranscriptContext, options?: ApiStreamOptions<T>) {
				return this.#source.stream(request, context, options);
			}
			streamSimple(request: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
				return this.#source.streamSimple(request, context, options);
			}
		}
		const nativeRegistration = transactional ? runtime.createExtensionProviderTransaction() : runtime;
		const native = new LegacyNativeProvider();
		nativeRegistration.registerNativeProvider(native);
		if ("commit" in nativeRegistration) await nativeRegistration.commit();
		for (const id of [legacy, "azure"]) {
			assert.equal(runtime.getRegisteredNativeProvider(id), native);
			const deployment = runtime.getModel(id, "native-deployment");
			assert.ok(deployment);
			assert.equal(deployment.provider, "azure");
			const result = await runtime
				.streamSimple(
					deployment,
					{ messages: [] },
					{
						onPayload: () => {
							throw new Error("offline capture");
						},
					},
				)
				.result();
			assert.equal(result.errorMessage, "offline capture");
		}
		const replacement = transactional ? runtime.createExtensionProviderTransaction([legacy]) : runtime;
		if ("commit" in replacement) await replacement.commit();
		else replacement.unregisterProvider(legacy);
		assert.deepEqual(runtime.getRegisteredProviderIds(), []);
		assert.equal(runtime.getModel("azure", "native-deployment"), undefined);
	}
});

test("Azure extension registrations retain implicit Responses and explicit Chat Completions", async () => {
	for (const provider of [legacy, "azure"]) {
		for (const transactional of [false, true]) {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const source = runtime.getModel("azure", "gpt-5.4");
			assert.ok(source);
			const { api: _api, ...definition } = source;
			const registration = transactional ? runtime.createExtensionProviderTransaction() : runtime;
			registration.registerProvider(provider, {
				baseUrl: "https://azure.test",
				models: [
					{ ...definition, baseUrl: "https://azure.test", id: "responses-deployment" },
					{ ...definition, baseUrl: "https://azure.test", id: "chat-deployment", api: "openai-completions" },
				],
			});
			if ("commit" in registration) await registration.commit();
			assert.equal(runtime.getModel(provider, "responses-deployment")?.api, legacy);
			assert.equal(runtime.getModel(provider, "chat-deployment")?.api, "openai-completions");
			const replacement = transactional ? runtime.createExtensionProviderTransaction() : runtime;
			replacement.registerProvider(provider, {
				baseUrl: "https://azure.test",
				api: "openai-completions",
				models: [{ ...definition, baseUrl: "https://azure.test", id: "provider-api-deployment" }],
			});
			if ("commit" in replacement) await replacement.commit();
			assert.equal(runtime.getModel(provider, "provider-api-deployment")?.api, "openai-completions");
		}
	}
});

test("legacy native Azure providers keep canonical model identity under a models.json overlay", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-azure-native-overlay-"));
	try {
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { [legacy]: { baseUrl: "https://overlay.test" } } }));
		for (const transactional of [false, true]) {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath,
				allowModelNetwork: false,
			});
			const azure = runtime.getProvider("azure");
			const source = runtime.getModel("azure", "gpt-5.4");
			assert.ok(azure && source);
			const models = [{ ...source, id: "native-deployment", provider: legacy, baseUrl: "https://native.test" }];
			const native: Provider = { ...azure, id: legacy, getModels: () => models, getAllModels: () => models };
			const registration = transactional ? runtime.createExtensionProviderTransaction() : runtime;
			registration.registerNativeProvider(native);
			if ("commit" in registration) await registration.commit();
			await runtime.refresh();
			for (const id of [legacy, "azure"]) {
				const model = runtime.getModel(id, "native-deployment");
				assert.equal(model?.provider, "azure");
				const selected = resolveCliModel({ cliModel: `${id}/native-deployment`, modelRuntime: runtime });
				assert.equal(selected.error, undefined);
				assert.equal(selected.model?.provider, "azure");
				assert.equal(selected.model?.id, "native-deployment");
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
