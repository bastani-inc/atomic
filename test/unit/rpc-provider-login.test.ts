import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.ts";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.ts";

function createSessionRegistry(login: (prompt: (message: string) => Promise<string>) => Promise<string>) {
	const authStorage = AuthStorage.inMemory();
	const registry = ModelRegistry.inMemory(authStorage);
	const template = ModelRegistry.inMemory(AuthStorage.inMemory({
		"kimi-coding": { type: "api_key", key: "template" },
	})).getAvailable().find((model) => model.provider === "kimi-coding");
	assert.ok(template);
	let refreshCount = 0;
	registry.registerProvider("extension-login", {
		auth: {
			apiKey: {
				name: "Extension Login",
				login: async ({ prompt }) => ({
					type: "api_key",
					key: await login((message) => prompt({ type: "secret", message, placeholder: "token" })),
				}),
			},
		},
		refreshModels: async ({ credential }) => {
			refreshCount += 1;
			return credential ? [{ ...template, id: "extension-model" }] : [];
		},
	});
	return { authStorage, registry, refreshCount: () => refreshCount };
}

function runtimeHost(): AgentSessionRuntime {
	return { services: { agentDir: process.cwd() } } as AgentSessionRuntime;
}

test("login_provider prompts in the host, persists the credential, refreshes, and returns provider metadata", async () => {
	const state = createSessionRegistry(async (prompt) => prompt("Enter extension token"));
	const session = { modelRegistry: state.registry, scopedModels: [] } as unknown as AgentSession;
	const handle = createRpcCommandHandler({
		runtimeHost: runtimeHost(),
		getSession: () => session,
		rebindSession: async () => {},
		output: () => {},
		inputForm: {
			open: async (request) => {
				assert.equal(request.title, "Enter extension token");
				assert.equal(request.fields[0]?.placeholder, "token");
				return { value: "child-secret" };
			},
		},
	});

	const response = await handle({ id: "login", type: "login_provider", provider: "extension-login" });

	assert.ok(response?.success && "data" in response);
	assert.equal(response.command, "login_provider");
	assert.equal(response.data.cancelled, false);
	assert.deepEqual(state.authStorage.get("extension-login"), { type: "api_key", key: "child-secret" });
	assert.ok(state.refreshCount() > 0);
	if (!response.data.cancelled) {
		assert.deepEqual(response.data.customAuthProviders, [{ id: "extension-login", name: "Extension Login" }]);
		assert.equal(response.data.models.some((model) => model.provider === "extension-login"), true);
	}
});

test("cancel_login_provider aborts an active child login without storing credentials", async () => {
	const state = createSessionRegistry(async (prompt) => prompt("Enter extension token"));
	const session = { modelRegistry: state.registry, scopedModels: [] } as unknown as AgentSession;
	const handle = createRpcCommandHandler({
		runtimeHost: runtimeHost(),
		getSession: () => session,
		rebindSession: async () => {},
		output: () => {},
		inputForm: {
			open: async (_request, signal) => new Promise((resolve) => {
				signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			}),
		},
	});

	const login = handle({ id: "login", type: "login_provider", provider: "extension-login" });
	await Bun.sleep(0);
	const cancelled = await handle({ id: "cancel", type: "cancel_login_provider", provider: "extension-login" });
	const response = await login;

	assert.ok(cancelled?.success);
	assert.ok(response?.success && "data" in response);
	assert.deepEqual(response.data, { provider: "extension-login", cancelled: true });
	assert.equal(state.authStorage.get("extension-login"), undefined);
});

test("non-isolated registries retain the local custom authentication contract", async () => {
	const state = createSessionRegistry(async (prompt) => prompt("Local prompt"));
	const auth = state.registry.getCustomApiKeyAuth("extension-login");
	assert.ok(auth);
	assert.equal(auth.name, "Extension Login");
	const credential = await auth.login({
		signal: new AbortController().signal,
		prompt: async ({ message }) => {
			assert.equal(message, "Local prompt");
			return "local-secret";
		},
	});
	assert.deepEqual(credential, { type: "api_key", key: "local-secret" });
});
