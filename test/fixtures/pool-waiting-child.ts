import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

/**
 * A pooled child that the waiting stub worker (`pool-waiting-stub-worker.mjs`) runs in its place: a `waits` child
 * reports its one stage waiting released until `gate` exists, a `holds` child stays busy until `gate` exists, and a
 * `quick` child completes at once. The definition is what the root enqueues; the stub never runs this body.
 */
export const child = workflow({
	name: "pool-waiting-child",
	description: "Pooled child whose stage waits released, or which stays busy, until a gate opens",
	inputs: { index: Type.Number(), mode: Type.String(), gate: Type.String() },
	outputs: { index: Type.Number() },
	async run(ctx) {
		return { index: ctx.inputs.index };
	},
});
