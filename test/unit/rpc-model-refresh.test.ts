import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { clearApiKeyCache } from "../../packages/coding-agent/src/core/provider-composer.ts";
import { RemoteModelCatalog } from "../../packages/coding-agent/src/modes/interactive-engine/remote-model-catalog.ts";
import type { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.ts";

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
