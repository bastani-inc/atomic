import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as native from "@bastani/atomic-natives";
import { test } from "vitest";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	FINISHED_TASK_RETENTION,
	isTaskEvictedError,
	TaskEvictedError,
} from "../../packages/coding-agent/src/core/tasks/eviction-error.js";
import { OwnerTaskStore, TASK_ACTIVITY_LIMIT } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type FakeRunnerContext,
	type TaskLease,
	TaskSupervisor,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { lookupOwnedTask } from "../../packages/coding-agent/src/core/tools/bash-pty-native.js";
import { TaskToolError } from "../../packages/coding-agent/src/core/tools/shell-task-status.js";
import { sleep } from "../helpers/runtime.js";

/** Thousands of finished tasks, many times the retention, so a missing bound cannot pass. */
const FINISHED_TASKS = 5_000;
const CHECKPOINT_EVERY = 250;
const CONVERGE_TIMEOUT_MS = 10_000;
/** Longer than the supervisor's 25 ms reconcile poll, so its own watcher drains at least once meanwhile. */
const OWNER_POLL_PASS_MS = 50;
const agentIntent = { kind: "agent" as const, agent: "worker", task: "work" };
const failed = { kind: "failed" as const, code: "Done", message: "done" };
/** An agent task whose runner the test reports for and releases. */
const HELD = "held";

type NativeResult<T> = { ok: true; value: T } | { ok: false; error: native.TaskFailure };
function ok<T>(result: NativeResult<T>): T {
	assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error));
	if (!result.ok) throw new Error("refused");
	return result.value;
}
function value<T, E>(result: C.Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error));
	if (!result.ok) throw new Error("refused");
	return result.value;
}
function refusal<T, E>(result: C.Result<T, E>): E {
	assert.equal(result.ok, false, "expected a refusal");
	if (result.ok) throw new Error("accepted");
	return result.error;
}

function nativeOwner() {
	const actor = new native.TaskSupervisor();
	const scope: native.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const owner = ok(actor.openTaskOwner(actor.bindHostSession(scope), scope));
	return { actor, owner };
}
function finishNative(actor: native.TaskSupervisor, owner: native.OwnerLease, operation: string): string {
	const task = ok(actor.startAgentTask(owner, agentIntent, operation));
	const runner = ok(actor.claimTaskRunner(task));
	ok(actor.reportRunnerOutcome(runner, failed));
	ok(actor.acknowledgeTaskCleanup(runner, { kind: "reaped" }));
	return ok(actor.taskReference(task)).taskId;
}
function snapshotOf(actor: native.TaskSupervisor, owner: native.OwnerLease): native.OwnerSnapshot {
	const watch = ok(actor.watchOwnerTasks(owner, () => {}));
	actor.disposeSubscription(watch.lease);
	return watch.snapshot;
}
function lookupCode(actor: native.TaskSupervisor, owner: native.OwnerLease, taskId: string): string | undefined {
	const found = actor.lookupTask(owner, taskId);
	return found.ok ? undefined : found.error.code;
}

test("an owner keeps at most 256 finished task records however many of its tasks finish (#4385)", () => {
	const { actor, owner } = nativeOwner();
	const live = ok(actor.startAgentTask(owner, agentIntent, "live"));
	ok(actor.claimTaskRunner(live));
	const liveId = ok(actor.taskReference(live)).taskId;
	const finished: string[] = [];
	for (let index = 0; index < FINISHED_TASKS; index++) {
		finished.push(finishNative(actor, owner, `finished-${index}`));
		if ((index + 1) % CHECKPOINT_EVERY === 0)
			assert.equal(snapshotOf(actor, owner).tasks.length, Math.min(index + 1, FINISHED_TASK_RETENTION) + 1);
	}
	const tasks = snapshotOf(actor, owner).tasks;
	assert.deepEqual(
		tasks.map((task) => task.ref.taskId),
		[liveId, ...finished.slice(-FINISHED_TASK_RETENTION)],
	);
	assert.equal(tasks[0]?.execution.kind, "running", "the running task is untouched");
	const oldestKept = finished.length - FINISHED_TASK_RETENTION;
	assert.equal(lookupCode(actor, owner, finished[0] as string), "TaskEvicted");
	assert.equal(lookupCode(actor, owner, finished[oldestKept - 1] as string), "TaskEvicted");
	assert.equal(lookupCode(actor, owner, finished[oldestKept] as string), undefined);
	const [prefix] = liveId.split(/-\d+$/u);
	assert.equal(lookupCode(actor, owner, `${prefix}-${FINISHED_TASKS + 1}`), "UnknownTask");
});

test("a watcher draining after every finish receives each eviction once, without a reset (#4385)", () => {
	const { actor, owner } = nativeOwner();
	const watch = ok(actor.watchOwnerTasks(owner, () => {}));
	const total = FINISHED_TASK_RETENTION * 4;
	const finished: string[] = [];
	const evicted: string[] = [];
	for (let index = 0; index < total; index++) {
		finished.push(finishNative(actor, owner, `finished-${index}`));
		const drained = ok(actor.drainOwnerTasks(watch.lease));
		assert.equal(drained.reset, false);
		for (const event of drained.events)
			if (event.payload.kind === "task-evicted") evicted.push(event.payload.ref.taskId);
		if ((index + 1) % CHECKPOINT_EVERY === 0)
			assert.equal(snapshotOf(actor, owner).tasks.length, Math.min(index + 1, FINISHED_TASK_RETENTION));
	}
	for (const event of ok(actor.drainOwnerTasks(watch.lease)).events)
		if (event.payload.kind === "task-evicted") evicted.push(event.payload.ref.taskId);
	assert.deepEqual(evicted, finished.slice(0, total - FINISHED_TASK_RETENTION));
	actor.disposeSubscription(watch.lease);
});

type Harness = Awaited<ReturnType<typeof harness>>;
async function harness(options: { dispatch: boolean }) {
	const supervisor = new TaskSupervisor();
	const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const notices: string[] = [];
	const held: Array<{ context: FakeRunnerContext; release: () => void }> = [];
	const host = supervisor.bindHostSession({
		scope,
		authorizeLaunch() {},
		onTaskSettled(ref) {
			notices.push(ref.taskId);
		},
		createRunner: (context, intent) => {
			if (intent.task !== HELD)
				return { result: Promise.resolve(failed), cleanup: Promise.resolve({ kind: "reaped" }) };
			const result = Promise.withResolvers<C.TaskResult>();
			const cleanup = Promise.withResolvers<C.Cleanup>();
			const release = () => {
				result.resolve(failed);
				cleanup.resolve({ kind: "reaped" });
			};
			context.signal.addEventListener("abort", release, { once: true });
			held.push({ context, release });
			return { result: result.promise, cleanup: cleanup.promise };
		},
	});
	const owner = value(supervisor.openTaskOwner(host, scope));
	const store = new OwnerTaskStore(supervisor, owner);
	value(store.connect());
	const queue = options.dispatch ? undefined : () => {};
	const start = async (operation: string, heartbeatMs?: number, task = agentIntent.task) =>
		value(
			await supervisor.startAgentTask(
				owner,
				{ ...agentIntent, task, ...(heartbeatMs === undefined ? {} : { heartbeatMs }) },
				operation as C.OperationId,
				queue,
			),
		);
	const finish = async (operation: string, heartbeatMs?: number) => {
		const task = await start(operation, heartbeatMs);
		const outcome = value(await supervisor.waitForTask(task, CONVERGE_TIMEOUT_MS));
		assert.equal(outcome.kind, "settled");
		await new Promise<void>((resolve) => setImmediate(resolve));
		return task;
	};
	/** Every watcher of the owner drains on its own poll; the bound holds once each has caught up. */
	const converge = async (expected: () => boolean) => {
		const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
		while (!expected()) {
			assert.ok(Date.now() < deadline, `not converged: ${store.tasks.length} tasks, ${notices.length} notices`);
			await sleep(5);
			store.drain();
		}
	};
	const close = async () => {
		store.dispose();
		await supervisor.closeTaskOwner(owner, "session-close");
	};
	return { supervisor, owner, store, notices, held, start, finish, converge, close };
}
const idOf = (h: Harness, task: TaskLease) => h.supervisor.taskReference(task).taskId;

test("a burst of finishes beyond the retention still delivers every completion before eviction (#4385)", async () => {
	const h = await harness({ dispatch: false });
	try {
		const total = FINISHED_TASK_RETENTION * 3;
		const tasks: TaskLease[] = [];
		for (let index = 0; index < total; index++) tasks.push(await h.start(`queued-${index}`));
		for (const task of tasks) value(await h.supervisor.cancelTask(task, "user"));
		await h.converge(() => h.notices.length === total && h.store.tasks.length === FINISHED_TASK_RETENTION);
		assert.deepEqual(new Set(h.notices), new Set(tasks.map((task) => idOf(h, task))), "one notice per task");
		assert.equal(h.notices.length, total);
		const kept = tasks.slice(-FINISHED_TASK_RETENTION).map((task) => idOf(h, task));
		assert.deepEqual(
			h.store.tasks.map((task) => task.ref.taskId),
			kept,
		);
		assert.equal(h.store.settlementOrder.size, FINISHED_TASK_RETENTION);
		assert.equal(h.store.anchors.size, FINISHED_TASK_RETENTION);
		const evicted = idOf(h, tasks[0] as TaskLease);
		const expected = new TaskEvictedError({ taskId: evicted }).message;
		assert.deepEqual(refusal(h.supervisor.lookupTask(h.owner, evicted as C.TaskId)), {
			code: "TaskEvicted",
			message: expected,
		});
		assert.deepEqual(refusal(await h.supervisor.cancelTask(tasks[0] as TaskLease, "user")), {
			code: "TaskEvicted",
			message: expected,
		});
		assert.equal(refusal(await h.supervisor.waitForTask(tasks[1] as TaskLease, 0)).code, "TaskEvicted");
		assert.equal(refusal(await h.supervisor.foregroundTask(tasks[2] as TaskLease, 0)).code, "TaskEvicted");
		assert.equal(refusal(h.supervisor.taskStdin(tasks[3] as TaskLease)).code, "TaskEvicted");
		assert.equal(refusal(await h.supervisor.waitForTaskId(h.owner, evicted as C.TaskId, 0)).code, "TaskEvicted");
		assert.equal(
			value(h.supervisor.lookupTask(h.owner, kept[0] as C.TaskId)),
			tasks[total - FINISHED_TASK_RETENTION],
		);
		assert.deepEqual(value(await h.supervisor.waitForTaskId(h.owner, kept[0] as C.TaskId, 0)), {
			kind: "settled",
			taskId: kept[0],
			result: { kind: "cancelled", cause: "user" },
		});
		assert.deepEqual(refusal(h.supervisor.lookupTask(h.owner, `${evicted}0` as C.TaskId)), {
			code: "UnknownTask",
			message: "UnknownTask",
		});
		const view = ownerTaskViewSource(h.store);
		assert.deepEqual(refusal(await view.readTaskOutput(evicted as C.TaskId, { start: "0", maximumBytes: 16 })), {
			message: expected,
		});
		assert.throws(
			() => lookupOwnedTask({ supervisor: h.supervisor, owner: h.owner }, evicted),
			(error: unknown) =>
				error instanceof TaskToolError &&
				error.code === "TaskEvicted" &&
				isTaskEvictedError(error.cause) &&
				error.cause.taskId === evicted,
		);
	} finally {
		await h.close();
	}
});

test("/tasks drops an evicted row as its eviction arrives and keeps the newest finished tasks (#4385)", async () => {
	const h = await harness({ dispatch: true });
	try {
		for (let index = 0; index < FINISHED_TASK_RETENTION; index++) await h.finish(`fill-${index}`);
		await h.converge(() => h.store.tasks.length === FINISHED_TASK_RETENTION);
		h.store.drain();
		const oldest = h.store.tasks[0]?.ref.taskId;
		const newest = idOf(h, await h.finish("one-more"));
		await h.converge(() => !h.store.tasks.some((task) => task.ref.taskId === oldest));
		assert.equal(h.store.tasks.length, FINISHED_TASK_RETENTION);
		assert.equal(h.store.tasks.at(-1)?.ref.taskId, newest);
		assert.ok(!h.store.tasks.some((task) => task.ref.taskId === oldest), "the evicted row is gone");
		assert.ok(!h.store.settlementOrder.has(oldest as C.TaskId));
		assert.ok(!h.store.anchors.has(oldest as C.TaskId));
	} finally {
		await h.close();
	}
});

test("an operation replayed after its task was evicted starts a fresh task with its own launch settings (#4385)", async () => {
	const h = await harness({ dispatch: true });
	try {
		const first = await h.finish("replayed", 60_000);
		assert.equal(await h.start("replayed", 120_000), first, "a retained task answers its replay");
		for (let index = 0; index < FINISHED_TASK_RETENTION; index++) await h.finish(`fill-${index}`);
		await h.converge(() => !h.store.tasks.some((task) => task.ref.taskId === idOf(h, first)));
		assert.equal(refusal(h.supervisor.lookupTask(h.owner, idOf(h, first) as C.TaskId)).code, "TaskEvicted");
		await sleep(OWNER_POLL_PASS_MS);
		const replay = await h.start("replayed", 120_000);
		assert.notEqual(idOf(h, replay), idOf(h, first));
		await h.converge(() => h.store.tasks.some((task) => task.ref.taskId === idOf(h, replay)));
		assert.equal(h.store.tasks.find((task) => task.ref.taskId === idOf(h, replay))?.heartbeatMs, 120_000);
	} finally {
		await h.close();
	}
});

test("/tasks keeps a kept task's activity across updates and forgets an evicted task's (#4385)", async () => {
	const h = await harness({ dispatch: true });
	try {
		const id = idOf(h, await h.start("busy", undefined, HELD));
		await h.converge(() => h.held.length === 1);
		const runner = h.held[0] as (typeof h.held)[number];
		const reportsPerDrain = 10;
		for (let drain = 0; drain * reportsPerDrain <= TASK_ACTIVITY_LIMIT; drain++) {
			for (let index = 0; index < reportsPerDrain; index++)
				value(
					runner.context.reportActivity({
						reportId: `${drain}-${index}`,
						change: { kind: "action", tool: "bash", text: `step ${drain}.${index}` },
					}),
				);
			h.store.drain();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		const kept = h.store.recentActivity(id as C.TaskId);
		assert.ok(kept.length > 0);
		assert.equal(h.store.activityOmitted(id as C.TaskId), true, "more reports than the preview keeps");
		runner.release();
		await h.finish("later");
		await h.converge(() => h.store.tasks.some((task) => task.ref.taskId === id && task.cleanup.kind === "reaped"));
		assert.deepEqual(h.store.recentActivity(id as C.TaskId), kept, "a kept task keeps its activity");
		for (let index = 0; index < FINISHED_TASK_RETENTION; index++) await h.finish(`fill-${index}`);
		await h.converge(() => !h.store.tasks.some((task) => task.ref.taskId === id));
		assert.deepEqual(h.store.recentActivity(id as C.TaskId), []);
		assert.equal(h.store.activityOmitted(id as C.TaskId), false);
	} finally {
		await h.close();
	}
});

test.runIf(process.platform !== "win32")(
	"a shell task's output opens from /tasks while it is kept, and its eviction is reported instead (#4385)",
	async () => {
		const h = await harness({ dispatch: true });
		try {
			const intent: C.CommandIntent = { kind: "command", command: "cat", terminal: { kind: "pipe" } };
			const command = value(await h.supervisor.startCommandTask(h.owner, intent, "shell" as C.OperationId));
			const stdin = value(h.supervisor.taskStdin(command));
			const write = (operation: string, data: C.InputData) =>
				h.supervisor.writeTaskInput(stdin, operation as C.OperationId, data);
			value(await write("kept", { kind: "bytes", bytes: Buffer.from("kept") }));
			value(await write("eof", { kind: "eof" }));
			assert.equal(value(await h.supervisor.waitForTask(command, CONVERGE_TIMEOUT_MS)).kind, "settled");
			const id = idOf(h, command) as C.TaskId;
			const view = ownerTaskViewSource(h.store);
			await h.converge(() => h.store.tasks.some((task) => task.ref.taskId === id && task.cleanup.kind === "reaped"));
			assert.equal(value(await view.readTaskOutput(id, { start: "0", maximumBytes: 16 })).text, "kept");
			for (let index = 0; index < FINISHED_TASK_RETENTION; index++) await h.finish(`fill-${index}`);
			await h.converge(() => !h.store.tasks.some((task) => task.ref.taskId === id));
			const expected = new TaskEvictedError({ taskId: id }).message;
			assert.deepEqual(refusal(await view.readTaskOutput(id, { start: "0", maximumBytes: 16 })), {
				message: expected,
			});
			assert.deepEqual(refusal(await h.supervisor.readTaskOutput(command, { start: "0", maximumBytes: 16 })), {
				code: "TaskEvicted",
				message: expected,
			});
			assert.deepEqual(refusal(await write("late", { kind: "bytes", bytes: Buffer.from("x") })), {
				code: "TaskEvicted",
				message: expected,
			});
			await sleep(OWNER_POLL_PASS_MS);
			const replay = value(await h.supervisor.startCommandTask(h.owner, intent, "shell" as C.OperationId));
			assert.notEqual(idOf(h, replay), id, "the evicted command's operation starts a fresh command");
		} finally {
			await h.close();
		}
	},
);
