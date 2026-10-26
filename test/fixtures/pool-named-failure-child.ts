import { appendFileSync } from "node:fs";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

function failing(name: string) {
	return workflow({
		name,
		description: "Fails on a local worker with the given message",
		inputs: { message: Type.String(), executions: Type.String() },
		outputs: { pid: Type.Number() },
		async run(ctx) {
			const pid = await ctx.tool("fail", {}, async () => {
				// One line per execution, so a test can tell a replayed result from a new run.
				appendFileSync(ctx.inputs.executions, `${process.pid}\n`);
				throw new Error(ctx.inputs.message);
			});
			return { pid };
		},
	});
}

/** A child whose name reads like a rate limit (#4031). */
export const namedChild = failing("rate-limit-overloaded-child");
/** A child with a neutral name (#4031). */
export const plainChild = failing("plain-child");
