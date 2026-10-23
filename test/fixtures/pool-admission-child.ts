import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";
import { poolStageOptions } from "./pool-stage-options.js";

export const child = workflow({
	name: "admitted-child", description: "", inputs: {}, outputs: { pid: Type.String() },
	async run(ctx) {
		const stage = ctx.stage("agent", await poolStageOptions(ctx.cwd ?? process.cwd(), false, 0) as never);
		return { pid: await stage.complete("Reply with your PID") };
	},
});

export const paused = workflow({
	name: "paused-admitted-child", description: "", inputs: {}, outputs: { pid: Type.String(), first: Type.Number() },
	async run(ctx) {
		const first = await ctx.tool("first", {}, async () => process.pid);
		const stage = ctx.stage("agent", await poolStageOptions(ctx.cwd ?? process.cwd(), false, first, true) as never);
		return { pid: await stage.complete("Reply with your PID"), first };
	},
});
