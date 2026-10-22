import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";

const POOL_SIZE = 3;
const ITEMS = 6;

export const child = workflow({
	name: "child",
	description: "",
	inputs: { topic: Type.String() },
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("child-work", { topic: ctx.inputs.topic }, async () => "done");
		return {};
	},
});

export const pool = workflow({
	name: "rolling-pool",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		const inFlight = new Map<number, Promise<void>>();
		let next = 0;
		while (next < ITEMS || inFlight.size > 0) {
			while (next < ITEMS && inFlight.size < POOL_SIZE) {
				const index = next++;
				const promise = (async (): Promise<void> => {
					await ctx.workflow(child, { inputs: { topic: `topic-${index}` } });
					throw new Error(`author error after child ${index}`);
				})();
				inFlight.set(index, promise);
				void promise.finally(() => inFlight.delete(index));
			}
			await Promise.race(inFlight.values()).catch(() => {});
		}
		return {};
	},
});
