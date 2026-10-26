import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

/** A child whose name reads like a rate limit and whose only tool fails for an ordinary reason. */
export const child = workflow({
	name: "rate-limit-overloaded-child",
	description: "Fails on a local worker for an ordinary reason",
	inputs: { message: Type.String() },
	outputs: { pid: Type.Number() },
	async run(ctx) {
		const pid = await ctx.tool("fail", {}, async () => {
			throw new Error(ctx.inputs.message);
		});
		return { pid };
	},
});
