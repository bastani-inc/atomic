import { join } from "node:path";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const [agentDir, endpoint] = process.argv.slice(2) as [string, string];
const modelRuntime = await ModelRuntime.create({
	credentials: AuthStorage.inMemory({ openrouter: { type: "api_key", key: "fixture" } }),
	modelsPath: join(agentDir, "models.json"),
	catalogBaseUrl: endpoint,
});
const { session } = await createAgentSession({
	agentDir,
	cwd: agentDir,
	modelRuntime,
	model: modelRuntime.getModel("openrouter", "openai/gpt-4o"),
	settingsManager: SettingsManager.inMemory(),
	sessionManager: SessionManager.inMemory(agentDir),
	builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
});
// The parent acknowledges only after it has the background list request in hand.
await (await fetch(`${endpoint}/close-session`)).text();
await session.dispose();
console.log("disposed");
