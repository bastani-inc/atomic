import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

/** A pooled child that asks its user a question through `ctx.ui` and returns the answer. */
export const child = workflow({
	name: "pool-prompt-child",
	description: "Local worker ctx.ui prompt fixture",
	inputs: {},
	outputs: { branch: Type.String() },
	async run(ctx) {
		return { branch: await ctx.ui.input("Which branch should the worker use?") };
	},
});
