import { appendFileSync } from "node:fs";
import v8 from "node:v8";
import vm from "node:vm";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

/** Heap in use right after two full collections, so only what is still reachable counts. */
function heapAfterCollection(): number {
	v8.setFlagsFromString("--expose-gc");
	const gc = vm.runInNewContext("gc") as () => void;
	v8.setFlagsFromString("--no-expose-gc");
	gc();
	gc();
	return process.memoryUsage().heapUsed;
}

/**
 * A pooled child that records one durable `ctx.tool` output of `bytes` characters. When it starts, it appends to `log`
 * the heap its worker still holds, after a full collection, with the worker's pid: what the worker kept of the children
 * it ran before.
 */
export const child = workflow({
	name: "pool-memory-child",
	description: "Pooled child with one large durable tool output",
	inputs: { index: Type.Number(), bytes: Type.Number(), log: Type.String() },
	outputs: { length: Type.Number() },
	async run(ctx) {
		const { index, bytes, log } = ctx.inputs;
		appendFileSync(log, `${JSON.stringify({ index, pid: process.pid, heapUsed: heapAfterCollection() })}\n`);
		const { text } = await ctx.tool("payload", { index }, async () => ({
			text: `payload ${index} `.repeat(Math.ceil(bytes / 10)).slice(0, bytes),
		}));
		return { length: text.length };
	},
});
