import { expect, test } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionAPI } from "../src/core/extensions/loader-api.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import type { Extension, ProviderConfig } from "../src/core/extensions/types.ts";

function extension(path: string): Extension {
	return {
		path,
		resolvedPath: path,
		sourceInfo: { path, source: "test", scope: "user", origin: "top-level", configurationOrigin: "bundled" },
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

const providerConfig: ProviderConfig = {
	baseUrl: "https://provider.test/v1",
	apiKey: "provider-test-key",
	api: "openai-completions",
	models: [
		{
			id: "instant-model",
			name: "Instant Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.75 },
			contextWindow: 128000,
			maxTokens: 4096,
		},
	],
};

test("rolls back providers applied before a failed commit", () => {
	const runtime = createExtensionRuntime();
	const originalRegister = runtime.registerProvider.bind(runtime);
	let calls = 0;
	runtime.registerProvider = ((nameOrProvider, configOrPath, extensionPath) => {
		calls += 1;
		if (calls === 2) throw new Error("second provider failed");
		originalRegister(nameOrProvider, configOrPath, extensionPath);
	}) as typeof runtime.registerProvider;

	const { api, commit, discard } = createExtensionAPI(extension("multi"), runtime, "/tmp", createEventBus());
	api.registerProvider("first", providerConfig);
	api.registerProvider("second", { ...providerConfig, baseUrl: "https://provider-two.test/v1" });

	expect(() => commit()).toThrow("second provider failed");
	discard();
	expect(
		runtime.pendingProviderRegistrations.map((registration) =>
			"provider" in registration ? registration.provider.id : registration.name,
		),
	).toEqual([]);
});

test("rollback keeps an earlier extension's provider of the same name", () => {
	const runtime = createExtensionRuntime();

	// An earlier extension owns "shared-provider" and stays committed.
	const earlier = createExtensionAPI(extension("earlier"), runtime, "/tmp", createEventBus());
	earlier.api.registerProvider("shared-provider", providerConfig);
	earlier.commit();

	const originalRegister = runtime.registerProvider.bind(runtime);
	let calls = 0;
	runtime.registerProvider = ((nameOrProvider, configOrPath, extensionPath) => {
		calls += 1;
		if (calls === 2) throw new Error("later provider failed");
		originalRegister(nameOrProvider, configOrPath, extensionPath);
	}) as typeof runtime.registerProvider;

	// A later extension reuses the same provider name, then fails mid-commit.
	const later = createExtensionAPI(extension("later"), runtime, "/tmp", createEventBus());
	later.api.registerProvider("shared-provider", { ...providerConfig, baseUrl: "https://later.test/v1" });
	later.api.registerProvider("later-only", { ...providerConfig, baseUrl: "https://later-two.test/v1" });

	expect(() => later.commit()).toThrow("later provider failed");
	later.discard();

	// The failing extension's registration is gone; the earlier owner survives.
	const shared = runtime.pendingProviderRegistrations.filter(
		(registration) => !("provider" in registration) && registration.name === "shared-provider",
	);
	expect(shared).toHaveLength(1);
	expect(shared[0] && "extensionPath" in shared[0] ? shared[0].extensionPath : undefined).toBe("earlier");
});
