import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

const inputs = { release: Type.String() };
const leaf = workflow({
	name: "publication-leaf",
	description: "",
	inputs,
	outputs: {},
	async run(ctx) {
		await ctx.tool("check", {}, async () => {
			while (ctx.inputs.release && !existsSync(ctx.inputs.release)) await sleep(20);
			throw new Error("nested check failed");
		});
		return {};
	},
});

const middle = workflow({
	name: "publication-middle",
	description: "",
	inputs,
	outputs: {},
	async run(ctx) {
		await ctx.workflow(leaf, { inputs: ctx.inputs });
		return {};
	},
});

export const nestedChild = workflow({
	name: "publication-child",
	description: "",
	inputs: { deep: Type.Boolean(), release: Type.String() },
	outputs: {},
	async run(ctx) {
		await ctx.workflow(ctx.inputs.deep ? middle : leaf, { inputs: { release: ctx.inputs.release } });
		return {};
	},
});
