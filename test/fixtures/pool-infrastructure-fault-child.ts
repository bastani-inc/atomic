import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";

/** The message a stage of a 0.9.57 pool failed with when a busy host closed its startup delivery under it. */
export const INFRASTRUCTURE_FAULT = "Worker exited before delivery acknowledgement";

/**
 * A pooled child that fails on a pool infrastructure fault, then completes. By default only its first run fails: the
 * marker file `faulted` in `directory` records it. With `persistent`, every run fails until the test creates the file
 * `recovered` in `directory`, as a fault that lasts a whole root incarnation does. Every run leaves a `run-<n>` file.
 */
export const faultedChild = workflow({
	name: "pool-infrastructure-fault-child",
	description: "Fails on a pool infrastructure fault, then completes",
	inputs: { directory: Type.String(), persistent: Type.Optional(Type.Boolean()) },
	outputs: { runs: Type.Number() },
	async run(ctx) {
		const marker = join(ctx.inputs.directory, "faulted");
		await ctx.tool("deliver", {}, async () => {
			let run = 1;
			while (existsSync(join(ctx.inputs.directory, `run-${run}`))) run++;
			writeFileSync(join(ctx.inputs.directory, `run-${run}`), "");
			if (ctx.inputs.persistent === true ? existsSync(join(ctx.inputs.directory, "recovered")) : existsSync(marker))
				return true;
			writeFileSync(marker, "");
			throw new Error(INFRASTRUCTURE_FAULT);
		});
		return { runs: 2 };
	},
});
