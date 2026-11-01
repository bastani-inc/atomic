import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";

/** The message a stage of a 0.9.57 pool failed with when a busy host closed its startup delivery under it. */
export const INFRASTRUCTURE_FAULT = "Worker exited before delivery acknowledgement";

/**
 * A pooled child whose first run fails on a pool infrastructure fault, as its stage did in an earlier root incarnation,
 * and whose later runs complete. The marker file next to the test's journal records the first run.
 */
export const faultedChild = workflow({
	name: "pool-infrastructure-fault-child",
	description: "Fails on a pool infrastructure fault the first time, then completes",
	inputs: { directory: Type.String() },
	outputs: { runs: Type.Number() },
	async run(ctx) {
		const marker = join(ctx.inputs.directory, "faulted");
		await ctx.tool("deliver", {}, async () => {
			if (existsSync(marker)) return true;
			writeFileSync(marker, "");
			throw new Error(INFRASTRUCTURE_FAULT);
		});
		return { runs: 2 };
	},
});
