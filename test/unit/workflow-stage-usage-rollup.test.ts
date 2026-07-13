import { describe } from "bun:test";
import type { Usage } from "@earendil-works/pi-ai/compat";
import {
	assert,
	createStore,
	mockSession,
	run,
	test,
	Type,
	workflow,
	type StageSessionRuntime,
} from "./executor-shared.ts";

function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

type StageSessionListener = Parameters<StageSessionRuntime["subscribe"]>[0];


describe("workflow stage usage rollups", () => {
	test("nested descendant usage is forwarded before the stage turn ends", async () => {
		const emitted: Array<{ usage: Usage; settled?: boolean }> = [];
		const stageUsage = usage(42, 4.2);
		const listeners = new Set<StageSessionListener>();
		const emit = (event: { type: string }): void => {
			for (const listener of [...listeners]) listener(event as Parameters<StageSessionListener>[0]);
		};
		const session = {
			...mockSession(),
			sessionId: "stage-session-1",
			sessionFile: "/tmp/stage-session-1.jsonl",
			state: { model: { contextWindow: 1000 } },
			sessionManager: {},
			modelRegistry: {},
			getContextUsage: () => ({ tokens: 0, contextWindow: 1000, percent: 0 }),
			getTransitiveUsage: () => ({
				self: usage(0, 0),
				descendants: stageUsage,
				total: stageUsage,
				complete: false,
				breakdown: [],
			}),
			subscribe(listener: StageSessionListener) {
				listeners.add(listener);
				return () => { listeners.delete(listener); };
			},
			async prompt() {
				emit({ type: "descendant_usage_changed" });
				assert.equal(emitted.length, 1, "stage descendant usage should roll up before agent_end");
				assert.equal(emitted[0]?.usage.cost.total, 4.2);
				emit({ type: "agent_end" });
				return "ok";
			},
		} satisfies StageSessionRuntime & {
			readonly state: object;
			readonly sessionManager: object;
			readonly modelRegistry: object;
			getContextUsage(): { tokens: number; contextWindow: number; percent: number };
			getTransitiveUsage(): {
				self: Usage;
				descendants: Usage;
				total: Usage;
				complete: boolean;
				breakdown: [];
			};
		};
		const def = workflow({
			name: "nested-usage-rollup",
			description: "",
			inputs: {},
			outputs: { ok: Type.Boolean() },
			run: async (ctx) => {
				await ctx.task("stage", { task: "spend in nested descendants" });
				return { ok: true };
			},
		});
		const result = await run(def, {}, {
			store: createStore(),
			adapters: { agentSession: { create: async () => session } },
			usageRollup: {
				emitStageRollup(_stageId, nextUsage, meta) {
					emitted.push({ usage: nextUsage, settled: meta.settled });
				},
			},
		});
		assert.equal(result.status, "completed");
		assert.ok(emitted.length >= 2, "agent_end/finalization may emit additional keyed-upsert rollups");
		assert.equal(emitted[0]?.settled, false);
	});

	test("stage finalization reconciles descendant usage before emitting the terminal rollup", async () => {
		const emitted: Array<{ usage: Usage; settled?: boolean }> = [];
		let complete = false;
		let walkCalls = 0;
		const transitiveUsage = () => ({
			self: usage(10, 1),
			descendants: usage(20, 2),
			total: usage(30, 3),
			complete,
			breakdown: [],
		});
		const session = {
			...mockSession(),
			state: { model: { contextWindow: 1000 } },
			sessionManager: {},
			modelRegistry: {},
			getContextUsage: () => ({ tokens: 0, contextWindow: 1000, percent: 0 }),
			getTransitiveUsage: transitiveUsage,
			async walkDescendantUsage() {
				walkCalls += 1;
				complete = true;
				return transitiveUsage();
			},
		} satisfies StageSessionRuntime & {
			readonly state: object;
			readonly sessionManager: object;
			readonly modelRegistry: object;
			getContextUsage(): { tokens: number; contextWindow: number; percent: number };
			getTransitiveUsage(): ReturnType<typeof transitiveUsage>;
			walkDescendantUsage(): Promise<ReturnType<typeof transitiveUsage>>;
		};
		const def = workflow({
			name: "reconciled-stage-usage",
			description: "",
			inputs: {},
			outputs: { ok: Type.Boolean() },
			run: async (ctx) => {
				await ctx.task("stage", { task: "reconcile descendants" });
				return { ok: true };
			},
		});
		const result = await run(def, {}, {
			store: createStore(),
			adapters: { agentSession: { create: async () => session } },
			usageRollup: {
				emitStageRollup(_stageId, nextUsage, meta) {
					emitted.push({ usage: nextUsage, settled: meta.settled });
				},
			},
		});
		assert.equal(result.status, "completed");
		assert.equal(walkCalls, 1);
		assert.equal(emitted.at(-1)?.usage.cost.total, 3);
		assert.equal(emitted.at(-1)?.settled, true);
	});
	test("continuation replay emits persisted stage usage to the launching session", async () => {
		const sourceStore = createStore();
		let replayConcurrently = false;
		const def = workflow({
			name: "replayed-stage-usage",
			description: "",
			inputs: {},
			outputs: { ok: Type.Boolean() },
			run: async (ctx) => {
				const firstStage = ctx.stage("first");
				let first: string;
				let firstFinalization: Promise<string> | undefined;
				if (replayConcurrently) {
					firstFinalization = firstStage.prompt("first");
					first = await firstStage.complete("first");
				} else {
					first = await firstStage.prompt("first");
				}
				await ctx.stage("second").prompt(`second:${first}`);
				await firstFinalization;
				return { ok: true };
			},
		});
		const firstRun = await run(def, {}, {
			store: sourceStore,
			adapters: { prompt: { prompt: async (text) => {
				if (text.startsWith("second:")) throw new Error("fail once");
				return "first-result";
			} } },
		});
		assert.equal(firstRun.status, "failed");
		const source = sourceStore.runs().find((candidate) => candidate.id === firstRun.runId)!;
		Object.assign(source.stages[0]!, {
			sessionId: "replayed-stage-session",
			sessionFile: "/tmp/replayed-stage.jsonl",
			usage: usage(20, 2),
			usageComplete: false,
		});
		replayConcurrently = true;
		const emitted: Array<{ stageId: string; usage: Usage; meta: { label?: string; sessionId: string; sessionFile?: string; settled?: boolean } }> = [];
		const replayStageEndStarted = Promise.withResolvers<void>();
		const releaseReplayStageEnd = Promise.withResolvers<void>();
		let resumedStageCalls = 0;
		const continuedPromise = run(def, {}, {
			store: createStore(),
			continuation: { source, resumeFromStageId: source.failedStageId! },
			adapters: { prompt: { prompt: async () => { resumedStageCalls += 1; return "second-result"; } } },
			usageRollup: {
				emitStageRollup(stageId, nextUsage, meta) { emitted.push({ stageId, usage: nextUsage, meta }); },
			},
			onStageEnd: async (_runId, snapshot) => {
				if (snapshot.replayed !== true) return;
				replayStageEndStarted.resolve();
				await releaseReplayStageEnd.promise;
			},
		});
		await replayStageEndStarted.promise;
		assert.equal(resumedStageCalls, 0, "replay persistence must settle before the resumed stage starts");
		releaseReplayStageEnd.resolve();
		const continued = await continuedPromise;
		assert.equal(continued.status, "completed");
		assert.equal(emitted.length, 1);
		assert.equal(emitted[0]?.stageId, continued.stages[0]?.id);
		assert.deepEqual(emitted[0]?.usage, usage(20, 2));
		assert.deepEqual(emitted[0]?.meta, {
			label: "first",
			sessionId: "replayed-stage-session",
			sessionFile: "/tmp/replayed-stage.jsonl",
			settled: false,
		});
	});

});
