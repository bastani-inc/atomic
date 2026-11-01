import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

/**
 * A pooled child that kills the first worker to run it after its first checkpoint. Its replacement replays it and
 * waits until the test creates `releasePath`.
 */
export const child = workflow({
	name: "pool-replayed-heartbeat-child",
	description: "Crashes its first worker once, then waits to be released",
	inputs: { crashedPath: Type.String(), releasePath: Type.String() },
	outputs: {},
	async run(ctx) {
		await ctx.tool("checkpoint", {}, async () => process.pid);
		if (!existsSync(ctx.inputs.crashedPath)) {
			writeFileSync(ctx.inputs.crashedPath, String(process.pid));
			process.kill(process.pid, "SIGKILL");
		}
		while (!existsSync(ctx.inputs.releasePath)) await delay(20);
		await ctx.tool("released", {}, async () => true);
		return {};
	},
});
