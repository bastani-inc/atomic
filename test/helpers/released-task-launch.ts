import assert from "node:assert/strict";
import type { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { subagentReleasePolicy } from "../../packages/subagents/src/runs/foreground/released-children.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RELEASED_STATUS,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { liveChildEnvironment } from "./live-child-environment.js";

export const agent: AgentConfig = {
	name: "waiter",
	description: "waits on CI",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/waiter.md",
};

export async function launchReleasedTask(
	index: number,
	env: Awaited<ReturnType<typeof liveChildEnvironment>>,
	host: AgentTaskHost,
	owner: SessionManager,
	dispatcher: AgentWakeDispatcher,
): Promise<void> {
	env.faux.setResponses([
		{
			role: "assistant",
			content: [{ type: "toolCall", id: `ci-${index}`, name: "wait_for_ci", arguments: { run: String(index) } }],
			stopReason: "toolUse",
		} as never,
	]);
	const response = await runAgentTask({
		host,
		cwd: env.root,
		agents: [agent],
		agent: "waiter",
		task: "watch CI",
		options: {
			...env.options(`gct-${index}`, {
				sessionManager: await SessionManager.create(new MemorySessionStore(), env.root),
				resumeSession: true,
				releaseWhenWaiting: subagentReleasePolicy(0),
				intercomSessionName: `subagent-waiter-gct-${index}`,
			}),
			index: 0,
		},
		wakeDispatcher: dispatcher,
		wait: { kind: "background" },
		recordChild: createSubagentChildRecordSink(
			{ appendEntry: async (type, data) => void (await owner.appendCustomEntry(type, data)) },
			{ sessionManager: owner, orchestrationContext: undefined },
		),
		runtime: { runSync },
	});
	assert.equal(response.kind, "admitted");
	for (let turn = 0; turn < 2000; turn++) {
		const record = readSubagentChildRecords(owner.getEntries()).get(`gct-${index}:0`);
		if (record?.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`child gct-${index} was never recorded released`);
}
