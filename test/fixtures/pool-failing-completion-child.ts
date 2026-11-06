import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";

/**
 * Breaks its first worker's channel for the one request that completes the child, as a failing IPC send would, and
 * completes normally on its replay.
 */
export const failingCompletionChild = workflow({
	name: "failing-completion-pool-child",
	description: "Its first attempt cannot send its completion; its replay completes",
	inputs: { directory: Type.String() },
	outputs: { pid: Type.Number() },
	async run(ctx) {
		const pid = await ctx.tool("arrange", {}, async () => {
			const marker = join(ctx.inputs.directory, "sabotaged");
			if (!existsSync(marker)) {
				writeFileSync(marker, String(process.pid));
				const send = process.send!.bind(process) as (message: object, ...rest: unknown[]) => boolean;
				process.send = ((message: { readonly kind?: string }, ...rest: unknown[]) => {
					if (message.kind === "complete") throw new Error("the worker's channel refused its completion");
					return send(message, ...rest);
				}) as typeof process.send;
			}
			return process.pid;
		});
		return { pid };
	},
});
