import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { SubagentChildPolicy } from "../src/core/extensions/index.js";
import { createAgentSession } from "../src/core/sdk.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk-types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { TASK_COMPLETION_MESSAGE_TYPE } from "../src/core/tasks/completion.js";
import type { OperationId, TaskId } from "../src/core/tasks/contracts.js";
import { getOwnerTaskStore } from "../src/core/tasks/owner-store.js";
import type { BashToolDetails } from "../src/core/tools/bash.js";
import { WorkflowStageAdmissionBoundary } from "../src/core/workflow-stage-admission.js";
import { createTestResourceLoader } from "./utilities.js";

vi.mock("../src/utils/shell.js", async (importOriginal) => {
	const shell = await importOriginal<typeof import("../src/utils/shell.js")>();
	return {
		...shell,
		isPowerShellAvailable: () => true,
		getPowerShellConfig: () =>
			process.platform !== "win32" && process.env.ATOMIC_TEST_PWSH
				? { shell: process.env.ATOMIC_TEST_PWSH, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] }
				: shell.getPowerShellConfig(),
	};
});

type ShellName = "bash" | "powershell";

const nativeShell: ShellName = process.platform === "win32" ? "powershell" : "bash";
const powerShellRunnable = process.platform === "win32" || !!process.env.ATOMIC_TEST_PWSH;
const runnableShells: ShellName[] =
	powerShellRunnable && nativeShell === "bash" ? ["bash", "powershell"] : [nativeShell];
const waitingCommands: Record<ShellName, string> = {
	powershell: "$value = [Console]::ReadLine(); Write-Output 'child shell done'; exit 3",
	bash: "read value; printf 'child shell done'; exit 3",
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tool(session: AgentSession, name: ShellName | "kill") {
	const registered = session.agent.state.tools.find((item) => item.name === name);
	assert.ok(registered, `${name} must be registered on the session`);
	return registered;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

async function newSession(root: string, options: CreateAgentSessionOptions = {}): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory({ bashInterceptor: { enabled: false } }),
		resourceLoader: createTestResourceLoader(),
		tools: ["bash", "powershell", "kill"],
		...options,
	});
	session.pauseQueuedMessages();
	cleanups.push(async () => {
		await session.closeSessionTasks();
		session.dispose();
	});
	return session;
}

function childPolicy(executionEnded: AbortSignal): SubagentChildPolicy {
	return {
		depth: 1,
		managementActions: "restricted",
		fanoutAuthorized: false,
		inheritProjectContext: false,
		inheritSkills: false,
		executionEnded,
	};
}

async function childOf(
	parent: AgentSession,
	root: string,
	orchestrationContext?: AgentSession["orchestrationContext"],
) {
	const executionEnded = new AbortController();
	const inherited = parent.extensionRunner.createContext().getChildSessionOptions!({ cwd: root });
	const child = await newSession(root, {
		...inherited,
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory({ bashInterceptor: { enabled: false } }),
		resourceLoader: createTestResourceLoader(),
		tools: ["bash", "powershell", "kill"],
		subagentPolicy: childPolicy(executionEnded.signal),
		...(orchestrationContext ? { orchestrationContext } : {}),
	});
	return { child, endExecution: () => executionEnded.abort() };
}

async function startBackground(session: AgentSession, name: ShellName): Promise<TaskId> {
	const result = await tool(session, name).execute("launch", {
		command: waitingCommands[name],
		wait: { kind: "background" },
		timeout: 20,
	});
	const observation = (result.details as BashToolDetails).observation;
	assert.equal(observation?.kind, "yielded");
	assert.ok(observation);
	return observation.taskId;
}

async function release(owner: AgentSession, id: TaskId) {
	const host = owner.getAgentTaskHost();
	const task = host.resolveTask(id);
	assert.ok(task.ok);
	const { supervisor } = host.ownerBinding;
	const input = supervisor.taskStdin(task.value);
	assert.ok(input.ok);
	const written = await supervisor.writeTaskInput(input.value, crypto.randomUUID() as OperationId, {
		kind: "bytes",
		bytes: Buffer.from("go\n"),
	});
	assert.ok(written.ok);
}

function ownerTaskIds(owner: AgentSession): string[] {
	const watched = owner.getAgentTaskHost().watchOwnerTasks();
	assert.ok(watched.ok);
	const ids = watched.value.snapshot.tasks.map((task) => task.ref.taskId);
	watched.value.dispose();
	return ids;
}

function completionNotices(session: AgentSession, taskId: TaskId): number {
	return session.sessionManager
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === TASK_COMPLETION_MESSAGE_TYPE &&
				(entry.details as { taskId?: string } | undefined)?.taskId === taskId,
		).length;
}

function acknowledgedBy(owner: AgentSession, taskId: TaskId): boolean {
	const entries = owner.sessionManager.getEntries();
	const intent = entries.find(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "task-completion-intent" &&
			(entry.data as { taskId?: string } | undefined)?.taskId === taskId,
	);
	const completionId = intent?.type === "custom" ? (intent.data as { completionId: string }).completionId : undefined;
	return entries.some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "task-completion-ack" &&
			(entry.data as { completionId?: string } | undefined)?.completionId === completionId,
	);
}

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-child-shell-tasks-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

for (const name of runnableShells) {
	test(`subagent ${name} background tasks run in the main chat parent's /tasks and stay waitable`, async () => {
		const root = tempRoot();
		const parent = await newSession(root);
		const { child } = await childOf(parent, root);

		const id = await startBackground(child, name);

		assert.deepEqual(ownerTaskIds(parent), [id], "the parent owner holds the child's shell");
		assert.ok(
			getOwnerTaskStore(parent)?.tasks.some((task) => task.ref.taskId === id),
			"the parent's /tasks store shows the child's shell",
		);
		const polled = await tool(child, name).execute("poll", { action: "wait", id, budgetMs: 0 });
		assert.equal((polled.details as BashToolDetails).observation?.kind, "yielded");

		await release(parent, id);
		const settled = await tool(child, name).execute("settle", { action: "wait", id, budgetMs: 10000 });
		assert.equal((settled.details as BashToolDetails).exitCode, 3);
		assert.match(text(settled), /child shell done/);
	});
}

test("a subagent can only wait on or kill the shells it launched", async () => {
	const root = tempRoot();
	const parent = await newSession(root);
	const { child } = await childOf(parent, root);
	const parentTask = await startBackground(parent, nativeShell);
	const childTask = await startBackground(child, nativeShell);

	await assert.rejects(tool(child, nativeShell).execute("foreign", { action: "wait", id: parentTask }), /UnknownTask/);
	await assert.rejects(tool(child, "kill").execute("foreign", { id: parentTask }), /UnknownTask/);

	const killed = await tool(child, "kill").execute("own", { id: childTask });
	assert.equal((killed.details as { taskId?: string }).taskId ?? childTask, childTask);
	const parentView = await tool(parent, nativeShell).execute("parent-wait", {
		action: "wait",
		id: childTask,
		budgetMs: 10000,
	});
	assert.equal((parentView.details as BashToolDetails).observation?.kind, "settled");
});

test("child shell completion notifies the child while it runs and the parent after it ends", async () => {
	const root = tempRoot();
	const parent = await newSession(root);
	const { child, endExecution } = await childOf(parent, root);

	const whileRunning = await startBackground(child, nativeShell);
	await release(parent, whileRunning);
	await vi.waitFor(() => assert.equal(completionNotices(child, whileRunning), 1), { timeout: 10000 });
	assert.equal(completionNotices(parent, whileRunning), 0);

	const afterEnd = await startBackground(child, nativeShell);
	endExecution();
	await release(parent, afterEnd);
	await vi.waitFor(() => assert.equal(completionNotices(parent, afterEnd), 1), { timeout: 10000 });
	assert.equal(completionNotices(child, afterEnd), 0);
});

test("child shells outlive the child session and remain in the parent's /tasks", async () => {
	const root = tempRoot();
	const parent = await newSession(root);
	const { child, endExecution } = await childOf(parent, root);
	const id = await startBackground(child, nativeShell);

	endExecution();
	await child.closeSessionTasks();
	child.dispose();

	assert.deepEqual(ownerTaskIds(parent), [id]);
	await release(parent, id);
	const settled = await tool(parent, nativeShell).execute("settle", { action: "wait", id, budgetMs: 10000 });
	assert.equal((settled.details as BashToolDetails).exitCode, 3);
});

test("workflow-stage subagent shells land in the stage's /tasks without rebinding the stage owner", async () => {
	const root = tempRoot();
	const boundary = new WorkflowStageAdmissionBoundary();
	cleanups.push(() => boundary.close());
	const stage = await newSession(root, {
		orchestrationContext: {
			kind: "workflow-stage",
			workflowRunId: crypto.randomUUID(),
			workflowStageId: "stage",
			workflowStageName: "Stage",
			constraints: { disableWorkflowTool: true },
			messageAdmission: {
				boundary,
				extensionState: new Map<string, object>(),
				isOpen: () => boundary.isOpen(),
			},
		},
	});
	const stageHost = stage.getAgentTaskHost();
	const { child, endExecution } = await childOf(stage, root, stage.orchestrationContext);

	assert.notEqual(child.getAgentTaskHost(), stageHost, "a child never binds the stage's task owner");
	const childTask = await startBackground(child, nativeShell);
	assert.deepEqual(ownerTaskIds(stage), [childTask]);

	endExecution();
	const stageTask = await startBackground(stage, nativeShell);
	await release(stage, stageTask);
	await release(stage, childTask);
	await vi.waitFor(
		() => {
			assert.ok(acknowledgedBy(stage, stageTask), "the stage outbox delivers the stage's own completion");
			assert.ok(acknowledgedBy(stage, childTask), "the stage outbox delivers the ended child's completion");
		},
		{ timeout: 10000 },
	);
	assert.equal(completionNotices(child, stageTask), 0, "stage completions still reach the stage");
});

test("a subagent without a parent task owner keeps refusing background shells", async () => {
	const root = tempRoot();
	const child = await newSession(root, { subagentPolicy: childPolicy(new AbortController().signal) });
	await assert.rejects(
		tool(child, nativeShell).execute("background", { command: "must not run", wait: { kind: "background" } }),
		/supported task owner/,
	);
});
