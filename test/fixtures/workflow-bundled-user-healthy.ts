import { setTimeout as delay } from "node:timers/promises";
import { workflow } from "@bastani/atomic/workflows";

export const healthy = workflow({
	name: "healthy",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await delay(300);
		await ctx.tool("healthy-work", {}, async () => "done");
		await delay(300);
		return {};
	},
});
