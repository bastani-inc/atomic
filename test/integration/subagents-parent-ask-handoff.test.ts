import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitEnvironment, type ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { getAgentTaskHost } from "../../packages/coding-agent/src/core/agent-session-tasks.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { requestParentAskHandoff } from "../../packages/intercom/parent-ask-handoff.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { registerExecutionParentAskHandoff } from "../../packages/subagents/src/runs/foreground/execution-parent-ask-handoff.js";
import { formatParentAskHandoffOutput } from "../../packages/subagents/src/runs/foreground/parent-ask-output.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import {
	PARENT_ASK_HANDOFF_REQUEST_EVENT,
	type ParentAskHandoffRequest,
} from "../../packages/subagents/src/shared/types.js";
import { sleep, spawnSyncCollect } from "../helpers/runtime.js";

class TestEvents {
	private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
	readonly listenerReady = Promise.withResolvers<void>();

	on(channel: string, handler: (payload: unknown) => void): () => void {
		let listeners = this.handlers.get(channel);
		if (!listeners) {
			listeners = new Set();
			this.handlers.set(channel, listeners);
		}
		listeners.add(handler);
		if (channel === PARENT_ASK_HANDOFF_REQUEST_EVENT) this.listenerReady.resolve();
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
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
}

function context(root: string, options: { forkable?: boolean } = {}): ExtensionContext {
	const parentSessionFile = join(root, "parent.jsonl");
	if (options.forkable) writeFileSync(parentSessionFile, "", "utf8");
	return {
		cwd: root,
		mode: "tui",
		hasUI: false,
		model: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => parentSessionFile,
			getSessionId: () => "parent-session-id",
			getLeafId: () => (options.forkable ? "parent-leaf" : null),
			getSessionDir: () => root,
			openSession: () => ({
				createBranchedSession: () => {
					const forked = join(root, "forked-child.jsonl");
					writeFileSync(forked, "", "utf8");
					return forked;
				},
			}),
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
	const result = spawnSyncCollect(["git", "-C", root, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: createGitEnvironment(),
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout.toString().trim();
}

function executor(
	root: string,
	events: TestEvents,
	childState: ExecutorDeps["state"],
	runtime: SubagentExecutorRuntimeDeps,
) {
	return createSubagentExecutor({
		pi: { events, getSessionName: () => "parent-session" } as never,
		state: childState,
		config: { parallel: { concurrency: 2, maxTasks: 10 } },
		tempArtifactsDir: join(root, "artifacts"),
		getSubagentSessionRoot: () => join(root, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [worker()] }),
		runtime,
	});
}

test("empty parent question is preserved exactly in the parent block and fresh task context", () => {
	const output = formatParentAskHandoffOutput({
		askingChildIndex: 0,
		releasedChildIndices: [0],
		unlaunchedChildIndices: [],
		request: {
			runId: "terminal-run",
			index: 0,
			agent: "worker",
			childIntercomTarget: "child",
			orchestratorTarget: "parent",
			kind: "decision",
			question: "",
			taskContext: "Original task",
			claimed: true,
		},
	});

	assert.equal(
		output,
		`Subagent yielded for parent input (worker, child 1).
Previous run (terminal): terminal-run
Question:


Start a fresh subagent with a new run identity, replacing <SUPERVISOR_ANSWER> with your answer:
subagent({
  "agent": "worker",
  "task": "[TASK_CONTEXT]\\nOriginal delegated task and objective:\\nOriginal task\\n\\nPrevious child identity: worker (child 1)\\nPrevious child question:\\n\\n\\nContinue with this supervisor answer: <SUPERVISOR_ANSWER>"
})`,
	);
});

test("SINGLE parent ask ends the old child and returns an ordered fresh-start handoff", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-single-parent-handoff-"));
	const events = new TestEvents();
	const childState = state();
	const gate = Promise.withResolvers<void>();
	let firstOptions: Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4] | undefined;
	let runCalls = 0;
	const runtime: SubagentExecutorRuntimeDeps = {
		runSync: async (cwd, agents, agentName, task, options) => {
			runCalls += 1;
			firstOptions ??= options;
			return runSync(cwd, agents, agentName, task, {
				...options,
				testSession:
					runCalls === 1
						? { output: "must not complete", promptGate: gate.promise, abortResolvesPrompt: true }
						: { output: `fresh follow-up: ${task}` },
			});
		},
	};
	const run = executor(root, events, childState, runtime);
	clearSubagentControls();
	try {
		const initial = run.execute(
			"initial",
			{ agent: "worker", task: "Original  objective\nwith exact spacing", artifacts: false },
			new AbortController().signal,
			undefined,
			context(root),
		);
		await events.listenerReady.promise;
		for (let attempt = 0; attempt < 100 && !firstOptions; attempt++) await sleep(1);
		assert.ok(firstOptions?.intercomSessionName && firstOptions.orchestratorIntercomTarget);
		const attachments = [
			{ type: "snippet" as const, name: "same.ts", content: "first  attachment", language: "ts" },
			{ type: "context" as const, name: "same.ts", content: "second\nattachment" },
		];
		const request: ParentAskHandoffRequest = {
			runId: firstOptions.runId,
			index: 0,
			agent: "worker",
			childIntercomTarget: firstOptions.intercomSessionName,
			orchestratorTarget: firstOptions.orchestratorIntercomTarget,
			kind: "decision",
			question: "Keep  this question\nverbatim?",
			attachments,
			claimed: false,
		};
		events.emit(PARENT_ASK_HANDOFF_REQUEST_EVENT, request);
		const yielded = await initial;
		assert.equal(request.claimed, true);
		assert.equal(request.taskContext, "Original  objective\nwith exact spacing");
		assert.equal(yielded.details.parentAskYielded, true);
		assert.equal(yielded.details.results[0]?.status, "interrupted");
		assert.match(text(yielded), /Subagent yielded for parent input \(worker, child 1\)\./);
		assert.match(text(yielded), /Keep {2}this question\nverbatim\?/);
		assert.match(text(yielded), /📎 same\.ts\n~~~ts\nfirst {2}attachment\n~~~/);
		assert.match(text(yielded), /📎 same\.ts\nsecond\nattachment/);
		assert.match(text(yielded), /\[TASK_CONTEXT\]/);
		assert.match(text(yielded), /Start a fresh subagent with a new run identity/);
		assert.match(text(yielded), /Continue with this supervisor answer: <SUPERVISOR_ANSWER>/);
		assert.doesNotMatch(text(yielded), /action.*resume|Resume with:/i);
		assert.equal(Object.hasOwn(childState, "foregroundRuns"), false);

		gate.resolve();
		const followUp = await run.execute(
			"fresh-follow-up",
			{ agent: "worker", task: "[TASK_CONTEXT] Supervisor answer: choose B", artifacts: false },
			new AbortController().signal,
			undefined,
			context(root),
		);
		assert.notEqual(followUp.details.runId, yielded.details.runId);
		assert.equal(runCalls, 2);
		assert.match(text(followUp), /fresh follow-up/);
	} finally {
		gate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("forked SINGLE handoff keeps the original unusual task verbatim instead of the fork preamble", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-fork-parent-handoff-"));
	const events = new TestEvents();
	const childState = state();
	const originalTask = "  leading\tspace\r\n[TASK_CONTEXT]? `ticks` $" + "{literal}\n雪  trailing  ";
	let runtimeTask = "";
	let capturedRequest: ParentAskHandoffRequest | undefined;
	const runtime: SubagentExecutorRuntimeDeps = {
		runSync: async (_cwd, _agents, agentName, task, options) => {
			runtimeTask = task;
			const request: ParentAskHandoffRequest = {
				runId: options.runId,
				index: options.index ?? 0,
				agent: agentName,
				childIntercomTarget: options.intercomSessionName!,
				orchestratorTarget: options.orchestratorIntercomTarget!,
				kind: "decision",
				question: "Answer exactly",
				claimed: true,
			};
			capturedRequest = request;
			options.onParentAskHandoff?.(request);
			return {
				agent: agentName,
				task,
				status: "interrupted",
				interrupted: true,
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				finalOutput: "terminal handoff",
			};
		},
	};
	const run = executor(root, events, childState, runtime);
	clearSubagentControls();
	try {
		const result = await run.execute(
			"fork-handoff",
			{ agent: "worker", task: originalTask, context: "fork", artifacts: false, progress: false },
			new AbortController().signal,
			undefined,
			context(root, { forkable: true }),
		);

		assert.match(runtimeTask, /delegated subagent running from a fork of the parent session/);
		assert.notEqual(runtimeTask, originalTask);
		assert.equal(capturedRequest?.taskContext, originalTask);
		assert.equal(result.details.parentAskYielded, true);
		assert.match(text(result), /Start a fresh subagent with a new run identity/);
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("PARALLEL declines terminal parent handoff and completes every original child", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-parallel-parent-handoff-"));
	const events = new TestEvents();
	const childState = state();
	const gate = Promise.withResolvers<void>();
	const options = new Map<number, Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4]>();
	const calls: Array<{ index: number; task: string }> = [];
	const runtime: SubagentExecutorRuntimeDeps = {
		runSync: async (cwd, agents, agentName, task, runOptions) => {
			const index = runOptions.index ?? -1;
			calls.push({ index, task });
			options.set(index, runOptions);
			return runSync(cwd, agents, agentName, task, {
				...runOptions,
				testSession: { output: `completed ${index}`, promptGate: gate.promise, abortResolvesPrompt: true },
			});
		},
	};
	const run = executor(root, events, childState, runtime);
	clearSubagentControls();
	try {
		const initial = run.execute(
			"parallel",
			{
				tasks: [
					{ agent: "worker", task: "asking child" },
					{ agent: "worker", task: "active sibling" },
					{ agent: "worker", task: "queued sibling" },
				],
				concurrency: 2,
				artifacts: false,
			},
			new AbortController().signal,
			undefined,
			context(root),
		);
		for (let attempt = 0; attempt < 200 && options.size < 2; attempt++) await sleep(1);
		const asker = options.get(0);
		assert.ok(asker?.intercomSessionName && asker.orchestratorIntercomTarget);
		const request: ParentAskHandoffRequest = {
			runId: asker.runId,
			index: 0,
			agent: "worker",
			childIntercomTarget: asker.intercomSessionName,
			orchestratorTarget: asker.orchestratorIntercomTarget,
			kind: "intercom",
			question: "Parallel choice?",
			claimed: false,
		};
		events.emit(PARENT_ASK_HANDOFF_REQUEST_EVENT, request);
		assert.equal(request.claimed, false);
		assert.equal(options.get(0)?.interruptSignal?.aborted, false);
		assert.equal(options.get(1)?.interruptSignal?.aborted, false);
		gate.resolve();
		const yielded = await initial;
		assert.equal(yielded.details.parentAskYielded, false);
		assert.ok(yielded.details.results.every((result) => result.status === "ok"));
		assert.deepEqual(
			calls.map(({ index }) => index),
			[0, 1, 2],
		);
		assert.equal(Object.hasOwn(childState, "foregroundRuns"), false);
		assert.match(text(yielded), /completed 0/);
		assert.match(text(yielded), /completed 1/);
		assert.match(text(yielded), /completed 2/);
		assert.doesNotMatch(text(yielded), /fresh subagent|TASK_CONTEXT/i);
	} finally {
		gate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("PARALLEL retains dirty worktrees through parent coordination and cleans them after all children finish", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-parent-handoff-worktrees-"));
	const events = new TestEvents();
	const childState = state();
	const gate = Promise.withResolvers<void>();
	const optionsByIndex = new Map<number, Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4]>();
	const runtime: SubagentExecutorRuntimeDeps = {
		runSync: async (cwd, agents, agentName, task, runOptions) => {
			const index = runOptions.index ?? -1;
			optionsByIndex.set(index, runOptions);
			assert.ok(runOptions.cwd);
			writeFileSync(join(runOptions.cwd, `dirty-${index}.txt`), `dirty child ${index}\n`);
			return runSync(cwd, agents, agentName, task, {
				...runOptions,
				testSession: { output: "completed", promptGate: gate.promise, abortResolvesPrompt: true },
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
		const run = executor(root, events, childState, runtime);
		clearSubagentControls();
		const execution = run.execute(
			"worktree-parent-handoff",
			{
				tasks: [
					{ agent: "worker", task: "ask from worktree", progress: false },
					{ agent: "worker", task: "active sibling", progress: false },
					{ agent: "worker", task: "queued sibling", progress: false },
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
		const asker = optionsByIndex.get(0);
		assert.ok(asker?.intercomSessionName && asker.orchestratorIntercomTarget);
		const worktreePaths = [optionsByIndex.get(0)?.cwd, optionsByIndex.get(1)?.cwd];
		for (const [index, worktreePath] of worktreePaths.entries()) {
			assert.ok(worktreePath && existsSync(worktreePath));
			assert.equal(readFileSync(join(worktreePath, `dirty-${index}.txt`), "utf8"), `dirty child ${index}\n`);
		}
		const request: ParentAskHandoffRequest = {
			runId: asker.runId,
			index: 0,
			agent: "worker",
			childIntercomTarget: asker.intercomSessionName,
			orchestratorTarget: asker.orchestratorIntercomTarget,
			kind: "decision",
			question: "Capture work before ending?",
			claimed: false,
		};
		events.emit(PARENT_ASK_HANDOFF_REQUEST_EVENT, request);
		assert.equal(request.claimed, false);
		for (const worktreePath of worktreePaths) assert.ok(worktreePath && existsSync(worktreePath));
		gate.resolve();
		const handedOff = await execution;

		assert.equal(handedOff.details.parentAskYielded, false);
		assert.match(text(handedOff), /=== Worktree Changes ===/);
		assert.match(text(handedOff), /dirty-0\.txt/);
		assert.match(text(handedOff), /dirty-1\.txt/);
		assert.equal(optionsByIndex.has(2), true);
		assert.match(text(handedOff), /dirty-2\.txt/);
		for (const worktreePath of worktreePaths) assert.ok(worktreePath && !existsSync(worktreePath));
		assert.equal(git(root, ["branch", "--list", "worktree-*"]), "");
	} finally {
		gate.resolve();
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

type ParentWait = "foreground" | "background" | "foreground-yielded";

async function childAskClaimedWhileParent(wait: ParentWait): Promise<boolean> {
	const session = {
		sessionManager: SessionManager.inMemory(),
		sendCustomMessage: async () => {},
	} as unknown as ThisParameterType<typeof getAgentTaskHost>;
	const host = getAgentTaskHost.call(session);
	const events = new TestEvents();
	const childRunning = Promise.withResolvers<void>();
	const askNow = Promise.withResolvers<void>();
	const asked = Promise.withResolvers<boolean>();
	const interruptController = new AbortController();
	const metadata = {
		orchestratorTarget: "parent",
		runId: "run-3251",
		agent: "worker",
		index: "0",
		sessionName: "child",
	};
	const runSyncFake: SubagentExecutorRuntimeDeps["runSync"] = async (_cwd, _agents, agent, task, options) => {
		const cleanup = registerExecutionParentAskHandoff(options, { agent, isUnavailable: () => false });
		childRunning.resolve();
		await askNow.promise;
		const claimed = requestParentAskHandoff(events as never, metadata, {
			kind: "intercom",
			question: "Approve plan?",
		});
		cleanup();
		asked.resolve(claimed);
		return {
			agent,
			task,
			exitCode: 0,
			status: claimed ? "cancelled" : "ok",
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			...(claimed ? { interrupted: true } : {}),
		} as never;
	};
	try {
		const launch = runAgentTask({
			host,
			cwd: "/repo",
			agents: [worker()],
			agent: "worker",
			task: "Send the plan to the parent with intercom ask before editing.",
			options: {
				runId: "run-3251",
				index: 0,
				intercomEvents: events,
				intercomSessionName: "child",
				orchestratorIntercomTarget: "parent",
				interruptSignal: interruptController.signal,
				onParentAskHandoff: () => interruptController.abort(),
			},
			wait: { kind: wait === "background" ? "background" : "foreground" },
			runtime: { runSync: runSyncFake },
		});
		await childRunning.promise;
		if (wait === "background") await launch;
		if (wait === "foreground-yielded") {
			host.yieldTaskWaits("input-needed");
			await launch;
		}
		askNow.resolve();
		const claimed = await asked.promise;
		await launch;
		return claimed;
	} finally {
		await host.close("session-close");
	}
}

test("a background child's parent ask is not claimed as a handoff, so intercom delivers it (#3251)", async () => {
	assert.equal(await childAskClaimedWhileParent("background"), false);
});

test("a parent ask after the foreground observation yielded is not claimed as a handoff (#3251)", async () => {
	assert.equal(await childAskClaimedWhileParent("foreground-yielded"), false);
});

test("a parent ask while the parent waits in the foreground is still claimed as a handoff (#3251)", async () => {
	assert.equal(await childAskClaimedWhileParent("foreground"), true);
});
