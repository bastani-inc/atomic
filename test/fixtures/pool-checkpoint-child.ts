import { workflow } from "@bastani/atomic/workflows";
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
