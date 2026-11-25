import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentTaskHost } from "../src/core/tasks/agent-adapter.js";
import type { TaskId } from "../src/core/tasks/contracts.js";
import { createBashToolDefinition } from "../src/core/tools/bash.js";

const LIMIT = 64;
const REFUSAL =
	"64 commands are already running in this session, the most it runs at once. Stop one you no longer need with kill or /tasks, or wait for one to finish, then run this command again.";

test.runIf(process.platform !== "win32")(
	"a session runs at most 64 commands at once, refuses the next, and takes one again once a command stops",
	async () => {
		const owner = new AgentTaskHost({
			scope: { kind: "session", sessionId: crypto.randomUUID() },
			tasks: { wait: { kind: "automatic", commandBudgetMs: 0 } },
			authorizeLaunch() {},
		});
		const tool = createBashToolDefinition(process.cwd(), { taskOwner: owner.ownerBinding });
		const launch = () =>
			tool.execute("launch", { command: "read value", wait: { kind: "background" } }).then(
				(result) => ({ taskId: result.details?.observation?.taskId as TaskId | undefined }),
				(error: Error) => ({ refused: error.message }),
			);
		try {
			// Launched together: a launch still starting holds its place as one already running does.
			const launches = await Promise.all(Array.from({ length: LIMIT + 2 }, launch));
			const started = launches.flatMap((outcome) => ("taskId" in outcome && outcome.taskId ? [outcome.taskId] : []));
			const refused = launches.flatMap((outcome) => ("refused" in outcome ? [outcome.refused] : []));
			assert.equal(started.length, LIMIT);
			assert.deepEqual(refused, [REFUSAL, REFUSAL]);

			const task = owner.resolveTask(started[0]);
			assert.ok(task.ok);
			assert.ok((await owner.ownerBinding.supervisor.cancelTask(task.value, "user")).ok);
			const next = await launch();
			assert.ok("taskId" in next && next.taskId, JSON.stringify(next));
			assert.deepEqual(await launch(), { refused: REFUSAL });
		} finally {
			await owner.close("session-close");
		}
	},
);
