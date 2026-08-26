import assert from "node:assert/strict";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import {
	buildSubagentResultIntercomPayload,
	formatSubagentResultReceipt,
} from "../../packages/subagents/src/intercom/result-intercom.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.ts";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { recoverCancelledChildOutput } from "../../packages/subagents/src/runs/shared/cancellation-recovery.ts";
import { formatParallelResultContent } from "../../packages/subagents/src/runs/shared/parallel-utils.ts";
import type { SubagentState } from "../../packages/subagents/src/shared/types.ts";
import {
	fileExistsSync,
	makeTempDirectory,
	removeTempDirectory,
	sleep,
	spawnSyncCollect,
	writeTextSync,
} from "../helpers/runtime.ts";

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
test("a mixed interrupt and parent-cancelled parallel set keeps recovered cancelled findings", async () => {
	const root = makeTempDirectory("atomic-cancel-parallel-mixed-");
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
			discoverAgents: () => ({ agents: [sampleAgent(), { ...sampleAgent(), name: "reviewer" }] }),
			runtime: {
				runSync: async (_cwd, _agents, agentName, task) =>
					agentName === "reviewer"
						? {
								agent: agentName,
								task,
								status: "interrupted" as const,
								interrupted: true,
								envelope: "Interrupted",
								finalOutput: "Interrupted",
								messages: [],
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							}
						: cancelledExecutorResult(agentName, task),
			},
		});
		const result = await execute.execute(
			"cancel-parallel-mixed",
			{
				tasks: [
					{ agent: "reviewer", task: "user interrupt first" },
					{ agent: "analysis", task: "cancelled sibling" },
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
		assert.match(text, /This is incomplete/);
		assert.deepEqual(
			result.details?.results.map((child) => child.cause),
			[undefined, "abort"],
		);
	} finally {
		clearSubagentControls();
		removeTempDirectory(root);
	}
});
test("an error whose cause is abort does not hide a sibling user interrupt", async () => {
	const root = makeTempDirectory("atomic-cancel-parallel-error-abort-");
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
			discoverAgents: () => ({ agents: [sampleAgent(), { ...sampleAgent(), name: "reviewer" }] }),
			runtime: {
				runSync: async (_cwd, _agents, agentName, task) =>
					agentName === "reviewer"
						? {
								agent: agentName,
								task,
								status: "interrupted" as const,
								interrupted: true,
								envelope: "Interrupted",
								finalOutput: "Interrupted",
								messages: [],
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							}
						: {
								agent: agentName,
								task,
								status: "error" as const,
								cause: "abort",
								error: "abort",
								envelope: "abort",
								finalOutput: "abort",
								messages: [],
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							},
			},
		});
		const result = await execute.execute(
			"cancel-parallel-error-abort",
			{
				tasks: [
					{ agent: "reviewer", task: "user interrupt first" },
					{ agent: "analysis", task: "error sibling" },
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
		assert.match(text, /Parallel run ended after interrupt/);
	} finally {
		clearSubagentControls();
		removeTempDirectory(root);
	}
});
test("parent receipts label cancelled children instead of failed", () => {
	const payload = buildSubagentResultIntercomPayload({
		to: "orchestrator",
		runId: "cancel-receipt",
		mode: "parallel",
		children: [
			{
				agent: "analysis",
				status: "interrupted",
				cause: "abort",
				summary: "Run cancelled by parent.",
				index: 0,
				artifactPath: join(makeTempDirectory("atomic-cancel-receipt-"), "out.md"),
				sessionPath: join(makeTempDirectory("atomic-cancel-receipt-"), "session.jsonl"),
			},
			{ agent: "worker", status: "completed", summary: "done", artifactPath: "/no/out", sessionPath: "/no/sess" },
		],
	});
	const receipt = formatSubagentResultReceipt({ mode: "parallel", runId: "cancel-receipt", payload });
	assert.match(receipt, /cancelled/);
	assert.doesNotMatch(receipt, /failed/);
	assert.match(receipt, /Artifacts:[\s\S]*worker \[completed\]: \/no\/out[\s\S]*Sessions:/);
	assert.doesNotMatch(receipt, /analysis \[cancelled\]:/);
});
test("a populated shared parallel progress.md is recovered once on the first progress child", async () => {
	const root = makeTempDirectory("atomic-cancel-parallel-progress-");
	const progressPath = join(root, "progress.md");
	writeTextSync(progressPath, "# Progress\n\n- Shared parallel finding\n");
	const gateA = Promise.withResolvers<void>();
	const gateB = Promise.withResolvers<void>();
	const controller = new AbortController();
	clearSubagentControls();
	try {
		const pending = Promise.all([
			runSingleInProcess(root, sampleAgent(), "inspect fixture a", {
				cwd: root,
				runId: "cancel-parallel-progress",
				index: 0,
				sessionDir: join(root, "sessions", "a"),
				signal: controller.signal,
				progressPath,
				testSession: {
					output: "too late a",
					promptGate: gateA.promise,
					abortResolvesPrompt: true,
					promptLogPath: join(root, "prompt-a.log"),
				},
			}),
			runSingleInProcess(root, sampleAgent(), "inspect fixture b", {
				cwd: root,
				runId: "cancel-parallel-progress",
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
		await Promise.all([waitForPrompt(join(root, "prompt-a.log")), waitForPrompt(join(root, "prompt-b.log"))]);
		controller.abort();
		const [first, second] = await pending;
		assert.match(first?.envelope ?? "", /Partial findings from progress\.md/);
		assert.match(first?.envelope ?? "", /Shared parallel finding/);
		assert.doesNotMatch(second?.envelope ?? "", /Partial findings from progress\.md/);
		assert.match(second?.envelope ?? "", /Run cancelled by parent/);
	} finally {
		gateA.resolve();
		gateB.resolve();
		clearSubagentControls();
		removeTempDirectory(root);
	}
});
test("parallel executor attributes shared progress.md only to the first progress-enabled child", async () => {
	const root = makeTempDirectory("atomic-cancel-parallel-progress-path-");
	clearSubagentControls();
	const captured: Array<{ path?: string; task: string }> = [];
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
			discoverAgents: () => ({ agents: [{ ...sampleAgent(), defaultProgress: true }] }),
			runtime: {
				runSync: async (_cwd, _agents, agentName, task, options) => {
					captured.push({ path: options.progressPath, task });
					return cancelledExecutorResult(agentName, task);
				},
			},
		});
		const result = await execute.execute(
			"cancel-parallel-progress-path",
			{
				tasks: [
					{ agent: "analysis", task: "inspect a", progress: true },
					{ agent: "analysis", task: "inspect b", progress: true },
				],
				artifacts: false,
			},
			new AbortController().signal,
			undefined,
			executorContext(root),
		);
		assert.equal(captured[0]?.path, join(root, "progress.md"));
		assert.equal(captured[1]?.path, undefined);
		assert.ok(!result.isError && captured.every((row) => /Update progress at:/.test(row.task)));
	} finally {
		clearSubagentControls();
		removeTempDirectory(root);
	}
});
test("artifacts-disabled parallel cancel cites the surviving shared progress.md", async () => {
	const root = makeTempDirectory("atomic-cancel-parallel-progress-cite-");
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
			discoverAgents: () => ({ agents: [{ ...sampleAgent(), defaultProgress: true }] }),
			runtime: {
				runSync: async (_cwd, _agents, agentName, task) => {
					const progressPath = join(_cwd, "progress.md");
					writeTextSync(progressPath, "# Progress\n\n- Shared parallel finding\n");
					const recovered = recoverCancelledChildOutput({
						progressPath,
						progressArtifactPath: progressPath,
						toolCount: 4,
					});
					return {
						agent: agentName,
						task,
						status: "interrupted" as const,
						interrupted: true,
						cause: "abort",
						envelope: recovered.text,
						finalOutput: recovered.text,
						messages: [],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					};
				},
			},
		});
		const result = await execute.execute(
			"cancel-parallel-progress-cite",
			{
				tasks: [
					{ agent: "analysis", task: "inspect a", progress: true },
					{ agent: "analysis", task: "inspect b", progress: true },
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
		assert.match(text, /Partial findings from progress\.md/);
		assert.match(text, /Shared parallel finding/);
		assert.match(text, /Progress: /);
	} finally {
		clearSubagentControls();
		removeTempDirectory(root);
	}
});
test("parallel cancel cites a precreated progress.md only because the file exists", async () => {
	const root = makeTempDirectory("atomic-cancel-parallel-progress-missing-");
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
			discoverAgents: () => ({ agents: [{ ...sampleAgent(), defaultProgress: true }] }),
			runtime: {
				runSync: async (_cwd, _agents, agentName, task) => {
					const progressPath = join(_cwd, "progress.md");
					const recovered = recoverCancelledChildOutput({
						progressPath,
						progressArtifactPath: progressPath,
					});
					return {
						...cancelledExecutorResult(agentName, task),
						envelope: recovered.text,
						finalOutput: recovered.text,
					};
				},
			},
		});
		const result = await execute.execute(
			"cancel-parallel-progress-missing",
			{
				tasks: [
					{ agent: "analysis", task: "inspect a", progress: true },
					{ agent: "analysis", task: "inspect b", progress: true },
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
		assert.match(text, /Progress: /);
		assert.doesNotMatch(text, /Partial findings from progress\.md/);
	} finally {
		clearSubagentControls();
		removeTempDirectory(root);
	}
});
test("parent cancellation still reports worktree diffs from finished siblings", async () => {
	const root = makeTempDirectory("atomic-cancel-parallel-worktree-");
	clearSubagentControls();
	try {
		const runGit = (args: string[]): void => {
			const result = spawnSyncCollect(["git", ...args], { cwd: root, env: createGitEnvironment() });
			assert.equal(result.exitCode, 0, result.stderr.toString());
		};
		runGit(["init", "--quiet"]);
		runGit(["config", "user.name", "Atomic Fixture"]);
		runGit(["config", "user.email", "fixture@example.invalid"]);
		runGit(["config", "commit.gpgSign", "false"]);
		writeTextSync(join(root, "seed.txt"), "seed\n");
		runGit(["add", "seed.txt"]);
		runGit(["commit", "--quiet", "-m", "initial"]);
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
				runSync: async (_cwd, _agents, agentName, task, options) => {
					writeTextSync(join(options.cwd ?? root, `${agentName}.txt`), `${task}\n`);
					return cancelledExecutorResult(agentName, task);
				},
			},
		});
		const result = await execute.execute(
			"cancel-parallel-worktree",
			{
				tasks: [
					{ agent: "analysis", task: "finished sibling" },
					{ agent: "analysis", task: "cancelled sibling" },
				],
				worktree: true,
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
		assert.match(text, /CANCELLED/);
		assert.match(text, /=== Worktree Changes ===/);
	} finally {
		clearSubagentControls();
		removeTempDirectory(root);
	}
});
