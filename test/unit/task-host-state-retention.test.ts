import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { FINISHED_TASK_RETENTION } from "../../packages/coding-agent/src/core/tasks/eviction-error.js";
import { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type FakeExecution,
	type OwnerLease,
	type TaskSubscription,
	TaskSupervisor,
	taskHostStateSizesForTesting,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.js";
import { sleep } from "../helpers/runtime.js";

/** Several times the retention, so per-task host state that is never pruned cannot pass. */
const FINISHED_TASKS = 2_000;
const CONVERGE_TIMEOUT_MS = 20_000;
/** Thousands of real native tasks with their settlement notices, store reconciles and convergence. */
const HOST_STATE_TEST_TIMEOUT_MS = 60_000;
/** A live owner that ran beside the closed one, so a close that forgot every owner's metadata cannot pass. */
const CONTROL_TASKS = 8;
/** Commands launched by named sessions, each finished before newer tasks evict it. */
const COMMAND_LAUNCHES = 16;
/** Finished agent tasks per owner in the per-map and SDK release counts. */
const PROBE_TASKS = 5;
/** Enough released SDK sessions that what each one left behind would outgrow one owner's retention. */
const RELEASED_SESSIONS = 64;
/** Each released session is a real SDK session: created, running agent tasks, then closed in full. */
const SDK_RELEASE_TEST_TIMEOUT_MS = 120_000;

const LAUNCH_METADATA = {
	requestedModel: "provider/model:low",
	heartbeatMs: 60_000,
} as const;

type LaunchMetadataSizes = { requestedModels: number; launchHeartbeats: number };

function value<T, E>(result: C.Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error));
	if (!result.ok) throw new Error("refused");
	return result.value;
}

function launchMetadataSizes(owner: OwnerLease): LaunchMetadataSizes {
	const { requestedModels, launchHeartbeats } = taskHostStateSizesForTesting(owner);
	return { requestedModels, launchHeartbeats };
}

function launchMetadataOf({ requestedModel, heartbeatMs }: C.TaskRecord) {
	return { requestedModel, heartbeatMs };
}

function finishedExecution(): FakeExecution {
	return {
		result: Promise.resolve<C.TaskResult>({ kind: "failed", code: "Done", message: "done" }),
		cleanup: Promise.resolve<C.Cleanup>({ kind: "reaped" }),
	};
}

function finishingOwner(supervisor: TaskSupervisor): OwnerLease {
	const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const host = supervisor.bindHostSession({ scope, authorizeLaunch() {}, createRunner: finishedExecution });
	return value(supervisor.openTaskOwner(host, scope));
}

/**
 * A task finishes once it settled and its cleanup was reaped, and its owner evicts finished tasks in the order they
 * finished. A command reports its reap just after it settles, so waiting for the settle alone can let a later task
 * finish first and be evicted in its place.
 */
async function waitForReap(records: TaskSubscription, taskId: C.TaskId): Promise<void> {
	const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
	for (;;) {
		records.drain();
		if (records.snapshot.tasks.some((task) => task.ref.taskId === taskId && task.cleanup.kind === "reaped")) return;
		assert.ok(Date.now() < deadline, `${taskId} settled but its cleanup was never reaped`);
		await sleep(5);
	}
}

async function finishAgentTasks(
	supervisor: TaskSupervisor,
	owner: OwnerLease,
	count: number,
	metadata: Partial<typeof LAUNCH_METADATA>,
	options: { prefix: string; retain?: boolean },
): Promise<void> {
	for (let index = 0; index < count; index++) {
		const task = value(
			await supervisor.startAgentTask(
				owner,
				{ kind: "agent", agent: "worker", task: `task ${index}`, ...metadata },
				`${options.prefix}-${index}` as C.OperationId,
			),
		);
		if (options.retain) supervisor.retainTaskRecord(task);
		assert.equal(value(await supervisor.waitForTask(task, CONVERGE_TIMEOUT_MS)).kind, "settled");
	}
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
				requestedModels: FINISHED_TASK_RETENTION,
				launchHeartbeats: FINISHED_TASK_RETENTION,
				executionTimeouts: 0,
				releases: 0,
				launchers: 0,
				launchedAt: 0,
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

test("closing a host reconciles held finished records before its watchers stop, then forgets their launch metadata (#4385, #4451)", async () => {
	const supervisor = new TaskSupervisor();
	const owner = finishingOwner(supervisor);
	const control = finishingOwner(supervisor);
	const store = new OwnerTaskStore(supervisor, owner);
	value(store.connect());
	const lagging = value(supervisor.watchOwnerTasks(owner));
	lagging.drain = () => {};
	try {
		await finishAgentTasks(supervisor, owner, FINISHED_TASK_RETENTION + 32, LAUNCH_METADATA, {
			prefix: "close-operation",
			retain: true,
		});
		await finishAgentTasks(supervisor, control, CONTROL_TASKS, LAUNCH_METADATA, { prefix: "control-operation" });
		assert.equal(taskHostStateSizesForTesting(owner).tasks, FINISHED_TASK_RETENTION + 32);
		value(await supervisor.closeTaskOwner(owner, "session-close"));
		store.drain();
		assert.equal(store.snapshot?.state, "closed");
		assert.equal(store.tasks.length, FINISHED_TASK_RETENTION);
		assert.deepEqual(
			store.tasks.map(launchMetadataOf),
			store.tasks.map(() => LAUNCH_METADATA),
			"the trimmed records every watcher received still carry their launch metadata",
		);
		assert.deepEqual(taskHostStateSizesForTesting(owner), {
			tasks: FINISHED_TASK_RETENTION,
			settledTasks: 0,
			quarantinedTasks: 0,
			unconfirmedCleanups: 0,
			permits: 0,
			commandStarts: 0,
			requestedModels: 0,
			launchHeartbeats: 0,
			executionTimeouts: 0,
			releases: 0,
			launchers: 0,
			launchedAt: 0,
		});
		assert.deepEqual(
			launchMetadataSizes(control),
			{ requestedModels: CONTROL_TASKS, launchHeartbeats: CONTROL_TASKS },
			"a live owner keeps its own launch metadata",
		);
		const watched = value(supervisor.watchOwnerTasks(control));
		watched.dispose();
		assert.deepEqual(
			watched.snapshot.tasks.map(launchMetadataOf),
			watched.snapshot.tasks.map(() => LAUNCH_METADATA),
		);
		assert.equal(watched.snapshot.tasks.length, CONTROL_TASKS);
	} finally {
		store.dispose();
		await supervisor.closeTaskOwner(owner, "session-close");
		await supervisor.closeTaskOwner(control, "session-close");
	}
});

test.each([
	{ map: "requestedModels", metadata: { requestedModel: LAUNCH_METADATA.requestedModel } },
	{ map: "launchHeartbeats", metadata: { heartbeatMs: LAUNCH_METADATA.heartbeatMs } },
] as const)("a closed owner keeps no $map entry of its finished tasks (#4451)", async ({ map, metadata }) => {
	const supervisor = new TaskSupervisor();
	const owner = finishingOwner(supervisor);
	await finishAgentTasks(supervisor, owner, PROBE_TASKS, metadata, { prefix: map });
	const live = launchMetadataSizes(owner);
	value(await supervisor.closeTaskOwner(owner, "session-close"));
	const none = { requestedModels: 0, launchHeartbeats: 0 };
	assert.deepEqual(
		{ live, closed: launchMetadataSizes(owner) },
		{ live: { ...none, [map]: PROBE_TASKS }, closed: none },
		"a launch adds an entry only for the metadata it carries",
	);
});

test(
	"SDK sessions released after running agent tasks leave no launch metadata behind (#4451)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-launch-metadata-"));
		const sessions: AgentSession[] = [];
		const released: OwnerLease[] = [];
		const counts: Array<{ live: LaunchMetadataSizes; released: LaunchMetadataSizes }> = [];
		try {
			for (let index = 0; index < RELEASED_SESSIONS; index++) {
				const { session } = await createAgentSession({
					cwd: root,
					agentDir: root,
					builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
					sessionManager: SessionManager.inMemory(root),
					settingsManager: SettingsManager.inMemory(),
					resourceLoader: createTestResourceLoader(),
				});
				sessions.push(session);
				const host = session.getAgentTaskHost();
				for (let task = 0; task < PROBE_TASKS; task++) {
					const { taskId } = value(
						await host.startAgentTask(
							{ kind: "agent", agent: "worker", task: `task ${task}`, ...LAUNCH_METADATA },
							`operation-${task}` as C.OperationId,
							finishedExecution,
						),
					);
					assert.equal(value(await host.waitForTask(taskId, CONVERGE_TIMEOUT_MS)).kind, "settled");
				}
				const { owner } = host.ownerBinding;
				const live = launchMetadataSizes(owner);
				await session.dispose();
				released.push(owner);
				counts.push({ live, released: launchMetadataSizes(owner) });
			}
			const ran = { requestedModels: PROBE_TASKS, launchHeartbeats: PROBE_TASKS };
			const none = { requestedModels: 0, launchHeartbeats: 0 };
			assert.deepEqual(
				counts,
				counts.map(() => ({ live: ran, released: none })),
			);
			assert.equal(counts.length, RELEASED_SESSIONS);
			assert.deepEqual(
				released.map(launchMetadataSizes),
				released.map(() => none),
				"no later session's tasks leave entries with a released one",
			);
		} finally {
			for (const session of sessions) await session.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	},
	SDK_RELEASE_TEST_TIMEOUT_MS,
);

test("finished commands keep their launching session and launch time only until their owner evicts them (#5342)", async () => {
	const supervisor = new TaskSupervisor();
	const owner = finishingOwner(supervisor);
	const launchRecords = () => {
		const { launchers, launchedAt } = taskHostStateSizesForTesting(owner);
		return { launchers, launchedAt };
	};
	try {
		// Every command finishes before the agent tasks that evict it, so those evict all of them.
		const records = value(supervisor.watchOwnerTasks(owner));
		try {
			for (let index = 0; index < COMMAND_LAUNCHES; index++) {
				const command = value(
					await supervisor.startCommandTask(
						owner,
						{
							kind: "command",
							command: "echo launched",
							terminal: { kind: "pipe" },
							launchedBy: `session-${index}`,
						},
						`command-${index}` as C.OperationId,
					),
				);
				assert.equal(value(await supervisor.waitForTask(command, CONVERGE_TIMEOUT_MS)).kind, "settled");
				await waitForReap(records, supervisor.taskReference(command).taskId);
			}
		} finally {
			// A watcher holds back eviction until it acknowledges each finish: this one stops before the evicting tasks.
			records.dispose();
		}
		const finished = launchRecords();
		await finishAgentTasks(supervisor, owner, FINISHED_TASK_RETENTION, {}, { prefix: "evicting-operation" });
		const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
		while (taskHostStateSizesForTesting(owner).tasks > FINISHED_TASK_RETENTION) {
			assert.ok(Date.now() < deadline, `not converged: ${JSON.stringify(taskHostStateSizesForTesting(owner))}`);
			supervisor.failedTaskCleanups(owner);
			await sleep(5);
		}
		assert.deepEqual(
			{ finished, evicted: launchRecords() },
			{
				finished: { launchers: COMMAND_LAUNCHES, launchedAt: COMMAND_LAUNCHES },
				evicted: { launchers: 0, launchedAt: 0 },
			},
		);
	} finally {
		await supervisor.closeTaskOwner(owner, "session-close");
	}
});

test("a finished command's remembered start keeps nothing of the async context it was launched in", async () => {
	const supervisor = new TaskSupervisor();
	const owner = finishingOwner(supervisor);
	const contexts = new AsyncLocalStorage<object>();
	const launchContexts = trackCollection();
	const intent: C.CommandIntent = { kind: "command", command: "echo launched", terminal: { kind: "pipe" } };
	const operation = "remembered-command" as C.OperationId;
	try {
		// A session that launches a command and ends, as a released session's context does.
		const task = value(
			await (async () => {
				const session = { transcript: Array.from({ length: 1_000 }, (_, index) => `entry ${index}`) };
				launchContexts.track(session);
				return contexts.run(session, () => supervisor.startCommandTask(owner, intent, operation));
			})(),
		);
		assert.equal(value(await supervisor.waitForTask(task, CONVERGE_TIMEOUT_MS)).kind, "settled");
		await collectEverythingTracked(launchContexts);
		assert.deepEqual(launchContexts.uncollected(), [], "the remembered start keeps its launching context");
		// The owner still remembers the start: the same operation gives back the same task.
		assert.equal(value(await supervisor.startCommandTask(owner, intent, operation)), task);
	} finally {
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
