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
});
