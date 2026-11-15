import { workflow } from "@bastani/atomic/workflows";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@bastani/atomic-ai";
import { Type } from "typebox";
import { poolStageOptions } from "./pool-stage-options.js";

/** Commits two checkpoints and completes: each is one commit of its attempt to the pool. */
export const checkpointChild = workflow({
	name: "checkpoint-pool-child",
	description: "Commits two checkpoints, then completes",
	inputs: { directory: Type.String() },
	outputs: {},
	async run(ctx) {
		await ctx.tool("first", {}, async () => 1);
		await ctx.tool("second", {}, async () => 2);
		return {};
	},
});

/** Runs one agent stage on a stub model: its session's entries are commits of their own, written as the stage runs. */
export const stageChild = workflow({
	name: "stage-pool-child",
	description: "Runs one stage on a stub model, then completes",
	inputs: { directory: Type.String() },
	outputs: {},
	async run(ctx) {
		const options = await poolStageOptions(ctx.cwd ?? process.cwd(), false, "never");
		await ctx.stage("agent", options as never).complete("Reply with your PID.");
		return {};
	},
});

/**
 * Runs one stage whose model holds its first reply until the test writes `release` next to it, after writing `waiting`:
 * a test can end the attempt while the stage's turn is in flight, so the stage's session has entries left to write
 * when it closes.
 */
export const heldStageChild = workflow({
	name: "held-stage-pool-child",
	description: "Runs one stage whose first reply waits for the test",
	inputs: { directory: Type.String() },
	outputs: {},
	async run(ctx) {
		const options = await poolStageOptions(ctx.cwd ?? process.cwd(), false, "never");
		const original = options.modelRuntime.getModel("pool-fixture", "fixture")!;
		let calls = 0;
		options.modelRuntime.registerProvider("pool-fixture", {
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			apiKey: "fixture",
			models: [{ ...original, id: "fixture" }],
			streamSimple(model: { readonly api: string; readonly provider: string; readonly id: string }) {
				const first = ++calls === 1;
				const stream = createAssistantMessageEventStream();
				void (async () => {
					if (first) {
						writeFileSync(join(ctx.inputs.directory, "waiting"), String(process.pid));
						while (!existsSync(join(ctx.inputs.directory, "release"))) await delay(20);
					}
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							role: "assistant",
							api: model.api,
							provider: model.provider,
							model: model.id,
							timestamp: Date.now(),
							content: [{ type: "text", text: String(process.pid) }],
							stopReason: "stop",
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						},
					});
					stream.end();
				})();
				return stream;
			},
		} as never);
		await ctx.stage("agent", { ...options, model: options.modelRuntime.getModel("pool-fixture", "fixture")! } as never).complete(
			"Reply with your PID.",
		);
		return {};
	},
});
