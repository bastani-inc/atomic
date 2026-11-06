import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.js";
import type { WorkflowStageOrchestrationContext } from "../src/core/extensions/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { SessionMessageEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { AgentTaskHost } from "../src/core/tasks/agent-adapter.js";
import { TASK_COMPLETION_MESSAGE_TYPE, type TaskCompletionEnvelope } from "../src/core/tasks/completion.js";
import type { OperationId, TaskId, TaskResult } from "../src/core/tasks/contracts.js";
import { FINISHED_TASK_RETENTION } from "../src/core/tasks/eviction-error.js";
import { parkWorkflowStageForRelease } from "../src/index.js";
import { waitForCiTurn, waitTool } from "./helpers/detached-tools.js";
import { createHarness, type Harness } from "./suite/harness.js";

const BURST = FINISHED_TASK_RETENTION + 8;
const BURST_TEST_TIMEOUT_MS = 120_000;
const CONVERGENCE_TIMEOUT_MS = 60_000;

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

type Agent = {
	readonly taskId: TaskId;
	readonly gate: PromiseWithResolvers<TaskResult>;
	readonly entries: SessionMessageEntry[];
};

async function startAgents(host: AgentTaskHost, from: number, count: number): Promise<Agent[]> {
	const agents: Agent[] = [];
	for (let index = from; index < from + count; index++) {
		const gate = Promise.withResolvers<TaskResult>();
		const entries: SessionMessageEntry[] = [];
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "worker", task: `probe task ${index}` },
			`probe-${index}` as OperationId,
			(context) => {
				context.bindTranscript({ getSessionId: () => `child-${index}`, getEntries: () => entries });
				return { result: gate.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) };
			},
		);
		assert.ok(started.ok);
		await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
		agents.push({ taskId: started.value.taskId, gate, entries });
	}
	return agents;
}

function finishAgents(agents: readonly Agent[]): void {
	for (const agent of agents) {
		agent.entries.push({
			type: "message",
			id: `answer-${agent.taskId}`,
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: fauxAssistantMessage(`answer of ${agent.taskId}`),
		});
		agent.gate.resolve({ kind: "failed", code: "fixture", message: "done" });
	}
}

function cardOf(manager: SessionManager, taskId: TaskId): string | undefined {
	for (const entry of manager.getEntries()) {
		if (entry.type !== "custom_message" || entry.customType !== TASK_COMPLETION_MESSAGE_TYPE) continue;
		if ((entry.details as { taskId: TaskId }).taskId !== taskId) continue;
		return typeof entry.content === "string"
			? entry.content
			: entry.content.map((block) => ("text" in block ? block.text : "")).join("");
	}
	return undefined;
}

function stageContext(): WorkflowStageOrchestrationContext {
	return {
		kind: "workflow-stage",
		workflowRunId: crypto.randomUUID(),
		workflowStageId: "stage-a",
		workflowStageName: "Stage A",
		constraints: { disableWorkflowTool: true },
	};
}

function intentOf(manager: SessionManager, taskId: TaskId): TaskCompletionEnvelope | undefined {
	for (const entry of manager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== "task-completion-intent") continue;
		const envelope = entry.data as TaskCompletionEnvelope;
		if (envelope.taskId === taskId) return envelope;
	}
	return undefined;
}

function acknowledged(manager: SessionManager, completionId: string): boolean {
	return manager
		.getEntries()
		.some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "task-completion-ack" &&
				(entry.data as { completionId: string }).completionId === completionId,
		);
}

test(
	"a notice deferred behind a detached call and delivered by the reopened stage session releases its task's record (#4309)",
	async () => {
		const context = stageContext();
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, process.cwd());
		const ci = waitTool();
		const first = await createHarness({
			orchestrationContext: context,
			sessionManager: manager,
			customTools: [ci.definition],
		});
		harnesses.push(first);
		first.session.setToolDetachment({ afterMs: 0 });
		first.setResponses([waitForCiTurn("ci-1")]);
		await first.session.prompt("watch ci");
		const [detached] = first.session.takeDetachedToolCalls();
		assert.ok(detached !== undefined);

		const host = first.session.getAgentTaskHost();
		const [pinned] = await startAgents(host, 0, 1);
		assert.ok(pinned !== undefined);
		finishAgents([pinned]);
		const intent = await vi.waitFor(
			() => {
				const saved = intentOf(manager, pinned.taskId);
				assert.ok(saved !== undefined);
				return saved;
			},
			{ timeout: 10_000, interval: 20 },
		);
		assert.equal(acknowledged(manager, intent.completionId), false);

		parkWorkflowStageForRelease(context);
		await first.session.dispose();
		const reopened = await createHarness({
			orchestrationContext: context,
			sessionManager: await SessionManager.open(store, manager.getSessionId()),
			customTools: [ci.definition],
		});
		harnesses.push(reopened);
		reopened.setResponses([
			fauxAssistantMessage("ci passed"),
			...Array.from({ length: BURST }, () => fauxAssistantMessage("ok")),
		]);
		ci.finish(0, "passed");
		await reopened.session.resumeDetachedTurn([await detached.result]);
		await vi.waitFor(() => assert.equal(acknowledged(reopened.sessionManager, intent.completionId), true), {
			timeout: 10_000,
			interval: 20,
		});

		const reopenedHost = reopened.session.getAgentTaskHost();
		assert.equal(reopenedHost, host);
		finishAgents(await startAgents(reopenedHost, 1, BURST));

		await vi.waitFor(
			() => {
				const found = reopenedHost.resolveTask(pinned.taskId);
				assert.equal(found.ok, false);
				assert.equal(found.ok ? undefined : found.error.code, "TaskEvicted");
			},
			{ timeout: CONVERGENCE_TIMEOUT_MS, interval: 50 },
		);
		await context.messageAdmission?.boundary?.close();
	},
	BURST_TEST_TIMEOUT_MS,
);

async function settled(host: AgentTaskHost, ...taskIds: TaskId[]): Promise<void> {
	await vi.waitFor(
		() => {
			const watched = host.watchOwnerTasks();
			assert.ok(watched.ok);
			const done = new Set(
				watched.value.snapshot.tasks
					.filter((task) => task.execution.kind === "settled")
					.map((task) => task.ref.taskId),
			);
			watched.value.dispose();
			assert.ok(taskIds.every((taskId) => done.has(taskId)));
		},
		{ timeout: CONVERGENCE_TIMEOUT_MS, interval: 20 },
	);
}

test(
	"a restored notice whose completion id is not the task's own leaves that task's record pinned (#4309)",
	async () => {
		const context = stageContext();
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, process.cwd());
		const first = await createHarness({ orchestrationContext: context, sessionManager: manager });
		harnesses.push(first);
		first.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("ok")));
		const host = first.session.getAgentTaskHost();

		const [current, parked] = await startAgents(host, 0, 2);
		assert.ok(current !== undefined && parked !== undefined);
		finishAgents([current]);
		const own = await vi.waitFor(
			() => {
				const saved = intentOf(manager, current.taskId);
				assert.ok(saved !== undefined && acknowledged(manager, saved.completionId));
				return saved;
			},
			{ timeout: 10_000, interval: 20 },
		);
		await (first.session as unknown as AgentSessionInternalSurface)._taskCompletionOutbox?.flush();
		host.retainTaskRecord(current.taskId);
		const forged: TaskCompletionEnvelope = {
			...own,
			completionId: `completion-${current.taskId}-${"0".repeat(32)}`,
		};
		assert.notEqual(forged.completionId, own.completionId);
		await manager.appendCustomEntry("task-completion-intent", forged);

		parkWorkflowStageForRelease(context);
		await first.session.dispose();
		finishAgents([parked]);
		await settled(host, parked.taskId);

		const reopened = await createHarness({
			orchestrationContext: context,
			sessionManager: await SessionManager.open(store, manager.getSessionId()),
		});
		harnesses.push(reopened);
		reopened.setResponses(Array.from({ length: BURST + 1 }, () => fauxAssistantMessage("ok")));
		const reopenedHost = reopened.session.getAgentTaskHost();
		assert.equal(reopenedHost, host);
		await vi.waitFor(() => assert.equal(acknowledged(reopened.sessionManager, forged.completionId), true), {
			timeout: 10_000,
			interval: 20,
		});

		const burst = await startAgents(reopenedHost, 2, BURST);
		finishAgents(burst);
		const oldest = burst[0];
		assert.ok(oldest !== undefined);
		await vi.waitFor(
			() => {
				const found = reopenedHost.resolveTask(oldest.taskId);
				assert.equal(found.ok ? undefined : found.error.code, "TaskEvicted");
			},
			{ timeout: CONVERGENCE_TIMEOUT_MS, interval: 50 },
		);
		assert.equal(reopenedHost.resolveTask(current.taskId).ok, true);

		reopenedHost.releaseTaskRecord(current.taskId);
		finishAgents(await startAgents(reopenedHost, 2 + BURST, 1));
		await vi.waitFor(
			() => {
				const released = reopenedHost.resolveTask(current.taskId);
				assert.equal(released.ok ? undefined : released.error.code, "TaskEvicted");
			},
			{ timeout: CONVERGENCE_TIMEOUT_MS, interval: 50 },
		);
		await context.messageAdmission?.boundary?.close();
	},
	BURST_TEST_TIMEOUT_MS,
);

test(
	"a task that finishes while its stage is parked keeps its record through a burst until its notice is delivered (#4309)",
	async () => {
		const context = stageContext();
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, process.cwd());
		const first = await createHarness({ orchestrationContext: context, sessionManager: manager });
		harnesses.push(first);
		const host = first.session.getAgentTaskHost();
		const [parked, ...burst] = await startAgents(host, 0, BURST + 1);
		assert.ok(parked !== undefined);

		parkWorkflowStageForRelease(context);
		await first.session.dispose();
		finishAgents([parked]);
		await settled(host, parked.taskId);
		finishAgents(burst);
		await settled(host, ...burst.map((agent) => agent.taskId));
		assert.equal(host.resolveTask(parked.taskId).ok, true);

		const reopened = await createHarness({
			orchestrationContext: context,
			sessionManager: await SessionManager.open(store, manager.getSessionId()),
		});
		harnesses.push(reopened);
		assert.equal(reopened.session.getAgentTaskHost(), host);
		const card = await vi.waitFor(
			() => {
				const text = cardOf(reopened.sessionManager, parked.taskId);
				assert.ok(text !== undefined);
				return text;
			},
			{ timeout: CONVERGENCE_TIMEOUT_MS, interval: 50 },
		);
		assert.match(card, new RegExp(`answer of ${parked.taskId}`));
		assert.equal(reopened.getPendingResponseCount(), 0);

		await vi.waitFor(
			() => {
				const found = host.resolveTask(parked.taskId);
				assert.equal(found.ok ? undefined : found.error.code, "TaskEvicted");
			},
			{ timeout: CONVERGENCE_TIMEOUT_MS, interval: 50 },
		);
		await context.messageAdmission?.boundary?.close();
	},
	BURST_TEST_TIMEOUT_MS,
);
