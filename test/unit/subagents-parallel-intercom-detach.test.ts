import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runForegroundParallelTasks } from "../../packages/subagents/src/runs/foreground/subagent-executor-parallel-task.js";
import type {
	ForegroundParentAskPause,
	ParentAskPauseRequest,
	SingleResult,
} from "../../packages/subagents/src/shared/types.js";

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
		envelope: "Child detached for intercom coordination.",
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

test("one parallel parent ask pauses active siblings and withholds queued work", async () => {
	const started: number[] = [];
	const siblingStarted = Promise.withResolvers<void>();
	let pause: ForegroundParentAskPause | undefined;
	const output = await runForegroundParallelTasks({
		tasks: [
			{ agent: "fake-worker", task: "ask parent" },
			{ agent: "fake-worker", task: "remain active" },
			{ agent: "fake-worker", task: "remain queued" },
		],
		taskTexts: ["ask parent", "remain active", "remain queued"],
		agents: [agentConfig()],
		ctx: { cwd: process.cwd() } as Parameters<typeof runForegroundParallelTasks>[0]["ctx"],
		intercomEvents: {} as Parameters<typeof runForegroundParallelTasks>[0]["intercomEvents"],
		signal: new AbortController().signal,
		runId: "parallel-parent-ask",
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
		onParentAskPause: (value) => {
			pause = value;
		},
		runtime: {
			async runSync(_cwd, _agents, _agentName, _task, options) {
				const index = options.index ?? -1;
				started.push(index);
				if (index === 1) siblingStarted.resolve();
				if (index === 0) {
					await siblingStarted.promise;
					const request: ParentAskPauseRequest = {
						runId: "parallel-parent-ask",
						index: 0,
						agent: "fake-worker",
						childIntercomTarget: "child-0",
						orchestratorTarget: "parent",
						kind: "decision",
						question: "Pick one",
						claimed: true,
					};
					options.onParentAskClaim?.(request);
				}
				await new Promise<void>((resolve) => {
					options.interruptSignal?.addEventListener("abort", () => resolve(), { once: true });
					if (options.interruptSignal?.aborted) resolve();
				});
				return {
					agent: "fake-worker",
					task: `task-${index}`,
					status: "interrupted",
					interrupted: true,
					path: `child-${index}`,
					sessionFile: `session-${index}.jsonl`,
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				};
			},
		},
	});

	assert.deepEqual(started, [0, 1]);
	assert.deepEqual(pause?.releasedChildIndices, [0, 1]);
	assert.equal(pause?.askingChildIndex, 0);
	assert.deepEqual(pause?.unlaunchedChildIndices, [2]);
	assert.ok(output.slice(0, 2).every((entry) => entry.interrupted));
	assert.equal(output[2]?.status, "skipped");
	assert.match(output[2]?.error ?? "", /Skipped after parent ask pause/);
});

test("parallel authorization is exact and a child still waiting after a parent ask never starts", async () => {
	const requestedChildren: string[] = [];
	const authorizationGates = new Map<
		string,
		ReturnType<typeof Promise.withResolvers<{ capability: string; supervisorSessionId: string; childName: string }>>
	>();
	const twoRequests = Promise.withResolvers<void>();
	const firstStarted = Promise.withResolvers<void>();
	const started: number[] = [];
	let pause: ForegroundParentAskPause | undefined;
	const execution = runForegroundParallelTasks({
		tasks: [
			{ agent: "fake-worker", task: "ask parent" },
			{ agent: "fake-worker", task: "wait for authorization" },
			{ agent: "fake-worker", task: "remain queued" },
		],
		taskTexts: ["ask parent", "wait for authorization", "remain queued"],
		agents: [agentConfig()],
		ctx: { cwd: process.cwd() } as Parameters<typeof runForegroundParallelTasks>[0]["ctx"],
		intercomEvents: {
			emit(channel: string, payload: unknown) {
				if (channel !== "subagent:supervisor-authorization") return;
				const request = payload as {
					childName: string;
					completion?: Promise<{ capability: string; supervisorSessionId: string; childName: string }>;
				};
				requestedChildren.push(request.childName);
				const gate = Promise.withResolvers<{
					capability: string;
					supervisorSessionId: string;
					childName: string;
				}>();
				authorizationGates.set(request.childName, gate);
				request.completion = gate.promise;
				if (requestedChildren.length === 2) twoRequests.resolve();
			},
		} as Parameters<typeof runForegroundParallelTasks>[0]["intercomEvents"],
		signal: new AbortController().signal,
		runId: "parallel-authorization",
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
		childIntercomTarget: (_agent, index) => `child-${index}`,
		concurrencyLimit: 2,
		liveResults: [],
		liveProgress: [],
		onParentAskPause: (value) => {
			pause = value;
		},
		runtime: {
			async runSync(_cwd, _agents, _agentName, _task, options) {
				const index = options.index ?? -1;
				started.push(index);
				if (index === 0) firstStarted.resolve();
				assert.equal(options.supervisorAuthorization?.childName, `child-${index}`);
				assert.equal(options.supervisorAuthorization?.capability, `cap-child-${index}`);
				const request: ParentAskPauseRequest = {
					runId: "parallel-authorization",
					index,
					agent: "fake-worker",
					childIntercomTarget: `child-${index}`,
					orchestratorTarget: "parent",
					kind: "decision",
					question: "Pick one",
					claimed: true,
				};
				options.onParentAskClaim?.(request);
				return {
					agent: "fake-worker",
					task: `task-${index}`,
					status: "interrupted",
					interrupted: true,
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				};
			},
		},
	});

	await twoRequests.promise;
	assert.deepEqual(requestedChildren, ["child-0", "child-1"]);
	authorizationGates.get("child-0")?.resolve({
		capability: "cap-child-0",
		supervisorSessionId: "parent-id",
		childName: "child-0",
	});
	await firstStarted.promise;
	authorizationGates.get("child-1")?.resolve({
		capability: "cap-child-1",
		supervisorSessionId: "parent-id",
		childName: "child-1",
	});
	const output = await execution;

	assert.deepEqual(started, [0]);
	assert.deepEqual(pause?.releasedChildIndices, [0]);
	assert.deepEqual(requestedChildren, ["child-0", "child-1"]);
	assert.equal(output[0]?.status, "interrupted");
	assert.equal(output[1]?.status, "skipped");
	assert.equal(output[2]?.status, "skipped");
});
