import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { runForegroundParallelTasks } from "../../packages/subagents/src/runs/foreground/subagent-executor-parallel-task.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";

type Input = Parameters<typeof runForegroundParallelTasks>[0];
function result(index: number, detached = false): SingleResult {
	return {
		agent: "worker",
		task: `task-${index}`,
		status: detached ? "continued" : "ok",
		...(detached ? { detached: true } : {}),
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}
function input(runSync: Input["runtime"]["runSync"]): Input {
	return {
		tasks: [0, 1, 2].map((index) => ({ agent: "worker", task: `task-${index}` })),
		taskTexts: ["task-0", "task-1", "task-2"],
		agents: [
			{
				name: "worker",
				description: "worker",
				source: "project",
				filePath: "worker.md",
				systemPrompt: "Work",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
			},
		],
		ctx: { cwd: process.cwd() } as Input["ctx"],
		intercomEvents: {} as Input["intercomEvents"],
		signal: new AbortController().signal,
		runId: "parallel-detach",
		sessionDirForIndex: () => undefined,
		sessionFileForIndex: async () => undefined,
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
		behaviors: [0, 1, 2].map(() => ({
			output: false,
			outputMode: "inline",
			reads: false,
			progress: false,
			skills: false,
		})),
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
		runtime: { runSync },
	};
}

test("parallel detach releases observations but retains execution slots until detached exits", async () => {
	const started: number[] = [];
	const exits = new Map<number, RunSyncOptions["onDetachedExit"]>();
	const execution = runForegroundParallelTasks(
		input(async (_cwd, _agents, _agent, _task, options) => {
			const index = options.index!;
			started.push(index);
			exits.set(index, options.onDetachedExit);
			if (index === 0) {
				await Promise.resolve();
				options.onIntercomDetachCommit?.();
			} else if (!options.intercomDetachSignal?.aborted)
				await new Promise<void>((resolve) =>
					options.intercomDetachSignal?.addEventListener("abort", () => resolve(), { once: true }),
				);
			return result(index, true);
		}),
	);
	const output = await execution;
	assert.deepEqual(started, [0, 1]);
	assert.equal(output.length, 3);
	assert.ok(output.every((child) => child.detached && child.status === "continued"));
	exits.get(1)?.(result(1));
	await vi.waitFor(() => assert.deepEqual(started, [0, 1, 2]));
	exits.get(0)?.(result(0));
	exits.get(2)?.(result(2));
});

test("parallel children cannot install the single-child terminal parent handoff", async () => {
	const optionsSeen: RunSyncOptions[] = [];
	const output = await runForegroundParallelTasks(
		input(async (_cwd, _agents, _agent, _task, options) => {
			optionsSeen.push(options);
			assert.equal(options.onParentAskHandoff, undefined);
			assert.equal(options.interruptSignal?.aborted, false);
			return result(options.index!);
		}),
	);
	assert.deepEqual(
		optionsSeen.map((options) => options.index),
		[0, 1, 2],
	);
	assert.ok(output.every((child) => child.status === "ok"));
});

test("an authorization still pending at peer detach retains its exact child and launches once", async () => {
	const gates = new Map<
		string,
		ReturnType<typeof Promise.withResolvers<{ capability: string; supervisorSessionId: string; childName: string }>>
	>();
	const starts: string[] = [];
	const first = Promise.withResolvers<void>();
	const config = input(async (_cwd, _agents, _agent, _task, options) => {
		const name = `child-${options.index}`;
		starts.push(name);
		assert.equal(options.supervisorAuthorization?.childName, name);
		assert.equal(options.supervisorAuthorization?.capability, `cap-${name}`);
		if (options.index === 0) {
			options.onIntercomDetachCommit?.();
			first.resolve();
		}
		return result(options.index!);
	});
	config.childIntercomTarget = (_agent, index) => `child-${index}`;
	config.intercomEvents = {
		on() {
			return () => {};
		},
		emit(channel, payload) {
			if (channel !== "subagent:supervisor-authorization") return;
			const request = payload as {
				childName: string;
				completion?: Promise<{ capability: string; supervisorSessionId: string; childName: string }>;
			};
			const gate = Promise.withResolvers<{ capability: string; supervisorSessionId: string; childName: string }>();
			gates.set(request.childName, gate);
			request.completion = gate.promise;
		},
	};
	const execution = runForegroundParallelTasks(config);
	await vi.waitFor(() => assert.equal(gates.size, 3));
	assert.deepEqual(starts, [], "admission cannot bypass any child's pending authorization");
	const release = (name: string) =>
		gates.get(name)!.resolve({ capability: `cap-${name}`, supervisorSessionId: "parent", childName: name });
	release("child-0");
	await first.promise;
	assert.deepEqual(starts, ["child-0"], "peer coordination cannot release another child's authorization gate");
	release("child-1");
	release("child-2");
	await execution;
	await vi.waitFor(() => assert.deepEqual(starts, ["child-0", "child-1", "child-2"]));
});
