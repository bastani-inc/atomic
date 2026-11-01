import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";

/** How long each step's tool runs: steps keep committing checkpoints until the test creates `release`. */
const STEP_MS = 50;

export const committingChild = workflow({
	name: "pool-committing-child",
	description: "Commits a checkpoint every few milliseconds until the test releases it",
	inputs: { directory: Type.String(), index: Type.Number() },
	outputs: { firstPid: Type.Number(), finalPid: Type.Number() },
	async run(ctx) {
		const firstPid = await ctx.tool("start", {}, async () => {
			writeFileSync(join(ctx.inputs.directory, `started-${ctx.inputs.index}-${process.pid}`), "");
			return process.pid;
		});
		for (let step = 0; !existsSync(join(ctx.inputs.directory, "release")); step++)
			await ctx.tool(`step-${step}`, { step }, async () => {
				await delay(STEP_MS);
				return step;
			});
		const finalPid = await ctx.tool("finish", {}, async () => process.pid);
		return { firstPid, finalPid };
	},
});
