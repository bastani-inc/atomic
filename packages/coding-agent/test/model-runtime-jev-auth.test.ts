import { afterEach, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { RpcProviderAuth } from "../src/modes/rpc/rpc-provider-auth.ts";

afterEach(() => vi.unstubAllEnvs());

test("Jev uses the unified classifier provider for legacy login and logout without exposing chat models", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "environment-test-key");
	const credentials = AuthStorage.inMemory();
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
	expect(runtime.getProvider("typesafe-ai")).toBeUndefined();
	expect(runtime.getProvider("typesafe")?.auth.apiKey).toBeTruthy();
	expect(runtime.getModelOfType("classifier", "typesafe", "jev-latest")?.api).toBe("typesafe-system-one");
	expect((await runtime.getAuth("typesafe"))?.auth.apiKey).toBe("environment-test-key");
	await runtime.login("typesafe-ai", "api_key", {
		signal: new AbortController().signal,
		prompt: async () => "stored-test-key",
		notify: () => {},
	});
	expect(credentials.peek("typesafe")).toEqual({ type: "api_key", key: "stored-test-key" });
	expect(runtime.hasConfiguredAuth("typesafe")).toBe(true);
	expect((await runtime.getAuth("typesafe"))?.auth.apiKey).toBe("stored-test-key");
	expect(runtime.getModels("typesafe")).toEqual([]);
	expect(await runtime.getAvailable("typesafe")).toEqual([]);
	await runtime.logout("typesafe-ai");
	expect(credentials.peek("typesafe")).toBeUndefined();
	expect((await runtime.getAuth("typesafe"))?.auth.apiKey).toBe("environment-test-key");
	vi.stubEnv("TYPESAFE_API_KEY", "");
	expect(await runtime.getAuth("typesafe")).toBeUndefined();
});

test("legacy saved Jev key resolves through the classifier provider and is removed on logout", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "");
	const credentials = AuthStorage.inMemory({
		"typesafe-ai": { type: "api_key", key: "$JEV_TEST_KEY", env: { JEV_TEST_KEY: "scoped-test-key" } },
	});
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
	expect(runtime.getProviderAuthStatus("typesafe").source).toBe("stored");
	expect((await runtime.getAuth("typesafe"))?.auth.apiKey).toBe("scoped-test-key");
	await runtime.logout("typesafe-ai");
	expect(credentials.peek("typesafe-ai")).toBeUndefined();
	expect(await runtime.getAuth("typesafe")).toBeUndefined();
});

test("isolated Jev login persists in the engine and returns no key or chat model", async () => {
	const credentials = AuthStorage.inMemory();
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
	const session = { modelRuntime, scopedModels: [] } as unknown as AgentSession;
	const result = await new RpcProviderAuth({ open: async () => ({ value: "isolated-test-secret" }) }).login(
		session,
		"typesafe",
	);
	expect(result.cancelled).toBe(false);
	expect(credentials.peek("typesafe")?.type).toBe("api_key");
	expect((await modelRuntime.getAuth("typesafe"))?.auth.apiKey).toBe("isolated-test-secret");
	expect(JSON.stringify(result)).not.toContain("isolated-test-secret");
	expect(result.models?.some((model) => model.provider === "typesafe")).toBe(false);
});

test("Jev uses only TYPESAFE_API_KEY for environment authentication", async () => {
	vi.stubEnv("TYPESAFE_AI_API_KEY", "synthetic-obsolete-key");
	vi.stubEnv("TYPESAFE_API_KEY", undefined);
	const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	expect(await runtime.getAuth("typesafe")).toBeUndefined();
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-current-key");
	expect((await runtime.getAuth("typesafe"))?.auth.apiKey).toBe("synthetic-current-key");
	vi.stubEnv("TYPESAFE_AI_API_KEY", undefined);
	expect((await runtime.getAuth("typesafe"))?.auth.apiKey).toBe("synthetic-current-key");
	vi.stubEnv("TYPESAFE_API_KEY", "");
	expect(await runtime.getAuth("typesafe")).toBeUndefined();
});
