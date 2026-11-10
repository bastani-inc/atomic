import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import {
	ChildTaskWaits,
	createChildCommandTaskOwner,
} from "../../packages/coding-agent/src/core/tasks/child-command-owner.js";
import type {
	CommandIntent,
	Execution,
	OperationId,
	TaskId,
	TaskRecord,
	TaskResult,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	executeSupervisedCommand,
	type SupervisedCommandOwner,
} from "../../packages/coding-agent/src/core/tools/bash-pty-native.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";

/** The child is a real in-process session on a scripted model, so it starts like any subagent does. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

const route = { isOpen: () => true, deliver: async () => {} };

function ownerHost(): AgentTaskHost {
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: randomUUID() }, authorizeLaunch() {} });
	cleanups.push(() => void host.close("session-close"));
	return host;
}

/** Starts an agent task whose runner binds the transcript of the session `sessionId`, as a subagent's runner does. */
async function startAgent(host: AgentTaskHost, sessionId: string | undefined) {
	const result = Promise.withResolvers<TaskResult>();
	const started = await host.startAgentTask(
		{ kind: "agent", agent: "worker", task: "work" },
		randomUUID() as OperationId,
		(context) => {
			if (sessionId !== undefined) context.bindTranscript({ getSessionId: () => sessionId, getEntries: () => [] });
			return { result: result.promise, cleanup: Promise.resolve({ kind: "reaped" }) };
		},
	);
	assert.ok(started.ok);
	return { taskId: started.value.taskId, finish: (value: TaskResult) => result.resolve(value) };
}

function ownerTasks(host: AgentTaskHost): TaskRecord[] {
	const watched = host.watchOwnerTasks();
	assert.ok(watched.ok);
	const tasks = watched.value.snapshot.tasks;
	watched.value.dispose();
	return tasks;
}

async function settled(host: AgentTaskHost, taskId: TaskId): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const execution: Execution | undefined = ownerTasks(host).find((task) => task.ref.taskId === taskId)?.execution;
		if (execution?.kind === "settled") return;
		await host.waitForTask(taskId, 50);
	}
	assert.fail(`task ${taskId} did not settle`);
}

describe("a subagent's shells name the subagent that launched them (#4640)", () => {
	test("a child's binding names its own running agent task in the parent's owner, and no other (#4640)", async () => {
		const host = ownerHost();
		const owner = createChildCommandTaskOwner(() => host);
		const unbound = await startAgent(host, undefined);
		const other = await startAgent(host, "child-b");
		const child = await startAgent(host, "child-a");
		assert.equal(owner.bind("child-a", route, new ChildTaskWaits()).parentTaskId, child.taskId);
		assert.equal(owner.bind("child-b", route, new ChildTaskWaits()).parentTaskId, other.taskId);
		assert.equal(owner.bind("child-c", route, new ChildTaskWaits()).parentTaskId, undefined);
		unbound.finish({ kind: "cancelled", cause: "user" });

		child.finish({ kind: "cancelled", cause: "user" });
		await settled(host, child.taskId);
		assert.equal(
			owner.bind("child-a", route, new ChildTaskWaits()).parentTaskId,
			undefined,
			"a finished subagent's later shells are not attached to it, which its owner would refuse",
		);
		const resumed = await startAgent(host, "child-a");
		assert.equal(owner.bind("child-a", route, new ChildTaskWaits()).parentTaskId, resumed.taskId);
	});

	test("a shell launched through the binding records the subagent as its parent task (#4640)", async () => {
		const host = ownerHost();
		const child = await startAgent(host, "child-a");
		const binding = createChildCommandTaskOwner(() => host).bind("child-a", route, new ChildTaskWaits());
		await executeSupervisedCommand(
			"printf built",
			process.cwd(),
			{ taskOwner: binding, wait: { kind: "background" }, onData: () => {} },
			false,
		);
		const shell = ownerTasks(host).find((task) => task.kind === "command");
		assert.equal(shell?.parentTaskId, child.taskId);
		const agent = ownerTasks(host).find((task) => task.ref.taskId === child.taskId);
		assert.equal(agent?.parentTaskId, undefined);
	});

	test("a shell launched without a subagent carries no parent task (#4640)", async () => {
		const intents: CommandIntent[] = [];
		const supervisor = {
			startCommandTask: async (_owner: unknown, intent: CommandIntent) => {
				intents.push(intent);
				return { ok: false, error: { code: "OwnerClosing", message: "closing" } };
			},
		} as unknown as TaskSupervisor;
		const owner = {} as SupervisedCommandOwner["owner"];
		for (const taskOwner of [
			{ supervisor, owner },
			{ supervisor, owner, parentTaskId: "agent-1" as TaskId },
		] satisfies SupervisedCommandOwner[]) {
			await assert.rejects(
				executeSupervisedCommand("true", process.cwd(), { taskOwner, onData: () => {} }, false),
				/OwnerClosing/,
			);
		}
		assert.deepEqual(
			intents.map((intent) => ("parentTaskId" in intent ? intent.parentTaskId : "absent")),
			["absent", "agent-1"],
		);
	});
});

const builder: AgentConfig = {
	name: "builder",
	description: "builds",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/builder.md",
};

test(
	"a background subagent's own shell names the subagent's task as its parent in the shared owner (#4640)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const host = ownerHost();
		const parentCommandTaskOwner = createChildCommandTaskOwner(() => host);
		const shellTool = process.platform === "win32" ? "powershell" : "bash";
		env.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall(shellTool, { command: "echo built", wait: { kind: "background" } }, { id: "sh-1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("started the build"),
		]);
		const options = env.options("shell-parent");
		const childOptions = options.getChildSessionOptions;
		assert.ok(childOptions);
		const response = await runAgentTask({
			host,
			cwd: env.root,
			agents: [builder],
			agent: "builder",
			task: "start the build",
			options: {
				...options,
				getChildSessionOptions: (base) => ({ ...childOptions(base), parentCommandTaskOwner }),
				index: 0,
			},
			wait: { kind: "background" },
			runtime: { runSync },
		});
		assert.equal(response.kind, "admitted");
		const subagent = response.observation.taskId;
		await settled(host, subagent);
		const shells = ownerTasks(host).filter((task) => task.kind === "command");
		assert.deepEqual(
			shells.map((task) => task.parentTaskId),
			[subagent],
		);
	},
	LIVE_CHILD_TIMEOUT_MS,
);
