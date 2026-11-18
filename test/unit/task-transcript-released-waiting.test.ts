import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment, transcriptOnlySource } from "../helpers/task-transcript-environment.js";

const id = "agent-1" as TaskId;

function releasedAgent(): TaskRecord {
	return {
		...taskRecord(id),
		agentName: "worker",
		title: "Build and wait for the build",
		execution: {
			kind: "settled",
			result: {
				kind: "cancelled",
				cause: "pause",
				released: { waitingOn: [{ toolCallId: "toolu_9", toolName: "bash" }] },
			},
		},
	};
}

function runningShell(): TaskRecord {
	return { ...taskRecord("shell-1", "command"), title: "npm run build", parentTaskId: id };
}

test("a released subagent's transcript says what it waits on, that it wakes by itself, and where its shell is", async () => {
	initTheme("dark");
	const tasks = [releasedAgent(), runningShell()];
	const source = transcriptOnlySource({
		tasks,
		ownerTasks: tasks,
		readTaskTranscript: () => ({
			ok: true,
			value: { messages: [{ role: "user", content: "Build and wait for the build", timestamp: 1 }] },
		}),
		followTaskTranscript: () => undefined,
		sendTaskMessage: async () => {},
		taskStopped: () => true,
	});
	const env = taskTranscriptEnvironment({
		keybindings: new KeybindingsManager(),
		createChat: (options) => new ChatSessionHost(options),
	});
	const page = new TaskAgentTranscriptPage(source, id, env, () => {});
	await page.load();
	assert.equal(
		page.status,
		"Waiting on bash (toolu_9) · wakes by itself when it finishes · its shell npm run build is running, /tasks opens it",
	);
	const screen = page
		.render(100, 12)
		.map((row) => stripVTControlCharacters(row))
		.join("\n");
	assert.match(screen, /Build and wait for the build/);
	assert.match(screen, /worker · Build and wait for the build · waiting on bash/);
	assert.match(screen, /Message worker to wake it…/);
	assert.doesNotMatch(screen, /Stopped · send to resume/);
	page.dispose();
});
