import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { Cleanup, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { requestSubagentChildStop } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { AttemptOutcome } from "../../packages/subagents/src/runs/inprocess/runner.js";
import type { SingleResult } from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const worker: AgentConfig = {
	name: "worker",
	description: "Cleanup order fixture",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "project",
	filePath: "worker.md",
};

test("a stopped child's result reaches its task before the host takes the child's cleanup as its end", async () => {
	const cwd = makeTempDirectory("subagent-cleanup-order-");
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: randomUUID() }, authorizeLaunch() {} });
	try {
		const response = await runAgentTask({
			host,
			cwd,
			agents: [worker],
			agent: "worker",
			task: "work",
			options: { runId: "cleanup-order", index: 0 },
			runtime: {
				runSync: async (_cwd, _agents, agent, task, options): Promise<SingleResult> => {
					const cleanup = Promise.withResolvers<Cleanup>();
					options.taskExecution?.onExecution({
						result: new Promise<AttemptOutcome>(() => {}),
						cleanup: cleanup.promise,
					});
					await new Promise((resolve) => options.signal?.addEventListener("abort", resolve, { once: true }));
					cleanup.resolve({ kind: "reaped" });
					await new Promise((resolve) => setTimeout(resolve, 20));
					return {
						agent,
						task,
						status: "interrupted",
						interrupted: true,
						finalOutput: "partial work",
						messages: [],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					};
				},
			},
		});
		assert.ok(response.kind === "admitted");
		const taskId = response.observation.taskId as TaskId;

		requestSubagentChildStop(taskId, "quit");
		const cancelled = await host.cancelTask(taskId, "quit");
		assert.ok(cancelled.ok);
		const settled = await host.waitForTask(taskId);

		assert.ok(settled.ok && settled.value.kind === "settled");
		assert.equal(settled.value.result.kind, "cancelled");
		assert.ok(settled.value.result.output, "the settled task keeps the output its result carried");
	} finally {
		await host.close("session-close");
		removeTempDirectory(cwd);
	}
});
