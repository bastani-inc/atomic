import { workflow } from "@bastani/atomic/workflows";

export const crashingChild = workflow({
	name: "crashing-pool-child",
	description: "Kills every worker that runs it after its first checkpoint",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("checkpoint", {}, async () => process.pid);
		await ctx.tool("crash", {}, async () => process.kill(process.pid, "SIGKILL"));
		return {};
	},
});
