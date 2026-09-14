import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { stageTimingFields } from "../../packages/workflows/src/shared/timing.js";
import {
	assert,
	createStore,
	run,
	Type,
	test,
	waitForExecutorStagePendingPrompt,
	workflow,
} from "./executor-shared.js";

const timingKeys = ["startedAt", "endedAt", "durationMs"] as const;
function assertTiming(actual: StageSnapshot, expected: Partial<StageSnapshot>): void {
	for (const key of timingKeys) {
		assert.equal(actual[key], expected[key], key);
		// Store terminal snapshots may own undefined fields; no numeric history may be fabricated.
	}
}

// #3038: replay is hydration, not a new execution or a zero-duration measurement.
test("completed predecessor timing survives repeated continuation and session restoration", async () => {
	let predecessorCalls = 0;
	const def = workflow({
		name: "replay-timing",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const first = ctx.stage("first");
			await first.prompt("first");
			await ctx.stage("other").prompt("other");
			return { value: await ctx.stage("failure").prompt("fail") };
		},
	});
	const adapters = {
		prompt: {
			prompt: async (text: string) => {
				if (text === "fail") throw new Error("resume-me");
				predecessorCalls++;
				return `${text}-result`;
			},
		},
	};
	const store = createStore();
	const initial = await run(def, {}, { store, adapters });
	assert.equal(initial.status, "failed");
	const original = store.runs().find((item) => item.id === initial.runId)!;
	const calls = predecessorCalls;
	for (const values of [
		[111, 999, 456],
		[0, 0, 0],
	]) {
		for (let mask = 0; mask < 8; mask++) {
			const expected: Partial<StageSnapshot> = {};
			for (const [index, key] of timingKeys.entries()) if (mask & (1 << index)) expected[key] = values[index];
			assert.deepEqual(stageTimingFields(expected), expected, "timing copies omit missing fields and retain zero");
			assert.ok(original.failedStageId, initial.error);
			let source = {
				...original,
				stages: original.stages.map((stage) => {
					if (stage.name === "failure") return stage;
					const copy = { ...stage, sessionId: "source-session", sessionFile: "/source/transcript.jsonl" };
					for (const key of timingKeys) delete copy[key];
					return { ...copy, ...expected };
				}),
			};
			for (let resume = 0; resume < 2; resume++) {
				const entries: SessionEntry[] = [];
				const observations: StageSnapshot[] = [];
				const continuationStore = createStore();
				const result = await run(
					def,
					{},
					{
						store: continuationStore,
						adapters,
						continuation: { source, resumeFromStageId: source.failedStageId! },
						persistence: {
							appendEntry: (type, payload) => {
								entries.push(JSON.parse(JSON.stringify({ id: String(entries.length), type, payload })));
								return String(entries.length);
							},
						},
						onStageStart: (_id, stage) => {
							if (stage.replayed) observations.push({ ...stage });
						},
						onStageEnd: (_id, stage) => {
							if (stage.replayed) observations.push({ ...stage });
						},
					},
				);
				assert.equal(result.status, "failed");
				assert.equal(observations.length, 4);
				for (const stage of observations) assertTiming(stage, expected);
				assert.equal(result.stages.filter((item) => item.replayed).length, 2);
				for (const stage of result.stages.filter((item) => item.replayed)) {
					assertTiming(stage, expected);
					assert.equal(stage.replayedFromStageId, source.stages.find((item) => item.name === stage.name)!.id);
					assert.equal(stage.sessionId, "source-session");
					assert.equal(stage.sessionFile, "/source/transcript.jsonl");
					assert.equal(
						entries.filter((entry) => entry.type === "workflow.stage.end" && entry.payload?.stageId === stage.id)
							.length,
						1,
					);
					for (const [key, type, field] of [
						["startedAt", "workflow.stage.start", "ts"],
						["endedAt", "workflow.stage.end", "endedAt"],
						["durationMs", "workflow.stage.end", "durationMs"],
					] as const) {
						const payload = entries.find((entry) => entry.type === type && entry.payload?.stageId === stage.id)!
							.payload!;
						assert.equal(payload[field], expected[key], `persisted ${key}`);
						assert.equal(Object.hasOwn(payload, field), expected[key] !== undefined, `persisted ${key} presence`);
					}
				}
				const restored = createStore();
				restoreOnSessionStart(
					{ getEntries: () => entries },
					{ resumeInFlight: "auto", persistRuns: true },
					restored,
				);
				source = restored.runs().find((item) => item.id === result.runId)!;
				assert.ok(source);
				for (const stage of source.stages.filter((item) => item.replayed)) assertTiming(stage, expected);
			}
		}
	}
	assert.equal(predecessorCalls, calls, "completed predecessors must not run again");
});

// #3038: child boundaries are completed stages, not newly executed children on resume.
test("child boundary timing is preserved without invoking the child again", async () => {
	let childCalls = 0;
	const child = workflow({
		name: "timed-child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			childCalls++;
			await ctx.stage("child-work").prompt("child");
			return {};
		},
	});
	const parent = workflow({
		name: "timed-parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.workflow(child);
			await ctx.stage("failure").prompt("fail");
			return {};
		},
	});
	const store = createStore();
	const adapters = {
		prompt: {
			prompt: async (text: string) => {
				if (text === "fail") throw new Error("resume-me");
				return "ok";
			},
		},
	};
	const initial = await run(parent, {}, { store, adapters });
	assert.equal(initial.status, "failed");
	let source = store.runs().find((item) => item.id === initial.runId)!;
	const expected = { startedAt: 100, endedAt: 900, durationMs: 450 };
	source = {
		...source,
		stages: source.stages.map((stage) => (stage.workflowChild ? { ...stage, ...expected } : stage)),
	};
	for (let index = 0; index < 2; index++) {
		const result = await run(
			parent,
			{},
			{ store, adapters, continuation: { source, resumeFromStageId: source.failedStageId! } },
		);
		assert.equal(result.status, "failed");
		const boundary = result.stages.find((stage) => stage.workflowChild)!;
		assertTiming(boundary, expected);
		assert.equal(boundary.replayed, true);
		assert.deepEqual(boundary.workflowChild, source.stages.find((stage) => stage.workflowChild)!.workflowChild);
		source = store.runs().find((item) => item.id === result.runId)!;
	}
	assert.equal(childCalls, 1);
});

// #3038: a session-restored source must retain the original terminal timestamp.
test("original execution timing survives session persistence before continuation", async () => {
	const entries: SessionEntry[] = [];
	const def = workflow({
		name: "persist-timing",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("work").prompt("work");
			return {};
		},
	});
	const result = await run(
		def,
		{},
		{
			adapters: { prompt: { prompt: async () => "done" } },
			persistence: {
				appendEntry: (type, payload) => {
					entries.push(JSON.parse(JSON.stringify({ id: String(entries.length), type, payload })));
					return String(entries.length);
				},
			},
		},
	);
	assert.equal(result.status, "completed");
	const restored = createStore();
	restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "auto", persistRuns: true }, restored);
	assertTiming(restored.runs().find((item) => item.id === result.runId)!.stages[0]!, result.stages[0]!);
});

// #3038: checkpoint completion is not proof of missing execution start/duration.
test("durable cached stages retain zero and partial legacy execution timing", async () => {
	for (const values of [
		[111, 999, 456],
		[0, 0, 0],
	]) {
		for (let mask = 0; mask < 8; mask++) {
			const expected: Partial<StageSnapshot> = {};
			for (const [index, key] of timingKeys.entries()) if (mask & (1 << index)) expected[key] = values[index];
			const backend = new InMemoryDurableBackend();
			const runId = crypto.randomUUID();
			backend.registerWorkflow({
				workflowId: runId,
				name: "legacy-timing",
				inputs: {},
				createdAt: 1,
				status: "running",
			});
			backend.recordCheckpoint({
				kind: "stage",
				workflowId: runId,
				checkpointId: "stage:stage:work:1",
				name: "work",
				replayKey: "stage:work:1",
				output: "cached",
				completedAt: 1234,
				...expected,
			});
			const def = workflow({
				name: "legacy-timing",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					assert.equal(await ctx.stage("work").prompt("work"), "cached");
					return {};
				},
			});
			for (let resume = 0; resume < 2; resume++) {
				const result = await run(
					def,
					{},
					{
						runId,
						durableBackend: backend,
						store: createStore(),
						adapters: {
							prompt: {
								prompt: async () => {
									throw new Error("cached predecessor executed");
								},
							},
						},
					},
				);
				assert.equal(result.status, "completed", result.error);
				assertTiming(result.stages[0]!, expected);
			}
		}
	}
});

// #3038: replaying an answered prompt must not time the new hydration.
test("answered prompt replay preserves original timing", async () => {
	const store = createStore();
	const def = workflow({
		name: "prompt-timing",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			assert.equal(await ctx.ui.confirm("continue?"), true);
			await ctx.stage("failure").prompt("fail");
			return {};
		},
	});
	const adapters = {
		prompt: {
			prompt: async () => {
				throw new Error("resume-me");
			},
		},
	};
	const initial = run(def, {}, { store, usePromptNodesForUi: true, adapters });
	const pending = await waitForExecutorStagePendingPrompt(store);
	store.resolveStagePendingPrompt(pending.runId, pending.stageId, pending.promptId, true);
	const first = await initial;
	assert.equal(first.status, "failed");
	const expected = { startedAt: 100, endedAt: 900, durationMs: 450 };
	const original = store.runs().find((item) => item.id === first.runId)!;
	let source = {
		...original,
		stages: original.stages.map((stage) => (stage.name === "confirm" ? { ...stage, ...expected } : stage)),
	};
	for (let resume = 0; resume < 2; resume++) {
		const result = await run(
			def,
			{},
			{
				store,
				usePromptNodesForUi: true,
				adapters,
				continuation: { source, resumeFromStageId: source.failedStageId! },
			},
		);
		assert.equal(result.status, "failed");
		const prompt = result.stages.find((stage) => stage.name === "confirm")!;
		assert.equal(prompt.replayed, true);
		assertTiming(prompt, expected);
		source = store.runs().find((item) => item.id === result.runId)!;
	}
});

// #3038: same-ID durable recovery must retain answered prompt timing in a fresh Store.
test("durable answered prompt timing survives repeated fresh-Store recovery", async () => {
	const backend = new InMemoryDurableBackend();
	const store = createStore();
	const runId = crypto.randomUUID();
	let answers = 0;
	const def = workflow({
		name: "durable-prompt-timing",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			assert.equal(await ctx.ui.confirm("confirm"), false);
			answers++;
			await ctx.stage("failure").prompt("fail");
			return {};
		},
	});
	const adapters = {
		prompt: {
			prompt: async () => {
				throw new Error("resume-me");
			},
		},
	};
	const opts = { runId, durableBackend: backend, usePromptNodesForUi: true, adapters };
	const initial = run(def, {}, { ...opts, store });
	const pending = await waitForExecutorStagePendingPrompt(store);
	store.resolveStagePendingPrompt(pending.runId, pending.stageId, pending.promptId, false);
	const first = await initial;
	assert.equal(first.status, "failed");
	const original = first.stages.find((stage) => stage.name === "confirm")!;
	assert.equal(typeof original.startedAt, "number");
	assert.equal(typeof original.endedAt, "number");
	assert.equal(typeof original.durationMs, "number");
	for (let resume = 0; resume < 2; resume++) {
		const result = await run(def, {}, { ...opts, store: createStore() });
		assert.equal(result.status, "failed");
		const prompt = result.stages.find((stage) => stage.name === "confirm")!;
		assert.equal(prompt.id, original.id);
		assert.equal(prompt.replayed, true);
		assert.equal(prompt.promptAnswerState, "available");
		assertTiming(prompt, original);
	}
	assert.equal(answers, 3, "the cached false answer returns on both recoveries without another prompt");
});
