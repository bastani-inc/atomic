import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

const leaf = workflow({
	name: "pool-publishing-leaf",
	description: "",
	inputs: {},
	outputs: { pid: Type.Number() },
	async run(ctx) {
		return { pid: await ctx.tool("leaf", {}, async () => process.pid) };
	},
});

/** Every this many steps the child runs a nested workflow, so its publications carry nested runs and their stages. */
export const PUBLISHING_NESTED_EVERY = 5;

/**
 * A pooled child that publishes a long run: one tool node per step and a nested workflow every
 * {@link PUBLISHING_NESTED_EVERY} steps. At each step in `gates` it marks `at-<step>-<index>-<pid>` in `directory`
 * and holds that step's tool until the test creates `release-<step>` there.
 */
export const publishingChild = workflow({
	name: "pool-publishing-child",
	description: "Publishes many tool nodes and nested runs, holding at the steps the test releases",
	inputs: {
		directory: Type.String(),
		index: Type.Number(),
		steps: Type.Number(),
		gates: Type.Array(Type.Number()),
	},
	outputs: { steps: Type.Number(), pid: Type.Number() },
	async run(ctx) {
		const { directory, index, steps, gates } = ctx.inputs;
		for (let step = 0; step < steps; step++) {
			if (step % PUBLISHING_NESTED_EVERY === 0) await ctx.workflow(leaf, {});
			await ctx.tool(`step-${step}`, { step }, async () => {
				if (gates.includes(step)) {
					writeFileSync(join(directory, `at-${step}-${index}-${process.pid}`), "");
					while (!existsSync(join(directory, `release-${step}`))) await delay(20);
				}
				return step;
			});
		}
		return { steps, pid: await ctx.tool("finish", {}, async () => process.pid) };
	},
});
