import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { type FakeRunnerContext, TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
export function taskValue<T, E>(result: C.Result<T, E>): T {
	assert.equal(result.ok, true);
	return result.value;
}
export function deferredTaskValue<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
export function taskFixture(
	scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() },
	options: { settleOnAbort?: boolean } = {},
) {
	const supervisor = new TaskSupervisor();
	const runners: Array<{ context: FakeRunnerContext; result: ReturnType<typeof deferredTaskValue<C.TaskResult>> }> =
		[];
	const host = supervisor.bindHostSession({
		scope,
		authorizeLaunch() {},
		createRunner(context) {
			const result = deferredTaskValue<C.TaskResult>();
			runners.push({ context, result });
			if (options.settleOnAbort !== false)
				context.signal.addEventListener(
					"abort",
					() => result.resolve({ kind: "cancelled", cause: "owner-close" }),
					{
						once: true,
					},
				);
			return { result: result.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) };
		},
	});
	const owner = taskValue(supervisor.openTaskOwner(host, scope));
	const store = new OwnerTaskStore(supervisor, owner);
	taskValue(store.connect());
	return {
		supervisor,
		owner,
		host,
		store,
		runners,
		async start(task = "Inspect task projection", description?: string, background = true) {
			const lease = taskValue(
				await supervisor.startAgentTask(
					owner,
					{ kind: "agent", agent: "worker", task, ...(description === undefined ? {} : { description }) },
					randomUUID() as C.OperationId,
				),
			);
			if (background) taskValue(await supervisor.initialObservation(lease, { kind: "background" }));
			store.drain();
			return lease;
		},
		async settle(index = 0) {
			const record = store.tasks[index];
			runners[index].result.resolve({ kind: "completed", output: record.output });
			await new Promise<void>((resolve) => setImmediate(resolve));
			store.drain();
		},
		async dispose() {
			for (const runner of runners) runner.result.resolve({ kind: "cancelled", cause: "owner-close" });
			store.dispose();
			taskValue(await supervisor.closeTaskOwner(owner, "session-close"));
		},
	};
}
