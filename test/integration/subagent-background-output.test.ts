import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	INLINE_TASK_OUTPUT_MAX_BYTES,
	runAgentTask,
	settledOutputsFromResponse,
	settledTaskOutputText,
	taskToolResultWithOutput,
} from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";
import { fileExists, makeTempDirectory, readText, removePathSync, removeTempDirectory } from "../helpers/runtime.js";

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
	outputText?: (child: SingleResult) => string;
}) {
	return runAgentTask({
		host: input.host,
		cwd: input.cwd,
		agents: [agent],
		agent: "fake",
		task: "report",
		options: { cwd: input.cwd, runId: `run-${Math.random().toString(16).slice(2)}`, ...input.options },
		...(input.wait ? { wait: input.wait } : {}),
		...(input.outputText ? { outputText: input.outputText } : {}),
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

function fullOutputPath(text: string): string {
	const match = /^Full output: (.+)$/m.exec(text);
	assert.ok(match, `settled output must name its full-output file: ${text}`);
	return match[1]!;
}

async function settledText(host: AgentTaskHost, response: Awaited<ReturnType<typeof launch>>): Promise<string> {
	return settledTaskOutputText(host, settledOutputsFromResponse(response));
}

test("a background run honours output and a settled wait names a readable full-output file (#3294)", async () => {
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
		assert.match(text, new RegExp(`Requested output: ${outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.doesNotMatch(text, /first \d+ shown/);
		assert.match(await readText(fullOutputPath(text)), /background findings/);
	} finally {
		gate.resolve();
		await host.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("the full-output copy survives removal of the requested output file, as in a cleaned-up worktree (#3294)", async () => {
	const cwd = makeTempDirectory("subagent-worktree-output-");
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: cwd }, authorizeLaunch() {} });
	const worktree = join(cwd, "worktree");
	const outputPath = join(worktree, "only.md");
	try {
		const response = await launch({
			host,
			cwd,
			output: "file-only findings",
			options: { outputPath, outputMode: "file-only" },
			wait: { kind: "foreground" },
		});
		const launchText = (await taskToolResultWithOutput(response, host)).content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
		assert.match(launchText, /Output saved to: .*only\.md/);
		const copy = fullOutputPath(launchText);
		removePathSync(worktree, { recursive: true, force: true });
		assert.equal(await readText(copy), "file-only findings");
	} finally {
		await host.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("the full-output copy holds the exact settled text, including a long parent-ask handoff (#3294)", async () => {
	const cwd = makeTempDirectory("subagent-handoff-output-");
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: cwd }, authorizeLaunch() {} });
	const handoff = `Question:\n${"q".repeat(INLINE_TASK_OUTPUT_MAX_BYTES * 2)}\nsubagent({ agent: "fake" })`;
	try {
		const response = await launch({
			host,
			cwd,
			output: "child output",
			options: { artifactsDir: join(cwd, "artifacts") },
			wait: { kind: "foreground" },
			outputText: () => handoff,
		});
		const text = await settledText(host, response);
		assert.match(text, new RegExp(`first ${INLINE_TASK_OUTPUT_MAX_BYTES} shown`));
		assert.ok(text.length < INLINE_TASK_OUTPUT_MAX_BYTES + 1024);
		assert.equal(await readText(fullOutputPath(text)), handoff);
	} finally {
		await host.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("the full-output copy is private to the current user (#3294)", async () => {
	if (process.platform === "win32") return;
	const cwd = makeTempDirectory("subagent-private-output-");
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: cwd }, authorizeLaunch() {} });
	try {
		const response = await launch({
			host,
			cwd,
			output: "secret findings",
			options: {},
			wait: { kind: "foreground" },
		});
		const copy = fullOutputPath(await settledText(host, response));
		assert.equal(statSync(copy).mode & 0o777, 0o600);
		assert.equal(statSync(dirname(copy)).mode & 0o777, 0o700);
	} finally {
		await host.close("session-close");
		removeTempDirectory(cwd);
	}
});
