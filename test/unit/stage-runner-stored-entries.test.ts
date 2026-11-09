import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	storedAssistantMessageSince,
	storedEntryCount,
} from "../../packages/workflows/src/runs/foreground/stage-runner-reopen.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";

/** What the stage runner takes for an `AgentSession`: a runtime with a session manager beside the agent's own state. */
function agentSessionOver(sessionManager: object): StageSessionRuntime {
	return { state: {}, sessionManager, modelRuntime: {}, getContextUsage: () => undefined } as never;
}

const assistant = fauxAssistantMessage("done") as never;

async function transcript(): Promise<SessionManager> {
	const manager = SessionManager.inMemory();
	await manager.appendMessage({ role: "user", content: "go", timestamp: 1 });
	return manager;
}

describe("a position in the stage session's store that a compaction leaves valid (#4580)", () => {
	test("counts the entries the store holds, for a session of the SDK (#4580)", async () => {
		const manager = await transcript();

		assert.equal(storedEntryCount(agentSessionOver(manager)), manager.getEntries().length);
		await manager.appendMessage(assistant);
		assert.equal(storedEntryCount(agentSessionOver(manager)), manager.getEntries().length);
	});

	test("counts nothing for a runtime that is not a session of the SDK, or whose manager lists no entries (#4580)", async () => {
		assert.equal(storedEntryCount({ messages: [] } as unknown as StageSessionRuntime), undefined);
		assert.equal(storedEntryCount(agentSessionOver({ buildSessionProjection: () => ({ messages: [] }) })), undefined);
	});

	test("sees an assistant message the store gained after the position (#4580)", async () => {
		const manager = await transcript();
		const mark = manager.getEntries().length;
		await manager.appendMessage(assistant);

		assert.equal(storedAssistantMessageSince(agentSessionOver(manager), mark), true);
	});

	test("does not see an assistant message from before the position (#4580)", async () => {
		const manager = await transcript();
		await manager.appendMessage(assistant);
		const mark = manager.getEntries().length;
		await manager.appendMessage({ role: "user", content: "and then?", timestamp: 2 });

		assert.equal(storedAssistantMessageSince(agentSessionOver(manager), mark), false);
	});

	test("does not take another entry after the position for an assistant message (#4580)", async () => {
		const manager = await transcript();
		const mark = manager.getEntries().length;
		await manager.appendMessage({ role: "user", content: "and then?", timestamp: 2 });
		await manager.appendCustomMessageEntry("note", "a note", true);

		assert.equal(storedAssistantMessageSince(agentSessionOver(manager), mark), false);
	});

	test("sees nothing when the store was never counted (#4580)", async () => {
		const manager = await transcript();
		await manager.appendMessage(assistant);

		assert.equal(storedAssistantMessageSince(agentSessionOver(manager), undefined), false);
	});

	test("sees nothing in a runtime that is not a session of the SDK (#4580)", () => {
		assert.equal(storedAssistantMessageSince({ messages: [assistant] } as unknown as StageSessionRuntime, 0), false);
	});
});
