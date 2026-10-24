import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";

export const resumedChild = workflow({
	name: "resumed-pool-child",
	description: "Holds its lease until the root is restarted, then finishes on a new worker",
	inputs: { directory: Type.String(), index: Type.Number() },
	outputs: { firstPid: Type.Number(), finalPid: Type.Number() },
	async run(ctx) {
		const firstPid = await ctx.tool("checkpoint", {}, async () => process.pid);
		const finalPid = await ctx.tool("wait", {}, async () => {
			writeFileSync(join(ctx.inputs.directory, `started-${ctx.inputs.index}-${process.pid}`), "");
			while (!existsSync(join(ctx.inputs.directory, "release"))) await delay(20);
			return process.pid;
		});
		return { firstPid, finalPid };
	},
});
