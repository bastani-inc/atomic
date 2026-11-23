import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { Cleanup, OwnerSnapshot, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { cancelPausedOwnerTasks } from "../../packages/coding-agent/src/core/tasks/pause.js";

test("a pause waits for the quarantined cleanup of a command it stopped, not one that had already settled (#4338)", async () => {
	const quarantined: Cleanup = {
		kind: "quarantined",
		resources: [
			{ resource: "process-group:9", code: "CleanupUnconfirmed", message: "Output reader drain was not confirmed" },
		],
	};
	const record = (taskId: string, cleanup: Cleanup) =>
		({
			ref: { ownerId: "owner", taskId, attemptId: "1", generation: "1" },
			kind: "command",
			execution: { kind: "running" },
			cleanup,
		}) as unknown as TaskRecord;
	const snapshot = { tasks: [record("stopped", { kind: "active" }), record("raced", { kind: "active" })] };
	const subscription = {
		get snapshot() {
			return snapshot;
		},
		onReconcile: (_snapshot: OwnerSnapshot, _events: readonly never[]) => {},
		drain() {},
		dispose() {},
	};
	const settle = (taskId: string, cleanup: Cleanup) => {
		snapshot.tasks = snapshot.tasks.map((task) =>
			task.ref.taskId === taskId
				? ({
						...task,
						execution: { kind: "settled", result: { kind: "completed", exitCode: 0 } },
						cleanup,
					} as unknown as TaskRecord)
				: task,
		);
		subscription.onReconcile(snapshot as unknown as OwnerSnapshot, []);
	};
	const host = {
		watchOwnerTasks: () => ({ ok: true, value: subscription }),
		ownerBinding: { supervisor: { drainCommandAdmissions: async () => {} }, owner: {} },
		cancelTask: async (taskId: string) => {
			// "raced" finished on its own between the snapshot and its cancel, so nothing stopped it.
			if (taskId === "raced") settle("raced", quarantined);
			return {
				ok: true,
				value: {
					taskId,
					decision: taskId === "stopped" ? "cancellation-requested" : "already-settled",
					execution: { kind: "running" },
					cleanup: { kind: "active" },
				},
			};
		},
	} as unknown as AgentTaskHost;
	const idle = subscription.onReconcile;
	let paused = false;
	const pausing = cancelPausedOwnerTasks(host).then(() => {
		paused = true;
	});
	while (subscription.onReconcile === idle) await new Promise<void>((resolve) => setImmediate(resolve));
	settle("stopped", quarantined);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(paused, false, "the pause must wait for the cleanup of the command it stopped");
	settle("stopped", { kind: "reaped" });
	await pausing;
	assert.equal(paused, true, "an earlier quarantine is confirmed by the owner's close, not the pause");
});
