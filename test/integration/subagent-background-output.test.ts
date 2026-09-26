import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	INLINE_TASK_OUTPUT_MAX_BYTES,
	runAgentTask,
	settledTaskOutputText,
	taskToolResultWithOutput,
} from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.js";
import { fileExists, makeTempDirectory, readText, removeTempDirectory } from "../helpers/runtime.js";

const agent: AgentConfig = {
	name: "fake",
	description: "fake",
	source: "project",
	filePath: "fake.md",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

async function launch(input: {
	host: AgentTaskHost;
	cwd: string;
	output: string;
	options: Omit<RunSyncOptions, "runId">;
	promptGate?: Promise<void>;
	wait?: { kind: "foreground" };
}) {
	return runAgentTask({
		host: input.host,
		cwd: input.cwd,
		agents: [agent],
		agent: "fake",
		task: "report",
		options: { cwd: input.cwd, runId: `run-${Math.random().toString(16).slice(2)}`, ...input.options },
		...(input.wait ? { wait: input.wait } : {}),
		runtime: {
			runSync: (...args) =>
				runSync(args[0], args[1], args[2], args[3], {
					...args[4],
					testSession: {
						output: input.output,
						...(input.promptGate ? { promptGate: input.promptGate } : {}),
					},
				}),
		},
	});
}

test("a background run honours output and a settled wait names its path and text (#3294)", async () => {
	const cwd = makeTempDirectory("subagent-background-output-");
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: cwd }, authorizeLaunch() {} });
	const gate = Promise.withResolvers<void>();
	const outputPath = join(cwd, "result.md");
	try {
		const response = await launch({
			host,
			cwd,
			output: "background findings",
			options: { outputPath },
			promptGate: gate.promise,
		});
		assert.equal(response.kind, "admitted");
		assert.equal(response.observation.kind, "yielded");
		gate.resolve();
		const settled = await host.waitForTask(response.observation.taskId as TaskId);
		assert.ok(settled.ok);
		assert.equal(settled.value.kind, "settled");

		assert.equal(await fileExists(outputPath), true);
		assert.equal(await readText(outputPath), "background findings");
		const text = await settledTaskOutputText(host, [{ taskId: settled.value.taskId, result: settled.value.result }]);
		assert.match(text, new RegExp(`Output saved to: ${outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(text, /background findings/);
		assert.doesNotMatch(text, /first \d+ shown/);
	} finally {
		gate.resolve();
		await host.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a foreground settled launch inlines its output, and file-only returns only the reference (#3294)", async () => {
	const cwd = makeTempDirectory("subagent-foreground-output-");
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: cwd }, authorizeLaunch() {} });
	const outputPath = join(cwd, "only.md");
	try {
		const inline = await launch({ host, cwd, output: "inline findings", options: {}, wait: { kind: "foreground" } });
		const inlineText = (await taskToolResultWithOutput(inline, host)).content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
		assert.match(inlineText, /inline findings/);

		const fileOnly = await launch({
			host,
			cwd,
			output: "file-only findings",
			options: { outputPath, outputMode: "file-only" },
			wait: { kind: "foreground" },
		});
		const fileOnlyText = (await taskToolResultWithOutput(fileOnly, host)).content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
		assert.match(fileOnlyText, /Output saved to: .*only\.md/);
		assert.doesNotMatch(fileOnlyText, /file-only findings/);
		assert.equal(await readText(outputPath), "file-only findings");
	} finally {
		await host.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("large settled output is bounded but still leads with the saved path (#3294)", async () => {
	const cwd = makeTempDirectory("subagent-large-output-");
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: cwd }, authorizeLaunch() {} });
	const outputPath = join(cwd, "large.md");
	const large = "x".repeat(INLINE_TASK_OUTPUT_MAX_BYTES * 2);
	try {
		const response = await launch({
			host,
			cwd,
			output: large,
			options: { outputPath },
			wait: { kind: "foreground" },
		});
		assert.equal(response.kind, "admitted");
		assert.equal(response.observation.kind, "settled");
		const text = await settledTaskOutputText(host, [
			{ taskId: response.observation.taskId, result: response.observation.result },
		]);
		assert.match(text, /Output saved to: .*large\.md/);
		assert.match(text, new RegExp(`first ${INLINE_TASK_OUTPUT_MAX_BYTES} shown`));
		assert.ok(text.length < INLINE_TASK_OUTPUT_MAX_BYTES + 1024);
		assert.equal((await readText(outputPath)).length, large.length);
	} finally {
		await host.close("session-close");
		removeTempDirectory(cwd);
	}
});
