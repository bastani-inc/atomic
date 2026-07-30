import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { clearApiKeyCache } from "../../packages/coding-agent/src/core/provider-composer.ts";
import { RemoteModelCatalog } from "../../packages/coding-agent/src/modes/interactive-engine/remote-model-catalog.ts";
import type { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.ts";

function availableProviders(response: Awaited<ReturnType<ReturnType<typeof createRpcCommandHandler>>>): Set<string> {
	assert.ok(response?.success);
	assert.equal(response.command, "refresh_models");
	assert.ok("data" in response);
	return new Set(response.data.models.map((model) => model.provider));
}

for (const scenario of [
	{
		name: "Kimi API-key login",
		provider: "kimi-coding",
		credential: { type: "api_key" as const, key: "fake-kimi-key" },
	},
	{
		name: "Anthropic OAuth login",
		provider: "anthropic",
		credential: {
			type: "oauth" as const,
			access: "fake-anthropic-access",
			refresh: "fake-anthropic-refresh",
			expires: Date.now() + 60_000,
		},
	},
]) {
	test(`refresh_models reloads child credentials after ${scenario.name}`, async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-rpc-model-refresh-"));
		try {
			const authPath = join(tempDir, "auth.json");
			const childAuth = AuthStorage.create(authPath);
			const childRuntime = await ModelRuntime.create({ credentials: childAuth, modelsPath: null });
			const session = { modelRuntime: childRuntime, scopedModels: [] } as unknown as AgentSession;
			const handle = createRpcCommandHandler({
				runtimeHost: { services: { agentDir: tempDir } } as unknown as AgentSessionRuntime,
				getSession: () => session,
				rebindSession: async () => {},
				output: () => {},
			});

			assert.equal(await childAuth.read(scenario.provider), undefined);
			assert.equal(
				childRuntime.getAvailableSnapshot().some((model) => model.provider === scenario.provider),
				false,
			);

			const hostAuth = AuthStorage.create(authPath);
			await hostAuth.modify(scenario.provider, async () => scenario.credential);
			assert.equal(await childAuth.read(scenario.provider), undefined);

			const response = await handle({ id: scenario.provider, type: "refresh_models", allowNetwork: false });

			assert.equal((await childAuth.read(scenario.provider))?.type, scenario.credential.type);
			assert.equal(availableProviders(response).has(scenario.provider), true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
}

test("refresh_models uses newly persisted credentials for forced dynamic discovery", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-rpc-dynamic-model-refresh-"));
	try {
		const authPath = join(tempDir, "auth.json");
		const childAuth = AuthStorage.create(authPath);
		const childRuntime = await ModelRuntime.create({ credentials: childAuth, modelsPath: null });
		let observedKey: string | undefined;
		let observedForce: boolean | undefined;
		childRuntime.registerProvider("dynamic-login", {
			baseUrl: "https://dynamic.test/v1",
			api: "openai-completions",
			apiKey: "$DYNAMIC_LOGIN_KEY",
			models: [],
			refreshModels: async ({ credential, force }) => {
				observedKey = credential?.type === "api_key" ? credential.key : undefined;
				observedForce = force;
				return observedKey
					? [
							{
								id: "discovered-after-login",
								name: "Discovered",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128_000,
								maxTokens: 4_096,
							},
						]
					: [];
			},
		});
		const session = { modelRuntime: childRuntime, scopedModels: [] } as unknown as AgentSession;
		const handle = createRpcCommandHandler({
			runtimeHost: { services: { agentDir: tempDir } } as unknown as AgentSessionRuntime,
			getSession: () => session,
			rebindSession: async () => {},
			output: () => {},
		});
		await AuthStorage.create(authPath).modify("dynamic-login", async () => ({
			type: "api_key",
			key: "new-dynamic-key",
		}));
		assert.equal(await childAuth.read("dynamic-login"), undefined);

		const response = await handle({ type: "refresh_models", allowNetwork: false, force: true });

		assert.deepEqual(await childAuth.read("dynamic-login"), { type: "api_key", key: "new-dynamic-key" });
		assert.equal(observedKey, "new-dynamic-key");
		assert.equal(observedForce, true);
		assert.equal(availableProviders(response).has("dynamic-login"), true);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("refresh_models is unbounded by default and honors an explicit caller timeout", async () => {
	const signals: Array<AbortSignal | undefined> = [];
	let reloads = 0;
	const modelRuntime = {
		reloadCredentials: async () => {
			reloads += 1;
		},
		refresh: async ({ signal }: { signal?: AbortSignal }) => {
			signals.push(signal);
			if (signal && !signal.aborted) {
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			}
			return { aborted: signal?.aborted ?? false, errors: new Map<string, Error>() };
		},
		getAvailableSnapshot: () => [],
		getProviders: () => [],
		getOAuthProviderMetadata: () => [],
	};
	const session = { modelRuntime, scopedModels: [] } as unknown as AgentSession;
	const handle = createRpcCommandHandler({
		runtimeHost: {} as AgentSessionRuntime,
		getSession: () => session,
		rebindSession: async () => {},
		output: () => {},
	});

	const unbounded = await handle({ type: "refresh_models", allowNetwork: false });
	const bounded = await handle({ type: "refresh_models", allowNetwork: false, timeoutMs: 5 });

	assert.equal(unbounded?.success, true);
	assert.equal(signals[0], undefined);
	assert.ok(signals[1] instanceof AbortSignal);
	assert.equal(signals[1].aborted, true);
	assert.ok(bounded?.success);
	assert.equal(bounded.command, "refresh_models");
	assert.ok("data" in bounded);
	assert.equal(bounded.data.aborted, true);
	assert.equal(reloads, 2);
});
test("bearer-only Anthropic models survive RPC and isolated catalog transport", async () => {
	const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
	const originalApiKey = process.env.ANTHROPIC_API_KEY;
	const originalOAuthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
	try {
		process.env.ANTHROPIC_AUTH_TOKEN = "gateway-token";
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		const hostRuntime = await ModelRuntime.create({ modelsPath: null });
		const hostSession = { modelRuntime: hostRuntime, scopedModels: [] } as unknown as AgentSession;
		const handle = createRpcCommandHandler({
			runtimeHost: { services: { agentDir: "/tmp/atomic-anthropic-bearer-rpc" } } as unknown as AgentSessionRuntime,
			getSession: () => hostSession,
			rebindSession: async () => {},
			output: () => {},
		});

		const response = await handle({ id: "catalog", type: "get_available_models" });
		assert.ok(response?.success);
		assert.equal(response.command, "get_available_models");
		assert.ok("data" in response);
		assert.ok(response.data.models.some((model) => model.provider === "anthropic"));

		delete process.env.ANTHROPIC_AUTH_TOKEN;
		clearApiKeyCache();
		const isolatedRuntime = await ModelRuntime.create({ modelsPath: null });
		const isolatedSession = { modelRuntime: isolatedRuntime, scopedModels: [] } as unknown as AgentSession;
		const remoteCatalog = new RemoteModelCatalog({} as RpcClient);
		remoteCatalog.apply(response.data);
		remoteCatalog.patch(isolatedSession);
		assert.deepEqual(isolatedRuntime.getAvailableSnapshot(), response.data.models);
	} finally {
		if (originalAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
		else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
		if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = originalApiKey;
		if (originalOAuthToken === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
		else process.env.ANTHROPIC_OAUTH_TOKEN = originalOAuthToken;
	}
});
