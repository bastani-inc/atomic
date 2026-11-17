import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { replaceSessionTaskOwner } from "../src/core/agent-session-tasks.js";
import type { SubagentChildPolicy } from "../src/core/extensions/index.js";
import { createAgentSession } from "../src/core/sdk.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk-types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { childDeliveryCount, childLaunchCount, keptChildNoticeCount } from "../src/core/tasks/child-command-owner.js";
import { TASK_COMPLETION_MESSAGE_TYPE } from "../src/core/tasks/completion.js";
import type { OperationId, TaskId, TaskResult } from "../src/core/tasks/contracts.js";
import { getOwnerTaskStore } from "../src/core/tasks/owner-store.js";
import type { BashToolDetails } from "../src/core/tools/bash.js";
import { parkWorkflowStageForRelease, WorkflowStageAdmissionBoundary } from "../src/core/workflow-stage-admission.js";
import { linkSharedTranspileCache } from "./helpers/shared-transpile-cache.ts";
import { createTestResourceLoader } from "./utilities.js";

vi.mock("../src/utils/shell.js", async (importOriginal) => {
	const shell = await importOriginal<typeof import("../src/utils/shell.js")>();
	return {
		...shell,
		isPowerShellAvailable: () => true,
		isPowerShellAvailableAsync: async () => true,
		getPowerShellConfig: () =>
			process.platform !== "win32" && process.env.ATOMIC_TEST_PWSH
				? { shell: process.env.ATOMIC_TEST_PWSH, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] }
				: shell.getPowerShellConfig(),
		getPowerShellConfigAsync: async () =>
			process.platform !== "win32" && process.env.ATOMIC_TEST_PWSH
				? { shell: process.env.ATOMIC_TEST_PWSH, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] }
				: shell.getPowerShellConfigAsync(),
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
		settingsManager: SettingsManager.inMemory(),
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
	sessionManager = SessionManager.inMemory(root),
) {
	const executionEnded = new AbortController();
	const inherited = parent.extensionRunner.createContext().getChildSessionOptions!({ cwd: root });
	const child = await newSession(root, {
		...inherited,
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		tools: ["bash", "powershell", "kill"],
		subagentPolicy: childPolicy(executionEnded.signal),
		...(orchestrationContext ? { orchestrationContext } : {}),
	});
	return {
		child,
		endExecution: () => executionEnded.abort(),
		parentCommandTaskOwner: inherited.parentCommandTaskOwner,
	};
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

function completionNoticeText(session: AgentSession, taskId: TaskId): string | undefined {
	const notice = session.sessionManager
		.getEntries()
		.find(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === TASK_COMPLETION_MESSAGE_TYPE &&
				(entry.details as { taskId?: string } | undefined)?.taskId === taskId,
		);
	return notice?.type === "custom_message" ? String(notice.content) : undefined;
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
	linkSharedTranspileCache(root);
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("a resumed child receives a prior run's shell notice without another shell call (#5342)", async () => {
	const root = tempRoot();
	const parent = await newSession(root);
	const manager = SessionManager.inMemory(root);
	const { child, endExecution } = await childOf(parent, root, undefined, manager);
	const shell = await startBackground(child, nativeShell);
	endExecution();
	await child.closeSessionTasks();
	child.dispose();

	const { child: resumed } = await childOf(parent, root, undefined, manager);
	await release(parent, shell);

	await vi.waitFor(() => assert.equal(completionNotices(resumed, shell), 1), { timeout: 10000 });
	await vi.waitFor(() => assert.ok(acknowledgedBy(parent, shell)), { timeout: 10000 });
	assert.equal(completionNotices(parent, shell), 0);
	assert.equal(keptChildNoticeCount(parent.getAgentTaskHost(), manager.getSessionId()), 0);
});

test("a taken child notice retries until acknowledgement and is then forgotten (#5342)", async () => {
	const root = tempRoot();
	const parent = await newSession(root);
	const { child } = await childOf(parent, root);
	const shell = await startBackground(child, nativeShell);
	const host = parent.getAgentTaskHost();
	const appendEntry = parent.sessionManager.appendCustomEntry.bind(parent.sessionManager);
	let failedAcknowledgements = 0;
	vi.spyOn(parent.sessionManager, "appendCustomEntry").mockImplementation(async (...args) => {
		if (args[0] === "task-completion-ack" && failedAcknowledgements++ === 0)
			throw new Error("SQLITE_BUSY: database is locked");
		return appendEntry(...args);
	});

	await release(parent, shell);
	await vi.waitFor(() => assert.equal(failedAcknowledgements, 1), { timeout: 10000 });
	assert.equal(completionNotices(child, shell), 1);
	assert.equal(acknowledgedBy(parent, shell), false);
	assert.equal(childDeliveryCount(host), 1, "an unacknowledged delivery stays idempotent");
	const internal = parent as unknown as import("../src/core/agent-session-methods.ts").AgentSessionInternalSurface;
	await vi.waitFor(
		async () => {
			await internal._taskCompletionOutbox!.flush();
			assert.ok(acknowledgedBy(parent, shell));
			assert.equal(childDeliveryCount(host), 0, "acknowledged completions retain no delivery record");
		},
		{ timeout: 10000 },
	);

	assert.equal(completionNotices(child, shell), 1, "acknowledgement retry never repeats the notice");
});

test("a child's settled and acknowledged shells leave no launch record in the parent's owner", async () => {
	const root = tempRoot();
	const parent = await newSession(root);
	const { child } = await childOf(parent, root);
	const host = parent.getAgentTaskHost();
	const background = [
		await startBackground(child, nativeShell),
		await startBackground(child, nativeShell),
		await startBackground(child, nativeShell),
	];
	for (const index of [1, 2]) {
		const foreground = await tool(child, nativeShell).execute(`foreground-${index}`, {
			command: nativeShell === "powershell" ? "Write-Output done" : "printf done",
			timeout: 20,
		});
		assert.match(text(foreground), /done/);
	}
	await vi.waitFor(() => assert.equal(childLaunchCount(host), background.length), { timeout: 10000 });

	for (const shell of background) await release(parent, shell);
	await vi.waitFor(
		() => {
			for (const shell of background) assert.ok(acknowledgedBy(parent, shell));
			assert.equal(childLaunchCount(host), 0, "every settled and acknowledged shell released its launch record");
		},
		{ timeout: 10000 },
	);
	for (const shell of background) assert.equal(completionNotices(child, shell), 1);
});

test("a child acknowledgement forgets delivery in the host it used before replacement (#5342)", async () => {
	const root = tempRoot();
	const parent = await newSession(root);
	const { child } = await childOf(parent, root);
	const shell = await startBackground(child, nativeShell);
	const host = parent.getAgentTaskHost();
	const appendEntry = parent.sessionManager.appendCustomEntry.bind(parent.sessionManager);
	const acknowledgement = Promise.withResolvers<void>();
	const acknowledging = Promise.withResolvers<void>();
	cleanups.push(() => acknowledgement.resolve());
	vi.spyOn(parent.sessionManager, "appendCustomEntry").mockImplementation(async (...args) => {
		if (args[0] === "task-completion-ack") {
			acknowledging.resolve();
			await acknowledgement.promise;
		}
		return appendEntry(...args);
	});

	await release(parent, shell);
	await acknowledging.promise;
	assert.equal(childDeliveryCount(host), 1);
	await parent.closeSessionTasks();
	replaceSessionTaskOwner(
		parent as unknown as import("../src/core/agent-session-methods.ts").AgentSessionInternalSurface,
	);
	const replacement = parent.getAgentTaskHost();
	assert.notEqual(replacement, host);
	acknowledgement.resolve();

	await vi.waitFor(
		() => {
			assert.ok(acknowledgedBy(parent, shell));
			assert.equal(childDeliveryCount(host), 0, "the acknowledged delivery leaves its original host");
		},
		{ timeout: 10000 },
	);
	assert.equal(completionNotices(child, shell), 1);
	assert.equal(childDeliveryCount(replacement), 0);
});

test("a failed own notice in a mixed batch never repeats the child's notice (#5342)", async () => {
	const root = tempRoot();
	const parent = await newSession(root);
	const { child } = await childOf(parent, root);
	const own = await startBackground(parent, nativeShell);
	const shell = await startBackground(child, nativeShell);
	const manager = parent.sessionManager;
	const appendEntry = manager.appendCustomEntry.bind(manager);
	const gate = Promise.withResolvers<void>();
	const gateHit = Promise.withResolvers<void>();
	let gated = false;
	vi.spyOn(manager, "appendCustomEntry").mockImplementation(async (...args) => {
		if (!gated && args[0] === "task-completion-intent") {
			gated = true;
			gateHit.resolve();
			await gate.promise;
		}
		return appendEntry(...args);
	});
	cleanups.push(() => gate.resolve());
	const appendMessage = manager.appendCustomMessageEntry.bind(manager);
	let failures = 0;
	vi.spyOn(manager, "appendCustomMessageEntry").mockImplementation(async (...args) => {
		if (args[0] === TASK_COMPLETION_MESSAGE_TYPE && failures++ === 0)
			throw new Error("SQLITE_BUSY: database is locked");
		return appendMessage(...args);
	});

	await release(parent, own);
	await gateHit.promise;
	await release(parent, shell);
	const internal = parent as unknown as import("../src/core/agent-session-methods.ts").AgentSessionInternalSurface;
	await vi.waitFor(() => assert.equal(internal._taskCompletionOutbox?.pending.length, 2), { timeout: 10000 });
	gate.resolve();
	await vi.waitFor(() => assert.equal(failures, 1), { timeout: 10000 });
	await vi.waitFor(() => assert.equal(completionNotices(child, shell), 1), { timeout: 10000 });
	await vi.waitFor(() => assert.ok(acknowledgedBy(parent, shell)), { timeout: 10000 });
	assert.equal(acknowledgedBy(parent, own), false);
	await internal._taskCompletionOutbox!.flush();
	await vi.waitFor(() => assert.ok(acknowledgedBy(parent, own)), { timeout: 10000 });
	await vi.waitFor(() => assert.ok(acknowledgedBy(parent, shell)), { timeout: 10000 });
	assert.equal(completionNotices(child, shell), 1);
	assert.equal(completionNotices(parent, own), 1);
	assert.equal(completionNotices(parent, shell), 0);
});

test("reopening a parent counts only notices shown in its own chat (#5342)", async () => {
	const root = tempRoot();
	const sessionDir = join(root, "sessions");
	const manager = await SessionManager.create(root, sessionDir);
	const parent = await newSession(root, { sessionManager: manager });
	await parent.sendCustomMessage({ customType: "note", content: "saved", display: true }, { triggerTurn: false });
	const { child, endExecution } = await childOf(parent, root);
	const shell = await startBackground(child, nativeShell);
	endExecution();
	await child.closeSessionTasks();
	child.dispose();
	await parent.closeSessionTasks();
	parent.dispose();
	const file = manager.getSessionFile();
	assert.ok(file);

	for (const round of [1, 2]) {
		const reopened = await newSession(root, { sessionManager: await SessionManager.open(file, sessionDir) });
		const recovery = await reopened.startPendingRecovery("resume");
		assert.equal(recovery.completions, 0, `reopen ${round} did not show the child's notice`);
		assert.equal(completionNotices(reopened, shell), 0);
		assert.equal(acknowledgedBy(reopened, shell), false);
		assert.equal(keptChildNoticeCount(reopened.getAgentTaskHost(), child.sessionId), 1);
		if (round === 2) {
			const { child: resumed } = await childOf(reopened, root, undefined, child.sessionManager);
			await vi.waitFor(
				() => {
					assert.ok(acknowledgedBy(reopened, shell));
					assert.equal(
						childDeliveryCount(reopened.getAgentTaskHost()),
						0,
						"a restored acknowledgement forgets delivery",
					);
				},
				{ timeout: 10000 },
			);
			assert.equal(completionNotices(resumed, shell), 1);
		}
		await reopened.closeSessionTasks();
		reopened.dispose();
	}
});

for (const name of runnableShells) {
	test(`subagent ${name} background tasks run in the parent's owner, stay out of the parent's /tasks and stay waitable`, async () => {
		const root = tempRoot();
		const parent = await newSession(root);
		const { child } = await childOf(parent, root);
		const parentShell = await startBackground(parent, name);

		const id = await startBackground(child, name);

		assert.deepEqual(ownerTaskIds(parent), [parentShell, id], "the parent owner runs the child's shell");
		const store = getOwnerTaskStore(parent);
		await vi.waitFor(
			() =>
				assert.ok(
					store?.ownerTasks.some((task) => task.ref.taskId === id),
					"the owner's tasks hold the child's shell",
				),
			{ timeout: 10000 },
		);
		assert.deepEqual(
			store?.tasks.map((task) => task.ref.taskId),
			[parentShell],
			"the parent's /tasks lists only its own shell",
		);
		assert.deepEqual(
			store?.backgroundTasks.map((task) => task.ref.taskId),
			[parentShell],
		);
		assert.equal(
			store?.ownerTasks.find((task) => task.ref.taskId === id)?.launchedBy,
			child.sessionManager.getSessionId(),
			"the shell names the child's session",
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

/** The subagent `child` runs again in its own session, as a resume reopens it. */
async function resumeChild(parent: AgentSession, root: string, child: AgentSession) {
	const inherited = parent.extensionRunner.createContext().getChildSessionOptions!({ cwd: root });
	return newSession(root, {
		...inherited,
		sessionManager: child.sessionManager,
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		tools: ["bash", "powershell", "kill"],
		subagentPolicy: childPolicy(new AbortController().signal),
	});
}

function intentRecorded(owner: AgentSession, taskId: TaskId): boolean {
	return owner.sessionManager
		.getEntries()
		.some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "task-completion-intent" &&
				(entry.data as { taskId?: string } | undefined)?.taskId === taskId,
		);
}

test("a subagent's shell notice reaches only that subagent: while it runs, and when it runs again after it ended", async () => {
	const root = tempRoot();
	const parent = await newSession(root);
	const { child, endExecution } = await childOf(parent, root);
	const childId = child.sessionManager.getSessionId();

	const whileRunning = await startBackground(child, nativeShell);
	await release(parent, whileRunning);
	await vi.waitFor(() => assert.equal(completionNotices(child, whileRunning), 1), { timeout: 10000 });
	assert.equal(completionNotices(parent, whileRunning), 0);

	const afterEnd = await startBackground(child, nativeShell);
	endExecution();
	await child.closeSessionTasks();
	child.dispose();
	await release(parent, afterEnd);
	await vi.waitFor(() => assert.ok(intentRecorded(parent, afterEnd)), { timeout: 10000 });
	await vi.waitFor(() => assert.equal(keptChildNoticeCount(parent.getAgentTaskHost(), childId), 1), {
		timeout: 10000,
	});
	assert.equal(completionNotices(parent, afterEnd), 0, "the parent never receives the subagent's notice");
	assert.equal(acknowledgedBy(parent, afterEnd), false, "it is kept until the subagent takes it");

	const resumed = await resumeChild(parent, root, child);
	await vi.waitFor(() => assert.equal(completionNotices(resumed, afterEnd), 1), { timeout: 10000 });
	await vi.waitFor(() => assert.ok(acknowledgedBy(parent, afterEnd)), { timeout: 10000 });
	assert.equal(completionNotices(parent, afterEnd), 0);
	assert.equal(keptChildNoticeCount(parent.getAgentTaskHost(), childId), 0);
});

test("child shells outlive the child session in the parent's owner", async () => {
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

test("workflow-stage subagent shells run in the stage's owner without rebinding it, and their notices never reach the stage", async () => {
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

	assert.deepEqual(
		getOwnerTaskStore(stage)?.tasks.map((task) => task.ref.taskId),
		[],
		"the stage's /tasks does not list its worker's shell",
	);

	endExecution();
	const stageTask = await startBackground(stage, nativeShell);
	await release(stage, stageTask);
	await release(stage, childTask);
	await vi.waitFor(
		() => {
			assert.ok(acknowledgedBy(stage, stageTask), "the stage outbox delivers the stage's own completion");
			assert.ok(intentRecorded(stage, childTask), "the ended child's completion is recorded");
			assert.equal(keptChildNoticeCount(stageHost, child.sessionManager.getSessionId()), 1);
		},
		{ timeout: 10000 },
	);
	assert.equal(completionNotices(stage, childTask), 0, "the ended child's completion never reaches the stage");
	assert.equal(acknowledgedBy(stage, childTask), false, "it is kept for the child");
	assert.equal(completionNotices(child, stageTask), 0, "stage completions still reach the stage");
});

test("a stage's notice built while the stage closes is kept for the stage, never routed to the chat that launched the workflow", async () => {
	const root = tempRoot();
	const boundary = new WorkflowStageAdmissionBoundary();
	cleanups.push(() => boundary.close());
	const routed: unknown[] = [];
	const context = {
		...workflowStageContext(boundary),
		lateMessageRouter: {
			routeMessage: (message: unknown) => void routed.push(message),
			routeMessages: (messages: readonly unknown[]) => void routed.push(...messages),
		},
	};
	const stage = await newSession(root, { orchestrationContext: context });
	const id = await startBackground(stage, nativeShell);
	const { supervisor } = stage.getAgentTaskHost().ownerBinding;
	const readOutput = supervisor.readTaskOutput.bind(supervisor);
	const building = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	vi.spyOn(supervisor, "readTaskOutput").mockImplementation(async (...args) => {
		building.resolve();
		await closed.promise;
		return readOutput(...args);
	});

	await release(stage, id);
	await building.promise;
	boundary.seal();
	closed.resolve();
	await vi.waitFor(() => assert.ok(intentRecorded(stage, id)), { timeout: 10000 });
	await new Promise((resolve) => setTimeout(resolve, 100));

	assert.deepEqual(routed, [], "the notice never takes the late route to another session");
	assert.equal(completionNotices(stage, id), 0);
	assert.equal(acknowledgedBy(stage, id), false, "the stage keeps it for its next session");
});

function workflowStageContext(
	boundary: WorkflowStageAdmissionBoundary,
): NonNullable<AgentSession["orchestrationContext"]> {
	return {
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
	};
}

/** A workflow stage whose session launched a worker that started a background shell. */
async function stageWithWorkerShell(root: string) {
	const boundary = new WorkflowStageAdmissionBoundary();
	cleanups.push(() => boundary.close());
	const context = workflowStageContext(boundary);
	const stage = await newSession(root, { orchestrationContext: context });
	const stageHost = stage.getAgentTaskHost();
	const { child, endExecution, parentCommandTaskOwner } = await childOf(stage, root, context);
	const id = await startBackground(child, nativeShell);
	return { context, stage, stageHost, worker: child, id, endExecution, parentCommandTaskOwner };
}

async function disposeStageSession(stage: AgentSession): Promise<void> {
	await stage.closeSessionTasks();
	await stage.dispose();
}

async function writeToTask(host: ReturnType<AgentSession["getAgentTaskHost"]>, id: TaskId): Promise<void> {
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

/** Wait until the task settles: a completion notice reaching the worker yields its pending waits. */
async function settledFor(worker: AgentSession, id: TaskId): Promise<BashToolDetails> {
	for (;;) {
		const result = await tool(worker, nativeShell).execute("settle", { action: "wait", id, budgetMs: 10000 });
		const details = result.details as BashToolDetails;
		if (details.observation?.kind === "settled") return details;
		assert.notEqual((details.observation as { reason?: string } | undefined)?.reason, "elapsed");
	}
}

/** The worker can still wait on its first shell, launch a second one, and kill it. */
async function assertWorkerControlsItsShells(worker: AgentSession, id: TaskId): Promise<void> {
	const polled = await tool(worker, nativeShell).execute("poll", { action: "wait", id, budgetMs: 0 });
	assert.equal(
		(polled.details as BashToolDetails).observation?.kind,
		"yielded",
		"the worker still observes its shell",
	);
	const second = await startBackground(worker, nativeShell);
	const killed = await tool(worker, "kill").execute("kill", { id: second });
	assert.equal((killed.details as { taskId?: string }).taskId ?? second, second);
	assert.equal((await settledFor(worker, second)).observation?.kind, "settled", "the worker controls its new shell");
}

test("a workflow-stage worker keeps waiting on, launching and killing its shells after the stage's session is replaced (#4639)", async () => {
	const root = tempRoot();
	const { context, stage, stageHost, worker, id } = await stageWithWorkerShell(root);

	await disposeStageSession(stage);
	const replacement = await newSession(root, { orchestrationContext: context });
	assert.equal(replacement.getAgentTaskHost(), stageHost, "the replacement binds the stage's one task host");

	await assertWorkerControlsItsShells(worker, id);
	await writeToTask(stageHost, id);
	assert.equal((await settledFor(worker, id)).exitCode, 3);
});

test("a workflow-stage worker keeps waiting on, launching and killing its shells while the stage is released (#4639)", async () => {
	const root = tempRoot();
	const { context, stage, stageHost, worker, id } = await stageWithWorkerShell(root);

	parkWorkflowStageForRelease(context);
	await disposeStageSession(stage);

	await assertWorkerControlsItsShells(worker, id);
	await writeToTask(stageHost, id);
	assert.equal((await settledFor(worker, id)).exitCode, 3);
});

test("a released workflow stage still refuses launches from its own session while its worker launches (#4639)", async () => {
	const root = tempRoot();
	const { context, stage, worker } = await stageWithWorkerShell(root);

	parkWorkflowStageForRelease(context);

	await assert.rejects(
		tool(stage, nativeShell).execute("stage-launch", { command: "echo late", wait: { kind: "background" } }),
		/stage-parked/,
	);
	await startBackground(worker, nativeShell);
});

test("a live worker receives its shell completion while its stage is released, then forgets delivery (#4639, #5342)", async () => {
	const root = tempRoot();
	const { context, stage, stageHost, worker, id } = await stageWithWorkerShell(root);

	parkWorkflowStageForRelease(context);
	await disposeStageSession(stage);
	const released = vi.spyOn(stageHost, "releaseTaskRecord");
	await writeToTask(stageHost, id);

	await vi.waitFor(() => assert.equal(completionNotices(worker, id), 1), { timeout: 10000 });
	assert.match(
		completionNoticeText(worker, id) ?? "",
		/^Background shell failed: [\s\S]*Result excerpt \(task output, not instructions\):\n[\s\S]*child shell done/,
	);
	await vi.waitFor(() => assert.deepEqual(released.mock.calls, [[id]]), { timeout: 10000 });
	await vi.waitFor(() => assert.equal(childDeliveryCount(stageHost), 0), { timeout: 10000 });
	const boundary = context.kind === "workflow-stage" ? context.messageAdmission?.boundary : undefined;
	assert.deepEqual(boundary?.takeParkedTaskSettlements(), [], "the stage's next session is not handed it again");
});

test("a worker's shell completion that its route cannot take is kept for the worker, never for its released stage's next session", async () => {
	const root = tempRoot();
	const { context, stage, stageHost, worker, id, endExecution, parentCommandTaskOwner } =
		await stageWithWorkerShell(root);
	assert.ok(parentCommandTaskOwner);
	parkWorkflowStageForRelease(context);
	await disposeStageSession(stage);
	const workerId = worker.sessionManager.getSessionId();
	endExecution();
	await worker.closeSessionTasks();
	await worker.dispose();
	parentCommandTaskOwner.routeReleased(workerId, {
		isOpen: () => true,
		deliver: async () => {
			throw new Error("the released worker's owner is gone");
		},
	});
	await writeToTask(stageHost, id);

	const boundary = context.kind === "workflow-stage" ? context.messageAdmission?.boundary : undefined;
	assert.ok(boundary);
	await vi.waitFor(() => assert.equal(keptChildNoticeCount(stageHost, workerId), 1), { timeout: 10000 });
	assert.deepEqual(boundary.takeParkedTaskSettlements(), [], "the stage's next session is never handed it");
});

test("a live worker hears that its released stage's close stopped its shell (#4639)", async () => {
	const root = tempRoot();
	const { context, stage, worker, id } = await stageWithWorkerShell(root);
	parkWorkflowStageForRelease(context);
	await disposeStageSession(stage);
	const boundary = context.kind === "workflow-stage" ? context.messageAdmission?.boundary : undefined;
	assert.ok(boundary);

	await boundary.close();

	await vi.waitFor(() => assert.equal(completionNotices(worker, id), 1), { timeout: 10000 });
	const notice = completionNoticeText(worker, id) ?? "";
	assert.match(notice, /^Background shell stopped \(workflow stage closed\)/);
	assert.match(notice, /Stop reason: owner-close \(workflow stage closed\)/);
	assert.doesNotMatch(notice, /Result excerpt|Output unavailable/);
});

test("a released worker's shell completion reaches it while its workflow stage is released too (#4639)", async () => {
	const root = tempRoot();
	const { context, stage, stageHost, worker, id, endExecution, parentCommandTaskOwner } =
		await stageWithWorkerShell(root);
	assert.ok(parentCommandTaskOwner);
	parkWorkflowStageForRelease(context);
	await disposeStageSession(stage);
	const workerId = worker.sessionManager.getSessionId();
	endExecution();
	await worker.closeSessionTasks();
	await worker.dispose();
	const delivered: string[] = [];

	const routed = parentCommandTaskOwner.routeReleased(workerId, {
		isOpen: () => true,
		deliver: async (message) => {
			delivered.push(message.content);
		},
	});
	await writeToTask(stageHost, id);

	assert.equal(routed, true, "the released worker's running shell is routed to it");
	await vi.waitFor(() => assert.equal(delivered.length, 1), { timeout: 10000 });
	assert.match(delivered[0] ?? "", /^Background shell failed: /);
	assert.match(delivered[0] ?? "", /child shell done/);
});

/** Registers the running agent task whose transcript is `worker`'s session, as a subagent's runner does. */
async function startWorkerAgentTask(stageHost: ReturnType<AgentSession["getAgentTaskHost"]>, worker: AgentSession) {
	const result = Promise.withResolvers<TaskResult>();
	const sessionId = worker.sessionManager.getSessionId();
	const started = await stageHost.startAgentTask(
		{ kind: "agent", agent: "worker", task: "work" },
		crypto.randomUUID() as OperationId,
		(context) => {
			context.bindTranscript({ getSessionId: () => sessionId, getEntries: () => [] });
			return { result: result.promise, cleanup: Promise.resolve({ kind: "reaped" }) };
		},
	);
	assert.ok(started.ok);
	cleanups.push(() => result.resolve({ kind: "cancelled", cause: "user" }));
	return started.value.taskId;
}

function launcherOf(stageHost: ReturnType<AgentSession["getAgentTaskHost"]>, id: TaskId): TaskId | undefined {
	const watched = stageHost.watchOwnerTasks();
	assert.ok(watched.ok);
	const task = watched.value.snapshot.tasks.find((item) => item.ref.taskId === id);
	watched.value.dispose();
	assert.ok(task, `${id} is in the stage's owner`);
	return task.parentTaskId;
}

test("a worker's shells name the worker's task after the stage session is replaced and while the stage is released (#4639)", async () => {
	const root = tempRoot();
	const { context, stage, stageHost, worker } = await stageWithWorkerShell(root);
	const workerTask = await startWorkerAgentTask(stageHost, worker);

	await disposeStageSession(stage);
	const replacement = await newSession(root, { orchestrationContext: context });
	assert.equal(replacement.getAgentTaskHost(), stageHost);
	const afterReplacement = await startBackground(worker, nativeShell);
	parkWorkflowStageForRelease(context);
	await disposeStageSession(replacement);
	const whileReleased = await startBackground(worker, nativeShell);

	assert.equal(launcherOf(stageHost, afterReplacement), workerTask, "launched after the stage session was replaced");
	assert.equal(launcherOf(stageHost, whileReleased), workerTask, "launched while the stage was released");
});

test("a subagent without a parent task owner keeps refusing background shells", async () => {
	const root = tempRoot();
	const child = await newSession(root, { subagentPolicy: childPolicy(new AbortController().signal) });
	await assert.rejects(
		tool(child, nativeShell).execute("background", { command: "must not run", wait: { kind: "background" } }),
		/supported task owner/,
	);
});
