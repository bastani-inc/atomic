import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@bastani/pi-ai/compat";
import type { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { ChildCommandTaskOwner } from "../../packages/coding-agent/src/core/tasks/child-command-owner.js";
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

export const SHELL_TOOL = process.platform === "win32" ? "powershell" : "bash";
const SHELL_COMMAND =
	process.platform === "win32" ? "$v = [Console]::ReadLine(); Write-Output 'built'" : "read v; printf built";
const SHELL_TIMEOUT_SECONDS = 120;

const builder: AgentConfig = {
	name: "shell-builder",
	description: "starts a build in the background and waits for it",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/shell-builder.md",
};

/**
 * Launch a background subagent that starts a shell task in its parent's task owner and then waits on it with a plain
 * shell `wait`, until it is recorded released. The shell goes on running: it is the call's own work.
 */
export async function launchReleasedShellWait(
	index: number,
	env: Awaited<ReturnType<typeof liveChildEnvironment>>,
	host: AgentTaskHost,
	owner: SessionManager,
	dispatcher: AgentWakeDispatcher,
	parentCommandTaskOwner: ChildCommandTaskOwner,
): Promise<void> {
	const startId = `sh-${index}`;
	env.faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					SHELL_TOOL,
					{ command: SHELL_COMMAND, wait: { kind: "background" }, timeout: SHELL_TIMEOUT_SECONDS },
					{ id: startId },
				),
			],
			{ stopReason: "toolUse" },
		),
		(context) => {
			const started = context.messages.find(
				(message): message is ToolResultMessage<{ observation?: { taskId?: string } }> =>
					message.role === "toolResult" && message.toolCallId === startId,
			);
			const taskId = started?.details?.observation?.taskId;
			assert.ok(taskId, "the shell task was admitted");
			return fauxAssistantMessage([fauxToolCall(SHELL_TOOL, { action: "wait", id: taskId }, { id: `w-${index}` })], {
				stopReason: "toolUse",
			});
		},
	]);
	const options = env.options(`gsw-${index}`, {
		sessionManager: await SessionManager.create(new MemorySessionStore(), env.root),
		resumeSession: true,
		releaseWhenWaiting: subagentReleasePolicy(0),
		intercomSessionName: `subagent-builder-gsw-${index}`,
	});
	const childOptions = options.getChildSessionOptions;
	assert.ok(childOptions);
	const response = await runAgentTask({
		host,
		cwd: env.root,
		agents: [builder],
		agent: "shell-builder",
		task: "build, then wait for it",
		options: {
			...options,
			getChildSessionOptions: (base) => ({ ...childOptions(base), parentCommandTaskOwner }),
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
		const record = readSubagentChildRecords(owner.getEntries()).get(`gsw-${index}:0`);
		if (record?.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`child gsw-${index} was never recorded released on its shell wait`);
}
