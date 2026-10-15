import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflow } from "@bastani/atomic/workflows";

const options = { model: "nested-discovery-fixture/fixture", group: "reviewers" };
const grandchild = workflow({
	name: "discovery-grandchild",
	description: "Isolated completed/live reviewer discovery fixture.",
	outputs: {},
	inputs: {},
	run: async (ctx) => {
		await ctx.stage("completed-reviewer", options).prompt("fixture-complete");
		await ctx.stage("live-reviewer", options).prompt("fixture-hold");
		return {};
	},
});
const child = workflow({
	name: "discovery-child",
	description: "Isolated child boundary fixture.",
	outputs: {},
	inputs: {},
	run: async (ctx) => {
		writeFileSync(join(process.env.NESTED_DISCOVERY_STATE_DIR!, "child-run-id"), ctx.runId!);
		await ctx.workflow(grandchild);
		return {};
	},
});
export default workflow({
	name: "nested-discovery-fixture",
	description: "Isolated root boundary fixture.",
	outputs: {},
	inputs: {},
	run: async (ctx) => {
		await ctx.workflow(child);
		return {};
	},
});
