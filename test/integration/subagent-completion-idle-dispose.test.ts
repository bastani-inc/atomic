import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../../packages/coding-agent/src/core/agent-session-persistent-custom-messages.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { makeTempDirectory } from "../helpers/runtime.js";

/**
 * Subscribes now and resolves at the session's next `agent_settled`, which follows the end of the whole
 * run, queued continuations included. Settling waits on the run's real persistence, so it is an event to
 * await, not a state a polling deadline can bound; subscribe before the run's last gate opens.
 */
function nextAgentSettled(session: Harness["session"]): Promise<void> {
	const settled = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "agent_settled") settled.resolve();
	});
	return settled.promise.finally(unsubscribe);
}

test("a file-backed session disposes cleanly after background completions settle while idle (#3925)", async () => {
	const root = makeTempDirectory("atomic-idle-completion-dispose-");
	try {
		const manager = await SessionManager.create(root, join(root, "sessions"));
		const harness = await createHarness({ sessionManager: manager });
		// Hold the first parent turn open so later completions arrive while it streams.
		const firstTurn = Promise.withResolvers<void>();
		const firstTurnStreaming = Promise.withResolvers<void>();
		harness.setResponses([
			async () => {
				firstTurnStreaming.resolve();
				await firstTurn.promise;
				return fauxAssistantMessage("parent saw notice");
			},
			...Array.from({ length: 20 }, () => fauxAssistantMessage("parent saw notice")),
		]);
		// Hold the last completion's durable card write until the parent has settled, so its
		// hidden reconciliation is queued after the run's last queue drain and no later
		// completion can start a turn that would drain it by accident.
		const cardWrites = Promise.withResolvers<void>();
		const heldCards = new Set<string>();
		const heldTaskIds = new Set<string>();
		// Each task's card, once its durable write returns. A write takes the session file's lock, and on
		// Windows releasing that lock can take more than a second, so these are awaited rather than polled.
		const cardEvents = new Map<string, { held: PromiseWithResolvers<void>; written: PromiseWithResolvers<void> }>();
		const cardEventsOf = (taskId: string) => {
			let events = cardEvents.get(taskId);
			if (events === undefined) {
				events = { held: Promise.withResolvers<void>(), written: Promise.withResolvers<void>() };
				cardEvents.set(taskId, events);
			}
			return events;
		};
		const appendEntry = manager.appendCustomMessageEntry.bind(manager);
		vi.spyOn(manager, "appendCustomMessageEntry").mockImplementation(async (...args) => {
			const taskId = (args[3] as { taskId?: string } | undefined)?.taskId;
			const card = args[0] === "task-completion" && taskId !== undefined;
			if (card && heldTaskIds.has(taskId)) {
				heldCards.add(taskId);
				cardEventsOf(taskId).held.resolve();
				await cardWrites.promise;
			}
			const entryId = await appendEntry(...args);
			if (card) cardEventsOf(taskId).written.resolve();
			return entryId;
		});
		let disposed = false;
		try {
			const host = harness.session.getAgentTaskHost();
			const gates: PromiseWithResolvers<TaskResult>[] = [];
			const taskIds: string[] = [];
			for (let index = 0; index < 3; index++) {
				const gate = Promise.withResolvers<TaskResult>();
				gates.push(gate);
				const started = await host.startAgentTask(
					{ kind: "agent", agent: "worker", task: `idle ${index}` },
					`idle-${index}` as OperationId,
					() => ({ result: gate.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) }),
				);
				assert.ok(started.ok);
				taskIds.push(started.value.taskId);
				await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
			}
			const failed: TaskResult = { kind: "failed", code: "fixture", message: "idle done" };
			const lastTaskId = taskIds.at(-1)!;
			heldTaskIds.add(lastTaskId);

			// The first completion starts a parent turn, which stays streaming.
			gates[0]!.resolve(failed);
			await firstTurnStreaming.promise;
			assert.equal(harness.session.isStreaming, true);
			// The second arrives while it streams and queues its reconciliation for that run.
			gates[1]!.resolve(failed);
			await cardEventsOf(taskIds[1]!).written.promise;
			assert.ok(
				manager
					.getBranch()
					.some(
						(entry) =>
							entry.type === "custom_message" &&
							(entry.details as { taskId?: string } | undefined)?.taskId === taskIds[1],
					),
			);
			assert.equal(harness.session.isStreaming, true);
			// The last arrives while it still streams; its durable card write stalls.
			gates[2]!.resolve(failed);
			await cardEventsOf(lastTaskId).held.promise;
			assert.ok(heldCards.has(lastTaskId));
			// The parent finishes its turn and its last drain, then goes idle.
			const parentSettled = nextAgentSettled(harness.session);
			firstTurn.resolve();
			await parentSettled;
			assert.equal(harness.session.isStreaming, false);
			// Only now does the card write finish and queue its reconciliation.
			const reconciliationSettled = nextAgentSettled(harness.session);
			cardWrites.resolve();
			await Promise.all(taskIds.map((taskId) => host.waitForTask(taskId as never)));

			const notices = (taskId: string) =>
				harness
					.eventsOfType("message_end")
					.filter(
						(event) =>
							event.message.role === "custom" &&
							event.message.customType === "task-completion" &&
							(event.message.details as { taskId: string }).taskId === taskId,
					).length;
			// Map each task's durable card to the saved hidden turns that reconcile it.
			const reconciliationsPerTask = () => {
				const branch = manager.getBranch();
				return taskIds.map((taskId) => {
					const cards = branch.filter(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "task-completion" &&
							(entry.details as { taskId?: string } | undefined)?.taskId === taskId,
					);
					assert.equal(cards.length, 1, `one durable card for ${taskId}`);
					return branch.filter(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE &&
							(entry.details as { protectedReconciliationOf?: string } | undefined)
								?.protectedReconciliationOf === cards[0]!.id,
					).length;
				});
			};
			const onePerTask = taskIds.map(() => 1);
			// Every completion's hidden reconciliation turn runs while the parent is otherwise idle.
			await reconciliationSettled;
			for (const taskId of taskIds) assert.equal(notices(taskId), 1, `notice for ${taskId}`);
			assert.deepEqual(reconciliationsPerTask(), onePerTask);
			assert.equal(harness.session.isStreaming, false);

			disposed = true;
			await harness.cleanup();
			for (const taskId of taskIds) assert.equal(notices(taskId), 1, `single notice for ${taskId}`);
			assert.deepEqual(reconciliationsPerTask(), onePerTask);
		} finally {
			if (!disposed) await harness.cleanup().catch(() => {});
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
