import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { ModelSingleResponse, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	INLINE_TASK_OUTPUT_MAX_BYTES,
	runAgentTask,
	settledOutputsFromRecords,
	settledOutputsFromResponse,
	settledTaskOutputText,
	taskToolResultWithOutput,
} from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.js";
import { collectGarbage } from "../helpers/collect-garbage.js";
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
}) {
	return runAgentTask({
		host: input.host,
		cwd: input.cwd,
		agents: [agent],
		agent: "fake",
		task: "report",
		options: { cwd: input.cwd, runId: `run-${Math.random().toString(16).slice(2)}`, ...input.options },
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

/** The launched child's outcome once it settled, as `subagent({ action: "wait", id })` sees it. */
async function settled(host: AgentTaskHost, response: ModelSingleResponse): Promise<ModelSingleResponse> {
	assert.ok(response.kind === "admitted");
	const waited = await host.waitForTask(response.observation.taskId as TaskId);
	assert.ok(waited.ok && waited.value.kind === "settled");
	return { kind: "admitted", observation: waited.value };
}

async function settledText(host: AgentTaskHost, response: ModelSingleResponse): Promise<string> {
	return settledTaskOutputText(host, settledOutputsFromResponse(await settled(host, response)));
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
		});
		const launchText = (await taskToolResultWithOutput(await settled(host, response), host)).content
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

test("the full-output copy holds the exact settled text of a long answer (#3294)", async () => {
	const cwd = makeTempDirectory("subagent-long-output-");
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: cwd }, authorizeLaunch() {} });
	const answer = `Findings:\n${"q".repeat(INLINE_TASK_OUTPUT_MAX_BYTES * 2)}\nsubagent({ agent: "fake" })`;
	try {
		const response = await launch({
			host,
			cwd,
			output: answer,
			options: { artifactsDir: join(cwd, "artifacts") },
		});
		const text = await settledText(host, response);
		assert.match(text, new RegExp(`first ${INLINE_TASK_OUTPUT_MAX_BYTES} shown`));
		assert.ok(text.length < INLINE_TASK_OUTPUT_MAX_BYTES + 1024);
		assert.equal(await readText(fullOutputPath(text)), answer);
	} finally {
		await host.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a retained subagent's answer is readable after another owner finishes 256 tasks (#5703)", async () => {
	const cwd = makeTempDirectory("subagent-output-owners-");
	const first = new AgentTaskHost({ scope: { kind: "session", sessionId: `${cwd}-first` }, authorizeLaunch() {} });
	const other = new AgentTaskHost({ scope: { kind: "session", sessionId: `${cwd}-other` }, authorizeLaunch() {} });
	const answer = "Only the first child wrote 鳥.";
	try {
		const fileOnly = await launch({
			host: first,
			cwd,
			output: "This text belongs only in the file.",
			options: { outputPath: join(cwd, "only.md"), outputMode: "file-only" },
		});
		assert.match(await settledText(first, fileOnly), /Output saved to:/);
		const response = await launch({ host: first, cwd, output: answer, options: {} });
		const initial = await settledText(first, response);
		assert.ok(initial.includes(answer));
		const copy = fullOutputPath(initial);
		for (let index = 0; index < 256; index++) {
			if (index === 255) assert.equal(await settledText(first, response), initial);
			const later = await runAgentTask({
				host: other,
				cwd,
				agents: [agent],
				agent: agent.name,
				task: "report",
				options: { runId: `other-${index}` },
				runtime: {
					runSync: async () => ({
						agent: agent.name,
						task: "report",
						status: "ok",
						finalOutput: "Another owner's answer.",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					}),
				},
			});
			await settled(other, later);
		}
		assert.equal(await fileExists(copy), false, "the process-wide private copy limit still applies");
		await collectGarbage(2);
		const waited = await settledText(first, response);
		assert.match(waited, /Only the first child wrote 鳥\./);
		assert.doesNotMatch(waited, /Another owner's answer|Full output:/);
		assert.ok(response.kind === "admitted");
		const records = first.taskRecords(new Set([response.observation.taskId]));
		assert.equal(await settledTaskOutputText(first, settledOutputsFromRecords(records)), waited);
		const missing = await settledText(first, fileOnly);
		assert.match(missing, /private copy.*recent output cache.*\/tasks task-/);
		assert.doesNotMatch(missing, /This text belongs only in the file|Full output:/);
	} finally {
		await Promise.all([first.close("session-close"), other.close("session-close")]);
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
		});
		const copy = fullOutputPath(await settledText(host, response));
		assert.equal(statSync(copy).mode & 0o777, 0o600);
		assert.equal(statSync(dirname(copy)).mode & 0o777, 0o700);
	} finally {
		await host.close("session-close");
		removeTempDirectory(cwd);
	}
});
