import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as native from "@bastani/atomic-natives";
import { test, vi } from "vitest";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { FINISHED_TASK_RETENTION } from "../../packages/coding-agent/src/core/tasks/eviction-error.js";
import {
	type TaskLease,
	TaskSupervisor,
	taskHostStateSizesForTesting,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { sleep } from "../helpers/runtime.js";

const CONVERGE_TIMEOUT_MS = 10_000;
const agentIntent = { kind: "agent" as const, agent: "worker", task: "work" };
const commandIntent: C.CommandIntent = { kind: "command", command: "echo replayed", terminal: { kind: "pipe" } };
const REPLAYED = "replayed" as C.OperationId;

function value<T, E>(result: C.Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error));
	if (!result.ok) throw new Error("refused");
	return result.value;
}

async function harness(processAdmission?: Promise<void>) {
	const supervisor = new TaskSupervisor();
	const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const defaults: { heartbeatMs?: number } = { heartbeatMs: 60_000 };
	const permits = { process: 0 };
	const host = supervisor.bindHostSession({
		scope,
		authorizeLaunch() {},
		authorizeCommandLaunch() {},
		defaultHeartbeatMs: () => defaults.heartbeatMs,
		resourceAdmission: {
			async acquire(kind) {
				if (kind === "process") {
					permits.process++;
					await processAdmission;
				}
				return async () => {};
			},
		},
		createRunner: () => ({
			result: Promise.resolve({ kind: "failed", code: "Done", message: "done" }),
			cleanup: Promise.resolve({ kind: "reaped" }),
		}),
	});
	const owner = value(supervisor.openTaskOwner(host, scope));
	const idOf = (task: TaskLease) => supervisor.taskReference(task).taskId;
	const settle = async (task: TaskLease) => {
		supervisor.retainTaskRecord(task);
		assert.equal(value(await supervisor.waitForTask(task, CONVERGE_TIMEOUT_MS)).kind, "settled");
		return task;
	};
	const record = (task: TaskLease) => {
		const watch = value(supervisor.watchOwnerTasks(owner));
		watch.dispose();
		return watch.snapshot.tasks.find((item) => item.ref.taskId === idOf(task));
	};
	const evict = async (first: TaskLease) => {
		for (let index = 0; index < FINISHED_TASK_RETENTION; index++)
			await settle(value(await supervisor.startAgentTask(owner, agentIntent, `fill-${index}` as C.OperationId)));
		const watch = value(supervisor.watchOwnerTasks(owner));
		const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
		const finished = () =>
			watch.snapshot.tasks.filter((task) => task.execution.kind === "settled" && task.cleanup.kind === "reaped");
		for (watch.drain(); finished().length <= FINISHED_TASK_RETENTION; watch.drain()) {
			assert.ok(Date.now() < deadline, `not finished: ${finished().length}`);
			await sleep(5);
		}
		watch.dispose();
		supervisor.failedTaskCleanups(owner);
		supervisor.failedTaskCleanups(owner);
		const before = taskHostStateSizesForTesting(owner).tasks;
		supervisor.releaseTaskRecord(first);
		const lookup = supervisor.lookupTask(owner, idOf(first) as C.TaskId);
		assert.equal(lookup.ok ? undefined : lookup.error.code, "TaskEvicted", "the native supervisor evicted it");
		assert.equal(taskHostStateSizesForTesting(owner).tasks, before, "the host has not seen the eviction");
	};
	return { supervisor, owner, defaults, permits, idOf, settle, record, evict };
}

test("a command replayed after its native eviction, before the host saw it, starts one fresh command (#4385)", async () => {
	const h = await harness();
	try {
		const changed: C.CommandIntent = { ...commandIntent, description: "changed" };
		const first = await h.settle(value(await h.supervisor.startCommandTask(h.owner, commandIntent, REPLAYED)));
		assert.equal(value(await h.supervisor.startCommandTask(h.owner, commandIntent, REPLAYED)), first);
		const conflict = await h.supervisor.startCommandTask(h.owner, changed, REPLAYED);
		assert.equal(conflict.ok ? undefined : conflict.error.code, "OperationConflict", "a kept task's intent holds");
		await h.evict(first);
		h.defaults.heartbeatMs = 120_000;
		const [replay, concurrent] = await Promise.all([
			h.supervisor.startCommandTask(h.owner, changed, REPLAYED),
			h.supervisor.startCommandTask(h.owner, changed, REPLAYED),
		]);
		assert.notEqual(h.idOf(value(replay)), h.idOf(first), "the evicted command neither answers nor conflicts");
		assert.equal(value(concurrent), value(replay), "concurrent replays share the fresh command");
		assert.equal(h.permits.process, 2, "one process permit for the first command and one for the fresh one");
		await h.settle(value(replay));
		h.supervisor.failedTaskCleanups(h.owner);
		assert.equal(h.record(value(replay))?.heartbeatMs, 120_000, "the fresh command takes its own cadence");
		assert.equal(taskHostStateSizesForTesting(h.owner).commandStarts, 1);
	} finally {
		await h.supervisor.closeTaskOwner(h.owner, "session-close");
	}
});

test("an agent replayed after its native eviction, before the host saw it, keeps its own cadence (#4385)", async () => {
	const h = await harness();
	try {
		const launch = (heartbeatMs: number) =>
			h.supervisor.startAgentTask(h.owner, { ...agentIntent, heartbeatMs }, REPLAYED);
		const first = await h.settle(value(await launch(60_000)));
		assert.equal(value(await launch(120_000)), first, "a retained task answers its replay");
		assert.equal(h.record(first)?.heartbeatMs, 60_000, "a replay keeps the cadence of the launch that admitted it");
		await h.evict(first);
		const replay = value(await launch(120_000));
		assert.notEqual(h.idOf(replay), h.idOf(first));
		assert.equal(h.record(replay)?.heartbeatMs, 120_000, "the fresh task carries the cadence it asked for");
		h.supervisor.failedTaskCleanups(h.owner);
		assert.equal(taskHostStateSizesForTesting(h.owner).tasks, FINISHED_TASK_RETENTION + 1, "the eviction arrived");
		assert.equal(h.record(replay)?.heartbeatMs, 120_000, "forgetting the evicted task keeps the new cadence");
	} finally {
		await h.supervisor.closeTaskOwner(h.owner, "session-close");
	}
});

test("an agent replayed without a cadence after its native eviction carries none (#4385)", async () => {
	const h = await harness();
	try {
		const first = await h.settle(
			value(await h.supervisor.startAgentTask(h.owner, { ...agentIntent, heartbeatMs: 60_000 }, REPLAYED)),
		);
		await h.evict(first);
		delete h.defaults.heartbeatMs;
		const heartbeatEntries = taskHostStateSizesForTesting(h.owner).launchHeartbeats;
		const replay = value(await h.supervisor.startAgentTask(h.owner, agentIntent, REPLAYED));
		assert.notEqual(h.idOf(replay), h.idOf(first));
		assert.equal(h.record(replay)?.heartbeatMs, undefined, "the evicted task's cadence is not inherited");
		assert.equal(taskHostStateSizesForTesting(h.owner).launchHeartbeats, heartbeatEntries - 1);
		h.supervisor.failedTaskCleanups(h.owner);
		assert.equal(h.record(replay)?.heartbeatMs, undefined);
	} finally {
		await h.supervisor.closeTaskOwner(h.owner, "session-close");
	}
});

test("a command launched under an evicted agent's operation keeps its cache and cadence when the host forgets the agent (#4385)", async () => {
	const h = await harness();
	try {
		const agent = await h.settle(
			value(await h.supervisor.startAgentTask(h.owner, { ...agentIntent, heartbeatMs: 60_000 }, REPLAYED)),
		);
		await h.evict(agent);
		h.defaults.heartbeatMs = 120_000;
		const command = await h.settle(value(await h.supervisor.startCommandTask(h.owner, commandIntent, REPLAYED)));
		h.supervisor.failedTaskCleanups(h.owner);
		assert.equal(h.record(command)?.heartbeatMs, 120_000);
		assert.equal(taskHostStateSizesForTesting(h.owner).commandStarts, 1, "the command's cache stays");
		assert.equal(h.permits.process, 1);
		assert.equal(value(await h.supervisor.startCommandTask(h.owner, commandIntent, REPLAYED)), command);
	} finally {
		await h.supervisor.closeTaskOwner(h.owner, "session-close");
	}
});

test("a conflicting command replay refuses before a pending process admission completes (#4385)", async () => {
	const admission = Promise.withResolvers<void>();
	const h = await harness(admission.promise);
	const first = h.supervisor.startCommandTask(h.owner, commandIntent, REPLAYED);
	try {
		const conflicting = h.supervisor.startCommandTask(
			h.owner,
			{ ...commandIntent, description: "changed" },
			REPLAYED,
		);
		const response = await Promise.race([
			conflicting,
			new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined))),
		]);
		assert.equal(response?.ok ? undefined : response?.error.code, "OperationConflict");
	} finally {
		admission.resolve();
		await first;
		await h.supervisor.closeTaskOwner(h.owner, "session-close");
	}
});

test("a refused command leaves no cached host launch record (#4385)", async () => {
	const h = await harness();
	try {
		const refused = await h.supervisor.startCommandTask(
			h.owner,
			{
				...commandIntent,
				cwd: join(process.cwd(), randomUUID()),
			},
			REPLAYED,
		);
		assert.equal(refused.ok ? undefined : refused.error.code, "SpawnFailed");
		assert.equal(taskHostStateSizesForTesting(h.owner).commandStarts, 0);
	} finally {
		await h.supervisor.closeTaskOwner(h.owner, "session-close");
	}
});

test("an agent launch after owner close returns its typed refusal (#4385)", async () => {
	const h = await harness();
	value(await h.supervisor.closeTaskOwner(h.owner, "session-close"));
	const refused = await h.supervisor.startAgentTask(h.owner, agentIntent, REPLAYED);
	assert.equal(refused.ok ? undefined : refused.error.code, "OwnerClosing");
});

test("a command's admission snapshot carries its cadence before its launch promise resolves (#4385)", async () => {
	const h = await harness();
	const admitted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const original = native.TaskSupervisor.prototype.startCommandTask;
	const door = vi.spyOn(native.TaskSupervisor.prototype, "startCommandTask").mockImplementation(async function (
		this: native.TaskSupervisor,
		...args: Parameters<typeof original>
	) {
		const result = await original.apply(this, args);
		admitted.resolve();
		await release.promise;
		return result;
	});
	const started = h.supervisor.startCommandTask(h.owner, commandIntent, REPLAYED);
	try {
		await admitted.promise;
		const watch = value(h.supervisor.watchOwnerTasks(h.owner));
		try {
			assert.equal(watch.snapshot.tasks[0]?.heartbeatMs, 60_000);
		} finally {
			watch.dispose();
		}
	} finally {
		release.resolve();
		await started;
		door.mockRestore();
		await h.supervisor.closeTaskOwner(h.owner, "session-close");
	}
});
