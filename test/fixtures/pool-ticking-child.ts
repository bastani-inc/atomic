import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

export const child = workflow({
	name: "pool-ticking-child",
	description: "Runs one tool after another until a test releases it, so a test can see a pause hold its tools",
	inputs: { releasePath: Type.String() },
	outputs: {},
	async run(ctx) {
		for (let index = 0; !existsSync(ctx.inputs.releasePath); index++) {
			await ctx.tool(`tick-${index}`, {}, async () => index);
			await delay(20);
		}
		return {};
	},
});
