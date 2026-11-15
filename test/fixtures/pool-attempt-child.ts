import { existsSync } from "node:fs";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

/**
 * A pooled child of two tools whose second one fails while the file at `failPath` exists, so a test can fail a pooled
 * child in one attempt of its root and let it complete in the next (#4874). A marker file, not a journal row, for the
 * reason `pool-live-stage-child.ts` gives.
 */
export const child = workflow({
	name: "pool-attempt-child",
	description: "Local worker child that fails while a marker file exists",
	inputs: { failPath: Type.String() },
	outputs: {},
	async run(ctx) {
		await ctx.tool("ct1", {}, async () => "ct1");
		await ctx.tool("ct2", {}, async () => {
			if (existsSync(ctx.inputs.failPath)) throw new Error("planned pooled child failure");
			return "ct2";
		});
		return {};
	},
});
