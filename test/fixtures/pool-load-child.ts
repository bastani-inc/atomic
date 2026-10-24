import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

/**
 * Child definition the load gate binds to its pool. The root only uses it to
 * enqueue work; the protocol stub worker (pool-load-stub-worker.mjs) performs
 * the work, so this body never runs.
 */
export const child = workflow({
	name: "pool-load-child",
	description: "Pooled child whose traffic is produced by a protocol stub worker",
	inputs: { index: Type.Number() },
	outputs: {},
	async run() {
		throw new Error("pool-load-child runs only in the load gate's stub worker");
	},
});
