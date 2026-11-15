import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import { poolStageOptions } from "./pool-stage-options.js";

/**
 * A pooled child that checkpoints a tool, asks its user through `ctx.ui`, then runs stages with the answer (#4941).
 * Every attempt appends its worker's pid to `<cwd>/attempt-pids`, so a test can kill the worker running it.
 */
export const answeredChild = workflow({
	name: "pool-ui-answer-child",
	description: "Local worker ctx.ui answer fixture",
	inputs: {},
	outputs: { branch: Type.String(), stages: Type.Number() },
	async run(ctx) {
		appendFileSync(join(ctx.cwd!, "attempt-pids"), `${process.pid}\n`);
		await ctx.tool("start", {}, async () => "started");
		const branch = await ctx.ui.input("which?");
		const options = await poolStageOptions(ctx.cwd!, false, process.pid);
		await ctx.stage("first", options as never).complete(`Use ${branch}`);
		await ctx.stage("second", options as never).complete(`Ship ${branch}`);
		return { branch, stages: 2 };
	},
});
