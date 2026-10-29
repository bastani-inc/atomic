import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";
import { processIdentity } from "./process-instance.js";

export const child = workflow({
	name: "pool-lifecycle-child",
	description: "Waits at a tool boundary for coordinator lifecycle tests",
	inputs: { releasePath: Type.String() },
	outputs: {
		firstPid: Type.Number(),
		finalPid: Type.Number(),
		firstInstance: Type.String(),
		finalInstance: Type.String(),
	},
	async run(ctx) {
		const first = await ctx.tool("checkpoint", {}, async () => processIdentity());
		const final = await ctx.tool("finish", {}, async () => {
			while (!existsSync(ctx.inputs.releasePath)) await delay(20);
			return processIdentity();
		});
		return {
			firstPid: first.pid,
			finalPid: final.pid,
			firstInstance: first.instance,
			finalInstance: final.instance,
		};
	},
});
