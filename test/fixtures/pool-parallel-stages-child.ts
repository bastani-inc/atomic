import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import { poolStageOptions } from "./pool-stage-options.js";

/**
 * A pooled child of the shape `start → [a ‖ b] → finish → c` (#5042). With `tools`, `start` and `finish` are tools and
 * both parallel stages are created before `start`; otherwise every node is an agent stage.
 */
export const child = workflow({
	name: "pool-parallel-stages-child",
	description: "Two agent stages beside each other between two tools",
	inputs: { directory: Type.String(), tools: Type.Boolean() },
	outputs: {},
	async run(ctx) {
		const options = await poolStageOptions(ctx.inputs.directory, false, 0);
		if (ctx.inputs.tools) {
			const a = ctx.stage("a", options as never);
			const b = ctx.stage("b", options as never);
			await ctx.tool("start", {}, async () => "start");
			await Promise.all([a.complete("a"), b.complete("b")]);
			await ctx.tool("finish", {}, async () => "finish");
		} else {
			await ctx.stage("start", options as never).complete("start");
			await Promise.all([ctx.stage("a", options as never).complete("a"), ctx.stage("b", options as never).complete("b")]);
			await ctx.stage("finish", options as never).complete("finish");
		}
		await ctx.stage("c", options as never).complete("c");
		return {};
	},
});
