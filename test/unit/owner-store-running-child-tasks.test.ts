import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test.runIf(process.platform !== "win32")(
	"the owner store says a subagent's shell runs from its launch until it settles, and not for its own shells",
	async () => {
		const fixture = taskFixture();
		try {
			const subagent = await fixture.start("Run the tests");
			const subagentId = fixture.supervisor.taskReference(subagent).taskId;
			const own = taskValue(
				await fixture.supervisor.startCommandTask(
					fixture.owner,
					{ kind: "command", command: "sleep 30", terminal: { kind: "pipe" } },
					randomUUID() as C.OperationId,
				),
			);
			fixture.store.drain();
			assert.equal(fixture.store.hasRunningChildTasks, false, "the session's own shell is not a subagent's");

			const child = taskValue(
				await fixture.supervisor.startCommandTask(
					fixture.owner,
					{ kind: "command", command: "sleep 30", terminal: { kind: "pipe" }, parentTaskId: subagentId },
					randomUUID() as C.OperationId,
				),
			);
			fixture.store.drain();
			assert.equal(fixture.store.hasRunningChildTasks, true);

			await fixture.supervisor.cancelTask(child, "user");
			await until(() => {
				fixture.store.drain();
				return !fixture.store.hasRunningChildTasks;
			});
			await fixture.supervisor.cancelTask(own, "user");
		} finally {
			await fixture.dispose();
		}
	},
);
