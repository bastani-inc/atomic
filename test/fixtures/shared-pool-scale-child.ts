import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

/**
 * A pooled child of the scale scenario (#4768): `steps` checkpoints, each one shared-pool write from whichever host
 * runs it.
 */
export const scaleChild = workflow({
	name: "shared-pool-scale-child",
	description: "A pooled child that commits checkpoints on whichever host runs it (#4768)",
	inputs: { index: Type.Number(), steps: Type.Number() },
	outputs: { host: Type.String() },
	async run(ctx) {
		for (let step = 0; step < ctx.inputs.steps; step++)
			await ctx.tool(`step-${step}`, { index: ctx.inputs.index, step }, async () => step);
		return { host: process.env.SHARED_POOL_HOST ?? "unknown" };
	},
});
