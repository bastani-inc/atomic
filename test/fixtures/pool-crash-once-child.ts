import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

/** Kills the worker that first runs it, after its first checkpoint; every later attempt completes. */
export const crashOnceChild = workflow({
	name: "crash-once-pool-child",
	description: "Kills the first worker that runs it, then completes",
	inputs: { directory: Type.String() },
	outputs: {},
	async run(ctx) {
		await ctx.tool("checkpoint", {}, async () => process.pid);
		const marker = join(ctx.inputs.directory, "crashed");
		if (!existsSync(marker)) {
			writeFileSync(marker, "");
			process.kill(process.pid, "SIGKILL");
		}
		return {};
	},
});
