import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import type { AgentSessionInternalSurface } from "../../packages/coding-agent/src/core/agent-session-methods.js";
import { replaceSessionTaskOwner } from "../../packages/coding-agent/src/core/agent-session-tasks.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";

function ownerIdOf(harness: Harness): string {
	const watched = harness.session.getAgentTaskHost().watchOwnerTasks();
	assert.ok(watched.ok);
	const ownerId = watched.value.snapshot.ownerId;
	watched.value.dispose();
	return ownerId;
}

/** Launch parallel background agent tasks, settle them together, and return their task ids. */
async function settleParallelBackgroundTasks(harness: Harness, label: string, count: number): Promise<string[]> {
	const host = harness.session.getAgentTaskHost();
	const gates: PromiseWithResolvers<TaskResult>[] = [];
	const taskIds: string[] = [];
	for (let index = 0; index < count; index++) {
		const gate = Promise.withResolvers<TaskResult>();
		gates.push(gate);
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "worker", task: `${label} ${index}` },
			`${label}-${index}` as OperationId,
			() => ({ result: gate.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) }),
		);
		assert.ok(started.ok);
		taskIds.push(started.value.taskId);
		await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
	}
	for (const gate of gates) gate.resolve({ kind: "failed", code: "fixture", message: `${label} done` });
	await Promise.all(taskIds.map((taskId) => host.waitForTask(taskId as never)));
	return taskIds;
}

function deliveredNotices(harness: Harness, taskId: string): number {
	return harness
		.eventsOfType("message_end")
		.filter(
			(event) =>
				event.message.role === "custom" &&
				event.message.customType === "task-completion" &&
				(event.message.details as { taskId: string }).taskId === taskId,
		).length;
}

async function assertOneNoticeEach(harness: Harness, taskIds: string[]): Promise<void> {
	await vi.waitFor(() => {
		for (const taskId of taskIds) assert.equal(deliveredNotices(harness, taskId), 1, `notice for ${taskId}`);
	});
	// Let any duplicate delivery surface before asserting exactly-once.
	await new Promise((resolve) => setTimeout(resolve, 50));
	for (const taskId of taskIds) assert.equal(deliveredNotices(harness, taskId), 1, `single notice for ${taskId}`);
}

test("parallel background subagents each deliver one completion notice to the parent (#3908)", async () => {
	const harness = await createHarness();
	harness.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("parent saw notice")));
	try {
		const taskIds = await settleParallelBackgroundTasks(harness, "parallel", 3);
		await assertOneNoticeEach(harness, taskIds);
	} finally {
		await harness.cleanup();
	}
});

test("a restarted owner that reuses earlier task numbers still delivers every completion notice (#3908)", async () => {
	const manager = SessionManager.inMemory();
	const harness = await createHarness({ sessionManager: manager });
	harness.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("parent saw notice")));
	try {
		// The next owner in this environment gets the following owner number. A restarted
		// process starts its counters over, so its task ids repeat ones an earlier owner
		// already delivered and acknowledged in this same session history.
		const [, environment, owner] = /^owner-(\d+)-(\d+)$/.exec(ownerIdOf(harness)) ?? [];
		assert.ok(environment && owner);
		const nextOwner = `${environment}-${Number(owner) + 1}`;
		for (let index = 0; index < 3; index++) {
			const taskId = `task-${nextOwner}-${index}`;
			const completionId = `completion-${taskId}`;
			const envelope = {
				completionId,
				ownerId: `owner-${nextOwner}`,
				taskId,
				terminalSequence: index,
				result: { kind: "completed" },
				display: false,
			};
			await manager.appendCustomEntry("task-completion-intent", envelope);
			await manager.appendCustomMessageEntry(
				"task-completion",
				`Subagent worker completed. Task: ${taskId}`,
				true,
				envelope,
				false,
				undefined,
				completionId,
			);
			await manager.appendCustomEntry("task-completion-ack", { completionId });
		}
		replaceSessionTaskOwner(harness.session as unknown as AgentSessionInternalSurface);
		assert.equal(ownerIdOf(harness), `owner-${nextOwner}`);

		const taskIds = await settleParallelBackgroundTasks(harness, "restarted", 3);
		assert.deepEqual(
			taskIds,
			[0, 1, 2].map((index) => `task-${nextOwner}-${index}`),
		);
		await assertOneNoticeEach(harness, taskIds);
	} finally {
		await harness.cleanup();
	}
});
