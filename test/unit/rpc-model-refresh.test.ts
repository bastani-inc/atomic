import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.ts";
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
			const childRegistry = ModelRegistry.create(childAuth, join(tempDir, "models.json"));
			const session = { modelRegistry: childRegistry, scopedModels: [] } as unknown as AgentSession;
			const handle = createRpcCommandHandler({
				runtimeHost: { services: { agentDir: tempDir } } as unknown as AgentSessionRuntime,
				getSession: () => session,
				rebindSession: async () => {},
				output: () => {},
			});

			assert.equal(childAuth.hasAuth(scenario.provider), false);
			assert.equal(childRegistry.getAvailable().some((model) => model.provider === scenario.provider), false);

			const hostAuth = AuthStorage.create(authPath);
			hostAuth.set(scenario.provider, scenario.credential);
			assert.equal(childAuth.hasAuth(scenario.provider), false, "child keeps its startup auth snapshot before RPC refresh");

			const response = await handle({ id: scenario.provider, type: "refresh_models", allowNetwork: false });

			assert.equal(childAuth.hasAuth(scenario.provider), true);
			assert.equal(availableProviders(response).has(scenario.provider), true);
			assert.deepEqual(response && "data" in response ? response.data : undefined, {
				aborted: false,
				errors: [],
				models: childRegistry.getAvailable(),
				scopedModels: [],
				customAuthProviders: [],
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
}

test("refresh_models uses a newly persisted credential for dynamic model discovery", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-rpc-dynamic-model-refresh-"));
	try {
		const authPath = join(tempDir, "auth.json");
		const childAuth = AuthStorage.create(authPath);
		const childRegistry = ModelRegistry.create(childAuth, join(tempDir, "models.json"));
		const template = ModelRegistry.inMemory(AuthStorage.inMemory({
			"kimi-coding": { type: "api_key", key: "template-key" },
		})).getAvailable().find((model) => model.provider === "kimi-coding");
		assert.ok(template);
		let observedKey: string | undefined;
		childRegistry.registerProvider("dynamic-login", {
			refreshModels: async ({ credential, allowNetwork, force }) => {
				observedKey = credential?.type === "api_key" ? credential.key : undefined;
				assert.equal(allowNetwork, false);
				assert.equal(force, true);
				return observedKey ? [{ ...template, provider: "dynamic-login", id: "discovered-after-login" }] : [];
			},
		});
		const session = { modelRegistry: childRegistry, scopedModels: [] } as unknown as AgentSession;
		const handle = createRpcCommandHandler({
			runtimeHost: { services: { agentDir: tempDir } } as unknown as AgentSessionRuntime,
			getSession: () => session,
			rebindSession: async () => {},
			output: () => {},
		});
		AuthStorage.create(authPath).set("dynamic-login", { type: "api_key", key: "new-dynamic-key" });

		const response = await handle({ type: "refresh_models", allowNetwork: false, force: true });

		assert.equal(observedKey, "new-dynamic-key");
		assert.equal(availableProviders(response).has("dynamic-login"), true);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
