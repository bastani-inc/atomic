import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";
import { poolStageOptions } from "./pool-stage-options.js";
import { processIdentity } from "./process-instance.js";

export const child = workflow({
	name: "admitted-child", description: "", inputs: {}, outputs: { pid: Type.String() },
	async run(ctx) {
		const stage = ctx.stage("agent", await poolStageOptions(ctx.cwd ?? process.cwd(), false, 0) as never);
		return { pid: await stage.complete("Reply with your PID") };
	},
});

export const paused = workflow({
	name: "paused-admitted-child", description: "", inputs: {}, outputs: { pid: Type.String(), first: Type.Number(), firstInstance: Type.String(), finalInstance: Type.String() },
	async run(ctx) {
		const first = await ctx.tool("first", {}, async () => processIdentity());
		const stage = ctx.stage("agent", await poolStageOptions(ctx.cwd ?? process.cwd(), false, first.instance, true) as never);
		const pid = await stage.complete("Reply with your PID");
		const final = await ctx.tool("final", {}, async () => processIdentity());
		return { pid, first: first.pid, firstInstance: first.instance, finalInstance: final.instance };
	},
});
