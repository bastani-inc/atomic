import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.ts";
import { sleep } from "../helpers/runtime.js";

async function createSessionRuntime() {
	const authStorage = AuthStorage.inMemory();
	const runtime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	const template = runtime.getModels("kimi-coding")[0];
	assert.ok(template);
	let refreshCount = 0;
	runtime.registerProvider("extension-login", {
		models: [{ ...template, id: "extension-model" }],
		refreshModels: async ({ credential }) => {
			refreshCount += 1;
			return credential ? [{ ...template, provider: "extension-login", id: "extension-model" }] : [];
		},
	});
	return { authStorage, runtime, refreshCount: () => refreshCount };
}

function runtimeHost(): AgentSessionRuntime {
	return { services: { agentDir: process.cwd() } } as AgentSessionRuntime;
}

test("login_provider persists and returns the current provider snapshot without refreshing", async () => {
	const state = await createSessionRuntime();
	const session = { modelRuntime: state.runtime, scopedModels: [] } as unknown as AgentSession;
	const handle = createRpcCommandHandler({
		runtimeHost: runtimeHost(),
		getSession: () => session,
		rebindSession: async () => {},
		output: () => {},
		inputForm: {
			open: async (request) => {
				assert.equal(request.title, "Enter API key");
				assert.equal(request.fields[0]?.placeholder, undefined);
				return { value: "child-secret" };
			},
		},
	});

	const response = await handle({ id: "login", type: "login_provider", provider: "extension-login" });

	assert.ok(response?.success && "data" in response);
	assert.equal(response.command, "login_provider");
	assert.equal(response.data.cancelled, false);
	assert.deepEqual(await state.authStorage.read("extension-login"), { type: "api_key", key: "child-secret" });
	assert.equal(state.refreshCount(), 0);
	if (!response.data.cancelled) {
		assert.deepEqual(response.data.customAuthProviders, []);
		assert.equal(
			response.data.models.some((model) => model.provider === "extension-login"),
			true,
		);
	}
});

test("cancel_login_provider aborts an active child login without storing credentials", async () => {
	const state = await createSessionRuntime();
	const session = { modelRuntime: state.runtime, scopedModels: [] } as unknown as AgentSession;
	const handle = createRpcCommandHandler({
		runtimeHost: runtimeHost(),
		getSession: () => session,
		rebindSession: async () => {},
		output: () => {},
		inputForm: {
			open: async (_request, signal) =>
				new Promise((resolve) => {
					signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
		},
	});

	const login = handle({ id: "login", type: "login_provider", provider: "extension-login" });
	await sleep(0);
	const cancelled = await handle({ id: "cancel", type: "cancel_login_provider", provider: "extension-login" });
	const response = await login;

	assert.ok(cancelled?.success);
	assert.ok(response?.success && "data" in response);
	assert.deepEqual(response.data, { provider: "extension-login", cancelled: true });
	assert.equal(await state.authStorage.read("extension-login"), undefined);
});

test("non-isolated runtimes retain provider-owned API-key authentication", async () => {
	const state = await createSessionRuntime();
	const credential = await state.runtime.login("extension-login", "api_key", {
		signal: new AbortController().signal,
		prompt: async ({ message }) => {
			assert.equal(message, "Enter API key");
			return "local-secret";
		},
		notify: () => {},
	});
	assert.deepEqual(credential, { type: "api_key", key: "local-secret" });
});
