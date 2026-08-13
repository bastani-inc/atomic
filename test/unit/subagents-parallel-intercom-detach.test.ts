import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runForegroundParallelTasks } from "../../packages/subagents/src/runs/foreground/subagent-executor-parallel-task.js";
import type { SingleResult } from "../../packages/subagents/src/shared/types.js";

function agentConfig(): AgentConfig {
	return {
		name: "fake-worker",
		description: "Fake worker",
		source: "project",
		filePath: "fake-worker.md",
		systemPrompt: "Work.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		model: "provider-a/stalled",
		fallbackModels: ["provider-b/working"],
	};
}

function result(index: number): SingleResult {
	return {
		agent: "fake-worker",
		task: `task-${index}`,
		status: "continued",
		path: `child-${index}`,
		envelope: "Child continued in background.",
		detached: true,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

test("one parallel child's supervisor detach releases every active foreground sibling", async () => {
	const started: number[] = [];
	const settled: number[] = [];
	const output = await runForegroundParallelTasks({
		tasks: [
			{ agent: "fake-worker", task: "ask supervisor" },
			{ agent: "fake-worker", task: "remain active" },
			{ agent: "fake-worker", task: "remain queued" },
		],
		taskTexts: ["ask supervisor", "remain active", "remain queued"],
		agents: [agentConfig()],
		ctx: { cwd: process.cwd() } as Parameters<typeof runForegroundParallelTasks>[0]["ctx"],
		intercomEvents: {} as Parameters<typeof runForegroundParallelTasks>[0]["intercomEvents"],
		signal: new AbortController().signal,
		runId: "parallel-detach",
		sessionDirForIndex: () => undefined,
		sessionFileForIndex: () => undefined,
		shareEnabled: false,
		artifactConfig: {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 0,
		},
		artifactsDir: process.cwd(),
		paramsCwd: process.cwd(),
		maxSubagentDepths: [0, 0, 0],
		availableModels: [],
		knownModelProviders: [],
		resolveCandidateModel: () => undefined,
		modelOverrides: [undefined, undefined, undefined],
		behaviors: [
			{ output: false, outputMode: "inline", reads: false, progress: false, skills: false },
			{ output: false, outputMode: "inline", reads: false, progress: false, skills: false },
			{ output: false, outputMode: "inline", reads: false, progress: false, skills: false },
		],
		firstProgressIndex: -1,
		controlConfig: {
			enabled: false,
			needsAttentionAfterMs: 1,
			activeNoticeAfterMs: 1,
			failedToolAttemptsBeforeAttention: 1,
			notifyOn: [],
			notifyChannels: [],
		},
		concurrencyLimit: 2,
		liveResults: [],
		liveProgress: [],
		runtime: {
			async runSync(_cwd, _agents, _agentName, _task, options) {
				const index = options.index ?? -1;
				started.push(index);
				if (index === 0) {
					await Promise.resolve();
					options.onIntercomDetachCommit?.();
				} else {
					await new Promise<void>((resolve) => {
						options.intercomDetachSignal?.addEventListener("abort", () => resolve(), { once: true });
						if (options.intercomDetachSignal?.aborted) resolve();
					});
				}
				settled.push(index);
				return result(index);
			},
		},
	});

	assert.deepEqual(started, [0, 1]);
	assert.deepEqual(settled.toSorted(), [0, 1]);
	assert.equal(output.length, 3);
	assert.ok(output.slice(0, 2).every((entry) => entry.detached));
	assert.equal(output[2]?.status, "skipped");
	assert.match(output[2]?.error ?? "", /Skipped after foreground group detached/);
});
