import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runAgentTask, taskToolResult } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { createToolPrimitive } from "../../packages/workflows/src/durable/tool-primitive.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { MemoryJournalBackend as InMemoryDurableBackend } from "../helpers/workflow-journal.js";

// RFC PR #2884: observation yield must never complete a durable DAG node.
test("a live admitted task prevents durable node completion and yielded checkpoints", async () => {
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: "durable-task" }, authorizeLaunch() {} });
	const result = Promise.withResolvers<TaskResult>();
	const yielded = Promise.withResolvers<void>();
	let ended = false;
	const tool = createToolPrimitive({
		workflowId: "task-durable",
		backend: new InMemoryDurableBackend(),
		nextCheckpointId: () => "one",
		throwIfCancelled() {},
		onNodeEnd() {
			ended = true;
		},
	});
	const execution = tool("agent", {}, async () => {
		const admitted = await host.startAgentTask(
			{ kind: "agent", agent: "fake", task: " raw " },
			"durable" as OperationId,
			() => ({ result: result.promise, cleanup: result.promise.then(() => ({ kind: "reaped" as const })) }),
		);
		assert.ok(admitted.ok);
		const observed = await host.observeAgentLaunch(admitted.value.taskId);
		assert.ok(observed.ok);
		yielded.resolve();
		return observed.value;
	});
	try {
		await yielded.promise;
		await sleep(1);
		assert.equal(ended, false, "live task cannot complete its DAG node");
		result.resolve({ kind: "failed", code: "fixture", message: "terminal" });
		const terminal = await execution;
		assert.equal(terminal.kind, "settled");
		assert.equal(ended, true);
	} finally {
		result.resolve({ kind: "failed", code: "fixture", message: "terminal" });
		await execution;
		await host.close("session-close");
	}
});

// RFC PR #2884: the model's serialized tool content must settle with its structured DTO.
test("durable real task tool results replace only linked serialized observations", async () => {
	const cwd = makeTempDirectory("task-durable-tool-");
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: cwd }, authorizeLaunch() {} });
	const gate = Promise.withResolvers<void>();
	const launched = Promise.withResolvers<void>();
	const tool = createToolPrimitive({
		workflowId: "task-wire",
		backend: new InMemoryDurableBackend(),
		nextCheckpointId: () => "one",
		throwIfCancelled() {},
	});
	const execution = tool("subagent", {}, async () => {
		const response = await runAgentTask({
			host,
			cwd,
			agents: [
				{
					name: "fake",
					description: "fake",
					source: "project",
					filePath: "fake.md",
					systemPrompt: "Work",
					systemPromptMode: "replace",
					inheritProjectContext: false,
					inheritSkills: false,
				},
			],
			agent: "fake",
			task: " x ",
			options: { cwd, runId: "durable-wire" },
			runtime: {
				runSync: (...args) =>
					runSync(args[0], args[1], args[2], args[3], {
						...args[4],
						testSession: { output: "done", promptGate: gate.promise },
					}),
			},
		});
		const wire = taskToolResult(response);
		launched.resolve();
		return {
			content: wire.content
				.filter((part) => part.type === "text")
				.map((part) => ({ type: part.type, text: part.text })),
			details: { taskResponse: response },
			raw: "  yielded  ",
		};
	});
	try {
		await launched.promise;
		gate.resolve();
		const terminal = await execution;
		assert.doesNotMatch(JSON.stringify(terminal.content), /yielded/);
		assert.equal(terminal.raw, "  yielded  ");
	} finally {
		gate.resolve();
		await execution;
		await host.close("session-close");
		removeTempDirectory(cwd);
	}
});
