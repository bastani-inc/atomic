import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { sleep } from "../helpers/runtime.js";

initTheme();
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

function value<T, E>(result: C.Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? "accepted" : JSON.stringify(result.error));
	return result.value;
}

// A stop whose cleanup the runner reports as failed used to stay "stopping" in the Tasks widget forever.
test("a stopped agent whose runner cannot confirm cleanup settles and leaves the Tasks widget", async () => {
	const failure: C.Cleanup = {
		kind: "failed",
		resources: [{ resource: "fake-runner", code: "CleanupFailed", message: "session still running" }],
	};
	const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const supervisor = new TaskSupervisor();
	const host = supervisor.bindHostSession({
		scope,
		authorizeLaunch() {},
		createRunner({ signal }) {
			// The runner never reports a result, and its stop cannot confirm the session ended.
			const cleanup = new Promise<C.Cleanup>((resolve) =>
				signal.addEventListener("abort", () => resolve(failure), { once: true }),
			);
			return { result: new Promise<C.TaskResult>(() => {}), cleanup };
		},
	});
	const owner = value(supervisor.openTaskOwner(host, scope));
	const store = new OwnerTaskStore(supervisor, owner);
	value(store.connect());
	try {
		const task = value(
			await supervisor.startAgentTask(
				owner,
				{ kind: "agent", agent: "worker", task: "work" },
				randomUUID() as C.OperationId,
			),
		);
		value(await supervisor.initialObservation(task, { kind: "background" }));
		store.drain();
		assert.equal(plain(renderTaskFooter(store.backgroundTasks, 80)), "Tasks  1 local agent running · /tasks");
		assert.equal(value(await supervisor.cancelTask(task, "user")).decision, "cancellation-requested");
		const deadline = Date.now() + 5000;
		while (store.tasks[0]?.execution.kind !== "settled") {
			assert.ok(Date.now() < deadline, `stop never settled: ${plain(renderTaskFooter(store.backgroundTasks, 80))}`);
			await sleep(10);
			store.drain();
		}
		assert.deepEqual(store.tasks[0].execution, { kind: "settled", result: { kind: "cancelled", cause: "user" } });
		assert.deepEqual(store.tasks[0].cleanup, failure);
		assert.deepEqual(renderTaskFooter(store.backgroundTasks, 80), []);
	} finally {
		store.dispose();
		await supervisor.closeTaskOwner(owner, "session-close");
	}
});
