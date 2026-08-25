import assert from "node:assert/strict";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { buildSubagentResultIntercomPayload } from "../../packages/subagents/src/intercom/result-intercom.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.ts";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { formatParallelResultContent } from "../../packages/subagents/src/runs/shared/parallel-utils.ts";
import type { SubagentState } from "../../packages/subagents/src/shared/types.ts";
import { fileExistsSync, makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.ts";

const PROMPT_TRIES = 2_400;
const PROMPT_MS = 5;

async function waitForPrompt(promptLogPath: string): Promise<void> {
	for (let attempt = 0; attempt < PROMPT_TRIES && !fileExistsSync(promptLogPath); attempt++) await sleep(PROMPT_MS);
	assert.equal(fileExistsSync(promptLogPath), true, "child prompt should start before abort");
}

function sampleAgent(): AgentConfig {
	return {
		name: "analysis",
		description: "analysis agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/analysis.md",
	};
}

function cancelledExecutorResult(agentName: string, task: string) {
	return {
		agent: agentName,
		task,
		status: "interrupted" as const,
		interrupted: true,
		cause: "abort",
		envelope: "Run cancelled by parent.\n\nThis is incomplete and has not been validated as a final answer.",
		finalOutput: "Run cancelled by parent.\n\nThis is incomplete and has not been validated as a final answer.",
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

function executorContext(root: string): ExtensionContext {
	return {
		cwd: root,
		mode: "tui",
		hasUI: false,
		ui: {},
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => join(root, "parent-session.jsonl"),
			getSessionId: () => "parent-session",
			getLeafId: () => null,
			getEntries: () => [],
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}
test("parallel parent abort reports each child cancelled instead of failed", async () => {
	const root = makeTempDirectory("atomic-cancel-parallel-");
	const gateA = Promise.withResolvers<void>();
	const gateB = Promise.withResolvers<void>();
	const controller = new AbortController();
	clearSubagentControls();
	try {
		const pending = Promise.all([
			runSingleInProcess(root, sampleAgent(), "inspect fixture a", {
				cwd: root,
				runId: "cancel-parallel-parent",
				index: 0,
				sessionDir: join(root, "sessions", "a"),
				signal: controller.signal,
				testSession: {
					output: "too late a",
					promptGate: gateA.promise,
					abortResolvesPrompt: true,
					promptLogPath: join(root, "prompt-a.log"),
				},
			}),
			runSingleInProcess(root, sampleAgent(), "inspect fixture b", {
				cwd: root,
				runId: "cancel-parallel-parent",
				index: 1,
				sessionDir: join(root, "sessions", "b"),
				signal: controller.signal,
				testSession: {
					output: "too late b",
					promptGate: gateB.promise,
					abortResolvesPrompt: true,
					promptLogPath: join(root, "prompt-b.log"),
				},
			}),
		]);
		await waitForPrompt(join(root, "prompt-a.log"));
		await waitForPrompt(join(root, "prompt-b.log"));
		controller.abort();
		const results = await pending;
		assert.deepEqual(
			results.map((result) => result.status),
			["interrupted", "interrupted"],
		);
		assert.deepEqual(
			results.map((result) => result.cause),
			["abort", "abort"],
		);
		for (const result of results) {
			assert.equal(result.progress?.status, "interrupted");
			assert.match(result.envelope ?? "", /Run cancelled by parent/);
		}
		const payload = buildSubagentResultIntercomPayload({
			to: "orchestrator",
			runId: "cancel-parallel-parent",
			mode: "parallel",
			children: results.map((result, index) => ({
				agent: result.agent,
				status: "interrupted",
				cause: result.cause,
				summary: result.envelope ?? "",
				index,
			})),
		});
		assert.equal(payload.status, "interrupted");
		assert.match(payload.summary, /cancelled/);
		assert.doesNotMatch(payload.summary, /failed/);
		assert.match(payload.message, /^Status: cancelled$/m);
		assert.doesNotMatch(payload.message, /failed/);
	} finally {
		gateA.resolve();
		gateB.resolve();
		clearSubagentControls();
		removeTempDirectory(root);
	}
});
test("formatParallelResultContent labels parent-aborted children cancelled", () => {
	const text = formatParallelResultContent(
		[
			{
				agent: "analysis",
				output: "Run cancelled by parent.\n\nThis is incomplete and has not been validated as a final answer.",
				status: "interrupted",
				cause: "abort",
			},
			{
				agent: "analysis",
				output: "Run cancelled by parent.\n\nThis is incomplete and has not been validated as a final answer.",
				status: "interrupted",
				cause: "abort",
			},
		],
		(index, agent) => `=== Task ${index + 1}: ${agent} ===`,
	);
	assert.match(text, /^0\/2 succeeded/);
	assert.match(text, /CANCELLED/);
	assert.doesNotMatch(text, /FAILED/);
});

test("parallel executor fall-through reports cancelled children instead of interrupt failure", async () => {
	const root = makeTempDirectory("atomic-cancel-parallel-exec-");
	clearSubagentControls();
	try {
		const state: SubagentState = {
			baseCwd: root,
			currentSessionId: "parent-session",
			subagentInProgress: false,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		};
		const execute = createSubagentExecutor({
			pi: {
				events: { on: () => () => {}, emit: () => {} },
				getSessionName: () => "parent",
			} as unknown as ExecutorDeps["pi"],
			state,
			config: { parallel: { concurrency: 4, maxTasks: 50 } },
			tempArtifactsDir: join(root, "artifacts"),
			getSubagentSessionRoot: () => join(root, "sessions"),
			expandTilde: (value) => value,
			discoverAgents: () => ({ agents: [sampleAgent()] }),
			runtime: {
				runSync: async (_cwd, _agents, agentName, task) => cancelledExecutorResult(agentName, task),
			},
		});
		const result = await execute.execute(
			"cancel-parallel-exec",
			{
				tasks: [
					{ agent: "analysis", task: "inspect a" },
					{ agent: "analysis", task: "inspect b" },
				],
				artifacts: false,
			},
			new AbortController().signal,
			undefined,
			executorContext(root),
		);
		const text = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		assert.doesNotMatch(text, /Parallel run ended after interrupt/);
		assert.match(text, /CANCELLED/);
		assert.match(text, /Run cancelled by parent/);
		assert.deepEqual(
			result.details?.results.map((child) => child.status),
			["interrupted", "interrupted"],
		);
		assert.deepEqual(
			result.details?.results.map((child) => child.cause),
			["abort", "abort"],
		);
		assert.notEqual(result.isError, true);
	} finally {
		clearSubagentControls();
		removeTempDirectory(root);
	}
});
