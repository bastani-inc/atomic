import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { RELEASED_SIBLING_RESUME_MESSAGE } from "../../packages/subagents/src/runs/foreground/parent-ask-output.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import {
	PARENT_ASK_PAUSE_REQUEST_EVENT,
	type ParentAskPauseRequest,
} from "../../packages/subagents/src/shared/types.js";
import { sleep, spawnSyncCollect } from "../helpers/runtime.js";

class TestEvents {
	private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
	readonly parentAskListenerReady = Promise.withResolvers<void>();
	parentAskRegistrations = 0;

	on(channel: string, handler: (payload: unknown) => void): () => void {
		let listeners = this.handlers.get(channel);
		if (!listeners) {
			listeners = new Set();
			this.handlers.set(channel, listeners);
		}
		listeners.add(handler);
		if (channel === PARENT_ASK_PAUSE_REQUEST_EVENT) {
			this.parentAskRegistrations += 1;
			this.parentAskListenerReady.resolve();
		}
		return () => listeners?.delete(handler);
	}

	emit(channel: string, payload: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(payload);
	}
}

function worker(): AgentConfig {
	return {
		name: "worker",
		description: "parent ask integration worker",
		systemPrompt: "Use parent coordination when instructed.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: "/tmp/parent-ask-worker.md",
	};
}

function state(): ExecutorDeps["state"] {
	return {
		baseCwd: "",
		currentSessionId: "parent",
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
}

function context(root: string): ExtensionContext {
	return {
		cwd: root,
		mode: "tui",
		hasUI: false,
		model: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => join(root, "parent.jsonl"),
			getSessionId: () => "parent-session-id",
			getLeafId: () => null,
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as never as ExtensionContext;
}

function text(result: Awaited<ReturnType<ReturnType<typeof createSubagentExecutor>["execute"]>>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function git(root: string, args: string[]): string {
	const result = spawnSyncCollect(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout.toString().trim();
}

test("SINGLE parent ask pauses, resumes with the answer, and cannot resume after completion", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-single-parent-ask-"));
	const events = new TestEvents();
	const childState = state();
	const initialGate = Promise.withResolvers<void>();
	const secondGate = Promise.withResolvers<void>();
	let options: Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4] | undefined;
	let runCalls = 0;
	const tasks: string[] = [];
	const runtime: SubagentExecutorRuntimeDeps = {
		runSync: async (cwd, agents, agentName, task, runOptions) => {
			runCalls += 1;
			tasks.push(task);
			options = runOptions;
			return runSync(cwd, agents, agentName, task, {
				...runOptions,
				testSession:
					runCalls === 1
						? {
								output: "must not complete",
								promptGate: initialGate.promise,
								abortResolvesPrompt: true,
							}
						: runCalls === 2
							? {
									output: "must pause again",
									promptGate: secondGate.promise,
									abortResolvesPrompt: true,
								}
							: { output: `used answer: ${task}` },
			});
		},
	};
	const executor = createSubagentExecutor({
		pi: { events, getSessionName: () => "parent-session" } as never,
		state: childState,
		config: { parallel: { concurrency: 2, maxTasks: 10 } },
		tempArtifactsDir: join(root, "artifacts"),
		getSubagentSessionRoot: () => join(root, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [worker()] }),
		runtime,
	});
	clearSubagentControls();
	try {
		const execution = executor.execute(
			"single-parent-ask",
			{ agent: "worker", task: "Ask the parent", artifacts: false },
			new AbortController().signal,
			undefined,
			context(root),
		);
		await events.parentAskListenerReady.promise;
		for (let attempt = 0; attempt < 100 && !options; attempt++) await sleep(1);
		assert.ok(options?.intercomSessionName);
		assert.ok(options.orchestratorIntercomTarget);
		const request: ParentAskPauseRequest = {
			runId: options.runId,
			index: options.index ?? 0,
			agent: "worker",
			childIntercomTarget: options.intercomSessionName,
			orchestratorTarget: options.orchestratorIntercomTarget,
			kind: "decision",
			question: "Keep  this question\nverbatim",
			attachments: [
				{ type: "snippet", name: "choice.ts", content: "const  choice = 42;", language: "ts" },
				{ type: "context", name: "choice.ts", content: "second\nattachment" },
			],
			claimed: false,
		};
		events.emit(PARENT_ASK_PAUSE_REQUEST_EVENT, request);
		const paused = await execution;

		assert.equal(request.claimed, true);
		assert.equal(paused.details.parentAskPaused, true);
		assert.match(text(paused), /Subagent paused for parent input/);
		assert.match(text(paused), /Keep {2}this question\nverbatim/);
		assert.match(text(paused), /subagent\(\{ action: "resume", id:/);
		assert.match(text(paused), /📎 choice\.ts\n~~~ts\nconst {2}choice = 42;\n~~~/);
		assert.match(text(paused), /📎 choice\.ts\nsecond\nattachment/);
		assert.equal(paused.details.results[0]?.status, "interrupted");
		assert.notEqual(paused.details.results[0]?.finalOutput, "must not complete");
		const retained = childState.foregroundRuns?.get(options.runId);
		assert.equal(retained?.children[0]?.status, "paused");
		assert.equal(retained?.parentAsk?.request.question, "Keep  this question\nverbatim");
		assert.equal(retained?.parentAsk?.request.attachments, request.attachments);
		assert.equal(retained?.children[0]?.sessionFile, paused.details.results[0]?.sessionFile);

		initialGate.resolve();
		const resumedForSecondAsk = executor.execute(
			"single-parent-resume",
			{ action: "resume", id: request.runId, message: "answer 42", artifacts: false },
			new AbortController().signal,
			undefined,
			context(root),
		);
		for (let attempt = 0; attempt < 200 && events.parentAskRegistrations < 2; attempt++) await sleep(1);
		assert.equal(events.parentAskRegistrations, 2);
		assert.ok(options?.intercomSessionName);
		assert.ok(options.orchestratorIntercomTarget);
		const secondRequest: ParentAskPauseRequest = {
			runId: request.runId,
			index: 0,
			agent: "worker",
			childIntercomTarget: options.intercomSessionName,
			orchestratorTarget: options.orchestratorIntercomTarget,
			kind: "decision",
			question: "One more choice?",
			claimed: false,
		};
		events.emit(PARENT_ASK_PAUSE_REQUEST_EVENT, secondRequest);
		const pausedAgain = await resumedForSecondAsk;
		assert.equal(secondRequest.claimed, true);
		assert.match(text(pausedAgain), /One more choice\?/);
		assert.deepEqual(tasks, ["Ask the parent", "answer 42"]);
		assert.equal(retained?.children[0]?.status, "paused");
		assert.equal(retained?.parentAsk?.request.question, "One more choice?");

		secondGate.resolve();
		const completed = await executor.execute(
			"single-parent-resume-final",
			{ action: "resume", id: request.runId, message: "final answer", artifacts: false },
			new AbortController().signal,
			undefined,
			context(root),
		);
		assert.equal(completed.isError, undefined, text(completed));
		assert.deepEqual(tasks, ["Ask the parent", "answer 42", "final answer"]);
		assert.equal(runCalls, 3);
		assert.equal(retained?.children[0]?.status, "completed");
		assert.equal(retained?.parentAsk, undefined);

		const completedResume = await executor.execute(
			"single-parent-resume-again",
			{ action: "resume", id: request.runId, message: "again" },
			new AbortController().signal,
			undefined,
			context(root),
		);
		assert.equal(completedResume.isError, true);
		assert.match(text(completedResume), /completed.*not resumable/i);
		assert.equal(runCalls, 3);
	} finally {
		initialGate.resolve();
		secondGate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("PARALLEL parent ask releases active siblings, withholds the queue, and resumes only the released set", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-parallel-parent-ask-"));
	const events = new TestEvents();
	const childState = state();
	const initialGate = Promise.withResolvers<void>();
	const initialOptions = new Map<number, Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4]>();
	const allOptions = new Map<number, Array<Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4]>>();
	const calls: Array<{ index: number; task: string }> = [];
	const runtime: SubagentExecutorRuntimeDeps = {
		runSync: async (cwd, agents, agentName, task, runOptions) => {
			const index = runOptions.index ?? -1;
			calls.push({ index, task });
			const optionsForIndex = allOptions.get(index) ?? [];
			optionsForIndex.push(runOptions);
			allOptions.set(index, optionsForIndex);
			if (!initialOptions.has(index)) initialOptions.set(index, runOptions);
			return runSync(cwd, agents, agentName, task, {
				...runOptions,
				testSession:
					calls.length <= 2
						? {
								output: `must not complete ${index}`,
								promptGate: initialGate.promise,
								abortResolvesPrompt: true,
							}
						: { output: `resumed ${index}` },
			});
		},
	};
	const executor = createSubagentExecutor({
		pi: { events, getSessionName: () => "parent-session" } as never,
		state: childState,
		config: { parallel: { concurrency: 2, maxTasks: 10 } },
		tempArtifactsDir: join(root, "artifacts"),
		getSubagentSessionRoot: () => join(root, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [worker()] }),
		runtime,
	});
	clearSubagentControls();
	try {
		mkdirSync(join(root, "child-0"));
		mkdirSync(join(root, "child-1"));
		const execution = executor.execute(
			"parallel-parent-ask",
			{
				tasks: [
					{
						agent: "worker",
						task: "ask parent",
						cwd: "child-0",
						group: "group-zero",
						output: "deliver-0.md",
						outputMode: "file-only",
						progress: false,
					},
					{
						agent: "worker",
						task: "active sibling",
						cwd: "child-1",
						group: "group-one",
						output: "deliver-1.md",
						outputMode: "file-only",
						progress: false,
					},
					{ agent: "worker", task: "queued task", progress: false },
				],
				concurrency: 2,
				artifacts: false,
			},
			new AbortController().signal,
			undefined,
			context(root),
		);
		await events.parentAskListenerReady.promise;
		for (let attempt = 0; attempt < 200 && initialOptions.size < 2; attempt++) await sleep(1);
		assert.equal(initialOptions.size, 2);
		const asker = initialOptions.get(0);
		assert.ok(asker?.intercomSessionName);
		assert.ok(asker.orchestratorIntercomTarget);
		const request: ParentAskPauseRequest = {
			runId: asker.runId,
			index: 0,
			agent: "worker",
			childIntercomTarget: asker.intercomSessionName,
			orchestratorTarget: asker.orchestratorIntercomTarget,
			kind: "intercom",
			question: "Parallel choice?",
			resolvedTargetId: "parent-id",
			claimed: false,
		};
		events.emit(PARENT_ASK_PAUSE_REQUEST_EVENT, request);
		const paused = await execution;

		assert.equal(request.claimed, true);
		assert.deepEqual(
			calls.map((call) => ({ index: call.index, task: call.task.split("\n", 1)[0] })),
			[
				{ index: 0, task: "ask parent" },
				{ index: 1, task: "active sibling" },
			],
		);
		assert.match(text(paused), /Parallel choice\?/);
		assert.equal(paused.details.parentAskPaused, true);
		assert.ok(paused.details.results.slice(0, 2).every((result) => result.interrupted));
		assert.equal(paused.details.results[2]?.status, "skipped");
		const retained = childState.foregroundRuns?.get(request.runId);
		assert.deepEqual(retained?.parentAsk?.releasedChildIndices, [0, 1]);
		assert.deepEqual(retained?.parentAsk?.unlaunchedChildIndices, [2]);
		assert.deepEqual(
			retained?.children.map((child) => child.index),
			[0, 1],
		);
		assert.ok(retained?.children.every((child) => child.status === "paused"));
		assert.equal(retained?.children[0]?.execution.options.cwd, join(root, "child-0"));
		assert.equal(retained?.children[1]?.execution.options.cwd, join(root, "child-1"));

		initialGate.resolve();
		const resumed = await executor.execute(
			"parallel-parent-resume",
			{ action: "resume", id: request.runId, message: "choose B", artifacts: false },
			new AbortController().signal,
			undefined,
			context(root),
		);
		assert.equal(resumed.isError, undefined, text(resumed));
		assert.deepEqual(calls.slice(2), [
			{ index: 0, task: "choose B" },
			{ index: 1, task: RELEASED_SIBLING_RESUME_MESSAGE },
		]);
		for (const index of [0, 1]) {
			const [initial, replayed] = allOptions.get(index) ?? [];
			assert.ok(initial && replayed);
			for (const key of [
				"cwd",
				"share",
				"artifactsDir",
				"artifactConfig",
				"maxOutput",
				"outputPath",
				"outputMode",
				"parentDepth",
				"workflowStageSubagentGuard",
				"workflowSessionMetadata",
				"controlConfig",
				"intercomSessionName",
				"orchestratorIntercomTarget",
				"intercomGroup",
				"modelOverride",
				"availableModels",
				"knownModelProviders",
				"resolveCandidateModel",
				"preferredModelProvider",
				"currentModel",
				"currentThinkingLevel",
				"skills",
			] as const) {
				assert.equal(replayed[key], initial[key], `child ${index} changed ${key}`);
			}
			assert.equal(replayed.index, index);
			assert.equal(replayed.sessionFile, retained?.children[index]?.sessionFile);
		}
		assert.deepEqual(
			resumed.details.results.map((result) => result.progress?.index),
			[0, 1],
		);
		assert.equal(resumed.details.totalSteps, 2);
		assert.equal(
			calls.some((call) => call.index === 2),
			false,
		);
		assert.equal(retained?.parentAsk, undefined);
		assert.ok(retained?.children.every((child) => child.status === "completed"));
	} finally {
		initialGate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("PARALLEL worktrees and dirty child work survive repeated parent-ask pauses until terminal resume", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-parent-ask-worktrees-"));
	const events = new TestEvents();
	const childState = state();
	const initialGate = Promise.withResolvers<void>();
	const repeatedGate = Promise.withResolvers<void>();
	const optionsByIndex = new Map<number, Array<Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4]>>();
	const runtime: SubagentExecutorRuntimeDeps = {
		runSync: async (cwd, agents, agentName, task, runOptions) => {
			const index = runOptions.index ?? -1;
			const attempts = optionsByIndex.get(index) ?? [];
			attempts.push(runOptions);
			optionsByIndex.set(index, attempts);
			assert.ok(runOptions.cwd);
			const marker = join(runOptions.cwd, `dirty-${index}.txt`);
			if (attempts.length === 1) writeFileSync(marker, `dirty child ${index}\n`);
			else assert.equal(readFileSync(marker, "utf8"), `dirty child ${index}\n`);
			return runSync(cwd, agents, agentName, task, {
				...runOptions,
				testSession:
					attempts.length === 1
						? { output: "initial must pause", promptGate: initialGate.promise, abortResolvesPrompt: true }
						: attempts.length === 2
							? {
									output: "resume must pause again",
									promptGate: repeatedGate.promise,
									abortResolvesPrompt: true,
								}
							: { output: `terminal child ${index}` },
			});
		},
	};
	try {
		git(root, ["init", "-b", "main"]);
		writeFileSync(join(root, "README.md"), "base\n");
		git(root, ["add", "README.md"]);
		git(root, [
			"-c",
			"user.name=Atomic Test",
			"-c",
			"user.email=atomic@example.com",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"base",
		]);
		const executor = createSubagentExecutor({
			pi: { events, getSessionName: () => "parent-session" } as never,
			state: childState,
			config: { parallel: { concurrency: 2, maxTasks: 10 } },
			tempArtifactsDir: join(root, "artifacts"),
			getSubagentSessionRoot: () => join(root, "sessions"),
			expandTilde: (value) => value,
			discoverAgents: () => ({ agents: [worker()] }),
			runtime,
		});
		clearSubagentControls();
		const execution = executor.execute(
			"worktree-parent-ask",
			{
				tasks: [
					{ agent: "worker", task: "ask from worktree", progress: false },
					{ agent: "worker", task: "sibling worktree", progress: false },
					{ agent: "worker", task: "queued worktree", progress: false },
				],
				concurrency: 2,
				worktree: true,
				artifacts: false,
			},
			new AbortController().signal,
			undefined,
			context(root),
		);
		for (let attempt = 0; attempt < 200 && optionsByIndex.size < 2; attempt++) await sleep(1);
		const asker = optionsByIndex.get(0)?.[0];
		assert.ok(asker?.intercomSessionName && asker.orchestratorIntercomTarget);
		const firstRequest: ParentAskPauseRequest = {
			runId: asker.runId,
			index: 0,
			agent: "worker",
			childIntercomTarget: asker.intercomSessionName,
			orchestratorTarget: asker.orchestratorIntercomTarget,
			kind: "decision",
			question: "Keep worktrees?",
			claimed: false,
		};
		events.emit(PARENT_ASK_PAUSE_REQUEST_EVENT, firstRequest);
		await execution;
		const worktreePaths = [0, 1].map((index) => optionsByIndex.get(index)?.[0]?.cwd);
		for (const [index, worktreePath] of worktreePaths.entries()) {
			assert.ok(worktreePath && existsSync(worktreePath));
			assert.equal(readFileSync(join(worktreePath, `dirty-${index}.txt`), "utf8"), `dirty child ${index}\n`);
			assert.equal(git(worktreePath, ["diff", "--cached", "--name-only"]), "");
			assert.match(git(worktreePath, ["status", "--porcelain"]), new RegExp(`dirty-${index}\\.txt`));
		}

		initialGate.resolve();
		const repeatedExecution = executor.execute(
			"worktree-parent-resume",
			{ action: "resume", id: firstRequest.runId, message: "first answer", artifacts: false },
			new AbortController().signal,
			undefined,
			context(root),
		);
		for (
			let attempt = 0;
			attempt < 200 && [...optionsByIndex.values()].some((options) => options.length < 2);
			attempt++
		)
			await sleep(1);
		const repeatedRequest: ParentAskPauseRequest = {
			...firstRequest,
			question: "Keep them one more time?",
			claimed: false,
		};
		events.emit(PARENT_ASK_PAUSE_REQUEST_EVENT, repeatedRequest);
		const pausedAgain = await repeatedExecution;
		assert.match(text(pausedAgain), /Keep them one more time/);
		for (const [index, worktreePath] of worktreePaths.entries()) {
			assert.ok(worktreePath && existsSync(join(worktreePath, `dirty-${index}.txt`)));
			assert.equal(optionsByIndex.get(index)?.[1]?.cwd, worktreePath);
		}

		repeatedGate.resolve();
		const completed = await executor.execute(
			"worktree-parent-resume-final",
			{ action: "resume", id: firstRequest.runId, message: "final answer", artifacts: false },
			new AbortController().signal,
			undefined,
			context(root),
		);
		assert.match(text(completed), /=== Worktree Changes ===/);
		assert.equal(optionsByIndex.has(2), false);
		for (const worktreePath of worktreePaths) assert.ok(worktreePath && !existsSync(worktreePath));
		assert.equal(childState.foregroundRuns?.get(firstRequest.runId)?.cleanup, undefined);
	} finally {
		initialGate.resolve();
		repeatedGate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});
