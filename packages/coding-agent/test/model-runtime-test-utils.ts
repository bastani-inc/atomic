import type { CredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const runtimes = new WeakMap<ModelRegistry, ModelRuntime>();

function wrap(runtime: ModelRuntime): ModelRegistry {
	const registry = new ModelRegistry(runtime);
	runtimes.set(registry, runtime);
	return registry;
}

export async function createModelRegistry(credentials: CredentialStore, modelsPath?: string): Promise<ModelRegistry> {
	return wrap(await ModelRuntime.create({ credentials, modelsPath, allowModelNetwork: false }));
}

export async function createInMemoryModelRegistry(credentials: CredentialStore): Promise<ModelRegistry> {
	return wrap(await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false }));
}

export function getModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	const runtime = runtimes.get(modelRegistry);
	if (!runtime) throw new Error("ModelRegistry was not created by the test helper");
	return runtime;
}

/** Minimal runtime-shaped test double for pure model-selection/UI tests. */
export function fakeModelRuntime(overrides: Partial<ModelRuntime> = {}): ModelRuntime {
	return {
		getModels: () => [],
		getAvailableSnapshot: () => [],
		getModel: () => undefined,
		getProvider: () => undefined,
		getProviders: () => [],
		hasConfiguredAuth: () => false,
		isUsingOAuth: () => false,
		getAuth: async () => undefined,
		getProviderAuthStatus: () => ({ configured: false }),
		refresh: async () => ({ ok: true, providers: [] }),
		...overrides,
	} as ModelRuntime;
}
