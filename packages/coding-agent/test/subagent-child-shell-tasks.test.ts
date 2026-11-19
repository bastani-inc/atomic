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
import type { OperationId, TaskId } from "../src/core/tasks/contracts.js";
import { getOwnerTaskStore } from "../src/core/tasks/owner-store.js";
import type { BashToolDetails } from "../src/core/tools/bash.js";
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

async function childOf(parent: AgentSession, root: string, sessionManager = SessionManager.inMemory(root)) {
	const executionEnded = new AbortController();
	const inherited = parent.extensionRunner.createContext().getChildSessionOptions!({ cwd: root });
	const child = await newSession(root, {
		...inherited,
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		tools: ["bash", "powershell", "kill"],
		subagentPolicy: childPolicy(executionEnded.signal),
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
	const { child, endExecution } = await childOf(parent, root, manager);
	const shell = await startBackground(child, nativeShell);
	endExecution();
	await child.closeSessionTasks();
	child.dispose();

	const { child: resumed } = await childOf(parent, root, manager);
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
			const { child: resumed } = await childOf(reopened, root, child.sessionManager);
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

test("a subagent without a parent task owner keeps refusing background shells", async () => {
	const root = tempRoot();
	const child = await newSession(root, { subagentPolicy: childPolicy(new AbortController().signal) });
	await assert.rejects(
		tool(child, nativeShell).execute("background", { command: "must not run", wait: { kind: "background" } }),
		/supported task owner/,
	);
});
