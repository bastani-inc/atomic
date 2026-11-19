import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
};

const sessions: AgentSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose().catch(() => undefined);
});

async function parentSession(modelRuntime: ModelRuntime, provider: string): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		modelRuntime,
		model: modelRuntime.getModel(provider, "m")!,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		sessionManager: SessionManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
	});
	sessions.push(session);
	return session;
}

test("a child that starts after its launching session closed with no successor inherits that session's last options (#3981)", async () => {
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ primary: { type: "api_key", key: "primary-key-3981" } }),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("primary", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		apiKey: "primary-key-3981",
		models: [spec],
	});
	const launching = await parentSession(modelRuntime, "primary");
	const ctx = launching.extensionRunner.createContext();
	const childOptions = ctx.getChildSessionOptionsResolver?.() ?? ctx.getChildSessionOptions;
	assert.ok(childOptions);
	await launching.dispose();

	assert.equal(childOptions({}).model?.provider, "primary");
});
