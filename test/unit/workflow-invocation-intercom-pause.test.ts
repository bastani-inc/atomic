import assert from "node:assert/strict";
import { test } from "vitest";
import {
	createStageControlRegistry,
	createStore,
	deferred,
	mockSession,
	pauseRun,
	resumeRun,
	run,
	workflow,
} from "./executor-shared.js";

test("live pause and resume keep the workflow invocation group", async () => {
	const promptStarted = deferred();
	const stageStarted = deferred<{ runId: string; stageId: string }>();
	let rejectPrompt: ((error: Error) => void) | undefined;
	const groups: string[] = [];
	let promptCalls = 0;
	const session = {
		...mockSession(),
		async prompt() {
			promptCalls += 1;
			if (promptCalls !== 1) return undefined;
			promptStarted.resolve();
			return new Promise<string | undefined>((_resolve, reject) => {
				rejectPrompt = reject;
			});
		},
		async abort() {
			rejectPrompt?.(new Error("AbortError"));
		},
	};
	const definition = workflow({
		name: "pause-resume-invocation-group",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("paused-stage").prompt("run");
			return {};
		},
	});
	const store = createStore();
	const stageControlRegistry = createStageControlRegistry();
	const runPromise = run(
		definition,
		{},
		{
			store,
			stageControlRegistry,
			adapters: {
				agentSession: {
					async create(options) {
						const group = options.orchestrationContext?.intercomGroup;
						assert.ok(group);
						groups.push(group);
						return session;
					},
				},
			},
			onStageStart: (runId, stage) => stageStarted.resolve({ runId, stageId: stage.id }),
		},
	);

	const [{ runId }] = await Promise.all([stageStarted.promise, promptStarted.promise]);
	const paused = await pauseRun(runId, { store, stageControlRegistry });
	assert.equal(paused.ok, true);
	assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");

	const resumed = await resumeRun(runId, { store, stageControlRegistry });
	assert.equal(resumed.ok, true);
	const result = await runPromise;

	assert.equal(result.status, "completed");
	assert.equal(groups.length, 1, "resume must keep the existing grouped session");
	assert.notEqual(groups[0], "default");
});
