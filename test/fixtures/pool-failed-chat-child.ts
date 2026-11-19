import { workflow } from "@bastani/atomic/workflows";
import { poolStageOptions } from "./pool-stage-options.js";

export const child = workflow({
	name: "pool-failed-chat-child",
	description: "A child that leaves a real agent transcript before failing",
	inputs: {},
	outputs: {},
	async run(ctx) {
		const { settingsManager: _settings, ...options } = await poolStageOptions(ctx.cwd!, false, process.pid);
		await ctx.stage("agent", options).complete("Produce an answer");
		throw new Error("failed after the agent stage");
	},
});

// A different import binding for the same workflow: the pool cannot rebind the already queued descriptor to it.
export const alternateChild = child;
