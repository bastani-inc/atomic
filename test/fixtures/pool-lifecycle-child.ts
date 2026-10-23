import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";

export const child = workflow({
	name: "pool-lifecycle-child",
	description: "Waits at a tool boundary for coordinator lifecycle tests",
	inputs: { releasePath: Type.String() },
	outputs: { firstPid: Type.Number(), finalPid: Type.Number() },
	async run(ctx) {
		const firstPid = await ctx.tool("checkpoint", {}, async () => process.pid);
		const finalPid = await ctx.tool("finish", {}, async () => {
			while (!existsSync(ctx.inputs.releasePath)) await delay(20);
			return process.pid;
		});
		return { firstPid, finalPid };
	},
});
