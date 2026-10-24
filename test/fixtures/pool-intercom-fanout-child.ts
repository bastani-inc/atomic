import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

/**
 * Child definition the pooled Intercom fan-out test binds to its pool. The root only uses it
 * to enqueue work; the protocol stub worker (pool-intercom-stub-worker.mjs) performs the work,
 * so this body never runs.
 */
export const child = workflow({
	name: "pool-intercom-fanout-child",
	description: "Pooled child whose Intercom-capable stage is started by a protocol stub worker",
	inputs: { index: Type.Number() },
	outputs: {},
	async run() {
		throw new Error("pool-intercom-fanout-child runs only in the Intercom fan-out test's stub worker");
	},
});
