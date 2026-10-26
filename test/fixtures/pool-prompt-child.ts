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

/** A pooled child that asks through `ctx.ui.custom`, whose component exists only in its worker. */
export const customChild = workflow({
	name: "pool-prompt-custom-child",
	description: "Local worker ctx.ui.custom fixture",
	inputs: {},
	outputs: { branch: Type.String() },
	async run(ctx) {
		const branch = await ctx.ui.custom<string>(() => {
			throw new Error("the component is never rendered outside the worker");
		});
		return { branch };
	},
});
