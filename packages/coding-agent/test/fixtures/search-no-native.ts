import assert from "node:assert/strict";
import { createAgentSession } from "../../src/core/sdk.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { getOwnerTaskStore } from "../../src/core/tasks/owner-store.js";
import { createHistoryRouter } from "../../src/core/tools/history-protocol.js";

const cwd = process.argv[2]!;
const manager = SessionManager.inMemory(cwd);
const { session } = await createAgentSession({ cwd, agentDir: cwd, sessionManager: manager, settingsManager: SettingsManager.inMemory(), builtins: {subagents:false,workflows:false,intercom:false,"web-access":false,mcp:false} });
try {
	for (const content of ["needle first", "needle second"]) await manager.appendMessage({role:"user",content,timestamp:Date.now()});
	const id = manager.getSessionId();
	const router = createHistoryRouter({cwd,currentSessionId:id,sessionStore:()=>manager.getSessionStore(),workflows:()=>undefined,budget:{rows:1}});
	const tool = session.getToolDefinition("search")!;
	const search = async (paths: string) => {
		const page = await tool.execute("page", {pattern:"needle",paths}, undefined, undefined, { cwd, internalResourceRouter:router } as never);
		return page.content.map(b => b.type === "text" ? b.text : "").join("\n");
	};
	const first = await search(`history://sessions/${id}`);
	const url = /continue with (history:\/\/[^\]]+)\]/.exec(first)?.[1];
	assert.ok(url,first);
	assert.match(await search(url), /needle/);
	assert.equal(getOwnerTaskStore(session),undefined);
} finally { await session.dispose(); }
