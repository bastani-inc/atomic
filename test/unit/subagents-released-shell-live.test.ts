import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { type AgentWake, AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import {
	childTaskCompletionRoute,
	createChildCommandTaskOwner,
	type TaskCompletionMessage,
} from "../../packages/coding-agent/src/core/tasks/child-command-owner.js";
import type { OperationId, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import {
	subagentReleasePolicy,
	subagentWakeNamespace,
} from "../../packages/subagents/src/runs/foreground/released-children.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RELEASED_STATUS,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";

const LIVE_CHILD_TIMEOUT_MS = 120_000;
const shellCommand =
	process.platform === "win32" ? "$v = [Console]::ReadLine(); Write-Output 'built'" : "read v; printf built";
const shellTool = process.platform === "win32" ? "powershell" : "bash";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

const agent: AgentConfig = {
	name: "builder",
	description: "builds, then waits on CI",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/builder.md",
};

test(
	"a child released while a shell task it launched still runs hands back a route its task's completion reaches (#4326)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const host = new AgentTaskHost({ scope: { kind: "session", sessionId: "shell-owner" }, authorizeLaunch() {} });
		cleanups.push(() => void host.close("session-close"));
		const parentCommandTaskOwner = createChildCommandTaskOwner(() => host);
		const store = new MemorySessionStore();
		const childSession = await SessionManager.create(store, env.root);
		env.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						shellTool,
						{ command: shellCommand, wait: { kind: "background" }, timeout: 30 },
						{ id: "sh-1" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
		]);
		const options = env.options("shell-release", {
			sessionManager: childSession,
			resumeSession: true,
			releaseWhenWaiting: { afterMs: 0 },
		});
		const childOptions = options.getChildSessionOptions;
		assert.ok(childOptions);

		const result = await runSingleInProcess(env.root, agent, "build, then wait for CI", {
			...options,
			getChildSessionOptions: (base) => ({ ...childOptions(base), parentCommandTaskOwner }),
		});
		assert.ok(result.released?.routeShellCompletions, "the child ran its shell in its parent's task owner");
		const taskId = (await SessionManager.open(store, childSession.getSessionId()))
			.buildSessionProjection()
			.messages.flatMap((message) =>
				message.role === "toolResult" && message.toolCallId === "sh-1"
					? [(message.details as { observation?: { taskId?: TaskId } }).observation?.taskId]
					: [],
			)[0];
		assert.ok(taskId);
		const delivered: string[] = [];
		const routed = result.released.routeShellCompletions({
			isOpen: () => true,
			deliver: async (message: TaskCompletionMessage) => void delivered.push(message.content),
		});

		const task = host.resolveTask(taskId);
		assert.ok(task.ok);
		const { supervisor } = host.ownerBinding;
		const input = supervisor.taskStdin(task.value);
		assert.ok(input.ok);
		await supervisor.writeTaskInput(input.value, crypto.randomUUID() as OperationId, {
			kind: "bytes",
			bytes: Buffer.from("go\n"),
		});
		await host.waitForTask(taskId);
		await childTaskCompletionRoute(host, taskId)?.deliver({
			customType: "task_completion",
			content: "build task finished",
			details: {},
			display: true,
		});

		assert.equal(routed, true);
		assert.deepEqual(delivered, ["build task finished"]);
		env.answers[0]?.({ content: [{ type: "text", text: "green" }], details: undefined });
	},
	LIVE_CHILD_TIMEOUT_MS,
);

async function writeLine(host: AgentTaskHost, taskId: TaskId): Promise<void> {
	const task = host.resolveTask(taskId);
	assert.ok(task.ok);
	const { supervisor } = host.ownerBinding;
	const input = supervisor.taskStdin(task.value);
	assert.ok(input.ok);
	await supervisor.writeTaskInput(input.value, crypto.randomUUID() as OperationId, {
		kind: "bytes",
		bytes: Buffer.from("go\n"),
	});
}

test(
	"a released background subagent's finished shell task is held in its record and wakes it, not its launcher (#4326)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const owner = SessionManager.inMemory(env.root);
		const ownerSessionId = owner.getSessionId();
		const host = new AgentTaskHost({ scope: { kind: "session", sessionId: ownerSessionId }, authorizeLaunch() {} });
		cleanups.push(() => void host.close("session-close"));
		const parentCommandTaskOwner = createChildCommandTaskOwner(() => host);
		const dispatcher = new AgentWakeDispatcher();
		const wakes: AgentWake[] = [];
		dispatcher.handle(subagentWakeNamespace(ownerSessionId), async (_key, batch) => void wakes.push(...batch));
		const store = new MemorySessionStore();
		const childSession = await SessionManager.create(store, env.root);
		env.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						shellTool,
						{ command: shellCommand, wait: { kind: "background" }, timeout: 30 },
						{ id: "sh-1" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
		]);
		const options = env.options("shell-task", {
			sessionManager: childSession,
			resumeSession: true,
			releaseWhenWaiting: subagentReleasePolicy(0),
		});
		const childOptions = options.getChildSessionOptions;
		assert.ok(childOptions);

		const response = await runAgentTask({
			host,
			cwd: env.root,
			agents: [agent],
			agent: "builder",
			task: "build, then wait for CI",
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
		const released = () => readSubagentChildRecords(owner.getEntries()).get("shell-task:0");
		for (let turn = 0; turn < 2000 && released()?.terminalStatus !== SUBAGENT_CHILD_RELEASED_STATUS; turn++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(released()?.terminalStatus, SUBAGENT_CHILD_RELEASED_STATUS);
		const taskId = (await SessionManager.open(store, childSession.getSessionId()))
			.buildSessionProjection()
			.messages.flatMap((message) =>
				message.role === "toolResult" && message.toolCallId === "sh-1"
					? [(message.details as { observation?: { taskId?: TaskId } }).observation?.taskId]
					: [],
			)[0];
		assert.ok(taskId);

		await writeLine(host, taskId);
		await host.waitForTask(taskId);
		await childTaskCompletionRoute(host, taskId)?.deliver({
			customType: "task_completion",
			content: "build task finished",
			details: { completionId: "done-1" },
			display: true,
		});
		await dispatcher.whenIdle();

		assert.deepEqual(released()?.heldMessages?.messages, ["build task finished"]);
		assert.deepEqual(
			wakes.map((wake) => [wake.id, wake.kind]),
			[["task-completion:done-1", "task-completion"]],
		);
		env.answers[0]?.({ content: [{ type: "text", text: "green" }], details: undefined });
	},
	LIVE_CHILD_TIMEOUT_MS,
);
