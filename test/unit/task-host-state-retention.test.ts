import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { FINISHED_TASK_RETENTION } from "../../packages/coding-agent/src/core/tasks/eviction-error.js";
import { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type OwnerLease,
	TaskSupervisor,
	taskHostStateSizesForTesting,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { sleep } from "../helpers/runtime.js";

/** Several times the retention, so per-task host state that is never pruned cannot pass. */
const FINISHED_TASKS = 2_000;
const CONVERGE_TIMEOUT_MS = 20_000;
/** Thousands of real native tasks with their settlement notices, store reconciles and convergence. */
const HOST_STATE_TEST_TIMEOUT_MS = 60_000;

function value<T, E>(result: C.Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error));
	if (!result.ok) throw new Error("refused");
	return result.value;
}

test(
	"the host keeps no per-task state for thousands of tasks its owner evicted (#4385)",
	async () => {
		const supervisor = new TaskSupervisor();
		const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
		const notices = new Set<string>();
		const finishes: Array<() => void> = [];
		const host = supervisor.bindHostSession({
			scope,
			authorizeLaunch() {},
			onTaskSettled: (ref) => notices.add(ref.taskId),
			createRunner(context) {
				context.reportActivity({ reportId: "step", change: { kind: "action", tool: "bash", text: "step" } });
				const result = Promise.withResolvers<C.TaskResult>();
				finishes.push(() => result.resolve({ kind: "failed", code: "Done", message: "done" }));
				return { result: result.promise, cleanup: result.promise.then((): C.Cleanup => ({ kind: "reaped" })) };
			},
		});
		const owner = value(supervisor.openTaskOwner(host, scope));
		const store = new OwnerTaskStore(supervisor, owner);
		value(store.connect());
		const taskIds: C.TaskId[] = [];
		try {
			for (let index = 0; index < FINISHED_TASKS; index++) {
				const task = value(
					await supervisor.startAgentTask(
						owner,
						{
							kind: "agent",
							agent: "worker",
							task: `task ${index}`,
							routerSelection: { model: "provider/model", effort: "low" },
							requestedModel: "provider/model:low",
							heartbeatMs: 60_000,
						},
						`operation-${index}` as C.OperationId,
					),
				);
				taskIds.push(supervisor.taskReference(task).taskId);
				assert.equal(value(await supervisor.initialObservation(task, { kind: "background" })).kind, "yielded");
				finishes.shift()?.();
				assert.equal(value(await supervisor.waitForTask(task, CONVERGE_TIMEOUT_MS)).kind, "settled");
				store.drain();
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
			while (
				store.tasks.length > FINISHED_TASK_RETENTION ||
				taskHostStateSizesForTesting(owner).tasks > FINISHED_TASK_RETENTION
			) {
				assert.ok(Date.now() < deadline, `not converged: ${JSON.stringify(taskHostStateSizesForTesting(owner))}`);
				await sleep(5);
				store.drain();
			}
			assert.equal(notices.size, FINISHED_TASKS, "every task was settled and noticed");
			assert.deepEqual(taskHostStateSizesForTesting(owner), {
				tasks: FINISHED_TASK_RETENTION,
				settledTasks: FINISHED_TASK_RETENTION,
				quarantinedTasks: 0,
				unconfirmedCleanups: 0,
				permits: 0,
				commandStarts: 0,
				routerSelections: FINISHED_TASK_RETENTION,
				requestedModels: FINISHED_TASK_RETENTION,
				launchHeartbeats: FINISHED_TASK_RETENTION,
			});
			const kept = new Set(store.tasks.map((task) => task.ref.taskId));
			const evicted = taskIds.filter((id) => !kept.has(id));
			assert.equal(evicted.length, FINISHED_TASKS - FINISHED_TASK_RETENTION);
			assert.deepEqual(
				{
					records: store.tasks.length,
					settlements: store.settlementOrder.size,
					anchors: store.anchors.size,
					withActivity: taskIds.filter((id) => store.recentActivity(id).length > 0).length,
					// biome-ignore lint/complexity/useLiteralKeys: the store keeps background membership privately
					backgroundIds: store["backgroundIds"].size,
					// biome-ignore lint/complexity/useLiteralKeys: the store keeps its activity cursors privately
					activityCursors: store["activityCursors"].size,
				},
				{
					records: FINISHED_TASK_RETENTION,
					settlements: FINISHED_TASK_RETENTION,
					anchors: FINISHED_TASK_RETENTION,
					withActivity: FINISHED_TASK_RETENTION,
					backgroundIds: FINISHED_TASK_RETENTION,
					activityCursors: FINISHED_TASK_RETENTION,
				},
			);
		} finally {
			store.dispose();
			await supervisor.closeTaskOwner(owner, "session-close");
		}
	},
	HOST_STATE_TEST_TIMEOUT_MS,
);

test("closing a host reconciles held finished records before its watchers stop (#4385)", async () => {
	const supervisor = new TaskSupervisor();
	const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const host = supervisor.bindHostSession({
		scope,
		authorizeLaunch() {},
		createRunner() {
			return {
				result: Promise.resolve<C.TaskResult>({ kind: "failed", code: "Done", message: "done" }),
				cleanup: Promise.resolve<C.Cleanup>({ kind: "reaped" }),
			};
		},
	});
	const owner = value(supervisor.openTaskOwner(host, scope));
	const store = new OwnerTaskStore(supervisor, owner);
	value(store.connect());
	const lagging = value(supervisor.watchOwnerTasks(owner));
	lagging.drain = () => {};
	const baseline = taskHostStateSizesForTesting(owner);
	try {
		for (let index = 0; index < FINISHED_TASK_RETENTION + 32; index++) {
			const task = value(
				await supervisor.startAgentTask(
					owner,
					{
						kind: "agent",
						agent: "worker",
						task: `task ${index}`,
						routerSelection: { model: "provider/model", effort: "low" },
						requestedModel: "provider/model:low",
						heartbeatMs: 60_000,
					},
					`close-operation-${index}` as C.OperationId,
				),
			);
			supervisor.retainTaskRecord(task);
			value(await supervisor.waitForTask(task, CONVERGE_TIMEOUT_MS));
		}
		assert.equal(taskHostStateSizesForTesting(owner).tasks, FINISHED_TASK_RETENTION + 32);
		value(await supervisor.closeTaskOwner(owner, "session-close"));
		store.drain();
		assert.equal(store.snapshot?.state, "closed");
		assert.equal(store.tasks.length, FINISHED_TASK_RETENTION);
		assert.deepEqual(taskHostStateSizesForTesting(owner), {
			tasks: FINISHED_TASK_RETENTION,
			settledTasks: 0,
			quarantinedTasks: 0,
			unconfirmedCleanups: 0,
			permits: 0,
			commandStarts: 0,
			routerSelections: baseline.routerSelections + FINISHED_TASK_RETENTION,
			requestedModels: baseline.requestedModels + FINISHED_TASK_RETENTION,
			launchHeartbeats: baseline.launchHeartbeats + FINISHED_TASK_RETENTION,
		});
	} finally {
		store.dispose();
		await supervisor.closeTaskOwner(owner, "session-close");
	}
});

test("host state sizes are read only for an owner this process opened (#4385)", () => {
	const foreign: OwnerLease = Object.freeze(Object.create(null));
	assert.throws(() => taskHostStateSizesForTesting(foreign), {
		name: "TypeError",
		message: "Foreign owner capability",
	});
});
