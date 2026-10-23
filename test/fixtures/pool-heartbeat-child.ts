import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

export const child = workflow({
	name: "pool-heartbeat-child",
	description: "Records tool activity, then waits until a test releases it",
	inputs: { releasePath: Type.String(), tools: Type.Number() },
	outputs: {},
	async run(ctx) {
		for (let index = 0; index < ctx.inputs.tools; index++) await ctx.tool(`step-${index}`, {}, async () => index);
		while (!existsSync(ctx.inputs.releasePath)) await delay(20);
		return {};
	},
});
